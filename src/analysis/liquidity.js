/**
 * analysis/liquidity.js — Liquidity Sweep Detection Engine
 *
 * A liquidity sweep (stop hunt) occurs when price wicks through a key level
 * to trigger resting stop orders, then reverses. Smart money uses this to
 * accumulate/distribute before making the real move.
 *
 * Levels monitored:
 *   PDH / PDL  — Previous Day High/Low  (strongest — most stops rest here)
 *   ONH / ONL  — Overnight High/Low     (medium — futures-session stops)
 *   ORH / ORL  — Opening Range High/Low (medium — ORB stop clusters)
 *
 * Sweep anatomy:
 *   ┌─────────────────────────────────────────────┐
 *   │  HIGH sweep:  bar.high > level              │
 *   │    REJECTED → bar.close < level  (reversal) │
 *   │    ACCEPTED → bar.close > level  (breakout) │
 *   │                                             │
 *   │  LOW sweep:   bar.low < level               │
 *   │    REJECTED → bar.close > level  (reversal) │
 *   │    ACCEPTED → bar.close < level  (breakdown)│
 *   └─────────────────────────────────────────────┘
 *
 * Output per sweep:
 *   level            — PDH | PDL | ONH | ONL | ORH | ORL
 *   levelPrice       — exact price of the level
 *   type             — HIGH | LOW
 *   result           — REJECTED | ACCEPTED
 *   sweepAmount      — points beyond the level the wick traveled
 *   rejectionStrength— 0.0–1.0 (how strongly price snapped back)
 *   impliedBias      — LONG (sweep+reject low) | SHORT (sweep+reject high)
 *   confirmed        — true | false | null (null = no follow-through bar yet)
 *   barsAgo          — 0 = most recent bar, 1 = one bar back, etc.
 *   barTime          — ET timestamp of the sweep bar
 */

const YahooFinance = require("yahoo-finance2").default;
const yf    = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const logger = require("../utils/logger");
const { getKeyLevels } = require("./levels");

// ── Config ────────────────────────────────────────────────────────

const HIGH_LEVELS = new Set(["PDH", "ONH", "ORH"]);
const LOW_LEVELS  = new Set(["PDL", "ONL", "ORL"]);

const DEFAULT_OPTIONS = {
  symbol:        "NQ=F",
  lookbackBars:  10,        // how many recent 5m bars to scan
  minSweepPts:   1.0,       // minimum wick-through to qualify (NQ points)
  requireClose:  true,      // only count if bar is complete (not forming)
};

// ── Data Fetcher ──────────────────────────────────────────────────

async function fetchRecentBars(symbol, count = 20) {
  const period1 = new Date();
  period1.setHours(period1.getHours() - Math.ceil((count * 5) / 60) - 2); // buffer
  const result = await yf.chart(
    symbol,
    { interval: "5m", period1, includePrePost: true },
    { validateResult: false }
  );
  const bars = (result.quotes || []).filter(q => q.high && q.low && q.close && q.open);
  return bars.slice(-count); // return only the last N bars
}

// ── ET Timestamp Helper ───────────────────────────────────────────

function toETString(date) {
  return date.toLocaleString("en-US", {
    timeZone:  "America/New_York",
    month:     "2-digit",
    day:       "2-digit",
    year:      "numeric",
    hour:      "2-digit",
    minute:    "2-digit",
    hour12:    false,
  });
}

// ── Core Sweep Checker ────────────────────────────────────────────

/**
 * Check a single bar against a single level for a sweep.
 * Returns a sweep object or null if no sweep.
 */
