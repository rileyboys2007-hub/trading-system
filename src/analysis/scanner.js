/**
 * analysis/scanner.js — Automatic Setup Scanner
 *
 * Runs the full analysis checklist on NQ=F without requiring a TradingView alert.
 * Called every 5 minutes during RTH by the market scanner service.
 *
 * ── Trigger Gate (must pass before pipeline runs) ────────────────
 *   At least ONE of:
 *     • Liquidity sweep active (swept + rejected within last 2 bars)
 *     • Playbook matched AND aligned (confidence ≥ 55%)
 *
 *   If neither: return early — no API calls, no cost, no noise.
 *
 * ── Direction Logic ───────────────────────────────────────────────
 *   Score each direction independently:
 *     • Active sweep aligned to direction = 2 points
 *     • Playbook matched + aligned = 1 point
 *   Require winning direction ≥ 2 AND losing direction ≤ 1.
 *   If both sides score ≥ 2 → conflicting signals, no alert.
 *
 * ── SL / TP Calculation ───────────────────────────────────────────
 *   SL: swept level price (if sweep triggered), else entry ± 30 pts
 *   TP1: entry + (entry - SL) × 1.5
 *   TP2: entry + (entry - SL) × 3.0
 *
 * ── Output ────────────────────────────────────────────────────────
 *   { triggered, direction, signal, scoreResult, decision, levels, triggerSummary }
 */

const logger = require("../utils/logger");

const { getKeyLevels }          = require("./levels");
const { getMarketInternals }    = require("./internals");
const { detectLiquiditySweeps } = require("./liquidity");
const { detectPlaybooks }       = require("./playbooks");
const { getDailyBias }          = require("./bias");
const { calculateVWAP }         = require("./vwap");
const { scoreSignal }           = require("./scoring");
const { makeDecision }          = require("./decision");
const { checkPreTrade }         = require("./riskManagement");
const { getNewsRisk }           = require("../services/newsRisk");

// ── Config ────────────────────────────────────────────────────────

const DEFAULT_SL_BUFFER    = 30;    // pts — fallback SL distance if no sweep
const TP1_MULTIPLIER       = 1.5;   // R multiplier for TP1
const TP2_MULTIPLIER       = 3.0;   // R multiplier for TP2

// ── Helpers ───────────────────────────────────────────────────────

function safe(label, fn) {
  return fn().catch(err => {
    logger.warn(`[scanner] ${label} failed: ${err.message}`);
    return null;
  });
}

function isWeekday() {
  const day = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York", weekday: "short",
  });
  return !["Sat", "Sun"].includes(day);
}

function isRTH() {
  if (!isWeekday()) return false;
  const s = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const [h, m] = s.split(":").map(Number);
  const mins = h * 60 + m;

  // CME maintenance break: 5:00–6:00 PM ET (2:00–3:00 PM PT) — NQ doesn't trade
  const inMaintenance = mins >= 1020 && mins < 1080;
  if (inMaintenance) return false;

  // 6:30 AM – 7:00 PM PT  =  9:30 AM – 10:00 PM ET
  // Covers: RTH + post-market + Asia session open
  return mins >= 570 && mins < 1320;
}

/**
 * Score trigger strength for one direction.
 * Only counts a sweep if it's actually ALIGNED with the intended direction.
 * Returns: { score, sweep, playbook }
 */
function scoreDirection(sweepResult, playbookResult, direction) {
  const sweep       = sweepResult?.activeSignal ?? null;
  // Sweep must be aligned: a REJECTED sweep that implies the same direction we want
  const sweepActive = sweep !== null && sweep.impliedBias === direction && sweep.result === "REJECTED";
  const playbookHit = playbookResult?.bestMatch?.aligned === true;

  const score = (sweepActive ? 2 : 0) + (playbookHit ? 1 : 0);
  return { score, sweep: sweepActive ? sweep : null, playbook: playbookResult?.bestMatch ?? null };
}

/**
 * Build a synthetic signal for the scanner (no TradingView input).
 * SL anchored to swept level when available.
 */
