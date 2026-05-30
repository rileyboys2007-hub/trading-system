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

    // Placeholders — filled by analysis modules
    bias:       null,
    score:      null,
    playbook:   null,
    notes:      raw.notes || null,
  };
}

module.exports = { createSignal, SIGNAL_STATUS };
