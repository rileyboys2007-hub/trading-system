/**
 * analysis/decision.js — Final Decision Engine
 *
 * Synthesizes every upstream module into one clear trading decision.
 * Applies hard rules first, then soft scoring, then confluence checks.
 *
 * Decision levels:
 *   STRONG TAKE — exceptional confluence, high conviction, full size
 *   TAKE        — solid setup, conditions met, standard execution
 *   WAIT        — setup exists but key factors misaligned — let it develop
 *   AVOID       — conditions not met, risk outweighs reward
 *
 * Hard rules (always override the score):
 *   FORCE AVOID:
 *     • News risk EXTREME (event ≤ 10 min away)
 *     • Bias AND Internals both opposed to direction (no support at all)
 *     • Trade score < 45 (Grade F)
 *
 *   FORCE WAIT (cap at WAIT, cannot TAKE):
 *     • News risk HIGH (event ≤ 30 min away)
 *     • Lunch hours (11:00–12:30 ET) with score < 75
 *     • Trade score 55–69 with no active sweep and no playbook
 *
 *   STRONG TAKE only if ALL:
 *     • Trade score ≥ 87
 *     • At least 5/7 factors green (≥ 65)
 *     • Playbook matched and aligned
 *     • Bias or internals (at least one) aligned
 *     • News risk not HIGH or EXTREME
 */

const logger       = require("../utils/logger");
const { scoreSignal } = require("./scoring");

// ── Hard Rule Definitions ─────────────────────────────────────────

const HARD_RULES = [
  {
    id:       "NEWS_EXTREME",
    label:    "News event imminent (≤10 min)",
    severity: "FORCE_AVOID",
    check:    ({ newsRisk }) => newsRisk?.riskLevel === "EXTREME",
  },
  {
    id:       "DUAL_OPPOSITION",
    label:    "Both bias AND internals opposed to direction",
    severity: "FORCE_AVOID",
    check:    ({ dailyBias, internals }) =>
      dailyBias?.score <= 25 && internals?.score <= 25,
  },
  {
    id:       "SCORE_F",
    label:    "Trade score below passing threshold (Grade F)",
    severity: "FORCE_AVOID",
    check:    ({ totalScore }) => totalScore < 45,
  },
  {
    id:       "NEWS_HIGH",
    label:    "High-impact news within 30 minutes",
    severity: "FORCE_WAIT",
    check:    ({ newsRisk }) => newsRisk?.riskLevel === "HIGH",
  },
  {
    id:       "LUNCH_CHOP",
    label:    "Lunch hours — low volume, stop-hunt zone",
    severity: "FORCE_WAIT",
    check:    ({ sessionQuality, totalScore }) =>
      sessionQuality?.session?.toLowerCase().includes("lunch") && totalScore < 75,
  },
  {
    id:       "WEAK_CONFLUENCE",
    label:    "Score 55–69 with no sweep and no playbook",
    severity: "FORCE_WAIT",
    check:    ({ totalScore, liquiditySweep, playbookQuality }) =>
      totalScore >= 55 && totalScore < 70 &&
      !liquiditySweep?.aligned &&
      !playbookQuality?.aligned,
  },
];

// ── Confluence Counter ────────────────────────────────────────────

function countGreenFactors(factors) {
  return Object.values(factors).filter(f => f.score >= 65).length;
}

// ── Decision Logic ────────────────────────────────────────────────

function computeDecision(scoreResult) {
  const { totalScore, factors, direction } = scoreResult;

  // Evaluate all hard rules
  const triggeredRules = HARD_RULES.filter(r => {
    try { return r.check({ ...factors, totalScore, direction }); }
    catch { return false; }
  });

  const forceAvoid = triggeredRules.some(r => r.severity === "FORCE_AVOID");
  const forceWait  = triggeredRules.some(r => r.severity === "FORCE_WAIT");
  const greenCount = countGreenFactors(factors);

  if (forceAvoid) {
    return { decision: "AVOID", triggeredRules, greenCount };
  }

  // Check STRONG TAKE criteria (now 8 factors — need 6 green)
  const canStrongTake =
    totalScore >= 87 &&
    greenCount >= 6 &&
    factors.playbookQuality?.aligned &&
    (factors.dailyBias?.aligned || factors.internals?.aligned) &&
    !["HIGH", "EXTREME"].includes(factors.newsRisk?.riskLevel);

  if (canStrongTake) {
    return { decision: "STRONG TAKE", triggeredRules: [], greenCount };
  }

  if (forceWait) {
    return { decision: "WAIT", triggeredRules, greenCount };
  }

  // Score-based decision
  if      (totalScore >= 80) return { decision: "TAKE",  triggeredRules: [], greenCount };
  else if (totalScore >= 78) return { decision: "TAKE",  triggeredRules: [], greenCount };
  else if (totalScore >= 50) return { decision: "WAIT",  triggeredRules: [], greenCount };
  else                       return { decision: "AVOID", triggeredRules: [], greenCount };
}

