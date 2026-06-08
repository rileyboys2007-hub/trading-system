/**
 * utils/validator.js — Incoming Webhook Payload Validator
 * Validates every field of an incoming TradingView signal.
 * Returns { valid: bool, errors: [] } so the route can reject bad payloads early.
 *
 * Required fields:
 *   symbol     — ticker string          (e.g. "NQ1!", "ES1!", "AAPL")
 *   timeframe  — chart resolution       ("1","3","5","15","30","60","D","W")
 *   setup      — setup type string      (see VALID_SETUPS below)
 *   entry      — entry price            (positive number)
 *   sl         — stop loss price        (positive number)
 *   tp1        — first target price     (positive number)
 *   tp2        — second target price    (positive number)
 */

const VALID_TIMEFRAMES = ["1", "3", "5", "15", "30", "60", "120", "240", "D", "W"];

const VALID_SETUPS = [
  // Generic (kept for backward compat / manual tests)
  "REVERSAL_LONG",
  "REVERSAL_SHORT",
  "BREAKOUT_LONG",
  "BREAKOUT_SHORT",
  "VWAP_RECLAIM_LONG",
  "VWAP_RECLAIM_SHORT",
  "LIQUIDITY_SWEEP_LONG",
  "LIQUIDITY_SWEEP_SHORT",
  "BIAS_LONG",
  "BIAS_SHORT",
  // NQ Scanner v2.0 — specific setup names sent by Pine Script alert() calls
  "PDH_SWEEP_REVERSAL_SHORT",
  "PDL_SWEEP_REVERSAL_LONG",
  "ONH_SWEEP_REVERSAL_SHORT",
  "ONL_SWEEP_REVERSAL_LONG",
  "ORH_SWEEP_REVERSAL_SHORT",
  "ORL_SWEEP_REVERSAL_LONG",
  "PMH_SWEEP_REVERSAL_SHORT",
  "PML_SWEEP_REVERSAL_LONG",
  "BULLISH_ORB_LONG",
  "BEARISH_ORB_SHORT",
  "ONH_BREAKOUT_CONTINUATION_LONG",
  "ONL_BREAKDOWN_CONTINUATION_SHORT",
  "BULLISH_TREND_PULLBACK_LONG",
  "BEARISH_TREND_PULLBACK_SHORT",
];

/**
 * Validate an incoming webhook payload.
 * @param {object} payload
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateSignal(payload) {
  const errors = [];

  if (!payload || typeof payload !== "object") {
    return { valid: false, errors: ["Payload must be a JSON object"] };
  }

  // ── symbol ────────────────────────────────────────────
  if (!payload.symbol) {
    errors.push("symbol is required");
  } else if (typeof payload.symbol !== "string" || payload.symbol.trim() === "") {
    errors.push("symbol must be a non-empty string");
  }

  // ── timeframe ─────────────────────────────────────────
  if (!payload.timeframe) {
    errors.push("timeframe is required");
  } else if (!VALID_TIMEFRAMES.includes(String(payload.timeframe))) {
    errors.push(`timeframe must be one of: ${VALID_TIMEFRAMES.join(", ")}`);
  }

  // ── setup ─────────────────────────────────────────────
  if (!payload.setup) {
    errors.push("setup is required");
  } else if (!VALID_SETUPS.includes(payload.setup.toUpperCase())) {
    errors.push(`setup must be one of: ${VALID_SETUPS.join(", ")}`);
  }

  // ── price fields ──────────────────────────────────────
  const priceFields = ["entry", "sl", "tp1", "tp2"];
  for (const field of priceFields) {
    const val = payload[field];
    if (val === undefined || val === null || val === "") {
      errors.push(`${field} is required`);
    } else if (isNaN(Number(val)) || Number(val) <= 0) {
      errors.push(`${field} must be a positive number`);
    }
  }

  // ── logical price checks (only if all fields present) ─
  if (errors.length === 0) {
    const entry = Number(payload.entry);
    const sl    = Number(payload.sl);
    const tp1   = Number(payload.tp1);
    const tp2   = Number(payload.tp2);
    const isLong = payload.setup.toUpperCase().includes("LONG");

    if (isLong) {
      if (sl >= entry) errors.push("sl must be below entry for a LONG setup");
      if (tp1 <= entry) errors.push("tp1 must be above entry for a LONG setup");
      if (tp2 <= tp1)   errors.push("tp2 must be above tp1 for a LONG setup");
    } else {
      if (sl <= entry) errors.push("sl must be above entry for a SHORT setup");
      if (tp1 >= entry) errors.push("tp1 must be below entry for a SHORT setup");
      if (tp2 >= tp1)   errors.push("tp2 must be below tp1 for a SHORT setup");
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateSignal, VALID_SETUPS, VALID_TIMEFRAMES };
