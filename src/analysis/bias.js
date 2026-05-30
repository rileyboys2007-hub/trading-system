/**
 * analysis/bias.js — Daily Bias Engine
 *
 * Determines NQ futures directional bias for the trading day.
 *
 * Data inputs:
 *   - QQQ performance (Nasdaq 100 ETF, direct proxy)
 *   - NVDA performance (largest NQ component at ~9%)
 *   - SPY performance (broad market risk-on / risk-off)
 *   - DXY direction (dollar strength = headwind for NQ)
 *   - 10Y Treasury yield direction (rising rates = pressure on tech)
 *   - 5Y Treasury yield direction (near-term rate expectations)
 *   - VIX level and direction (fear = sell, fear collapse = buy)
 *   - NQ futures overnight performance
 *   - AI-synthesized news context (Fed, macro, earnings)
 *
 * Output:
 *   {
 *     bias:       "BULLISH" | "BEARISH" | "NEUTRAL",
 *     confidence: 0–100,
 *     drivers:    ["driver1", "driver2", "driver3"],
 *     summary:    "One-line market summary",
 *     nqOutlook:  "One-line NQ-specific outlook",
 *     rawScores:  { qqq, nvda, dxy, yields, vix, overall },
 *     cachedAt:   ISO timestamp,
 *     dataSnapshot: { ... }
 *   }
 */

const logger        = require("../utils/logger");
const { fetchMarketSnapshot, snapshotToText } = require("../services/marketData");
const { analyzeJSON }   = require("../services/aiAnalyzer");
const biasHistory   = require("./biasHistory");

// ── Day-level cache: re-use within same calendar day unless forced ─
let _cache = { date: null, result: null };

// ── Rule-based pre-scoring ────────────────────────────────────────
/**
 * Score each instrument on a -3 to +3 scale before sending to AI.
 * Gives the AI grounded numbers to reason from.
 */
function scoreSnapshot(snap) {
  const scores = {};

  // QQQ: direct NQ proxy — highest weight
  const qqq = snap.QQQ?.changePct ?? 0;
  if      (qqq >  1.0) scores.qqq =  3;
  else if (qqq >  0.3) scores.qqq =  2;
  else if (qqq >  0.0) scores.qqq =  1;
  else if (qqq > -0.3) scores.qqq = -1;
  else if (qqq > -1.0) scores.qqq = -2;
  else                 scores.qqq = -3;

  // NVDA: largest NQ component, leads tech sentiment
  const nvda = snap.NVDA?.changePct ?? 0;
  if      (nvda >  2.0) scores.nvda =  2;
  else if (nvda >  0.5) scores.nvda =  1;
  else if (nvda > -0.5) scores.nvda =  0;
  else if (nvda > -2.0) scores.nvda = -1;
  else                  scores.nvda = -2;

  // SPY: broad market — if SPY weak but QQQ ok, mixed signal
  const spy = snap.SPY?.changePct ?? 0;
  if      (spy >  0.5) scores.spy =  1;
  else if (spy > -0.5) scores.spy =  0;
  else                 scores.spy = -1;

  // DXY: inverse relationship — strong dollar = NQ headwind
  const dxy = snap.DXY?.changePct ?? 0;
  if      (dxy >  0.5) scores.dxy = -2;
  else if (dxy >  0.2) scores.dxy = -1;
  else if (dxy > -0.2) scores.dxy =  0;
  else if (dxy > -0.5) scores.dxy =  1;
  else                 scores.dxy =  2;

  // TNX (10Y yield): rising rates = pressure on growth/tech
  const tnx = snap.TNX?.changePct ?? 0;
  if      (tnx >  1.0) scores.yields = -2;
  else if (tnx >  0.3) scores.yields = -1;
  else if (tnx > -0.3) scores.yields =  0;
  else if (tnx > -1.0) scores.yields =  1;
  else                 scores.yields =  2;

  // VIX: elevated VIX = risk-off, collapsing VIX = risk-on
  const vixPrice = snap.VIX?.price ?? 20;
  const vixChg   = snap.VIX?.changePct ?? 0;
  let vixScore = 0;
  if      (vixPrice > 30)   vixScore = -2;           // extreme fear
  else if (vixPrice > 20)   vixScore = -1;           // elevated
  else if (vixPrice < 15)   vixScore =  1;           // complacency/risk-on
  if (vixChg < -5)          vixScore += 1;           // VIX collapsing = bullish
  else if (vixChg > 5)      vixScore -= 1;           // VIX spiking = bearish
  scores.vix = Math.max(-2, Math.min(2, vixScore));

  // Overall weighted score
  scores.overall = (
    scores.qqq    * 3 +    // highest weight — direct proxy
    scores.nvda   * 2 +    // tech leadership
    scores.dxy    * 2 +    // macro factor
    scores.yields * 2 +    // rate environment
    scores.spy    * 1 +    // broad context
    scores.vix    * 1      // fear gauge
  );

  return scores;
}

