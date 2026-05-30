/**
 * analysis/tradeManagement.js — Trade Management Engine
 *
 * Manages an open trade using ONLY the levels supplied by TradingView:
 *   entry, sl (stop loss), tp1, tp2
 *
 * Does NOT generate new levels. Does NOT modify entry, SL, or targets.
 * Only tells you WHAT ACTION to take given where price is NOW.
 *
 * Four outputs:
 *   1. stopToBE    — when and how to move stop to breakeven
 *   2. tp1Action   — what to do when price hits TP1
 *   3. tp2Action   — what to do when price hits TP2
 *   4. earlyExit   — conditions that warrant closing before targets
 *
 * Trade state machine:
 *   ENTRY_PENDING     → price hasn't reached entry yet
 *   IN_TRADE_INITIAL  → entered, stop still at original SL
 *   BREAKEVEN_QUEUED  → price at BE trigger, stop should be moved to entry
 *   TP1_HIT           → first target reached, exit 50%, stop → entry
 *   TRAILING          → past TP1, riding to TP2 with BE stop
 *   TP2_HIT           → second target reached, exit remaining 50%
 *   STOPPED_OUT       → price hit original stop
 *   EARLY_EXITED      → closed due to an early exit condition
 */

const logger        = require("../utils/logger");
const { getNewsRisk }  = require("../services/newsRisk");
const { getMarketInternals } = require("./internals");

// ── Config ────────────────────────────────────────────────────────

const BE_TRIGGER_PCT  = 0.50;  // move stop to BE when price reaches 50% of TP1 distance
const TP1_EXIT_PCT    = 0.50;  // exit 50% of position at TP1
const TP2_EXIT_PCT    = 1.00;  // exit remaining at TP2 (100% of remainder = full close)
const RTH_CLOSE_MIN   = 955;   // 3:55 PM ET in minutes — 5 min before RTH close
const NEWS_EXIT_MIN   = 15;    // exit if news event within 15 min

// ── Helpers ───────────────────────────────────────────────────────

