/**
 * analysis/trendAlignment.js — Multi-Timeframe Trend Alignment
 *
 * Detects the dominant trend on 1H and 15m timeframes using two signals per TF:
 *   1. Price vs EMA  — is the close above or below its exponential moving average?
 *   2. Slope check   — is the close higher or lower than 4 bars ago (noise-filtered)?
 *
 * When both signals agree → strong trend call.
 * When only one agrees → EMA takes precedence.
 * When neither → NEUTRAL.
 *
 * EMA periods:
 *   1H  — 20-period (≈ 20 trading hours ≈ 3 days — medium-term trend)
 *   15m — 9-period  (≈ 2.25 trading hours — short-term momentum)
 *
 * Returns:
 *   trend1H      — "BULLISH" | "BEARISH" | "NEUTRAL"
 *   trend15m     — "BULLISH" | "BEARISH" | "NEUTRAL"
 *   aligned      — true if both timeframes agree on the same direction
 *   alignedWith  — "LONG" | "SHORT" | null
 *   consensus    — dominant direction (1H takes priority over 15m)
 *   strength     — 0–100 (how strongly aligned both TFs are)
 *   summary      — human-readable one-liner
 *   calculatedAt — ISO timestamp
 *
 * Integration:
 *   – Added as a 9th scoring factor in scoring.js (weight 10%)
 *   – Direction filter in scanner.js warns when trading against HTF trend
 *   – Displayed in every Discord alert as the "Trend" field
 */

const YahooFinance = require("yahoo-finance2").default;
const yf    = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const logger = require("../utils/logger");

// ── EMA Calculator ────────────────────────────────────────────────

/**
 * Exponential Moving Average.
 * Seeds from SMA of first `period` bars, then applies EMA from there.
 *
 * @param {number[]} closes  Array of closing prices (oldest first)
 * @param {number}   period  EMA period
 * @returns {number|null}    Final EMA value, or null if not enough data
 */
function calcEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period; // SMA seed
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// ── Single-TF Trend Detector ──────────────────────────────────────

/**
 * Detect trend direction for one timeframe.
 *
 * Uses two independent signals:
 *   – EMA position:  close > EMA → bullish, close < EMA → bearish
 *   – Slope:         close > close[n-5] * 1.001 → rising (0.1% buffer to filter noise)
 *
 * When both agree → BULLISH or BEARISH.
 * When only EMA gives a signal → use EMA (more reliable than raw slope).
 * When EMA is within noise range → NEUTRAL.
 *
 * @param {Array}  bars       OHLCV bar objects (.close required)
 * @param {number} emaPeriod  EMA period to use
 * @returns {"BULLISH"|"BEARISH"|"NEUTRAL"}
 */
function detectTrend(bars, emaPeriod) {
  if (!bars || bars.length < emaPeriod + 3) return "NEUTRAL";

  const closes   = bars.map(b => b.close);
  const ema      = calcEMA(closes, emaPeriod);
  if (!ema) return "NEUTRAL";

  const lastClose = closes[closes.length - 1];

  // ── Signal 1: Price vs EMA ────────────────────────────────────
  const aboveEma   = lastClose > ema;
  const emaDiffPct = Math.abs(lastClose - ema) / ema * 100;

  // ── Signal 2: Slope (compare last close to 4 bars ago) ───────
  const compareClose = closes[closes.length - 5] ?? closes[0];
  const bullSlope    = lastClose > compareClose * 1.001;  // 0.1% filter
  const bearSlope    = lastClose < compareClose * 0.999;

  // ── Combine ───────────────────────────────────────────────────
  const bullPoints = (aboveEma ? 1 : 0) + (bullSlope ? 1 : 0);
  const bearPoints = (!aboveEma ? 1 : 0) + (bearSlope ? 1 : 0);

  if (bullPoints === 2) return "BULLISH";
  if (bearPoints === 2) return "BEARISH";

  // One signal each — EMA takes precedence when it's meaningful
  if (emaDiffPct > 0.15) return aboveEma ? "BULLISH" : "BEARISH";

  return "NEUTRAL";
}

// ── Bar Fetcher ───────────────────────────────────────────────────

async function fetchBars(symbol, interval, daysBack) {
  const period1 = new Date();
  period1.setDate(period1.getDate() - daysBack);

  const result = await yf.chart(
    symbol,
    { interval, period1, includePrePost: false },
    { validateResult: false }
  );

  return (result.quotes || []).filter(q => q.high && q.low && q.close && q.volume > 0);
}

