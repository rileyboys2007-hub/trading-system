/**
 * analysis/scoring.js — Trade Scoring Engine
 *
 * Scores 7 factors for a given trade direction and returns an A+–F grade.
 * Each factor is scored 0–100, weighted, then summed into a composite score.
 *
 * Factors and weights:
 *   Daily Bias Alignment    18%  — does bias support the trade direction?
 *   Internals Alignment     17%  — do QQQ/NVDA/MSFT/AAPL support the direction?
 *   Playbook Quality        18%  — is there a matched playbook for this setup?
 *   Liquidity Sweep Quality 13%  — was there a clean sweep supporting the trade?
 *   Session Quality         11%  — is this a high-probability time of day?
 *   VWAP Position           12%  — is price above/below VWAP, and is VWAP sloping your way?
 *   Volume                  7%   — is the move volume-confirmed?
 *   News Risk               4%   — is there a news event nearby?
 *
 * Grade thresholds:
 *   A+  90–100   Elite setup — everything aligned, take maximum size
 *   A   80–89    Excellent — strong conviction, take full size
 *   B+  70–79    Good — most factors align, proceed with standard size
 *   B   60–69    Decent — minor gaps, reduce size or tighten SL
 *   C   45–59    Marginal — proceed only if other edge exists, half size
 *   F   0–44     Poor — skip or wait for better conditions
 */

const logger      = require("../utils/logger");
const { getDailyBias }          = require("./bias");
const { getMarketInternals }    = require("./internals");
const { detectLiquiditySweeps } = require("./liquidity");
const { detectPlaybooks }       = require("./playbooks");
const { getNewsRisk }           = require("../services/newsRisk");
const { calculateVWAP }         = require("./vwap");
const { getTrendAlignment }     = require("./trendAlignment");

// ── Grade Map ─────────────────────────────────────────────────────

const GRADES = [
  { min: 90, grade: "A+", label: "Elite",    recommendation: "TAKE",    description: "Everything aligned. Maximum conviction." },
  { min: 80, grade: "A",  label: "Excellent", recommendation: "TAKE",   description: "Strong setup. High probability. Full size." },
  { min: 70, grade: "B+", label: "Good",      recommendation: "TAKE",   description: "Most factors aligned. Standard size." },
  { min: 60, grade: "B",  label: "Decent",    recommendation: "CAUTION", description: "Minor gaps. Reduce size or tighten stop." },
  { min: 45, grade: "C",  label: "Marginal",  recommendation: "CAUTION", description: "Weak alignment. Half size if at all." },
  { min:  0, grade: "F",  label: "Poor",      recommendation: "SKIP",   description: "Too many factors against you. Wait." },
];

function getGrade(score) {
  return GRADES.find(g => score >= g.min) || GRADES[GRADES.length - 1];
}

// ── Factor Scorers ────────────────────────────────────────────────

/**
 * 1. Daily Bias Alignment (weight: 20%)
 * Full score if direction matches bias. Penalty if against it.
 */
function scoreBiasAlignment(biasResult, direction) {
  if (!biasResult) return { score: 50, explanation: "Bias data unavailable — neutral score applied" };

  const { bias, confidence } = biasResult;
  const confidenceMultiplier = confidence / 100;

  let base;
  const aligned  = (direction === "LONG"  && bias === "BULLISH") ||
                   (direction === "SHORT" && bias === "BEARISH");
  const opposed  = (direction === "LONG"  && bias === "BEARISH") ||
                   (direction === "SHORT" && bias === "BULLISH");
  const neutral  = bias === "NEUTRAL";

  if (aligned)   base = 75 + confidenceMultiplier * 25;   // 75–100 based on confidence
  else if (neutral) base = 50;
  else if (opposed) base = 0 + (1 - confidenceMultiplier) * 30; // 0–30

  const score = Math.round(base);

  const status = aligned ? "✓ ALIGNED" : opposed ? "✗ OPPOSED" : "~ NEUTRAL";
  const explanation = `${status} — Daily bias: ${bias} (${confidence}% confidence) | Trade: ${direction}`;

  return { score, bias, confidence, aligned, explanation };
}

