/**
 * analysis/playbooks.js — Playbook Detection Engine
 *
 * Scans recent price action against 8 predefined setups.
 * Each playbook scores a set of weighted conditions → confidence %.
 * A playbook is "matched" when required conditions pass AND
 * total weighted score meets the minimum threshold.
 *
 * Playbooks:
 *   1. Bullish Opening Range Breakout     (ORB Long)
 *   2. Bearish Opening Range Breakdown    (ORB Short)
 *   3. PDL Sweep Reversal                 (Long)
 *   4. PDH Sweep Reversal                 (Short)
 *   5. ONH Breakout Continuation          (Long)
 *   6. ONL Breakdown Continuation         (Short)
 *   7. Bullish Trend Pullback             (Long)
 *   8. Bearish Trend Pullback             (Short)
 */

const YahooFinance = require("yahoo-finance2").default;
const yf    = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const logger = require("../utils/logger");
const { getKeyLevels } = require("./levels");

const MATCH_THRESHOLD = 55;    // 55% of weighted score to count as "matched" (integer avoids float precision bugs)
const BARS_NEEDED     = 30;    // 5m bars for trend context (~2.5 hours)

// ── Data Fetcher ──────────────────────────────────────────────────

async function fetchBars(symbol, count = BARS_NEEDED) {
  const period1 = new Date();
  period1.setHours(period1.getHours() - Math.ceil((count * 5) / 60) - 2);
  const result = await yf.chart(
    symbol,
    { interval: "5m", period1, includePrePost: true },
    { validateResult: false }
  );
  return (result.quotes || [])
    .filter(q => q.high && q.low && q.close && q.open)
    .slice(-count);
}

// ── Shared Helpers ────────────────────────────────────────────────

/** Score a condition list. Returns { confidence, metCount, totalWeight, conditions }. */
function scoreConditions(conditions) {
  let metWeight   = 0;
  let totalWeight = 0;
  let metCount    = 0;

  for (const c of conditions) {
    totalWeight += c.weight;
    if (c.met) {
      metWeight += c.weight;
      metCount++;
    }
  }

  const confidence = totalWeight > 0
    ? Math.round((metWeight / totalWeight) * 100)
    : 0;

  return { confidence, metWeight, totalWeight, metCount, conditions };
}

/** Compute average close for a slice of bars. */
function avgClose(bars) {
  if (!bars.length) return 0;
  return bars.reduce((s, b) => s + b.close, 0) / bars.length;
}

/**
 * Detect trend direction from the last N bars.
 * Splits into two halves and compares average closes.
 */
function detectTrend(bars, lookback = 16) {
  const slice = bars.slice(-lookback);
  if (slice.length < 6) return { trend: "NEUTRAL", strength: 0 };

  const half = Math.floor(slice.length / 2);
  const first = avgClose(slice.slice(0, half));
  const last  = avgClose(slice.slice(half));
  const diff  = last - first;

  const rangeHigh = Math.max(...slice.map(b => b.high));
  const rangeLow  = Math.min(...slice.map(b => b.low));
  const range     = rangeHigh - rangeLow;

  const strength  = range > 0 ? Math.min(1, Math.abs(diff) / range) : 0;

  return {
    trend:      diff > 5 ? "BULLISH" : diff < -5 ? "BEARISH" : "NEUTRAL",
    strength:   +strength.toFixed(2),
    first,
    last,
    diff:       +diff.toFixed(2),
    rangeHigh,
    rangeLow,
  };
}

/** Check if price is near a level (within tolerance points). */
function nearLevel(price, level, tol = 15) {
  return level && Math.abs(price - level) <= tol;
}

// ── Individual Playbook Detectors ─────────────────────────────────

/**
 * 1. Bullish Opening Range Breakout
 * Price closes above ORH with bullish momentum + volume confirmation.
 */
function detectBullishORB(bars, levels) {
  if (!levels.ORH) return notMatched("ORH not formed yet");

  const cur  = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const prev2 = bars[bars.length - 3];
  if (!cur || !prev) return notMatched("Insufficient bars");

  const volumeRatio = cur.volume && levels._avgVolume
    ? cur.volume / levels._avgVolume
    : null;

  const conditions = [
    { name: "Close above ORH",          weight: 40, met: cur.close > levels.ORH },
    { name: "Bullish close (C > O)",     weight: 20, met: cur.close > cur.open },
    { name: "Clean break (>5 pts)",      weight: 15, met: cur.close > levels.ORH + 5 },
    { name: "Previous bars inside OR",   weight: 15, met: prev && prev2 && prev.close <= levels.ORH && prev2.close <= levels.ORH },
    { name: "Above-average volume",      weight: 10, met: volumeRatio ? volumeRatio >= 1.0 : false },
  ];

  return buildResult(1, "Bullish Opening Range Breakout", "LONG", conditions);
}