// ── Main Export ───────────────────────────────────────────────────

/**
 * Get multi-timeframe trend alignment for a symbol.
 * Fetches 1H and 15m bars in parallel from Yahoo Finance.
 *
 * @param {string} symbol  Yahoo Finance symbol (default: "NQ=F")
 * @returns {object|null}  Trend result, or null if data unavailable
 */
async function getTrendAlignment(symbol = "NQ=F") {
  logger.info(`[trendAlignment] Analyzing 1H + 15m trend for ${symbol}...`);

  let bars1H, bars15m, bars5m;
  try {
    [bars1H, bars15m, bars5m] = await Promise.all([
      fetchBars(symbol, "1h",  7),   // 7 days → ~35+ 1H RTH bars
      fetchBars(symbol, "15m", 3),   // 3 days → ~78+ 15m RTH bars
      fetchBars(symbol, "5m",  2),   // 2 days → ~156+ 5m RTH bars
    ]);
  } catch (err) {
    logger.warn(`[trendAlignment] Fetch failed: ${err.message}`);
    return null;
  }

  // Need at least emaPeriod + 3 bars for a meaningful read
  if (!bars1H || bars1H.length < 23) {
    logger.warn(`[trendAlignment] Insufficient 1H bars (${bars1H?.length ?? 0}) — need 23+`);
    return null;
  }
  if (!bars15m || bars15m.length < 12) {
    logger.warn(`[trendAlignment] Insufficient 15m bars (${bars15m?.length ?? 0}) — need 12+`);
    return null;
  }

  const trend1H  = detectTrend(bars1H,  20);   // 20-period EMA on 1H
  const trend15m = detectTrend(bars15m,  9);   // 9-period EMA on 15m
  // 5m bars may be unavailable (e.g. market closed, Yahoo delay); graceful fallback
  const trend5m  = (bars5m && bars5m.length >= 12)
    ? detectTrend(bars5m, 9)   // 9-period EMA on 5m
    : null;

  const aligned    = trend1H === trend15m && trend1H !== "NEUTRAL";
  const alignedWith = aligned
    ? (trend1H === "BULLISH" ? "LONG" : "SHORT")
    : null;

  // 1H takes priority for consensus; fall back to 15m if 1H is neutral
  const consensus = trend1H !== "NEUTRAL" ? trend1H : trend15m;

  // Strength reflects how strongly all available timeframes agree
  const tfs    = [trend1H, trend15m, trend5m].filter(Boolean);
  const unique = new Set(tfs.filter(t => t !== "NEUTRAL"));
  let strength;
  if (unique.size === 1 && tfs.filter(t => t !== "NEUTRAL").length === tfs.length) strength = 90;
  else if (aligned)                       strength = 85;
  else if (trend1H !== "NEUTRAL")         strength = 60;
  else if (trend15m !== "NEUTRAL")        strength = 40;
  else                                    strength = 25;

  // Human-readable
  const trendIcon = (t) => t === "BULLISH" ? "▲" : t === "BEARISH" ? "▼" : "—";
  const summary = aligned
    ? `All timeframes ${trend1H.toLowerCase()} ${trendIcon(trend1H)}`
    : [
        `1H: ${trend1H} ${trendIcon(trend1H)}`,
        `15m: ${trend15m} ${trendIcon(trend15m)}`,
        trend5m ? `5m: ${trend5m} ${trendIcon(trend5m)}` : null,
      ].filter(Boolean).join(" | ");

  logger.info(
    `[trendAlignment] ${symbol} | 1H: ${trend1H} | 15m: ${trend15m} | ` +
    (trend5m ? `5m: ${trend5m} | ` : "") +
    `Aligned: ${aligned} | Favors: ${alignedWith ?? "neither"} | Strength: ${strength}`
  );

  return {
    trend1H,
    trend15m,
    trend5m,
    aligned,
    alignedWith,
    consensus,
    strength,
    bars1H:       bars1H.length,
    bars15m:      bars15m.length,
    bars5m:       bars5m?.length ?? 0,
    source:       "YahooFinance",
    summary,
    calculatedAt: new Date().toISOString(),
  };
}

module.exports = { getTrendAlignment };