/**
 * 2. Internals Alignment (weight: 20%)
 * Maps STRONG_BULLISH → STRONG_BEARISH scale to 0–100 for the trade direction.
 */
function scoreInternalsAlignment(internalsResult, direction) {
  if (!internalsResult) return { score: 50, explanation: "Internals unavailable — neutral score applied" };

  const { sentiment, confidence } = internalsResult;
  const conf = confidence / 100;

  const MAP_LONG = {
    STRONG_BULLISH: 95,
    BULLISH:        80,
    MIXED:          50,
    BEARISH:        20,
    STRONG_BEARISH: 5,
  };
  const MAP_SHORT = {
    STRONG_BEARISH: 95,
    BEARISH:        80,
    MIXED:          50,
    BULLISH:        20,
    STRONG_BULLISH: 5,
  };

  const map   = direction === "LONG" ? MAP_LONG : MAP_SHORT;
  const base  = map[sentiment] ?? 50;
  // Blend with confidence — low confidence pulls toward 50
  const score = Math.round(base * conf + 50 * (1 - conf));

  const aligned = score >= 65;
  const status  = score >= 65 ? "✓ ALIGNED" : score >= 45 ? "~ MIXED" : "✗ OPPOSED";
  const explanation = `${status} — Internals: ${sentiment} (${confidence}% confidence) | Trade: ${direction}`;

  return { score, sentiment, confidence, aligned, explanation };
}

/**
 * 3. Session Quality (weight: 12%)
 * NQ has high-probability time windows. Score based on ET time.
 */
function scoreSessionQuality() {
  const etStr = new Date().toLocaleString("en-US", {
    timeZone:  "America/New_York",
    hour:      "2-digit",
    minute:    "2-digit",
    hour12:    false,
  });
  const [h, m]   = etStr.split(":").map(Number);
  const totalMin = h * 60 + m;

  let score, session, explanation;

  if (totalMin >= 570 && totalMin < 600) {
    score = 100; session = "Opening (9:30–10:00 AM)";
    explanation = "Opening 30 minutes — highest NQ volatility and volume window";
  } else if (totalMin >= 600 && totalMin < 660) {
    score = 88; session = "Morning drive (10:00–11:00 AM)";
    explanation = "Morning session — sustained directional moves, strong liquidity";
  } else if (totalMin >= 900 && totalMin < 960) {
    score = 90; session = "Power hour (3:00–4:00 PM)";
    explanation = "Power hour — institutional closing flows, high follow-through";
  } else if (totalMin >= 780 && totalMin < 900) {
    score = 75; session = "Afternoon (1:00–3:00 PM)";
    explanation = "Afternoon session — decent liquidity, watch for chop";
  } else if (totalMin >= 660 && totalMin < 750) {
    score = 35; session = "Lunch (11:00 AM–12:30 PM)";
    explanation = "Lunch hours — low volume, choppy, stop-hunty. Avoid new entries";
  } else if (totalMin >= 750 && totalMin < 780) {
    score = 60; session = "Early afternoon (12:30–1:00 PM)";
    explanation = "Transitioning out of lunch — volume picking back up";
  } else if (totalMin >= 960 && totalMin < 1020) {
    score = 50; session = "Post-market (4:00–5:00 PM)";
    explanation = "Post-RTH — order flow thinning, still directional but use caution";
  } else if (totalMin >= 1080 && totalMin < 1200) {
    score = 55; session = "Extended / Asia open (6:00–8:00 PM)";
    explanation = "Asia session open — NQ can trend; watch for overnight continuation";
  } else if (totalMin >= 1200 && totalMin < 1320) {
    score = 45; session = "Asia mid-session (8:00–10:00 PM)";
    explanation = "Asia mid-session — lower liquidity, setups require strong sweep or playbook";
  } else if (totalMin >= 240 && totalMin < 570) {
    score = 30; session = "Pre-market (4:00–9:30 AM)";
    explanation = "Pre-market — thin liquidity, gaps possible. Lower conviction setups";
  } else {
    score = 15; session = "After-hours / Overnight";
    explanation = "Outside RTH — very thin, wide spreads, not recommended for scalps";
  }

  return { score, session, timeET: etStr, explanation };
}