// ── AI Prompt Builder ─────────────────────────────────────────────
function buildBiasPrompt(snapshot, scores) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "America/New_York",
  });
  const time = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", timeZone: "America/New_York",
  });

  return `You are a professional NQ/ES futures trading analyst. Assess the daily market bias for NQ futures (Nasdaq 100 E-mini).

TODAY: ${today} | ${time} ET

${snapshotToText(snapshot)}

PRE-SCORED FACTORS (rule-based, scale -3 to +3):
  QQQ (Nasdaq proxy):        ${scores.qqq > 0 ? "+" : ""}${scores.qqq}
  NVDA (tech leadership):    ${scores.nvda > 0 ? "+" : ""}${scores.nvda}
  SPY (broad market):        ${scores.spy > 0 ? "+" : ""}${scores.spy}
  DXY (dollar, inverted):    ${scores.dxy > 0 ? "+" : ""}${scores.dxy}
  Treasury Yields (inverted):${scores.yields > 0 ? "+" : ""}${scores.yields}
  VIX (fear gauge, inverted):${scores.vix > 0 ? "+" : ""}${scores.vix}
  WEIGHTED OVERALL:          ${scores.overall > 0 ? "+" : ""}${scores.overall}

Using this data AND your knowledge of current Fed policy, recent macro events, and market conditions, determine the NQ daily bias.

Respond ONLY with valid JSON in this exact format:
{
  "bias": "BULLISH" or "BEARISH" or "NEUTRAL",
  "confidence": <integer 0-100>,
  "drivers": ["<driver 1>", "<driver 2>", "<driver 3>"],
  "summary": "<one sentence: overall market tone today>",
  "nqOutlook": "<one sentence: specific NQ outlook for today's session>",
  "fedContext": "<one sentence: current Fed stance and rate environment>",
  "keyRisk": "<one sentence: biggest risk to the bias today>"
}

Rules:
- BULLISH if score >= +4 AND macro supports
- BEARISH if score <= -4 AND macro supports
- NEUTRAL if conflicting signals or score -3 to +3
- Confidence 80-100 = strong conviction, 50-79 = moderate, below 50 = uncertain
- Be direct. No hedging. Traders need a clear lean.`;
}

// ── Main Export ───────────────────────────────────────────────────

/**
 * Get today's daily bias. Uses cache unless forced or date changed.
 * @param {boolean} forceRefresh — bypass cache and re-run analysis
 * @returns {object} bias result
 */
async function getDailyBias(forceRefresh = false) {
  const today = new Date().toISOString().split("T")[0];

  if (!forceRefresh && _cache.date === today && _cache.result) {
    logger.info("[bias] Returning cached daily bias");
    return _cache.result;
  }

  logger.info(`[bias] Running daily bias engine${forceRefresh ? " (forced)" : ""}...`);

  // 1. Fetch live market data
  const snapshot = await fetchMarketSnapshot();

  // 2. Rule-based pre-scoring
  const scores = scoreSnapshot(snapshot);
  logger.info(`[bias] Pre-scores: QQQ=${scores.qqq} NVDA=${scores.nvda} DXY=${scores.dxy} Yields=${scores.yields} VIX=${scores.vix} | Overall=${scores.overall}`);

  // 3. AI analysis
  const prompt = buildBiasPrompt(snapshot, scores);
  const aiResult = await analyzeJSON(prompt, 400);

  // 4. Build final result
  const result = {
    bias:         aiResult.bias       || "NEUTRAL",
    confidence:   aiResult.confidence || 50,
    drivers:      aiResult.drivers    || [],
    summary:      aiResult.summary    || "",
    nqOutlook:    aiResult.nqOutlook  || "",
    fedContext:   aiResult.fedContext || "",
    keyRisk:      aiResult.keyRisk    || "",
    rawScores:    scores,
    cachedAt:     new Date().toISOString(),
    dataSnapshot: snapshot,
  };

  // 5. Cache + persist
  _cache = { date: today, result };
  biasHistory.save(result);

  logger.info(`[bias] Result: ${result.bias} (${result.confidence}% confidence) | Drivers: ${result.drivers.join(" | ")}`);

  return result;
}

module.exports = { getDailyBias };
