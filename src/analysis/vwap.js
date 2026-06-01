/**
 * analysis/vwap.js — VWAP Calculator
 *
 * Calculates the Volume-Weighted Average Price from today's RTH session
 * (9:30 AM ET onwards). VWAP resets every session.
 *
 * Returns:
 *   vwap          — current VWAP price
 *   currentPrice  — latest bar close
 *   aboveVWAP     — is price above VWAP?
 *   distance      — pts above (+) or below (-) VWAP
 *   distancePts   — absolute distance
 *   slopeDir      — "RISING" | "FALLING" | "FLAT"
 *   position      — "FAR_ABOVE" | "ABOVE" | "AT" | "BELOW" | "FAR_BELOW"
 *   barsCount     — how many RTH bars used (data quality indicator)
 */

const YahooFinance = require("yahoo-finance2").default;
const yf    = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const logger = require("../utils/logger");

const RTH_START_MINS = 570;   // 9:30 AM ET
const AT_VWAP_BUFFER = 8;     // ±8 pts = "at VWAP"
const FAR_THRESHOLD  = 50;    // 50+ pts = "far" from VWAP

// ── Timezone helpers (mirrors levels.js) ─────────────────────────

function toET(date) {
  const str = date.toLocaleString("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const [datePart, timePart] = str.split(", ");
  const [month, day, year]   = datePart.split("/").map(Number);
  const [hours, minutes]     = timePart.split(":").map(Number);
  return { year, month, day, hours, minutes, totalMinutes: hours * 60 + minutes };
}

function todayET() {
  const str = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const [month, day, year] = str.split("/").map(Number);
  return { year, month, day };
}

function sameDay(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

// ── VWAP Calc ─────────────────────────────────────────────────────

/**
 * Calculate VWAP from an array of bars.
 * @param {Array} bars — each must have high, low, close, volume
 */
function calcVWAP(bars) {
  let cumTPV = 0;
  let cumVol = 0;
  for (const bar of bars) {
    const vol = bar.volume || 0;
    if (vol === 0) continue;
    const tp = (bar.high + bar.low + bar.close) / 3;
    cumTPV += tp * vol;
    cumVol += vol;
  }
  return cumVol > 0 ? cumTPV / cumVol : null;
}

/**
 * Calculate VWAP for today's RTH session.
 * @param {string} symbol — Yahoo Finance symbol (default: "NQ=F")
 */
async function calculateVWAP(symbol = "NQ=F") {
  logger.info(`[vwap] Calculating session VWAP for ${symbol}...`);

  const period1 = new Date();
  period1.setDate(period1.getDate() - 2); // go back 2 days to ensure we catch today

  let quotes;
  try {
    const result = await yf.chart(
      symbol,
      { interval: "5m", period1, includePrePost: false },
      { validateResult: false }
    );
    quotes = (result.quotes || []).filter(q => q.high && q.low && q.close);
  } catch (err) {
    logger.warn(`[vwap] Yahoo Finance fetch failed: ${err.message}`);
    return null;
  }

  const today = todayET();

  // Filter to today's RTH session only
  const rthBars = quotes.filter(q => {
    const et = toET(q.date ?? new Date(q.time * 1000));
    return sameDay(et, today) && et.totalMinutes >= RTH_START_MINS;
  });

  if (rthBars.length < 2) {
    logger.info(`[vwap] Not enough RTH bars (${rthBars.length}) — market likely closed or pre-open`);
    return null;
  }

  const vwap = calcVWAP(rthBars);
  if (!vwap) {
    logger.warn("[vwap] Could not calculate VWAP — zero volume");
    return null;
  }

  const currentPrice = rthBars[rthBars.length - 1].close;
  const distance     = currentPrice - vwap;
  const distancePts  = Math.abs(distance);

  // VWAP slope: compare full VWAP to VWAP from 3 bars ago
  let slopeDir = "FLAT";
  if (rthBars.length >= 5) {
    const prevBars  = rthBars.slice(0, -3);
    const prevVWAP  = calcVWAP(prevBars);
    if (prevVWAP) {
      const slope = vwap - prevVWAP;
      slopeDir = slope >  0.75 ? "RISING"
               : slope < -0.75 ? "FALLING"
               : "FLAT";
    }
  }

  // Position relative to VWAP
  let position;
  if (distancePts <= AT_VWAP_BUFFER) position = "AT";
  else if (distance > 0) position = distancePts >= FAR_THRESHOLD ? "FAR_ABOVE" : "ABOVE";
  else position = distancePts >= FAR_THRESHOLD ? "FAR_BELOW" : "BELOW";

  const result = {
    vwap:         +vwap.toFixed(2),
    currentPrice: +currentPrice.toFixed(2),
    aboveVWAP:    distance > 0,
    distance:     +distance.toFixed(2),
    distancePts:  +distancePts.toFixed(2),
    slopeDir,
    position,
    barsCount:    rthBars.length,
    calculatedAt: new Date().toISOString(),
  };

  logger.info(
    `[vwap] ${symbol} | VWAP: ${result.vwap} | Price: ${result.currentPrice} | ` +
    `${result.position} by ${result.distancePts} pts | Slope: ${result.slopeDir}`
  );

  return result;
}

module.exports = { calculateVWAP };