/**
 * 4. Volume (weight: 8%)
 * Cross-reference with QQQ volume ratio (best proxy for NQ volume).
 */
function scoreVolume(internalsResult) {
  const qqqVol = internalsResult?.instruments?.QQQ?.volumeRatio ?? null;

  if (qqqVol === null) {
    return { score: 50, volumeRatio: null, explanation: "Volume data unavailable — neutral score" };
  }

  let score;
  if      (qqqVol >= 2.0) score = 100;
  else if (qqqVol >= 1.5) score = 85;
  else if (qqqVol >= 1.2) score = 70;
  else if (qqqVol >= 1.0) score = 55;
  else if (qqqVol >= 0.7) score = 38;
  else                    score = 20;

  const label = qqqVol >= 1.2 ? "Above average" : qqqVol >= 0.8 ? "Average" : "Below average";
  const explanation = `QQQ volume ratio: ${qqqVol}x (${label}) — ${score >= 55 ? "confirms" : "does not confirm"} the move`;

  return { score, volumeRatio: qqqVol, explanation };
}

/**
 * 5. News Risk (weight: 5%)
 * Checks for upcoming high-impact USD events. Penalizes proximity.
 */
function scoreNewsRisk(newsRiskResult) {
  if (!newsRiskResult) return { score: 50, explanation: "News data unavailable — neutral score" };

  const { score, riskLevel, minutesUntil, nextEvent } = newsRiskResult;

  return {
    score,
    riskLevel,
    minutesUntil,
    nextEvent: nextEvent?.title ?? null,
    explanation: newsRiskResult.explanation,
  };
}

/**
 * 6. VWAP Position (weight: 12%)
 * Scores whether price is on the right side of VWAP for the trade direction,
 * and whether VWAP slope supports the direction.
 *
 * Key insight: trading WITH VWAP direction = institutional flow alignment.
 * Being extended FAR from VWAP = mean-reversion risk, lower score.
 */
function scoreVWAP(vwapResult, direction) {
  if (!vwapResult) return { score: 50, explanation: "VWAP unavailable (market likely closed) — neutral score" };

  const { aboveVWAP, position, slopeDir, distancePts, vwap, currentPrice } = vwapResult;
  const isLong = direction === "LONG";

  let score;
  let status;

  if (position === "AT") {
    // Price at VWAP — potential bounce zone, good for both directions
    score  = slopeDir === (isLong ? "RISING" : "FALLING") ? 82 : 72;
    status = `At VWAP (${vwap}) — potential ${direction === "LONG" ? "support" : "resistance"} bounce`;
  } else if (isLong && aboveVWAP) {
    // LONG trade, price above VWAP — institutional bullish bias confirmed
    if (position === "FAR_ABOVE") {
      score  = 52; // Extended — mean-reversion risk
      status = `Extended ${distancePts} pts above VWAP — overextended, mean-reversion risk`;
    } else {
      score  = slopeDir === "RISING" ? 88 : slopeDir === "FLAT" ? 72 : 60;
      status = `Above VWAP (${distancePts} pts) | VWAP ${slopeDir}`;
    }
  } else if (!isLong && !aboveVWAP) {
    // SHORT trade, price below VWAP — institutional bearish bias confirmed
    if (position === "FAR_BELOW") {
      score  = 52; // Extended
      status = `Extended ${distancePts} pts below VWAP — overextended, mean-reversion risk`;
    } else {
      score  = slopeDir === "FALLING" ? 88 : slopeDir === "FLAT" ? 72 : 60;
      status = `Below VWAP (${distancePts} pts) | VWAP ${slopeDir}`;
    }
  } else if (isLong && !aboveVWAP) {
    // LONG trade, price BELOW VWAP — fighting institutional bearish flow
    score  = slopeDir === "RISING" ? 42 : slopeDir === "FLAT" ? 30 : 15;
    status = `Below VWAP — fighting bearish institutional flow | VWAP ${slopeDir}`;
  } else {
    // SHORT trade, price ABOVE VWAP — fighting institutional bullish flow
    score  = slopeDir === "FALLING" ? 42 : slopeDir === "FLAT" ? 30 : 15;
    status = `Above VWAP — fighting bullish institutional flow | VWAP ${slopeDir}`;
  }

  return {
    score,
    vwap,
    currentPrice,
    position,
    slopeDir,
    distancePts,
    aboveVWAP,
    explanation: `${status} (VWAP: ${vwap}, Price: ${currentPrice})`,
  };
}