/**
 * 2. Bearish Opening Range Breakdown
 * Price closes below ORL with bearish momentum + volume confirmation.
 */
function detectBearishORB(bars, levels) {
  if (!levels.ORL) return notMatched("ORL not formed yet");

  const cur  = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const prev2 = bars[bars.length - 3];
  if (!cur || !prev) return notMatched("Insufficient bars");

  const volumeRatio = cur.volume && levels._avgVolume
    ? cur.volume / levels._avgVolume
    : null;

  const conditions = [
    { name: "Close below ORL",           weight: 40, met: cur.close < levels.ORL },
    { name: "Bearish close (C < O)",     weight: 20, met: cur.close < cur.open },
    { name: "Clean break (>5 pts)",      weight: 15, met: cur.close < levels.ORL - 5 },
    { name: "Previous bars inside OR",   weight: 15, met: prev && prev2 && prev.close >= levels.ORL && prev2.close >= levels.ORL },
    { name: "Above-average volume",      weight: 10, met: volumeRatio ? volumeRatio >= 1.0 : false },
  ];

  return buildResult(2, "Bearish Opening Range Breakdown", "SHORT", conditions);
}

/**
 * 3. PDL Sweep Reversal (Long)
 * A recent bar swept below PDL and was rejected — price snapped back above.
 */
function detectPDLSweepReversal(bars, levels) {
  if (!levels.PDL) return notMatched("PDL unavailable");

  // Look in last 3 bars for the sweep bar
  const recent = bars.slice(-3);
  const sweepBar = recent.find(b => b.low < levels.PDL);
  if (!sweepBar) return notMatched("No PDL sweep in last 3 bars");

  const cur          = bars[bars.length - 1];
  const sweepAmt     = levels.PDL - sweepBar.low;
  const snapBack     = sweepBar.close - levels.PDL;
  const rejStrength  = sweepAmt > 0 ? Math.min(1, snapBack / sweepAmt) : 0;

  const conditions = [
    { name: "Bar swept below PDL",        weight: 35, met: sweepBar.low < levels.PDL },
    { name: "Bar closed back above PDL",  weight: 35, met: sweepBar.close > levels.PDL },
    { name: "Current close above PDL",    weight: 15, met: cur.close > levels.PDL },
    { name: "Rejection strength > 0.3",   weight: 15, met: rejStrength > 0.3 },
  ];

  return buildResult(3, "PDL Sweep Reversal", "LONG", conditions, {
    sweepAmount:       +sweepAmt.toFixed(2),
    rejectionStrength: +rejStrength.toFixed(2),
    levelSwept:        "PDL",
    levelPrice:        levels.PDL,
  });
}

/**
 * 4. PDH Sweep Reversal (Short)
 * A recent bar swept above PDH and was rejected — price snapped back below.
 */
function detectPDHSweepReversal(bars, levels) {
  if (!levels.PDH) return notMatched("PDH unavailable");

  const recent   = bars.slice(-3);
  const sweepBar = recent.find(b => b.high > levels.PDH);
  if (!sweepBar) return notMatched("No PDH sweep in last 3 bars");

  const cur         = bars[bars.length - 1];
  const sweepAmt    = sweepBar.high - levels.PDH;
  const snapBack    = levels.PDH - sweepBar.close;
  const rejStrength = sweepAmt > 0 ? Math.min(1, snapBack / sweepAmt) : 0;

  const conditions = [
    { name: "Bar swept above PDH",        weight: 35, met: sweepBar.high > levels.PDH },
    { name: "Bar closed back below PDH",  weight: 35, met: sweepBar.close < levels.PDH },
    { name: "Current close below PDH",    weight: 15, met: cur.close < levels.PDH },
    { name: "Rejection strength > 0.3",   weight: 15, met: rejStrength > 0.3 },
  ];

  return buildResult(4, "PDH Sweep Reversal", "SHORT", conditions, {
    sweepAmount:       +sweepAmt.toFixed(2),
    rejectionStrength: +rejStrength.toFixed(2),
    levelSwept:        "PDH",
    levelPrice:        levels.PDH,
  });
}

