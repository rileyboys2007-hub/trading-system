/**
 * analysis/atr.js — Average True Range (ATR) Calculator
 *
 * Calculates the 14-period ATR from 5-minute bars to produce
 * dynamic, volatility-adjusted stop-loss distances for NQ=F.
 *
 * Why ATR instead of fixed stops?
 *   On a low-volatility day (ATR 8 pts) a 30-pt SL is 2× too wide — costs R.
 *   On a high-volatility day (ATR 18 pts) a 30-pt SL gets hit by noise.
 *   ATR × 2.0 adapts to the actual intraday range each session.
 *
 * Typical NQ 5m ATR ranges:
 *   Quiet day  : 6–10 pts  → SL 12–20 pts
 *   Normal day : 10–15 pts → SL 20–30 pts
 *   Volatile   : 15–22 pts → SL 30–44 pts (capped at 55)
 *
 * Returns:
 *   atr          — raw 14-period ATR in points
 *   suggestedSL  — atr × 2.0, clamped to [14, 55] pts
 *   period       — lookback period used
 *   interval     — bar interval used
 *   barsUsed     — number of bars in the dataset
 *   calculatedAt — ISO timestamp
 */

const YahooFinance = require("yahoo-finance2").default;
const yf    = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const logger = require("../utils/logger");

const ATR_PERIOD     = 14;
const ATR_MULTIPLIER = 2.0;   // SL = ATR × this
const SL_MIN_PTS     = 14;    // Floor — never tighter than 14 pts
const SL_MAX_PTS     = 55;    // Cap — never wider than 55 pts

// ── Core ATR Math ─────────────────────────────────────────────────

/**
 * Calculate ATR from an array of OHLC bars.
 * TR = max(H–L, |H–prevClose|, |L–prevClose|)
 * ATR = mean of last `period` TRs
 *
 * @param {Array}  bars    OHLCV bars (.high .low .close required)
 * @param {number} period  Lookback period (default: 14)
 * @returns {number|null}  ATR in price points, or null if not enough data
 */
function calcATR(bars, period = ATR_PERIOD) {
  if (!bars || bars.length < period + 1) return null;

  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const high      = bars[i].high;
    const low       = bars[i].low;
    const prevClose = bars[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low  - prevClose)
    );
    trs.push(tr);
  }

  // Use the last `period` true ranges
  const recent = trs.slice(-period);
  return recent.reduce((sum, v) => sum + v, 0) / recent.length;
}

// ── Main Export ───────────────────────────────────────────────────

/**
 * Fetch bars and calculate ATR for the given symbol.
 *
 * No date filtering — includes ALL returned bars so prior-day data
 * fills the lookback during pre-market / low-bar situations.
 *
 * @param {string} symbol   Yahoo Finance symbol (default: "NQ=F")
 * @param {number} period   ATR period (default: 14)
 * @param {string} interval Bar interval (default: "5m")
 */
async function getATR(symbol = "NQ=F", period = ATR_PERIOD, interval = "5m") {
  logger.info(`[atr] Calculating ${period}-period ATR (${interval}) for ${symbol}...`);

  const period1 = new Date();
  period1.setDate(period1.getDate() - 2);  // 2 days back → plenty of 5m bars

  let bars;
  try {
    const result = await yf.chart(
      symbol,
      { interval, period1, includePrePost: false },
      { validateResult: false }
    );
    // Include any bar that has valid OHLC — no date filter needed
    bars = (result.quotes || []).filter(q => q.high && q.low && q.close);
  } catch (err) {
    logger.warn(`[atr] Yahoo Finance fetch failed: ${err.message}`);
    return null;
  }

  if (!bars || bars.length < period + 1) {
    logger.warn(`[atr] Insufficient bars (${bars?.length ?? 0}) for ${period}-period ATR`);
    return null;
  }

  const atr = calcATR(bars, period);
  if (!atr) return null;

  // Volatility-adjusted SL, clamped to safe NQ range
  const suggestedSL = Math.max(SL_MIN_PTS, Math.min(SL_MAX_PTS, Math.round(atr * ATR_MULTIPLIER)));

  logger.info(
    `[atr] ${symbol} | 14-period ATR: ${atr.toFixed(2)} pts | ` +
    `Suggested SL: ${suggestedSL} pts (${ATR_MULTIPLIER}× ATR)`
  );

  return {
    atr:          +atr.toFixed(2),
    suggestedSL,
    multiplier:   ATR_MULTIPLIER,
    period,
    interval,
    barsUsed:     bars.length,
    calculatedAt: new Date().toISOString(),
  };
}

module.exports = { getATR, calcATR };