/**
 * 7. Liquidity Sweep Quality (weight: 13%)
 * A clean rejection sweep in the trade direction is high quality.
 */
function scoreLiquiditySweep(sweepResult, direction) {
  if (!sweepResult) return { score: 40, explanation: "Sweep data unavailable — conservative score" };

  const { activeSignal, sweepCount, rejections } = sweepResult;

  // Best case: active rejection sweep aligned with trade direction
  if (activeSignal && activeSignal.result === "REJECTED") {
    const aligned = activeSignal.impliedBias === direction;
    if (aligned) {
      const strength = activeSignal.rejectionStrength ?? 0;
      const score = Math.round(70 + strength * 30); // 70–100
      return {
        score,
        sweepLevel:        activeSignal.level,
        result:            "REJECTED",
        rejectionStrength: strength,
        aligned:           true,
        explanation: `✓ Active ${activeSignal.level} rejection (strength: ${(strength * 100).toFixed(0)}%) — aligned with ${direction}`,
      };
    } else {
      return {
        score: 15,
        sweepLevel:  activeSignal.level,
        result:      "REJECTED",
        aligned:     false,
        explanation: `✗ Active ${activeSignal.level} rejection implies ${activeSignal.impliedBias} but trade is ${direction}`,
      };
    }
  }

  // Recent rejections (not the most recent bar)
  const alignedRejections = rejections.filter(s => s.impliedBias === direction && s.barsAgo <= 5);
  if (alignedRejections.length > 0) {
    const best  = alignedRejections[0];
    const score = Math.round(50 + (best.rejectionStrength ?? 0) * 20);
    return {
      score,
      sweepLevel:  best.level,
      result:      "REJECTED",
      aligned:     true,
      explanation: `~ Recent ${best.level} rejection ${best.barsAgo} bars ago (strength: ${((best.rejectionStrength || 0) * 100).toFixed(0)}%)`,
    };
  }

  // No sweep — neutral
  if (sweepCount === 0) {
    return { score: 45, explanation: "No liquidity sweep detected — no confirmation, no contradiction" };
  }

  // Sweeps present but opposite direction
  return { score: 30, explanation: `${sweepCount} sweep(s) detected but none aligned with ${direction}` };
}

/**
 * 7. Playbook Quality (weight: 20%)
 * Matched playbook in trade direction = conviction. No match = low conviction.
 */
function scorePlaybookQuality(playbookResult, direction) {
  if (!playbookResult) return { score: 40, explanation: "Playbook data unavailable" };

  const { primaryMatch, matchedPlaybooks, allPlaybooks } = playbookResult;

  // Best case: find the highest-confidence matched playbook for THIS direction
  const dirMatch = (matchedPlaybooks || [])
    .filter(p => p.direction === direction)
    .sort((a, b) => b.confidence - a.confidence)[0] || null;

  if (dirMatch) {
    const conf  = dirMatch.confidence;
    const score = Math.round(55 + (conf / 100) * 45); // 55–100
    return {
      score,
      playbook:   dirMatch.name,
      confidence: conf,
      aligned:    true,
      explanation: `✓ "${dirMatch.name}" matched at ${conf}% confidence — aligned with ${direction}`,
    };
  }

  // Match exists but all matches are opposite direction
  if (primaryMatch && primaryMatch.direction !== direction) {
    return {
      score: 10,
      playbook:  primaryMatch.name,
      aligned:   false,
      explanation: `✗ "${primaryMatch.name}" matched but implies ${primaryMatch.direction}, not ${direction}`,
    };
  }

  // Partial match (high confidence but below the 55% match threshold)
  const allSorted = (allPlaybooks || [])
    .filter(p => p.direction === direction)
    .sort((a, b) => b.confidence - a.confidence);

  if (allSorted.length && allSorted[0].confidence >= 40) {
    return {
      score: 35,
      playbook:   allSorted[0].name,
      confidence: allSorted[0].confidence,
      aligned:    true,
      explanation: `~ "${allSorted[0].name}" partially matched (${allSorted[0].confidence}%) — below match threshold`,
    };
  }

  return { score: 20, explanation: `No playbook matched for ${direction} — low structural conviction` };
}