function checkSweep(bar, levelName, levelPrice, minSweepPts, barsAgo, nextBar = null) {
  if (!levelPrice) return null;

  const isHigh = HIGH_LEVELS.has(levelName);
  const isLow  = LOW_LEVELS.has(levelName);

  let sweepDetected = false;
  let sweepAmount   = 0;
  let result        = null;
  let rejectionStr  = 0;
  let impliedBias   = null;

  if (isHigh) {
    // ── HIGH level sweep ─────────────────────────────
    const wickAbove = bar.high - levelPrice;
    if (wickAbove < minSweepPts) return null;

    sweepDetected = true;
    sweepAmount   = +wickAbove.toFixed(2);

    if (bar.close < levelPrice) {
      // Closed back below — REJECTED → SHORT bias
      result       = "REJECTED";
      impliedBias  = "SHORT";
      const snapBack   = levelPrice - bar.close;
      rejectionStr = +Math.min(1, snapBack / sweepAmount).toFixed(2);
    } else {
      // Closed above — ACCEPTED → LONG bias (breakout confirmed)
      result      = "ACCEPTED";
      impliedBias = "LONG";
      const extension = bar.close - levelPrice;
      rejectionStr = 0;
    }
  }

  if (isLow) {
    // ── LOW level sweep ──────────────────────────────
    const wickBelow = levelPrice - bar.low;
    if (wickBelow < minSweepPts) return null;

    sweepDetected = true;
    sweepAmount   = +wickBelow.toFixed(2);

    if (bar.close > levelPrice) {
      // Closed back above — REJECTED → LONG bias
      result      = "REJECTED";
      impliedBias = "LONG";
      const snapBack   = bar.close - levelPrice;
      rejectionStr = +Math.min(1, snapBack / sweepAmount).toFixed(2);
    } else {
      // Closed below — ACCEPTED → SHORT bias (breakdown confirmed)
      result      = "ACCEPTED";
      impliedBias = "SHORT";
      rejectionStr = 0;
    }
  }

  if (!sweepDetected) return null;

  // ── Follow-through confirmation ───────────────────
  let confirmed = null;
  if (nextBar) {
    if (result === "REJECTED") {
      // Rejection confirmed if next bar also closes on the right side
      confirmed = isHigh
        ? nextBar.close < levelPrice
        : nextBar.close > levelPrice;
    } else {
      // Acceptance confirmed if next bar holds above/below the level
      confirmed = isHigh
        ? nextBar.close > levelPrice
        : nextBar.close < levelPrice;
    }
  }

  return {
    sweepDetected: true,
    level:             levelName,
    levelPrice,
    type:              isHigh ? "HIGH" : "LOW",
    result,
    sweepAmount,
    rejectionStrength: rejectionStr,
    impliedBias,
    confirmed,
    barsAgo,
    barTime:           toETString(bar.date),
    bar: {
      open:  bar.open,
      high:  bar.high,
      low:   bar.low,
      close: bar.close,
    },
  };
}

// ── Main Export ───────────────────────────────────────────────────

/**
 * Scan recent bars for liquidity sweeps across all tracked levels.
 * @param {object} options
 * @returns {object} structured sweep detection result
 */
async function detectLiquiditySweeps(options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  logger.info(`[liquidity] Scanning ${opts.lookbackBars} bars for liquidity sweeps on ${opts.symbol}...`);

  // 1. Fetch key levels + recent bars in parallel
  const [keyLevels, bars] = await Promise.all([
    getKeyLevels(opts.symbol),
    fetchRecentBars(opts.symbol, opts.lookbackBars + 2), // +2 for confirmation bars
  ]);

  const levelMap  = keyLevels.levels;   // { PDH, PDL, ONH, ONL, ORH, ORL }
  const totalBars = bars.length;

  // 2. Scan each bar × each level
  const allSweeps = [];

  for (let i = 0; i < totalBars; i++) {
    const bar     = bars[i];
    const nextBar = bars[i + 1] || null;
    const barsAgo = totalBars - 1 - i;

    for (const [levelName, levelPrice] of Object.entries(levelMap)) {
      if (!levelPrice) continue;
      const sweep = checkSweep(bar, levelName, levelPrice, opts.minSweepPts, barsAgo, nextBar);
      if (sweep) allSweeps.push(sweep);
    }
  }

  // 3. Sort: most recent first, then by rejection strength
  allSweeps.sort((a, b) => a.barsAgo - b.barsAgo || b.rejectionStrength - a.rejectionStrength);

  // 4. Summarize
  const rejections   = allSweeps.filter(s => s.result === "REJECTED");
  const acceptances  = allSweeps.filter(s => s.result === "ACCEPTED");
  const mostRecent   = allSweeps[0] || null;
  const activeSignal = rejections.find(s => s.barsAgo <= 2) || null; // fresh rejection = actionable

  logger.info(
    `[liquidity] Scan complete | ${allSweeps.length} sweeps found ` +
    `(${rejections.length} rejected, ${acceptances.length} accepted) ` +
    `| ${opts.lookbackBars} bars scanned`
  );

  return {
    symbol:           opts.symbol,
    currentPrice:     keyLevels.currentPrice,
    calculatedAt:     new Date().toISOString(),
    barsScanned:      totalBars,
    levels:           levelMap,

    // ── Summary ──────────────────────────────────────
    sweepsDetected:   allSweeps.length > 0,
    sweepCount:       allSweeps.length,
    rejectionCount:   rejections.length,
    acceptanceCount:  acceptances.length,

    // ── Actionable ───────────────────────────────────
    activeSignal,        // most recent rejection within 2 bars (highest priority)
    mostRecentSweep: mostRecent,

    // ── Full List ─────────────────────────────────────
    sweeps:      allSweeps,
    rejections,
    acceptances,
  };
}

module.exports = { detectLiquiditySweeps };
