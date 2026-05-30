/**
 * analysis/riskManagement.js — Daily Risk Management Engine
 *
 * Enforces session-level safety rules so a bad day doesn't become a blown account.
 *
 * ── Loss Rules (total losses today, resets each ET day) ───────────
 *   2 losses → RESTRICTED  — only A+ setups allowed (score ≥ 90)
 *   3 losses → HALTED      — no more trading today, period
 *
 * ── Overtrading Detection ─────────────────────────────────────────
 *   ≥ 5 trades → WARNING   — soft flag, recommendation to stop
 *   ≥ 7 trades → HARD STOP — overtrading limit reached
 *
 * ── Revenge Trading Detection ────────────────────────────────────
 *   New trade entered within 10 minutes of a LOSS being closed
 *   → revenge flag raised, trade blocked in RESTRICTED/HALTED states
 *   → warning issued in NORMAL state
 *
 * ── Two Entry Points ──────────────────────────────────────────────
 *   assessRisk()                                — full session report (no trade proposed)
 *   checkPreTrade({ tradeScore, entryTime })    — gate check before entering a trade
 */

const logger         = require("../utils/logger");
const {
  getStats,
  getLastLoss,
  getTodaySession,
  getCurrentLossStreak,
}  = require("../services/sessionTracker");

// ── Config ────────────────────────────────────────────────────────

const LOSS_THRESHOLD_RESTRICTED = 2;    // losses before A+ filter kicks in
const LOSS_THRESHOLD_HALTED     = 3;    // losses before session halt
const A_PLUS_MIN_SCORE          = 90;   // minimum score for a restricted-mode trade
const MAX_TRADES_WARNING        = 5;    // soft overtrading threshold
const MAX_TRADES_HARD_STOP      = 7;    // hard overtrading limit
const REVENGE_WINDOW_MINUTES    = 10;   // minutes after loss = revenge window
const NORMAL_TRADES_PER_SESSION = 3;    // baseline expectation (used in commentary)

// ── Status Levels ─────────────────────────────────────────────────
// NORMAL      — no restrictions
// RESTRICTED  — A+ setups only (2 losses)
// HALTED      — stop trading (3 losses OR hard overtrade)
// OVERTRADED  — soft warning (5+ trades) — not a hard block by itself

// ── Helpers ───────────────────────────────────────────────────────

function minutesBetween(earlierISO, laterISO) {
  const ms = new Date(laterISO).getTime() - new Date(earlierISO).getTime();
  return ms / 60000;
}

/**
 * Determine session status from today's stats.
 * Returns: { status, reason, canTrade, requiresAPlus }
 */
function evalSessionStatus(stats) {
  if (stats.losses >= LOSS_THRESHOLD_HALTED) {
    return {
      status:       "HALTED",
      reason:       `${stats.losses} losses today — daily loss limit reached`,
      canTrade:     false,
      requiresAPlus: false,
    };
  }

  if (stats.totalTrades >= MAX_TRADES_HARD_STOP) {
    return {
      status:       "HALTED",
      reason:       `${stats.totalTrades} trades today — hard overtrading limit reached`,
      canTrade:     false,
      requiresAPlus: false,
    };
  }

  if (stats.losses >= LOSS_THRESHOLD_RESTRICTED) {
    return {
      status:       "RESTRICTED",
      reason:       `${stats.losses} losses today — A+ setups only (score ≥ ${A_PLUS_MIN_SCORE})`,
      canTrade:     true,
      requiresAPlus: true,
    };
  }

  return {
    status:       "NORMAL",
    reason:       "No loss restrictions active",
    canTrade:     true,
    requiresAPlus: false,
  };
}

/**
 * Check for revenge trading pattern.
 * Compares the reference time (proposed entry OR now) against the last loss's recordedAt.
 *
 * @param {string|null} proposedEntryTime — ISO string, defaults to now
 * @returns {object} revenge alert details
 */