/**
 * 8. Multi-Timeframe Trend Alignment (weight: 10%)
 *
 * Scores whether the 1H and 15m trends support the trade direction.
 * Trading WITH the higher-timeframe trend dramatically improves win rate
 * by ensuring you're not fighting institutional order flow.
 *
 * Score matrix:
 *   1H ✓  15m ✓  → 92   (both TFs aligned — strongest signal)
 *   1H ✓  15m ~  → 75   (1H trend is enough, 15m just hasn't confirmed)
 *   1H ~  15m ✓  → 65   (15m leading, 1H not yet turned)
 *   1H ~  15m ~  → 50   (ranging / no directional bias — neutral)
 *   1H ✓  15m ✗  → 42   (disagreement — short-term pullback vs trend)
 *   1H ✗  15m ✓  → 38   (disagreement — 1H opposing despite 15m signal)
 *   1H ✗  15m ~  → 25   (1H trend working against you)
 *   1H ~  15m ✗  → 22   (15m trend working against you)
 *   1H ✗  15m ✗  →  8   (both TFs against — strong counter-trend warning)
 */
function scoreTrendAlignment(trendResult, direction) {
  if (!trendResult) {
    return { score: 50, explanation: "Trend data unavailable — neutral score applied" };
  }

  const { trend1H, trend15m } = trendResult;
  const dirTrend = direction === "LONG" ? "BULLISH" : "BEARISH";
  const oppTrend = direction === "LONG" ? "BEARISH" : "BULLISH";

  const h1Match  = trend1H  === dirTrend;
  const h1Opp    = trend1H  === oppTrend;
  const m15Match = trend15m === dirTrend;
  const m15Opp   = trend15m === oppTrend;

  let score;
  if      (h1Match && m15Match)  score = 92;
  else if (h1Match && !m15Opp)   score = 75;
  else if (!h1Opp  && m15Match)  score = 65;
  else if (!h1Opp  && !m15Opp)   score = 50;
  else if (h1Match && m15Opp)    score = 42;
  else if (h1Opp   && m15Match)  score = 38;
  else if (h1Opp   && !m15Opp)   score = 25;
  else if (!h1Opp  && m15Opp)    score = 22;
  else                           score = 8;    // both TFs against

  const aligned  = h1Match && m15Match;
  const opposed  = h1Opp || m15Opp;
  const status   = aligned ? "✓ ALIGNED" : opposed ? "✗ OPPOSED" : "~ MIXED";
  const trendIcon = t => t === "BULLISH" ? "▲" : t === "BEARISH" ? "▼" : "—";

  return {
    score,
    trend1H,
    trend15m,
    aligned,
    explanation: `${status} — 1H: ${trend1H} ${trendIcon(trend1H)} | 15m: ${trend15m} ${trendIcon(trend15m)} | Trade: ${direction}`,
  };
}

// ── Grade Explainer ───────────────────────────────────────────────

function buildSummary(factors, grade, totalScore) {
  const passed  = Object.values(factors).filter(f => f.score >= 65).length;
  const total   = Object.keys(factors).length;
  const weakest = Object.entries(factors)
    .sort((a, b) => a[1].score - b[1].score)
    .map(([name]) => name)[0];

  return (
    `${grade.label} setup (${totalScore}/100). ` +
    `${passed}/${total} factors aligned. ` +
    `Weakest factor: ${weakest}.`
  );
}

// ── Main Export ───────────────────────────────────────────────────

const FACTOR_WEIGHTS = {
  dailyBias:      0.16,  // was 0.18 — reduced slightly for new trend factor
  internals:      0.15,  // was 0.17
  playbookQuality:0.17,  // was 0.18
  liquiditySweep: 0.12,  // was 0.13
  sessionQuality: 0.09,  // was 0.11
  vwap:           0.11,  // was 0.12
  volume:         0.06,  // was 0.07
  newsRisk:       0.04,  // unchanged
  trendAlignment: 0.10,  // NEW — 1H + 15m trend confirmation
  // Sum: 0.16+0.15+0.17+0.12+0.09+0.11+0.06+0.04+0.10 = 1.00 ✓
};

