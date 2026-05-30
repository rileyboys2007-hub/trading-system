/**
 * services/marketData.js — Market Data Fetcher
 * Pulls live quotes for every instrument the bias engine needs.
 * Source: Yahoo Finance (no API key required).
 *
 * Instruments:
 *   QQQ   — Nasdaq 100 ETF (NQ proxy, most direct)
 *   NVDA  — NVIDIA (single biggest NQ weight, ~9%)
 *   SPY   — S&P 500 ETF (broad risk-on/off)
 *   DXY   — US Dollar Index (inverse correlation to NQ)
 *   TNX   — 10Y Treasury yield (rate pressure on tech)
 *   FVX   — 5Y Treasury yield (near-term rate expectations)
 *   VIX   — Volatility index (fear gauge)
 *   NQ    — NQ front-month futures (direct)
 */

const YahooFinance = require("yahoo-finance2").default;
const yf     = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const logger = require("../utils/logger");

const INSTRUMENTS = {
  QQQ:  { symbol: "QQQ",       label: "Nasdaq 100 ETF" },
  NVDA: { symbol: "NVDA",      label: "NVIDIA" },
  SPY:  { symbol: "SPY",       label: "S&P 500 ETF" },
  DXY:  { symbol: "DX-Y.NYB",  label: "US Dollar Index" },
  TNX:  { symbol: "^TNX",      label: "10Y Treasury Yield" },
  FVX:  { symbol: "^FVX",      label: "5Y Treasury Yield" },
  VIX:  { symbol: "^VIX",      label: "VIX" },
  NQ:   { symbol: "NQ=F",      label: "NQ Futures" },
};

/**
 * Fetch a single quote and normalize it.
 */
async function fetchOne(key) {
  const { symbol, label } = INSTRUMENTS[key];
  try {
    const q = await yf.quote(symbol, {}, { validateResult: false });
    return {
      key,
      label,
      symbol,
      price:         q.regularMarketPrice        ?? null,
      change:        +(q.regularMarketChange?.toFixed(2)        ?? 0),
      changePct:     +(q.regularMarketChangePercent?.toFixed(3) ?? 0),
      prevClose:     q.regularMarketPreviousClose ?? null,
      dayHigh:       q.regularMarketDayHigh       ?? null,
      dayLow:        q.regularMarketDayLow        ?? null,
      volume:        q.regularMarketVolume        ?? null,
      marketState:   q.marketState               ?? "UNKNOWN",
    };
  } catch (err) {
    logger.warn(`[marketData] ${symbol} fetch failed: ${err.message}`);
    return { key, label, symbol, price: null, change: null, changePct: null, error: err.message };
  }
}

/**
 * Fetch all instruments concurrently.
 * @returns {object} keyed by instrument key (QQQ, NVDA, etc.)
 */
async function fetchMarketSnapshot() {
  logger.info("[marketData] Fetching market snapshot...");
  const keys    = Object.keys(INSTRUMENTS);
  const results = await Promise.all(keys.map(fetchOne));

  const snapshot = {};
  for (const r of results) snapshot[r.key] = r;

  const live = results.filter(r => r.price !== null).length;
  logger.info(`[marketData] Snapshot complete — ${live}/${keys.length} instruments live`);

  return snapshot;
}

/**
 * Format snapshot as a human-readable string for AI prompts.
 */
function snapshotToText(snapshot) {
  const lines = ["CURRENT MARKET DATA:"];
  for (const [key, d] of Object.entries(snapshot)) {
    if (!d.price) {
      lines.push(`  ${d.label} (${d.symbol}): unavailable`);
      continue;
    }
    const dir  = d.changePct >= 0 ? "▲" : "▼";
    const sign = d.changePct >= 0 ? "+" : "";
    lines.push(
      `  ${d.label.padEnd(22)} ${String(d.price).padEnd(10)} ${dir} ${sign}${d.changePct}%`
    );
  }
  return lines.join("\n");
}

module.exports = { fetchMarketSnapshot, snapshotToText, INSTRUMENTS };