function evalRevenge(proposedEntryTime) {
  const lastLoss = getLastLoss();

  if (!lastLoss) {
    return { detected: false, minutesSinceLoss: null, threshold: REVENGE_WINDOW_MINUTES };
  }

  const referenceTime    = proposedEntryTime || new Date().toISOString();
  const minutesSinceLoss = minutesBetween(lastLoss.recordedAt, referenceTime);

  // Negative minutes = proposed entry is BEFORE the last loss (edge case / data issue)
  if (minutesSinceLoss < 0) {
    return { detected: false, minutesSinceLoss: null, threshold: REVENGE_WINDOW_MINUTES };
  }

  const detected = minutesSinceLoss <= REVENGE_WINDOW_MINUTES;

  return {
    detected,
    minutesSinceLoss:  +minutesSinceLoss.toFixed(1),
    threshold:          REVENGE_WINDOW_MINUTES,
    lastLossAt:         lastLoss.recordedAt,
    entryTimeIsExact:   !!proposedEntryTime,   // false = using "now" as approximation
    message: detected
      ? `⚠️ Possible revenge trade — only ${minutesSinceLoss.toFixed(1)} min after last loss. ` +
        `Wait ${(REVENGE_WINDOW_MINUTES - minutesSinceLoss).toFixed(1)} more minutes, step away, reset mentally.`
      : `No revenge pattern — ${minutesSinceLoss.toFixed(1)} min since last loss (threshold: ${REVENGE_WINDOW_MINUTES} min)`,
  };
}

/**
 * Check for overtrading.
 * Returns a soft warning at MAX_TRADES_WARNING, hard flag at MAX_TRADES_HARD_STOP.
 */
function evalOvertrading(stats) {
  const count = stats.totalTrades;

  if (count >= MAX_TRADES_HARD_STOP) {
    return {
      detected:    true,
      severity:    "HARD",
      tradeCount:  count,
      softLimit:   MAX_TRADES_WARNING,
      hardLimit:   MAX_TRADES_HARD_STOP,
      message:     `Hard limit reached — ${count} trades today (max: ${MAX_TRADES_HARD_STOP}). Stop trading.`,
    };
  }

  if (count >= MAX_TRADES_WARNING) {
    return {
      detected:    true,
      severity:    "WARNING",
      tradeCount:  count,
      softLimit:   MAX_TRADES_WARNING,
      hardLimit:   MAX_TRADES_HARD_STOP,
      message:     `${count} trades taken — approaching overtrading territory. ` +
                   `Normal session is ${NORMAL_TRADES_PER_SESSION}. Consider stopping.`,
    };
  }

  return {
    detected:    false,
    severity:    "NONE",
    tradeCount:  count,
    softLimit:   MAX_TRADES_WARNING,
    hardLimit:   MAX_TRADES_HARD_STOP,
    message:     `${count} trade(s) today — within normal range`,
  };
}

/**
 * Scan historical trade pairs to detect past revenge trading in today's session.
 * Uses entryTime of subsequent trade if available, otherwise recordedAt.
 */
function scanHistoricalRevenge(trades) {
  const flags = [];

  for (let i = 0; i < trades.length - 1; i++) {
    if (trades[i].outcome !== "LOSS") continue;

    const loss      = trades[i];
    const next      = trades[i + 1];
    const entryRef  = next.entryTime || next.recordedAt;
    const mins      = minutesBetween(loss.recordedAt, entryRef);
    const inexact   = !next.entryTimeIsExact;

    if (mins >= 0 && mins <= REVENGE_WINDOW_MINUTES) {
      flags.push({
        lossId:          loss.id,
        lossAt:          loss.recordedAt,
        nextTradeId:     next.id,
        nextEntryAt:     entryRef,
        minutesLater:    +mins.toFixed(1),
        entryTimeExact:  !inexact,
        note: inexact
          ? `~${mins.toFixed(1)} min (approximate — entryTime not supplied for next trade)`
          : `${mins.toFixed(1)} min`,
      });
    }
  }

  return flags;
}

/**
 * Build the human-readable recommendation string.
 */
function buildRecommendation(sessionStatus, revengeAlert, overtradingAlert) {
  if (sessionStatus.status === "HALTED") {
    return `🛑 STOP TRADING — ${sessionStatus.reason}. Close your platform and step away.`;
  }
  if (overtradingAlert.detected && overtradingAlert.severity === "HARD") {
    return `🛑 STOP TRADING — ${overtradingAlert.message}`;
  }
  if (sessionStatus.status === "RESTRICTED") {
    return `⚠️ RESTRICTED — ${sessionStatus.reason}. Do not enter unless grade is A+ (score ≥ ${A_PLUS_MIN_SCORE}).`;
  }
  if (overtradingAlert.detected && overtradingAlert.severity === "WARNING") {
    return `⚠️ OVERTRADING WARNING — ${overtradingAlert.message}`;
  }
  if (revengeAlert.detected) {
    return `⚠️ REVENGE TRADE RISK — ${revengeAlert.message}`;
  }
  return "✅ Clear — conditions are within normal limits. Trade your plan.";
}

