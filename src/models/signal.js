/**
 * models/signal.js — Signal Schema
 * Defines the shape of a normalized, stored signal.
 * Every incoming webhook payload is converted to this format
 * before being stored or processed downstream.
 *
 * Fields added at ingestion time (not from TradingView):
 *   id          — unique signal ID (timestamp + symbol)
 *   receivedAt  — ISO timestamp when webhook was received
 *   status      — lifecycle state of the signal
 *   riskReward  — calculated R:R ratios for TP1 and TP2
 */

const { v4: uuidv4 } = require("crypto").randomUUID
  ? { v4: () => require("crypto").randomUUID() }
  : { v4: () => `${Date.now()}-${Math.random().toString(36).slice(2)}` };

const SIGNAL_STATUS = {
  RECEIVED:   "RECEIVED",    // Just came in, not yet analyzed
  ANALYZING:  "ANALYZING",   // Being processed
  VALID:      "VALID",       // Passed all checks, ready to act
  FILTERED:   "FILTERED",    // Failed scoring/conditions — skip
  TRIGGERED:  "TRIGGERED",   // Alert sent
  EXPIRED:    "EXPIRED",     // Signal too old to act on
};

/**
 * Build a normalized signal object from a raw webhook payload.
 * @param {object} raw  — validated incoming payload
 * @returns {object}    — normalized signal
 */
function createSignal(raw) {
  const entry = Number(raw.entry);
  const sl    = Number(raw.sl);
  const tp1   = Number(raw.tp1);
  const tp2   = Number(raw.tp2);

  const slDist  = Math.abs(entry - sl);
  const rr1     = slDist > 0 ? +((Math.abs(tp1 - entry) / slDist).toFixed(2)) : null;
  const rr2     = slDist > 0 ? +((Math.abs(tp2 - entry) / slDist).toFixed(2)) : null;

  return {
    id:         uuidv4(),
    receivedAt: new Date().toISOString(),
    status:     SIGNAL_STATUS.RECEIVED,

    // From TradingView
    symbol:     raw.symbol.trim().toUpperCase(),
    timeframe:  String(raw.timeframe),
    setup:      raw.setup.toUpperCase(),
    entry,
    sl,
    tp1,
    tp2,

    // Derived
    direction:  raw.setup.toUpperCase().includes("LONG") ? "LONG" : "SHORT",
    slPoints:   +slDist.toFixed(2),
    rr1,
    rr2,

    // MTF trend from Pine Script (EMA 9 vs 21, "BULLISH" | "NEUTRAL" | "BEARISH")
    // Populated when TradingView sends t5/t15/t60 in the webhook payload.
    // Used by the scoring engine instead of a slower Yahoo Finance fetch.
    trend5m:    raw.t5  || null,
    trend15m:   raw.t15 || null,
    trend1h:    raw.t60 || null,
    // Full MTF context string from Pine Script f_mtf_ctx() — "4H:bull|1H:bear|15m:bear"
    // Used by the 4H hard filter in alertService to block counter-trend trades.
    mtf:        raw.mtf || null,

    // TradingView-native VWAP data (real-time, replaces Yahoo Finance calculateVWAP)
    // Populated when Pine Script sends vp/vslope/vpos in the webhook payload.
    vwapPrice:  raw.vp     ? Number(raw.vp)    : null,
    vwapSlope:  raw.vslope || null,   // "RISING" | "FALLING" | "FLAT"
    vwapPos:    raw.vpos   || null,   // "AT" | "ABOVE" | "BELOW" | "FAR_ABOVE" | "FAR_BELOW"

    // TradingView-native key levels (real-time, replaces Yahoo Finance getKeyLevels)
    // null = level not yet established for this session (e.g. ORH before opening range closes)
    pdh:  raw.pdh  != null && raw.pdh  !== "null" ? Number(raw.pdh)  : null,
    pdl:  raw.pdl  != null && raw.pdl  !== "null" ? Number(raw.pdl)  : null,
    pdc:  raw.pdc  != null && raw.pdc  !== "null" ? Number(raw.pdc)  : null,
    onh:  raw.onh  != null && raw.onh  !== "null" ? Number(raw.onh)  : null,
    onl:  raw.onl  != null && raw.onl  !== "null" ? Number(raw.onl)  : null,
    orh:  raw.orh  != null && raw.orh  !== "null" ? Number(raw.orh)  : null,
    orl:  raw.orl  != null && raw.orl  !== "null" ? Number(raw.orl)  : null,
    pmh:  raw.pmh  != null && raw.pmh  !== "null" ? Number(raw.pmh)  : null,
    pml:  raw.pml  != null && raw.pml  !== "null" ? Number(raw.pml)  : null,
    atr:  raw.atr  ? Number(raw.atr)  : null,

    // Placeholders — filled by analysis modules
    bias:       null,
    score:      null,
    playbook:   null,
    notes:      raw.notes || null,
  };
}

module.exports = { createSignal, SIGNAL_STATUS };
