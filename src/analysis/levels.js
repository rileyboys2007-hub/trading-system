/**
 * analysis/levels.js — Key Levels Engine
 *
 * Calculates 7 critical price levels for NQ (or any futures symbol):
 *
 *   PDH  Previous Day High       — sell-side liquidity above
 *   PDL  Previous Day Low        — buy-side liquidity below
 *   PDC  Previous Day Close      — fair value reference
 *   ONH  Overnight High          — Globex session high (4:15 PM → 9:30 AM ET)
 *   ONL  Overnight Low           — Globex session low
 *   PMH  Pre-Market High         — 4:00 AM → 9:30 AM ET high (institutional reference)
 *   PML  Pre-Market Low          — 4:00 AM → 9:30 AM ET low
 *   ORH  Opening Range High      — RTH first-N-minute candle high (default 30 min)
 *   ORL  Opening Range Low       — RTH first-N-minute candle low
 *
 * Also returns:
 *   nearestResistance  — closest level ABOVE current price
 *   nearestSupport     — closest level BELOW current price
 *   allResistance      — all levels above, sorted nearest → farthest
 *   allSupport         — all levels below, sorted nearest → farthest
 */

const YahooFinance = require("yahoo-finance2").default;
const yf    = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const logger = require("../utils/logger");

const OR_MINUTES   = 30;   // opening range window (changeable)
const RTH_START    = 570;  // 9:30 AM ET in minutes-since-midnight
const RTH_END      = 960;  // 4:00 PM ET
const GLOBEX_END   = 975;  // 4:15 PM ET (NQ RTH close)
const PREMARKET_START = 240; // 4:00 AM ET — pre-market open

// ── Timezone Helpers ──────────────────────────────────────────────

/** Convert a JS Date to its ET parts. */
function toET(date) {
  const str = date.toLocaleString("en-US", {
    timeZone:  "America/New_York",
    year:      "numeric",
    month:     "2-digit",
    day:       "2-digit",
    hour:      "2-digit",
    minute:    "2-digit",
    hour12:    false,
  });
  // "05/29/2026, 15:45"
  const [datePart, timePart] = str.split(", ");
  const [month, day, year]   = datePart.split("/").map(Number);
  const [hours, minutes]     = timePart.split(":").map(Number);
  return { year, month, day, hours, minutes, totalMinutes: hours * 60 + minutes };
}

/** Return today's {year, month, day} in ET. */
function todayET() {
  const str = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year:  "numeric",
    month: "2-digit",
    day:   "2-digit",
  });
  const [month, day, year] = str.split("/").map(Number);
  return { year, month, day };
}

function sameDay(etParts, ref) {
  return etParts.year === ref.year && etParts.month === ref.month && etParts.day === ref.day;
}

/** Return yesterday's {year, month, day} in ET (handles weekend → Friday). */
function yesterdayET() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const str = d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const [month, day, year] = str.split("/").map(Number);
  return { year, month, day };
}

// ── Data Fetchers ─────────────────────────────────────────────────

async function fetchDailyBars(symbol) {
  const period1 = new Date();
  period1.setDate(period1.getDate() - 14); // 2 weeks covers weekends/holidays
  const result = await yf.chart(symbol, { interval: "1d", period1 }, { validateResult: false });
  return (result.quotes || []).filter(q => q.high && q.low && q.close);
}

async function fetchIntradayBars(symbol) {
  const period1 = new Date();
  period1.setDate(period1.getDate() - 2); // yesterday + today
  const result = await yf.chart(
    symbol,
    { interval: "5m", period1, includePrePost: true },
    { validateResult: false }
  );
  return (result.quotes || []).filter(q => q.high && q.low);
}

/**
 * Fetch a real-time (or near real-time) price from the Yahoo Finance quote endpoint.
 * For NQ=F futures:
 *   – bid/ask are live exchange prices (0.50 pt spread → mid is best entry estimate)
 *   – regularMarketPrice has a 10-minute delay (same as chart bars)
 *
 * Returns { price, source } where source is "bid_ask_mid" | "quote" | null.
 */