// ── Main Functions ────────────────────────────────────────────────

/**
 * Full session risk assessment — no trade proposed.
 * Call this at any time to get the current risk state.
 *
 * @returns {object} complete risk report
 */
function assessRisk() {
  const stats          = getStats();
  const session        = getTodaySession();
  const sessionStatus  = evalSessionStatus(stats);
  const revengeAlert   = evalRevenge(null);           // check NOW against last loss
  const overtradingAlert = evalOvertrading(stats);
  const historicalRevenge = scanHistoricalRevenge(session.trades);
  const recommendation = buildRecommendation(sessionStatus, revengeAlert, overtradingAlert);

  logger.info(
    `[riskManagement] Assess: ${sessionStatus.status} | ` +
    `${stats.losses} losses | ${stats.totalTrades} trades | ` +
    `Revenge: ${revengeAlert.detected} | Overtrade: ${overtradingAlert.severity}`
  );

  return {
    sessionStatus: sessionStatus.status,
    canTrade:       sessionStatus.canTrade,
    requiresAPlus:  sessionStatus.requiresAPlus,
    aPlusMinScore:  A_PLUS_MIN_SCORE,

    // Today's numbers
    stats,

    // Risk flags
    revengeAlert,
    overtradingAlert,
    historicalRevengeTrades: historicalRevenge,

    // Active rules
    rulesInEffect: [
      {
        id:          "LOSS_RESTRICTION",
        description: `After ${LOSS_THRESHOLD_RESTRICTED} losses: A+ setups only`,
        threshold:   LOSS_THRESHOLD_RESTRICTED,
        current:     stats.losses,
        triggered:   stats.losses >= LOSS_THRESHOLD_RESTRICTED,
      },
      {
        id:          "SESSION_HALT",
        description: `After ${LOSS_THRESHOLD_HALTED} losses: stop trading`,
        threshold:   LOSS_THRESHOLD_HALTED,
        current:     stats.losses,
        triggered:   stats.losses >= LOSS_THRESHOLD_HALTED,
      },
      {
        id:          "OVERTRADE_WARNING",
        description: `After ${MAX_TRADES_WARNING} trades: overtrading warning`,
        threshold:   MAX_TRADES_WARNING,
        current:     stats.totalTrades,
        triggered:   stats.totalTrades >= MAX_TRADES_WARNING,
      },
      {
        id:          "OVERTRADE_HALT",
        description: `After ${MAX_TRADES_HARD_STOP} trades: hard stop`,
        threshold:   MAX_TRADES_HARD_STOP,
        current:     stats.totalTrades,
        triggered:   stats.totalTrades >= MAX_TRADES_HARD_STOP,
      },
    ],

    recommendation,
    assessedAt: new Date().toISOString(),
  };
}

/**
 * Pre-trade gate check — call this BEFORE entering any trade.
 *
 * @param {object} opts
 * @param {number}  [opts.tradeScore]     — 0–100 score from scoreSignal() / decision engine
 * @param {string}  [opts.tradeGrade]     — "A+", "A", "B+", etc.
 * @param {string}  [opts.proposedEntryTime] — ISO string (defaults to now)
 * @param {string}  [opts.direction]      — "LONG" | "SHORT" (for logging)
 * @param {string}  [opts.symbol]         — e.g. "NQ=F" (for logging)
 *
 * @returns {object} { allowed, blockReason, sessionStatus, ... }
 */
