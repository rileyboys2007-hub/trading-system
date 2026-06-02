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
 *   SL: swept level price (if sweep triggered)
 *       else ATR-based dynamic stop (14-period 5m ATR × 2.0, clamped 14–55 pts)
 *       else fixed fallback 30 pts
 *   TP1: entry + (entry - SL) × 1.5
 *   TP2: entry + (entry - SL) × 3.0
 *
 * ── Multi-Timeframe Trend ─────────────────────────────────────────
 *   getTrendAlignment() checks 1H (20 EMA) + 15m (9 EMA) trends.
 *   Trend alignment is scored as a 9th factor (10% weight) in scoring.js.
 *   Displayed as a field in every Discord alert.
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
const { getATR }                = require("./atr");
const { getTrendAlignment }     = require("./trendAlignment");
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

  // Find the best matched playbook for this specific direction (detectPlaybooks returns all)
  const bestMatch = (playbookResult?.matchedPlaybooks ?? [])
    .filter(p => p.direction === direction)
    .sort((a, b) => b.confidence - a.confidence)[0] ?? null;
  const playbookHit = bestMatch !== null;

  const score = (sweepActive ? 2 : 0) + (playbookHit ? 1 : 0);
  return { score, sweep: sweepActive ? sweep : null, playbook: bestMatch };
}

/**
 * Build a synthetic signal for the scanner (no TradingView input).
 * SL priority: 1) swept level  2) ATR-based dynamic  3) fixed 30-pt fallback
 *
 * @param {string} symbol
 * @param {string} direction
 * @param {number} currentPrice
 * @param {string|null} sweepLevel       name of swept level (e.g. "PDH")
 * @param {number|null} sweepLevelPrice  price of swept level
 * @param {number|null} atr             14-period 5m ATR (from getATR)
 */
function buildSignal(symbol, direction, currentPrice, sweepLevel, sweepLevelPrice, atr = null) {
  const isLong = direction === "LONG";

  let sl;
  let slNote;

  if (sweepLevelPrice != null) {
    // Best case: anchor SL to the swept structural level
    sl     = sweepLevelPrice;
    slNote = `SL at swept level (${sweepLevel}) — adjust for your chart`;
  } else if (atr != null) {
    // ATR-based dynamic SL: 2× ATR clamped to [14, 55] pts
    const atrSL = Math.max(14, Math.min(55, Math.round(atr * 2.0)));
    sl     = isLong ? currentPrice - atrSL : currentPrice + atrSL;
    slNote = `SL dynamic (ATR ${atr} pts × 2.0 = ${atrSL} pts) — adjust before entry`;
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

  // ── Step 1: Collect trigger + context data in parallel ──────
  const [
    levels,
    longSweep,
    shortSweep,
    playbookResult,
    vwapData,
    atrData,
    trendData,
  ] = await Promise.all([
    safe("levels",    () => getKeyLevels(symbol)),
    safe("sweep:LONG",  () => detectLiquiditySweeps({ direction: "LONG",  symbol })),
    safe("sweep:SHORT", () => detectLiquiditySweeps({ direction: "SHORT", symbol })),
    safe("playbooks", () => detectPlaybooks(symbol)),
    safe("vwap",      () => calculateVWAP(symbol)),
    safe("atr",       () => getATR(symbol)),
    safe("trend",     () => getTrendAlignment(symbol)),
  ]);

  if (!levels) {
    return { triggered: false, reason: "Could not fetch key levels" };
  }

  const currentPrice = levels.currentPrice;
  const priceSource  = levels.priceSource ?? "unknown";

  logger.info(
    `[scanner] Entry price: ${currentPrice} (${priceSource}) | ` +
    `ATR: ${atrData?.atr ?? "N/A"} pts | Trend: 1H ${trendData?.trend1H ?? "?"} / 15m ${trendData?.trend15m ?? "?"}`
  );

  // ── Step 2: Score each direction ─────────────────────────────
  const longTriggers  = scoreDirection(longSweep,  playbookResult, "LONG");
  const shortTriggers = scoreDirection(shortSweep, playbookResult, "SHORT");

  logger.info(
    `[scanner] Triggers — LONG: ${longTriggers.score} | SHORT: ${shortTriggers.score} | Price: ${currentPrice} (${priceSource})`
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

  // Determine direction using a composite rank:
  //   sweep aligned = 200 pts (dominant)  |  playbook confidence = tiebreaker (0–100)
  const longRank  = (longTriggers.score  >= 2 ? 200 : 0) + (longTriggers.playbook?.confidence  ?? 0);
  const shortRank = (shortTriggers.score >= 2 ? 200 : 0) + (shortTriggers.playbook?.confidence ?? 0);

  let direction, activeTriggers;

  if (longRank === 0 && shortRank === 0) {
    return { triggered: false, reason: "No setup triggers — no sweep or aligned playbook detected" };
  } else if (longRank === shortRank) {
    // Tie-break using VWAP: price above VWAP → LONG, below → SHORT
    if (vwapData && vwapData.position !== "AT") {
      if (vwapData.aboveVWAP) {
        logger.info(`[scanner] Playbook tie — VWAP above (${vwapData.distancePts} pts) favors LONG`);
        direction      = "LONG";
        activeTriggers = longTriggers;
      } else {
        logger.info(`[scanner] Playbook tie — VWAP below (${vwapData.distancePts} pts) favors SHORT`);
        direction      = "SHORT";
        activeTriggers = shortTriggers;
      }
    } else {
      return {
        triggered: false,
        reason: "Ambiguous signals — LONG and SHORT equally matched, VWAP at midpoint — no direction edge",
        longScore: longTriggers.score, shortScore: shortTriggers.score,
      };
    }
  } else if (longRank > shortRank) {
    direction       = "LONG";
    activeTriggers  = longTriggers;
  } else {
    direction       = "SHORT";
    activeTriggers  = shortTriggers;
  }

  // ── Step 3: Build synthetic signal ───────────────────────────
  const sweepLevel      = activeTriggers.sweep?.level ?? null;
  const sweepLevelPrice = activeTriggers.sweep?.levelPrice ?? null;

  const signal = buildSignal(symbol, direction, currentPrice, sweepLevel, sweepLevelPrice, atrData?.atr ?? null);

  // Attach setup name from playbook if matched
  if (activeTriggers.playbook?.name) {
    signal.setup = activeTriggers.playbook.name;
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
    sweep:    direction === "LONG" ? longSweep : shortSweep,  // full result, not raw signal
    playbook: playbookResult,   // full result for direction-aware scoring
    vwap:     vwapData,
    newsRisk: newsCheck,
    trend:    trendData,        // pre-fetched 1H + 15m trend alignment
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
    activeTriggers.playbook ? `Playbook: ${activeTriggers.playbook.name} (${activeTriggers.playbook.confidence}%)` : null,
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
    trend:         trendData,   // 1H + 15m trend alignment
    atr:           atrData,     // ATR data used for SL sizing
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