/**
 * Score a trade direction against all 7 factors.
 * Pass pre-fetched data to avoid redundant API calls, or leave null to auto-fetch.
 *
 * @param {object} opts
 * @param {string} opts.direction       "LONG" | "SHORT"
 * @param {string} opts.symbol          "NQ=F" (default)
 * @param {object} [opts.bias]          Pre-fetched bias result
 * @param {object} [opts.internals]     Pre-fetched internals result
 * @param {object} [opts.sweep]         Pre-fetched sweep result
 * @param {object} [opts.playbook]      Pre-fetched playbook result
 * @param {object} [opts.newsRisk]      Pre-fetched news risk result
 * @param {object} [opts.trend]        Pre-fetched trend alignment result (1H + 15m)
 */
async function scoreSignal(opts = {}) {
  const { direction = "LONG", symbol = "NQ=F" } = opts;

  logger.info(`[scoring] Scoring ${direction} trade on ${symbol}...`);

  // Fetch any missing data in parallel — each wrapped so one failure doesn't kill the rest
  const safe = fn => fn.catch(e => { logger.warn(`[scoring] Module failed: ${e.message}`); return null; });

  const [bias, internals, sweep, playbook, newsRiskData, vwapData, trendData] = await Promise.all([
    opts.bias      != null ? opts.bias      : safe(getDailyBias()),
    opts.internals != null ? opts.internals : safe(getMarketInternals()),
    opts.sweep     != null ? opts.sweep     : safe(detectLiquiditySweeps({ symbol })),
    opts.playbook  != null ? opts.playbook  : safe(detectPlaybooks(symbol)),
    opts.newsRisk  != null ? opts.newsRisk  : safe(getNewsRisk()),
    opts.vwap      != null ? opts.vwap      : safe(calculateVWAP(symbol)),
    opts.trend     != null ? opts.trend     : safe(getTrendAlignment(symbol)),
  ]);

  // Score each factor
  const factors = {
    dailyBias:       scoreBiasAlignment(bias, direction),
    internals:       scoreInternalsAlignment(internals, direction),
    playbookQuality: scorePlaybookQuality(playbook, direction),
    liquiditySweep:  scoreLiquiditySweep(sweep, direction),
    sessionQuality:  scoreSessionQuality(),
    vwap:            scoreVWAP(vwapData, direction),
    volume:          scoreVolume(internals),
    newsRisk:        scoreNewsRisk(newsRiskData),
    trendAlignment:  scoreTrendAlignment(trendData, direction),
  };

  // Weighted composite score
  const totalScore = Math.round(
    Object.entries(factors).reduce(
      (sum, [key, f]) => sum + f.score * FACTOR_WEIGHTS[key],
      0
    )
  );

  const gradeData = getGrade(totalScore);
  const summary   = buildSummary(factors, gradeData, totalScore);

  // Build scored breakdown (include weight + weighted contribution)
  const breakdown = {};
  for (const [key, f] of Object.entries(factors)) {
    breakdown[key] = {
      ...f,
      weight:          FACTOR_WEIGHTS[key],
      weightedScore:   +((f.score * FACTOR_WEIGHTS[key]).toFixed(1)),
    };
  }

  logger.info(
    `[scoring] ${direction} | Grade: ${gradeData.grade} (${totalScore}/100) | ` +
    Object.entries(factors).map(([k, f]) => `${k}:${f.score}`).join(" | ")
  );

  return {
    grade:          gradeData.grade,
    gradeLabel:     gradeData.label,
    recommendation: gradeData.recommendation,
    gradeDescription: gradeData.description,
    totalScore,
    direction,
    symbol,
    calculatedAt:   new Date().toISOString(),
    summary,
    factors:        breakdown,
    weights:        FACTOR_WEIGHTS,
  };
}

module.exports = { scoreSignal };