async function fetchRealtimePrice(symbol) {
  try {
    const q = await yf.quote(symbol, {}, { validateResult: false });
    if (q.bid && q.ask && q.bid > 0 && q.ask > 0) {
      const mid = +((q.bid + q.ask) / 2).toFixed(2);
      return { price: mid, source: "bid_ask_mid", bid: q.bid, ask: q.ask };
    }
    if (q.regularMarketPrice) {
      return { price: q.regularMarketPrice, source: "quote_delayed" };
    }
  } catch (err) {
    logger.warn(`[levels] Real-time quote failed: ${err.message}`);
  }
  return null;
}

// ── Level Calculators ─────────────────────────────────────────────

/** PDH / PDL / PDC — last COMPLETE trading day. */
function calcPreviousDay(dailyBars) {
  const today = todayET();
  // Filter out today's partial bar, then take the last remaining
  const past = dailyBars.filter(q => {
    const et = toET(q.date);
    return !sameDay(et, today);
  });
  if (!past.length) return { PDH: null, PDL: null, PDC: null };
  const prev = past[past.length - 1];
  return {
    PDH: prev.high,
    PDL: prev.low,
    PDC: prev.close,
  };
}

/** ONH / ONL — Globex overnight session (prev 4:15 PM ET → today 9:30 AM ET). */
function calcOvernight(intradayBars) {
  const today     = todayET();
  const yesterday = yesterdayET();

  const overnightBars = intradayBars.filter(q => {
    const et = toET(q.date);
    // Today's pre-market bars (before RTH open)
    if (sameDay(et, today) && et.totalMinutes < RTH_START) return true;
    // Yesterday's post-close bars (after NQ Globex start ~4:15 PM)
    if (sameDay(et, yesterday) && et.totalMinutes >= GLOBEX_END) return true;
    return false;
  });

  if (!overnightBars.length) return { ONH: null, ONL: null };

  const ONH = Math.max(...overnightBars.map(q => q.high));
  const ONL = Math.min(...overnightBars.map(q => q.low));
  return { ONH, ONL };
}

/** PMH / PML — Pre-Market session (4:00 AM → 9:30 AM ET). */
function calcPreMarket(intradayBars) {
  const today = todayET();

  const pmBars = intradayBars.filter(q => {
    const et = toET(q.date);
    return (
      sameDay(et, today) &&
      et.totalMinutes >= PREMARKET_START &&
      et.totalMinutes <  RTH_START
    );
  });

  if (!pmBars.length) return { PMH: null, PML: null };

  return {
    PMH: Math.max(...pmBars.map(q => q.high)),
    PML: Math.min(...pmBars.map(q => q.low)),
  };
}

/** ORH / ORL — Opening Range (first N minutes of RTH). */
function calcOpeningRange(intradayBars, orMinutes = OR_MINUTES) {
  const today  = todayET();
  const orEnd  = RTH_START + orMinutes; // e.g. 600 = 10:00 AM

  const orBars = intradayBars.filter(q => {
    const et = toET(q.date);
    return (
      sameDay(et, today) &&
      et.totalMinutes >= RTH_START &&
      et.totalMinutes <  orEnd
    );
  });

  if (!orBars.length) return { ORH: null, ORL: null, orComplete: false };

  const nowET = toET(new Date());
  const orComplete = nowET.totalMinutes >= orEnd;

  return {
    ORH: Math.max(...orBars.map(q => q.high)),
    ORL: Math.min(...orBars.map(q => q.low)),
    orComplete,
    orMinutes,
  };
}

// ── Nearest Level Calculator ──────────────────────────────────────

function buildLevelList(levels) {
  return Object.entries(levels)
    .filter(([, price]) => price !== null && price !== undefined)
    .map(([name, price]) => ({ name, price: +price.toFixed(2) }));
}

function findNearestLevels(currentPrice, levelList) {
  const above = levelList
    .filter(l => l.price > currentPrice)
    .map(l => ({ ...l, distance: +(l.price - currentPrice).toFixed(2) }))
    .sort((a, b) => a.distance - b.distance);

  const below = levelList
    .filter(l => l.price <= currentPrice)
    .map(l => ({ ...l, distance: +(currentPrice - l.price).toFixed(2) }))
    .sort((a, b) => a.distance - b.distance);

  return {
    nearestResistance: above[0]  || null,
    nearestSupport:    below[0]  || null,
    allResistance:     above,
    allSupport:        below,
  };
}

// ── Session State Helper ──────────────────────────────────────────