function buildSignal(symbol, direction, currentPrice, sweepLevel, sweepLevelPrice) {
  const isLong = direction === "LONG";

  let sl;
  let slNote;

  if (sweepLevelPrice != null) {
    // Use the swept level as the stop anchor
    sl     = sweepLevelPrice;
    slNote = `SL at swept level (${sweepLevel}) — adjust for your chart`;
  } else {
    // Fallback: fixed distance
    sl     = isLong ? currentPrice - DEFAULT_SL_BUFFER : currentPrice + DEFAULT_SL_BUFFER;
    slNote = `SL estimated (${DEFAULT_SL_BUFFER} pts default — adjust before entry)`;
  }

  const slDist = Math.abs(currentPrice - sl);
  const tp1    = isLong
    ? +(currentPrice + slDist * TP1_MULTIPLIER).toFixed(2)
    : +(currentPrice - slDist * TP1_MULTIPLIER).toFixed(2);
  const tp2    = isLong
    ? +(currentPrice + slDist * TP2_MULTIPLIER).toFixed(2)
    : +(currentPrice - slDist * TP2_MULTIPLIER).toFixed(2);

  const rr1 = slDist > 0 ? +(slDist * TP1_MULTIPLIER / slDist).toFixed(2) : null;
  const rr2 = slDist > 0 ? +(slDist * TP2_MULTIPLIER / slDist).toFixed(2) : null;

  return {
    id:          `scan_${Date.now()}`,
    source:      "scanner",
    symbol,
    direction,
    entry:       currentPrice,
    sl:          +sl.toFixed(2),
    tp1,
    tp2,
    slPoints:    +slDist.toFixed(2),
    rr1,
    rr2,
    slNote,
    setup:       null,   // filled in after playbook match
  };
}

// ── Main Scan Function ────────────────────────────────────────────

/**
 * Run a full setup scan on the given symbol.
 *
 * @param {string} symbol — e.g. "NQ=F"
 * @returns {object} scan result
 */