// ── Reason Builder ────────────────────────────────────────────────

function buildReasons(decision, scoreResult, triggeredRules, greenCount) {
  const { factors, totalScore, direction } = scoreResult;
  const reasons = { for: [], against: [], blocking: [], watch: [] };

  // --- FOR reasons (positive factors) ---
  if (factors.playbookQuality?.aligned && factors.playbookQuality?.score >= 65) {
    reasons.for.push(`${factors.playbookQuality.playbook || "Playbook"} matched at ${factors.playbookQuality.confidence}% confidence`);
  }
  if (factors.dailyBias?.aligned) {
    reasons.for.push(`Daily bias ${factors.dailyBias.bias} (${factors.dailyBias.confidence}% confidence) aligned with ${direction}`);
  }
  if (factors.internals?.aligned) {
    reasons.for.push(`Market internals ${factors.internals.sentiment} aligned with ${direction}`);
  }
  if (factors.liquiditySweep?.aligned && factors.liquiditySweep?.score >= 65) {
    reasons.for.push(`${factors.liquiditySweep.sweepLevel} sweep rejected — ${direction} implied`);
  }
  if (factors.sessionQuality?.score >= 75) {
    reasons.for.push(`High-quality session: ${factors.sessionQuality.session}`);
  }
  if (factors.volume?.score >= 65) {
    reasons.for.push(`Volume confirmed: ${factors.volume.volumeRatio}x average`);
  }
  if (factors.newsRisk?.score === 100) {
    reasons.for.push("Clear news runway — no high-impact events in next 2 hours");
  }
  if (factors.vwap?.score >= 75) {
    const v = factors.vwap;
    reasons.for.push(`VWAP ${v.position} (${v.distancePts} pts) | slope ${v.slopeDir} — institutional flow aligned`);
  }

  // --- AGAINST reasons (weak factors) ---
  if (!factors.playbookQuality?.aligned) {
    reasons.against.push(factors.playbookQuality?.explanation || "No matched playbook for this direction");
  }
  if (!factors.dailyBias?.aligned && factors.dailyBias?.score !== 50) {
    reasons.against.push(factors.dailyBias?.explanation || "Bias not aligned");
  }
  if (!factors.internals?.aligned && factors.internals?.score < 50) {
    reasons.against.push(factors.internals?.explanation || "Internals opposed");
  }
  if (factors.sessionQuality?.score < 45) {
    reasons.against.push(`Poor session: ${factors.sessionQuality?.session} — thin liquidity`);
  }
  if (factors.volume?.score < 45) {
    reasons.against.push(`Low volume (${factors.volume?.volumeRatio}x avg) — move not confirmed`);
  }
  if (factors.liquiditySweep?.score < 35) {
    reasons.against.push(factors.liquiditySweep?.explanation || "No sweep confirmation");
  }
  if (factors.vwap && factors.vwap.score < 40) {
    reasons.against.push(`VWAP opposing: price ${factors.vwap.position} (${factors.vwap.distancePts} pts) — fighting institutional flow`);
  }

  // --- BLOCKING reasons (hard rules that fired) ---
  for (const rule of triggeredRules) {
    reasons.blocking.push(rule.label);
  }

  // --- WATCH items (risk factors) ---
  if (factors.newsRisk?.minutesUntil && factors.newsRisk.minutesUntil <= 120) {
    reasons.watch.push(`${factors.newsRisk.nextEvent} in ${factors.newsRisk.minutesUntil} min — flatten before event`);
  }
  if (factors.liquiditySweep?.sweepLevel) {
    reasons.watch.push(`${factors.liquiditySweep.sweepLevel} level (${factors.liquiditySweep.levelPrice || ""}) — monitor for re-test`);
  }
  if (factors.internals?.sentiment === "MIXED") {
    reasons.watch.push("Mixed internals — can shift quickly, watch QQQ direction");
  }
  if (decision === "TAKE" || decision === "STRONG TAKE") {
    if (factors.volume?.volumeRatio < 1.0) {
      reasons.watch.push("Volume below average — size down and monitor for follow-through");
    }
  }

  return reasons;
}