function getSessionState() {
  const et = toET(new Date());
  const t  = et.totalMinutes;
  if (t < 240)         return "OVERNIGHT";
  if (t < RTH_START)   return "PRE_MARKET";
  if (t < RTH_START + OR_MINUTES) return "OPENING_RANGE";
  if (t < RTH_END)     return "RTH";
  if (t < GLOBEX_END)  return "POST_MARKET";
  return "OVERNIGHT";
}

// ── Main Export ───────────────────────────────────────────────────

/**
 * Calculate all key levels for the given symbol.
 * @param {string} symbol  Yahoo Finance symbol (default: 'NQ=F')
 * @returns {object}       Structured JSON with all levels + nearest S/R
 */
async function getKeyLevels(symbol = "NQ=F") {
  logger.info(`[levels] Calculating key levels for ${symbol}...`);

  const [dailyBars, intradayBars, realtimeQuote] = await Promise.all([
    fetchDailyBars(symbol),
    fetchIntradayBars(symbol),
    fetchRealtimePrice(symbol),
  ]);

  logger.info(`[levels] Daily bars: ${dailyBars.length} | Intraday bars: ${intradayBars.length}`);

  // Current price priority:
  //   1. Bid/ask mid from quote endpoint (live exchange prices for NQ=F)
  //   2. regularMarketPrice from quote (10-min delayed but more current than bar data)
  //   3. Last 5m bar close (10–15 min delayed — fallback only)
  const lastBar     = intradayBars[intradayBars.length - 1];
  const barPrice    = lastBar?.close ?? null;
  const currentPrice = realtimeQuote?.price ?? barPrice;
  const priceSource  = realtimeQuote?.source ?? "bar_close";

  logger.info(
    `[levels] Price: ${currentPrice} (source: ${priceSource})` +
    (realtimeQuote?.bid ? ` | bid: ${realtimeQuote.bid} ask: ${realtimeQuote.ask}` : "") +
    (barPrice && barPrice !== currentPrice ? ` | bar close (delayed): ${barPrice}` : "")
  );

  // Calculate each level group
  const pd  = calcPreviousDay(dailyBars);
  const on  = calcOvernight(intradayBars);
  const pm  = calcPreMarket(intradayBars);
  const or  = calcOpeningRange(intradayBars);

  const levels = {
    PDH: pd.PDH,
    PDL: pd.PDL,
    PDC: pd.PDC,
    ONH: on.ONH,
    ONL: on.ONL,
    PMH: pm.PMH,
    PML: pm.PML,
    ORH: or.ORH,
    ORL: or.ORL,
  };

  // Nearest S/R (only if current price is available)
  const levelList = buildLevelList(levels);
  const proximity = currentPrice
    ? findNearestLevels(currentPrice, levelList)
    : { nearestResistance: null, nearestSupport: null, allResistance: [], allSupport: [] };

  const result = {
    symbol,
    currentPrice,
    priceSource,                    // "bid_ask_mid" | "quote_delayed" | "bar_close"
    sessionState:      getSessionState(),
    calculatedAt:      new Date().toISOString(),
    orMinutes:         OR_MINUTES,
    orComplete:        or.orComplete ?? false,

    // ── All 9 Levels ─────────────────────────────────
    levels: {
      PDH: pd.PDH,
      PDL: pd.PDL,
      PDC: pd.PDC,
      ONH: on.ONH,
      ONL: on.ONL,
      PMH: pm.PMH,
      PML: pm.PML,
      ORH: or.ORH,
      ORL: or.ORL,
    },

    // ── Nearest Levels ────────────────────────────────
    nearestResistance: proximity.nearestResistance,
    nearestSupport:    proximity.nearestSupport,
    allResistance:     proximity.allResistance,
    allSupport:        proximity.allSupport,
  };

  logger.info(
    `[levels] ${symbol} @ ${currentPrice} | ` +
    `PDH:${pd.PDH} PDL:${pd.PDL} PDC:${pd.PDC} | ` +
    `ONH:${on.ONH} ONL:${on.ONL} | ` +
    `PMH:${pm.PMH} PML:${pm.PML} | ` +
    `ORH:${or.ORH} ORL:${or.ORL}`
  );

  return result;
}

module.exports = { getKeyLevels };