async function runScan(symbol = "NQ=F", { forceRun = false } = {}) {

  if (!isRTH() && !forceRun) {
    return { triggered: false, reason: "Outside RTH (9:30 AM – 4:00 PM ET, weekdays only)" };
  }

  logger.info(`[scanner] Scanning ${symbol}...`);

  // ── Step 0: News gate — abort before any expensive calls ─────
  const newsCheck = await safe("news", () => getNewsRisk());
  if (newsCheck?.riskLevel === "EXTREME") {
    logger.info(`[scanner] ⛔ News gate blocked: ${newsCheck.explanation}`);
    return {
      triggered: false,
      reason:    `News gate: ${newsCheck.explanation}`,
      newsBlocked: true,
      newsRisk:  newsCheck,
    };
  }

  // ── Step 1: Collect trigger data for both directions ─────────
  const [
    levels,
    longSweep,
    shortSweep,
    longPlaybook,
    shortPlaybook,
    vwapData,
  ] = await Promise.all([
    safe("levels",         () => getKeyLevels(symbol)),
    safe("sweep:LONG",     () => detectLiquiditySweeps({ direction: "LONG",  symbol })),
    safe("sweep:SHORT",    () => detectLiquiditySweeps({ direction: "SHORT", symbol })),
    safe("playbook:LONG",  () => detectPlaybooks({ direction: "LONG",  symbol })),
    safe("playbook:SHORT", () => detectPlaybooks({ direction: "SHORT", symbol })),
    safe("vwap",           () => calculateVWAP(symbol)),
  ]);

  if (!levels) {
    return { triggered: false, reason: "Could not fetch key levels" };
  }

  const currentPrice = levels.currentPrice;

  // ── Step 2: Score each direction ─────────────────────────────
  const longTriggers  = scoreDirection(longSweep,  longPlaybook,  "LONG");
  const shortTriggers = scoreDirection(shortSweep, shortPlaybook, "SHORT");

  logger.info(
    `[scanner] Triggers — LONG: ${longTriggers.score} | SHORT: ${shortTriggers.score} | Price: ${currentPrice}`
  );

  // No triggers at all → exit early
  if (longTriggers.score === 0 && shortTriggers.score === 0) {
    return { triggered: false, reason: "No setup triggers — no sweep or aligned playbook detected" };
  }

  // Conflicting signals → both sides score high → skip
  if (longTriggers.score >= 2 && shortTriggers.score >= 2) {
    return {
      triggered: false,
      reason: "Conflicting signals — both LONG and SHORT triggers active simultaneously",
      longScore: longTriggers.score,
      shortScore: shortTriggers.score,
    };
  }

  // Determine direction: winner must score ≥ 2
  let direction, activeTriggers;
  if (longTriggers.score >= shortTriggers.score && longTriggers.score >= 2) {
    direction       = "LONG";
    activeTriggers  = longTriggers;
  } else if (shortTriggers.score > longTriggers.score && shortTriggers.score >= 2) {
    direction       = "SHORT";
    activeTriggers  = shortTriggers;
  } else {
    // Only one trigger (score = 1) — not enough conviction without both sweep + playbook
    const stronger = longTriggers.score >= shortTriggers.score ? "LONG" : "SHORT";
    return {
      triggered: false,
      reason: `Weak trigger only (score: 1) for ${stronger} — need sweep + playbook for scanner confidence`,
    };
  }

  // ── Step 3: Build synthetic signal ───────────────────────────
  const sweepLevel      = activeTriggers.sweep?.level ?? null;
  const sweepLevelPrice = activeTriggers.sweep?.levelPrice ?? null;

  const signal = buildSignal(symbol, direction, currentPrice, sweepLevel, sweepLevelPrice);

  // Attach setup name from playbook if matched
  if (activeTriggers.playbook?.playbook) {
    signal.setup = activeTriggers.playbook.playbook;
  } else if (activeTriggers.sweep?.level) {
    signal.setup = direction === "LONG"
      ? `${activeTriggers.sweep.level}_SWEEP_REVERSAL_LONG`
      : `${activeTriggers.sweep.level}_SWEEP_REVERSAL_SHORT`;
  }

  // ── Step 4: Full pipeline (bias + internals + score + decision) ──
  const [bias, internals] = await Promise.all([
    safe("bias",      () => getDailyBias()),
    safe("internals", () => getMarketInternals()),
  ]);

  const scoreResult = await safe("scoring", () => scoreSignal({
    direction,
    symbol,
    bias,
    internals,
    sweep:    activeTriggers.sweep,
    playbook: activeTriggers.playbook,
    vwap:     vwapData,
    newsRisk: newsCheck,
  }));

  const decision = await safe("decision", () => makeDecision({
    direction,
    symbol,
    scoreResult: scoreResult ?? undefined,
  }));

  const riskCheck = checkPreTrade({
    tradeScore: scoreResult?.totalScore,
    tradeGrade: scoreResult?.grade,
    direction,
    symbol,
  });

  // ── Step 5: Assemble result ───────────────────────────────────
  const triggerSummary = [
    activeTriggers.sweep    ? `Sweep: ${activeTriggers.sweep.level} (${activeTriggers.sweep.result})` : null,
    activeTriggers.playbook ? `Playbook: ${activeTriggers.playbook.playbook} (${activeTriggers.playbook.confidence}%)` : null,
    vwapData ? `VWAP: ${vwapData.position} @ ${vwapData.vwap} (${vwapData.slopeDir})` : null,
  ].filter(Boolean).join(" | ");

  logger.info(
    `[scanner] ${direction} | Decision: ${decision?.decision ?? "N/A"} | ` +
    `Score: ${scoreResult?.totalScore ?? "N/A"} | ${triggerSummary}`
  );

  return {
    triggered:      true,
    symbol,
    direction,
    signal,
    scoreResult,
    decision,
    riskCheck,
    levels,
    vwap:          vwapData,
    newsRisk:      newsCheck,
    triggerSummary,
    scannedAt:     new Date().toISOString(),

    // Raw trigger data
    triggers: {
      longScore:  longTriggers.score,
      shortScore: shortTriggers.score,
      sweep:      activeTriggers.sweep,
      playbook:   activeTriggers.playbook,
    },
  };
}

/** Test wrapper — bypasses RTH check, always runs pipeline */
async function runScanForced(symbol = "NQ=F") {
  return runScan(symbol, { forceRun: true });
}

module.exports = { runScan, runScanForced, isRTH };