/**
 * 5. ONH Breakout Continuation (Long)
 * Price breaks above ONH and holds — multiple closes confirm the breakout.
 */
function detectONHBreakout(bars, levels) {
  if (!levels.ONH) return notMatched("ONH unavailable");

  const cur  = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const prev2 = bars[bars.length - 3];
  if (!cur || !prev) return notMatched("Insufficient bars");

  const conditions = [
    { name: "Current close above ONH",    weight: 30, met: cur.close > levels.ONH },
    { name: "Close above PDH too",        weight: 25, met: levels.PDH && cur.close > levels.PDH },
    { name: "Previous bar above ONH",     weight: 25, met: prev.close > levels.ONH },
    { name: "Bullish bar (C > O)",        weight: 20, met: cur.close > cur.open },
  ];

  return buildResult(5, "ONH Breakout Continuation", "LONG", conditions);
}

/**
 * 6. ONL Breakdown Continuation (Short)
 * Price breaks below ONL and holds — multiple closes confirm the breakdown.
 */
function detectONLBreakdown(bars, levels) {
  if (!levels.ONL) return notMatched("ONL unavailable");

  const cur  = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (!cur || !prev) return notMatched("Insufficient bars");

  const conditions = [
    { name: "Current close below ONL",    weight: 30, met: cur.close < levels.ONL },
    { name: "Close below PDL too",        weight: 25, met: levels.PDL && cur.close < levels.PDL },
    { name: "Previous bar below ONL",     weight: 25, met: prev.close < levels.ONL },
    { name: "Bearish bar (C < O)",        weight: 20, met: cur.close < cur.open },
  ];

  return buildResult(6, "ONL Breakdown Continuation", "SHORT", conditions);
}

/**
 * 7. Bullish Trend Pullback (Long)
 * Price has been trending up, pulled back shallowly, now showing reversal.
 */
function detectBullishPullback(bars, levels) {
  if (bars.length < 12) return notMatched("Insufficient bars for trend detection");

  const trendData = detectTrend(bars, 16);
  if (trendData.trend !== "BULLISH") return notMatched(`Trend is ${trendData.trend}, not BULLISH`);

  const cur    = bars[bars.length - 1];
  const recent = bars.slice(-6);
  const recentHigh = Math.max(...recent.map(b => b.high));
  const recentLow  = Math.min(...recent.map(b => b.low));
  const recentRange = recentHigh - recentLow;

  const pulledBack  = cur.close < recentHigh - 10;
  const notTooDeeep = recentRange > 0
    ? (recentHigh - cur.close) / recentRange < 0.6
    : false;

  const atSupportLevel = [levels.ONL, levels.ORL, levels.PDC].some(
    l => l && nearLevel(cur.low, l, 15)
  );

  const conditions = [
    { name: "Uptrend confirmed (16 bars)", weight: 30, met: trendData.trend === "BULLISH" },
    { name: "Price pulled back from high", weight: 25, met: pulledBack },
    { name: "Bullish reversal bar (C > O)",weight: 25, met: cur.close > cur.open },
    { name: "Pullback < 60% of range",     weight: 10, met: notTooDeeep },
    { name: "Near support level",          weight: 10, met: atSupportLevel },
  ];

  return buildResult(7, "Bullish Trend Pullback", "LONG", conditions, {
    trendStrength: trendData.strength,
    recentHigh,
  });
}

/**
 * 8. Bearish Trend Pullback (Short)
 * Price has been trending down, pulled back shallowly, now showing continuation.
 */