// ── Primary Reason Summary ────────────────────────────────────────

function buildPrimaryReason(decision, scoreResult, reasons) {
  const { totalScore, direction, factors } = scoreResult;

  if (decision === "STRONG TAKE") {
    const top = reasons.for[0] || "All key factors aligned";
    return `Maximum conviction — ${top}. Score: ${totalScore}/100.`;
  }
  if (decision === "TAKE") {
    const top = reasons.for[0] || "Setup meets minimum requirements";
    return `${top}. ${reasons.for.length} factors aligned. Score: ${totalScore}/100.`;
  }
  if (decision === "WAIT") {
    const block = reasons.blocking[0] || reasons.against[0] || "Key factors not aligned";
    return `${block}. Setup needs improvement before entry. Score: ${totalScore}/100.`;
  }
  // AVOID
  const block = reasons.blocking[0] || reasons.against[0] || "Conditions not met";
  return `${block}. Risk too high for entry. Score: ${totalScore}/100.`;
}

// ── Confidence in Decision ────────────────────────────────────────

function calcDecisionConfidence(decision, scoreResult, greenCount) {
  const { totalScore } = scoreResult;
  const greenPct = greenCount / 8;   // now 8 factors

  // How sure are we that this is the right call?
  if (decision === "STRONG TAKE") return Math.min(95, Math.round(80 + greenPct * 15));
  if (decision === "TAKE")        return Math.min(90, Math.round(60 + totalScore * 0.3));
  if (decision === "WAIT")        return Math.min(85, Math.round(50 + (100 - totalScore) * 0.3));
  return Math.min(90, Math.round(70 + (50 - Math.max(0, totalScore)) * 0.5));
}

// ── Main Export ───────────────────────────────────────────────────

/**
 * Run the full decision pipeline.
 * Optionally pass a pre-computed scoreResult to avoid re-fetching.
 *
 * @param {object} opts
 * @param {string} opts.direction
 * @param {string} opts.symbol
 * @param {object} [opts.scoreResult]  — pre-computed from scoreSignal()
 */
async function makeDecision(opts = {}) {
  const { direction = "LONG", symbol = "NQ=F" } = opts;

  logger.info(`[decision] Making ${direction} decision on ${symbol}...`);

  // Use pre-computed score or run the full pipeline
  const scoreResult = opts.scoreResult ?? await scoreSignal({ direction, symbol });

  // Apply decision logic
  const { decision, triggeredRules, greenCount } = computeDecision(scoreResult);

  // Build explanations
  const reasons       = buildReasons(decision, scoreResult, triggeredRules, greenCount);
  const primaryReason = buildPrimaryReason(decision, scoreResult, reasons);
  const confidence    = calcDecisionConfidence(decision, scoreResult, greenCount);

  const output = {
    decision,
    confidence,
    direction,
    symbol,
    calculatedAt:  new Date().toISOString(),
    primaryReason,
    reasons,
    tradeScore: {
      grade:      scoreResult.grade,
      totalScore: scoreResult.totalScore,
      recommendation: scoreResult.recommendation,
    },
    greenFactors:   greenCount,
    totalFactors:   8,
    blockedBy:      triggeredRules.map(r => ({ id: r.id, label: r.label, severity: r.severity })),
    factorSummary: Object.fromEntries(
      Object.entries(scoreResult.factors).map(([k, f]) => [
        k,
        { score: f.score, weight: f.weight, explanation: f.explanation },
      ])
    ),
  };

  logger.info(
    `[decision] ${decision} (${confidence}% confident) | ` +
    `Grade: ${scoreResult.grade} (${scoreResult.totalScore}/100) | ` +
    `${greenCount}/7 green | ` +
    `Blocked by: ${triggeredRules.length ? triggeredRules.map(r => r.id).join(", ") : "none"}`
  );

  return output;
}

module.exports = { makeDecision };