function etTotalMinutes() {
  const s = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

function calcMilestones(direction, entry, sl, tp1, tp2) {
  const isLong    = direction === "LONG";
  const slDist    = isLong ? entry - sl    : sl    - entry;
  const tp1Dist   = isLong ? tp1   - entry : entry - tp1;
  const tp2Dist   = isLong ? tp2   - entry : entry - tp2;
  const beTrigger = isLong
    ? entry + tp1Dist * BE_TRIGGER_PCT
    : entry - tp1Dist * BE_TRIGGER_PCT;

  return {
    slDistance:    +slDist.toFixed(2),
    tp1Distance:   +tp1Dist.toFixed(2),
    tp2Distance:   +tp2Dist.toFixed(2),
    beTriggerPrice:+beTrigger.toFixed(2),
    beLevel:       entry,   // breakeven = entry price
    rr1:           tp1Dist > 0 ? +(tp1Dist / slDist).toFixed(2) : null,
    rr2:           tp2Dist > 0 ? +(tp2Dist / slDist).toFixed(2) : null,
  };
}

function determineTradeState(direction, entry, sl, tp1, tp2, currentPrice, milestones) {
  const isLong = direction === "LONG";
  const { beTriggerPrice } = milestones;

  if (isLong) {
    if (currentPrice <= sl)             return "STOPPED_OUT";
    if (currentPrice >= tp2)            return "TP2_HIT";
    if (currentPrice >= tp1)            return "TP1_HIT";
    if (currentPrice >= beTriggerPrice) return "BREAKEVEN_QUEUED";
    if (currentPrice < entry)           return "ENTRY_PENDING";
    return "IN_TRADE_INITIAL";
  } else {
    if (currentPrice >= sl)             return "STOPPED_OUT";
    if (currentPrice <= tp2)            return "TP2_HIT";
    if (currentPrice <= tp1)            return "TP1_HIT";
    if (currentPrice <= beTriggerPrice) return "BREAKEVEN_QUEUED";
    if (currentPrice > entry)           return "ENTRY_PENDING";
    return "IN_TRADE_INITIAL";
  }
}

// ── Stop-to-Breakeven Logic ───────────────────────────────────────

function evalStopToBE(tradeState, entry, milestones, direction) {
  const triggered = ["BREAKEVEN_QUEUED", "TP1_HIT", "TP2_HIT"].includes(tradeState);

  return {
    triggered,
    bePrice:      entry,
    triggerPrice: milestones.beTriggerPrice,
    triggerPct:   BE_TRIGGER_PCT * 100,
    action:       triggered
      ? `Move stop to ${entry} (entry price — breakeven)`
      : `Not yet — move stop to breakeven when price reaches ${milestones.beTriggerPrice}`,
    reason: triggered
      ? `Price has moved ${BE_TRIGGER_PCT * 100}% of the way to TP1 — protect entry`
      : `BE trigger at ${milestones.beTriggerPrice} (${BE_TRIGGER_PCT * 100}% of TP1 distance from entry)`,
  };
}

// ── TP1 Logic ─────────────────────────────────────────────────────

function evalTP1Action(tradeState, tp1, tp2, entry, milestones) {
  const hit = ["TP1_HIT", "TP2_HIT"].includes(tradeState);

  return {
    triggered:   hit,
    price:       tp1,
    exitPercent: TP1_EXIT_PCT * 100,
    pnlPoints:   milestones.tp1Distance,
    rr:          milestones.rr1,
    action:      hit
      ? `Exit ${TP1_EXIT_PCT * 100}% of position at ${tp1} (+${milestones.tp1Distance} pts, R:${milestones.rr1})`
      : `Hold — TP1 at ${tp1} not yet reached (+${milestones.tp1Distance} pts away)`,
    postTP1:     hit
      ? [
          `Move stop to breakeven (${entry})`,
          `Hold remaining ${(1 - TP1_EXIT_PCT) * 100}% position for TP2 at ${tp2}`,
          "Trail stop if price shows strong momentum",
        ]
      : [],
  };
}

// ── TP2 Logic ─────────────────────────────────────────────────────

function evalTP2Action(tradeState, tp2, entry, milestones) {
  const hit = tradeState === "TP2_HIT";

  return {
    triggered:   hit,
    price:       tp2,
    exitPercent: TP2_EXIT_PCT * 100,
    pnlPoints:   milestones.tp2Distance,
    rr:          milestones.rr2,
    action:      hit
      ? `Exit remaining ${TP2_EXIT_PCT * 100}% of position at ${tp2} (+${milestones.tp2Distance} pts, R:${milestones.rr2})`
      : `Hold — TP2 at ${tp2} not yet reached (+${milestones.tp2Distance} pts away)`,
    note:        hit
      ? "Full trade closed. Log the result."
      : `TP2 requires ${milestones.tp2Distance} pts total move (R:${milestones.rr2})`,
  };
}

// ── Early Exit Conditions ─────────────────────────────────────────

async function evalEarlyExit(direction, entry, sl, currentPrice, milestones) {
  const conditions = [];

  // 1. Invalidation — price closes back through entry
  const isLong         = direction === "LONG";
  const backThruEntry  = isLong ? currentPrice < entry : currentPrice > entry;
  if (backThruEntry) {
    conditions.push({
      id:       "ENTRY_INVALIDATED",
      triggered: true,
      priority:  "HIGH",
      action:    "EXIT FULL POSITION immediately",
      reason:    `Price (${currentPrice}) has closed back through entry (${entry}) — setup invalidated`,
    });
  }

  // 2. News imminent — event within NEWS_EXIT_MIN minutes
  try {
    const news = await getNewsRisk();
    if (news.minutesUntil !== null && news.minutesUntil <= NEWS_EXIT_MIN) {
      conditions.push({
        id:       "NEWS_IMMINENT",
        triggered: true,
        priority:  "HIGH",
        action:    `EXIT before ${news.nextEvent} (${news.minutesUntil} min away)`,
        reason:    `High-impact USD event in ${news.minutesUntil} min — do not hold through news`,
      });
    }
  } catch { /* news check is optional */ }

  // 3. Session close — within 5 min of RTH close
  const nowMin = etTotalMinutes();
  if (nowMin >= RTH_CLOSE_MIN && nowMin < 975) {
    conditions.push({
      id:       "SESSION_CLOSE",
      triggered: true,
      priority:  "MEDIUM",
      action:    "EXIT all remaining positions before 4:00 PM ET",
      reason:    "Approaching RTH close — avoid holding into after-hours thin liquidity",
    });
  }

  // 4. Stop proximity warning — price within 25% of stop
  const slDist   = milestones.slDistance;
  const distToSL = isLong ? currentPrice - sl : sl - currentPrice;
  const slProximityPct = slDist > 0 ? distToSL / slDist : 1;

  if (slProximityPct < 0.25 && slProximityPct > 0) {
    conditions.push({
      id:       "STOP_PROXIMITY",
      triggered: false,   // warning only, not a hard exit
      priority:  "LOW",
      action:    "Monitor closely — do NOT manually widen stop",
      reason:    `Price within ${(slProximityPct * 100).toFixed(0)}% of stop loss — let stop do its job`,
    });
  }

  // Determine overall early exit status
  const hardExits = conditions.filter(c => c.triggered && c.priority === "HIGH");

  return {
    shouldExit:    hardExits.length > 0,
    exitCount:     hardExits.length,
    conditions,
    summary:       hardExits.length > 0
      ? `⚠️ EXIT TRIGGERED: ${hardExits[0].reason}`
      : conditions.length > 0
        ? `${conditions.length} condition(s) to monitor — no hard exit yet`
        : "No early exit conditions triggered",
  };
}

// ── P&L Estimate ──────────────────────────────────────────────────

function calcPnL(entry, sl, tp1, tp2, milestones) {
  return {
    atTP1: {
      points:      milestones.tp1Distance,
      description: `+${milestones.tp1Distance} pts on 50% of position (R:${milestones.rr1})`,
    },
    atTP2: {
      points:      milestones.tp2Distance,
      description: `+${milestones.tp2Distance} pts on remaining 50% (R:${milestones.rr2})`,
    },
    ifStopped: {
      points:      -milestones.slDistance,
      description: `-${milestones.slDistance} pts on full position (1R loss)`,
    },
    breakeven: {
      points:      0,
      description: "Exit at entry price — no loss, no gain",
    },
  };
}

// ── Summary Text ──────────────────────────────────────────────────

function buildSummary(tradeState, stopBE, tp1, tp2, earlyExit) {
  if (earlyExit.shouldExit) return `⚠️ EARLY EXIT — ${earlyExit.conditions.find(c => c.triggered)?.reason}`;

  const stateMessages = {
    ENTRY_PENDING:    "Waiting for entry price to be reached",
    IN_TRADE_INITIAL: `In trade — stop at original SL. BE trigger at ${stopBE.triggerPrice}`,
    BREAKEVEN_QUEUED: `✓ Move stop to breakeven (${stopBE.bePrice}) now — price reached ${stopBE.triggerPrice}`,
    TP1_HIT:          `✓ TP1 reached — exit 50%, move stop to breakeven (${stopBE.bePrice}), trail to TP2`,
    TP2_HIT:          "✓ TP2 reached — full exit. Trade complete.",
    STOPPED_OUT:      "✗ Stopped out at original SL",
    EARLY_EXITED:     "Trade closed via early exit condition",
  };

  return stateMessages[tradeState] || "Unknown trade state";
}

// ── Main Export ───────────────────────────────────────────────────

/**
 * Evaluate trade management for an open position.
 *
 * @param {object} signal       — from signalStore: { direction, entry, sl, tp1, tp2, symbol }
 * @param {number} currentPrice — current market price
 */
async function manageTrade(signal, currentPrice) {
  const { direction, entry, sl, tp1, tp2, symbol = "NQ=F" } = signal;

  if (!direction || !entry || !sl || !tp1 || !tp2) {
    throw new Error("manageTrade requires direction, entry, sl, tp1, tp2");
  }
  if (!currentPrice) {
    throw new Error("manageTrade requires currentPrice");
  }

  logger.info(
    `[tradeManagement] Managing ${direction} | ` +
    `Entry:${entry} SL:${sl} TP1:${tp1} TP2:${tp2} | Current:${currentPrice}`
  );

  const milestones = calcMilestones(direction, entry, sl, tp1, tp2);
  const tradeState = determineTradeState(direction, entry, sl, tp1, tp2, currentPrice, milestones);

  const [stopBE, tp1Action, tp2Action, earlyExit] = await Promise.all([
    Promise.resolve(evalStopToBE(tradeState, entry, milestones, direction)),
    Promise.resolve(evalTP1Action(tradeState, tp1, tp2, entry, milestones)),
    Promise.resolve(evalTP2Action(tradeState, tp2, entry, milestones)),
    evalEarlyExit(direction, entry, sl, currentPrice, milestones),
  ]);

  const summary = buildSummary(tradeState, stopBE, tp1Action, tp2Action, earlyExit);

  logger.info(`[tradeManagement] State: ${tradeState} | ${summary}`);

  return {
    symbol,
    direction,
    tradeState,
    calculatedAt:  new Date().toISOString(),
    currentPrice,

    // ── Input Levels (from TradingView — unchanged) ────────────
    levels: { entry, sl, tp1, tp2 },

    // ── Calculated Milestones ──────────────────────────────────
    milestones,

    // ── The Four Outputs ──────────────────────────────────────
    stopToBE:   stopBE,
    tp1Action,
    tp2Action,
    earlyExit,

    // ── P&L Reference ──────────────────────────────────────────
    pnl:     calcPnL(entry, sl, tp1, tp2, milestones),

    // ── One-line Summary ──────────────────────────────────────
    summary,
  };
}

module.exports = { manageTrade };