function checkPreTrade({ tradeScore, tradeGrade, proposedEntryTime, direction, symbol } = {}) {
  const stats            = getStats();
  const sessionStatus    = evalSessionStatus(stats);
  const revengeAlert     = evalRevenge(proposedEntryTime || null);
  const overtradingAlert = evalOvertrading(stats);

  const reasons  = [];
  let allowed    = true;
  let blockReason = null;

  // ── Hard blocks ────────────────────────────────────────────
  if (!sessionStatus.canTrade) {
    allowed     = false;
    blockReason = sessionStatus.reason;
    reasons.push({ type: "BLOCK", rule: sessionStatus.status, message: sessionStatus.reason });
  }

  // ── Restricted: check score ────────────────────────────────
  if (allowed && sessionStatus.requiresAPlus) {
    const scoreProvided = tradeScore !== undefined && tradeScore !== null;
    const passes        = scoreProvided ? tradeScore >= A_PLUS_MIN_SCORE : false;

    if (!passes) {
      allowed     = false;
      blockReason = scoreProvided
        ? `RESTRICTED mode: score ${tradeScore} < ${A_PLUS_MIN_SCORE} (A+ required after ${stats.losses} losses)`
        : `RESTRICTED mode: trade score required — provide tradeScore to pass the A+ filter`;
      reasons.push({
        type:    "BLOCK",
        rule:    "A_PLUS_REQUIRED",
        message: blockReason,
        scoreProvided,
        scoreRequired: A_PLUS_MIN_SCORE,
        scoreReceived: tradeScore ?? null,
      });
    } else {
      reasons.push({
        type:    "PASS",
        rule:    "A_PLUS_REQUIRED",
        message: `Score ${tradeScore} ≥ ${A_PLUS_MIN_SCORE} — passes A+ filter`,
      });
    }
  }

  // ── Revenge warning / soft block ────────────────────────────
  if (revengeAlert.detected) {
    if (!sessionStatus.canTrade || sessionStatus.requiresAPlus) {
      // In restricted/halted state, revenge trade is an additional hard block
      if (allowed) {
        allowed     = false;
        blockReason = revengeAlert.message;
      }
      reasons.push({ type: "BLOCK", rule: "REVENGE_TRADE", message: revengeAlert.message });
    } else {
      // In normal state, revenge is a strong warning (not a hard block)
      reasons.push({ type: "WARNING", rule: "REVENGE_TRADE", message: revengeAlert.message });
    }
  }

  // ── Overtrading warning ────────────────────────────────────
  if (overtradingAlert.detected) {
    if (overtradingAlert.severity === "HARD") {
      if (allowed) {
        allowed     = false;
        blockReason = overtradingAlert.message;
      }
      reasons.push({ type: "BLOCK", rule: "OVERTRADE_HARD", message: overtradingAlert.message });
    } else {
      reasons.push({ type: "WARNING", rule: "OVERTRADE_WARNING", message: overtradingAlert.message });
    }
  }

  // ── Positive pass message ──────────────────────────────────
  if (allowed && reasons.length === 0) {
    reasons.push({ type: "PASS", rule: "ALL_CLEAR", message: "All risk checks passed" });
  }

  // ── Build recommendation ──────────────────────────────────
  let recommendation;
  if (!allowed) {
    recommendation = `🚫 BLOCKED — ${blockReason}`;
  } else if (reasons.some(r => r.type === "WARNING")) {
    const warn = reasons.find(r => r.type === "WARNING");
    recommendation = `⚠️ PROCEED WITH CAUTION — ${warn.message}`;
  } else {
    recommendation = "✅ Cleared for entry — all risk rules passed";
  }

  logger.info(
    `[riskManagement] PreTrade check | ` +
    `${direction || "?"} ${symbol || ""} | ` +
    `Score: ${tradeScore ?? "N/A"} | ` +
    `${allowed ? "ALLOWED" : "BLOCKED"} — ${blockReason || "all clear"}`
  );

  return {
    allowed,
    blockReason,
    sessionStatus:    sessionStatus.status,
    canTrade:         sessionStatus.canTrade,
    requiresAPlus:    sessionStatus.requiresAPlus,
    aPlusMinScore:    A_PLUS_MIN_SCORE,

    // Score evaluation (if provided)
    scoreCheck: tradeScore !== undefined
      ? {
          provided:  tradeScore,
          grade:     tradeGrade || null,
          required:  sessionStatus.requiresAPlus ? A_PLUS_MIN_SCORE : null,
          passes:    sessionStatus.requiresAPlus ? tradeScore >= A_PLUS_MIN_SCORE : true,
        }
      : null,

    revengeAlert,
    overtradingAlert,
    stats,
    reasons,
    recommendation,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { assessRisk, checkPreTrade };