function detectBearishPullback(bars, levels) {
  if (bars.length < 12) return notMatched("Insufficient bars for trend detection");

  const trendData = detectTrend(bars, 16);
  if (trendData.trend !== "BEARISH") return notMatched(`Trend is ${trendData.trend}, not BEARISH`);

  const cur    = bars[bars.length - 1];
  const recent = bars.slice(-6);
  const recentHigh = Math.max(...recent.map(b => b.high));
  const recentLow  = Math.min(...recent.map(b => b.low));
  const recentRange = recentHigh - recentLow;

  const pulledBack  = cur.close > recentLow + 10;
  const notTooDeeep = recentRange > 0
    ? (cur.close - recentLow) / recentRange < 0.6
    : false;

  const atResistanceLevel = [levels.ONH, levels.ORH, levels.PDC].some(
    l => l && nearLevel(cur.high, l, 15)
  );

  const conditions = [
    { name: "Downtrend confirmed (16 bars)",weight: 30, met: trendData.trend === "BEARISH" },
    { name: "Price pulled back from low",   weight: 25, met: pulledBack },
    { name: "Bearish reversal bar (C < O)", weight: 25, met: cur.close < cur.open },
    { name: "Pullback < 60% of range",      weight: 10, met: notTooDeeep },
    { name: "Near resistance level",        weight: 10, met: atResistanceLevel },
  ];

  return buildResult(8, "Bearish Trend Pullback", "SHORT", conditions, {
    trendStrength: trendData.strength,
    recentLow,
  });
}

// ── Result Builders ───────────────────────────────────────────────

function notMatched(reason) {
  return { matched: false, confidence: 0, reason, conditions: [] };
}

function buildResult(id, name, direction, conditions, extras = {}) {
  const scored  = scoreConditions(conditions);
  const matched = scored.confidence >= MATCH_THRESHOLD;

  return {
    id,
    name,
    direction,
    matched,
    confidence: scored.confidence,
    metCount:   scored.metCount,
    totalConds: conditions.length,
    conditions: scored.conditions,
    ...extras,
  };
}

// ── Main Export ───────────────────────────────────────────────────

const DETECTORS = [
  { fn: detectBullishORB,        id: 1, name: "Bullish Opening Range Breakout",  direction: "LONG"  },
  { fn: detectBearishORB,        id: 2, name: "Bearish Opening Range Breakdown", direction: "SHORT" },
  { fn: detectPDLSweepReversal,  id: 3, name: "PDL Sweep Reversal",              direction: "LONG"  },
  { fn: detectPDHSweepReversal,  id: 4, name: "PDH Sweep Reversal",              direction: "SHORT" },
  { fn: detectONHBreakout,       id: 5, name: "ONH Breakout Continuation",       direction: "LONG"  },
  { fn: detectONLBreakdown,      id: 6, name: "ONL Breakdown Continuation",      direction: "SHORT" },
  { fn: detectBullishPullback,   id: 7, name: "Bullish Trend Pullback",          direction: "LONG"  },
  { fn: detectBearishPullback,   id: 8, name: "Bearish Trend Pullback",          direction: "SHORT" },
];

async function detectPlaybooks(symbol = "NQ=F") {
  logger.info(`[playbooks] Running playbook detection for ${symbol}...`);

  const [keyLevels, bars] = await Promise.all([
    getKeyLevels(symbol),
    fetchBars(symbol, BARS_NEEDED),
  ]);

  if (!bars.length) {
    logger.warn("[playbooks] No bars available");
    return { symbol, matched: false, playbooks: [] };
  }

  // Inject avg volume for ORB volume check
  const levelsWithVol = {
    ...keyLevels.levels,
    _avgVolume: bars.reduce((s, b) => s + (b.volume || 0), 0) / bars.length || null,
  };

  const cur = bars[bars.length - 1];

  // Run all detectors — always inject id, name, direction so unmatched results are complete
  const results = DETECTORS.map(({ fn, id, name, direction }) => {
    let r;
    try { r = fn(bars, levelsWithVol); }
    catch (e) { r = notMatched(`Error: ${e.message}`); }
    // Ensure id/name/direction always present
    return { id, name, direction, ...r };
  });

  const matched    = results.filter(r => r.matched);
  const unmatched  = results.filter(r => !r.matched);
  const primary    = matched.sort((a, b) => b.confidence - a.confidence)[0] || null;

  logger.info(
    `[playbooks] ${matched.length} playbook(s) matched | ` +
    (primary ? `Primary: "${primary.name}" (${primary.confidence}%)` : "No match")
  );

  return {
    symbol,
    currentPrice:     keyLevels.currentPrice,
    calculatedAt:     new Date().toISOString(),
    levels:           keyLevels.levels,
    barsAnalyzed:     bars.length,

    hasMatch:         matched.length > 0,
    matchCount:       matched.length,
    primaryMatch:     primary,

    matchedPlaybooks: matched.sort((a, b) => b.confidence - a.confidence),
    allPlaybooks:     results,
  };
}

module.exports = { detectPlaybooks };
