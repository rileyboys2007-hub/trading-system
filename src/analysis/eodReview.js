/**
 * analysis/eodReview.js — End-of-Day Review Engine
 *
 * Generates a structured post-session debrief:
 *   bestTrade          — highest R:R win of the day
 *   worstTrade         — loss or worst execution
 *   biasAccuracy       — was today's bias prediction correct?
 *   sessionGrade       — A+/A/B+/B/C/F
 *   riskViolations     — revenge trades, overtrading flags
 *   mistakes           — AI-identified errors (with trade refs)
 *   lessons            — AI-derived key takeaways
 *   improvementTomorrow — AI-generated actionable steps
 *
 * Persists each review to src/data/reviews/YYYY-MM-DD.json.
 * Accepts an optional date param for after-hours generation.
 *
 * @param {object} [opts]
 * @param {string} [opts.date]         — ET date string (defaults to today)
 * @param {boolean}[opts.forceRefresh] — regenerate even if review already exists
 */

const fs     = require("fs");
const path   = require("path");
const logger = require("../utils/logger");

const { getSessionByDate, getTodaySession } = require("../services/sessionTracker");
const { getAll: getAllSignals }             = require("../services/signalStore");
const { getDailyBias }                     = require("./bias");
const { getKeyLevels }                     = require("./levels");
const { analyzeJSON }                      = require("../services/aiAnalyzer");

const REVIEWS_DIR = path.join(__dirname, "../data/reviews");

// ── Helpers ───────────────────────────────────────────────────────

function todayET() {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
}

function minutesBetween(a, b) {
  return (new Date(b).getTime() - new Date(a).getTime()) / 60000;
}

// ── Session Data ──────────────────────────────────────────────────

function loadSessionData(date) {
  if (date === todayET()) return getTodaySession();
  const archived = getSessionByDate(date);
  if (!archived) throw new Error(`No session data found for ${date}`);
  return archived;
}

// ── Trade Enrichment ──────────────────────────────────────────────

/**
 * Cross-reference session trades with signalStore for full context.
 */
function enrichTrades(trades) {
  const signals = getAllSignals();
  const sigMap  = new Map(signals.map(s => [s.id, s]));

  return trades.map((trade, i) => {
    const sig = trade.signalId ? sigMap.get(trade.signalId) : null;
    return {
      index:     i + 1,
      id:        trade.id,
      outcome:   trade.outcome,
      symbol:    trade.symbol   || sig?.symbol   || "NQ=F",
      setup:     trade.setup    || sig?.setup     || null,
      direction: sig?.direction || null,
      entry:     sig?.entry     || null,
      sl:        sig?.sl        || null,
      tp1:       sig?.tp1       || null,
      tp2:       sig?.tp2       || null,
      rr1:       sig?.rr1       || null,
      rr2:       sig?.rr2       || null,
      slPoints:  sig?.slPoints  || null,
      entryTime: trade.entryTime    || null,
      entryTimeIsExact: trade.entryTimeIsExact || false,
      recordedAt: trade.recordedAt,
      notes:     trade.notes    || "",
    };
  });
}

// ── Best / Worst Trade ────────────────────────────────────────────

function findBestTrade(enriched) {
  const wins = enriched.filter(t => t.outcome === "WIN");
  if (wins.length === 0) return null;

  // Sort by rr1 descending (best minimum R:R first)
  wins.sort((a, b) => (b.rr1 || 0) - (a.rr1 || 0));
  const best = wins[0];

  return {
    tradeRef:   `#${best.index}`,
    symbol:     best.symbol,
    setup:      best.setup,
    direction:  best.direction,
    outcome:    "WIN",
    rr:         best.rr1,
    rrNote:     best.rr1
      ? "minimum (TP1 confirmed — TP2 outcome unknown)"
      : null,
    entry:      best.entry,
    tp1:        best.tp1,
    tp2:        best.tp2,
    recordedAt: best.recordedAt,
    description: best.rr1
      ? `${best.setup || "Trade"} ${best.direction || ""} — R:${best.rr1} at TP1`
      : `${best.setup || "Trade"} ${best.direction || ""} — WIN`,
  };
}

function findWorstTrade(enriched) {
  const losses = enriched.filter(t => t.outcome === "LOSS");

  if (losses.length > 0) {
    // All losses are -1R (SL respected). Pick one with most context.
    // If multiple losses: prefer the last one (most recent, most likely avoidable after RESTRICTED)
    const worst = losses[losses.length - 1];
    return {
      tradeRef:   `#${worst.index}`,
      symbol:     worst.symbol,
      setup:      worst.setup,
      direction:  worst.direction,
      outcome:    "LOSS",
      rr:         -1,
      entry:      worst.entry,
      sl:         worst.sl,
      recordedAt: worst.recordedAt,
      description: worst.setup
        ? `${worst.setup} ${worst.direction || ""} — stopped out (-1R)`
        : "Stopped out at SL (-1R)",
    };
  }

  // No losses — find the WIN with the lowest rr1 (least efficient execution)
  const wins = enriched.filter(t => t.outcome === "WIN" && t.rr1 !== null);
  if (wins.length === 0) return null;
  wins.sort((a, b) => (a.rr1 || 0) - (b.rr1 || 0));
  const worst = wins[0];
  return {
    tradeRef:    `#${worst.index}`,
    symbol:      worst.symbol,
    setup:       worst.setup,
    direction:   worst.direction,
    outcome:     "WIN",
    rr:          worst.rr1,
    note:        "No losses today — lowest R:R win shown instead",
    description: `${worst.setup || "Trade"} — lowest R:R win at ${worst.rr1}R`,
  };
}

// ── Bias Accuracy ─────────────────────────────────────────────────

async function calcBiasAccuracy() {
  try {
    const bias   = await getDailyBias();
    const levels = await getKeyLevels();

    if (!bias?.bias || !levels?.currentPrice || !levels?.levels?.PDC) {
      return { available: false, reason: "Insufficient data (bias or levels unavailable)" };
    }

    const { currentPrice }  = levels;
    const pdc               = levels.levels.PDC;
    const changePct         = ((currentPrice - pdc) / pdc) * 100;

    let actual;
    if      (changePct >  0.15) actual = "BULLISH";
    else if (changePct < -0.15) actual = "BEARISH";
    else                        actual = "NEUTRAL";

    const predicted = bias.bias.toUpperCase();

    let correct;
    if (predicted === actual)                          correct = true;
    else if (predicted === "NEUTRAL" || actual === "NEUTRAL") correct = "PARTIAL";
    else                                               correct = false;

    const correctLabel = correct === true ? "✓ CORRECT" : correct === "PARTIAL" ? "~ PARTIAL" : "✗ INCORRECT";

    return {
      available:           true,
      predicted,
      predictedConfidence: bias.confidence,
      actual,
      nqChangePct:         +changePct.toFixed(2),
      pdcPrice:            pdc,
      currentPrice,
      correct,
      correctLabel,
      assessment:
        `Predicted ${predicted} (${bias.confidence}% confidence) | ` +
        `NQ moved ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}% from PDC → ${actual} | ${correctLabel}`,
    };
  } catch (err) {
    logger.warn(`[eodReview] Bias accuracy check failed: ${err.message}`);
    return { available: false, reason: err.message };
  }
}

// ── Risk Violations ───────────────────────────────────────────────

/**
 * Scan today's session trades for risk violations (revenge, halt breach).
 */
function detectRiskViolations(enriched, stats) {
  const violations = [];

  // Scan for revenge trading pairs
  for (let i = 0; i < enriched.length - 1; i++) {
    if (enriched[i].outcome !== "LOSS") continue;
    const loss = enriched[i];
    const next = enriched[i + 1];
    const ref  = next.entryTime || next.recordedAt;
    const mins = minutesBetween(loss.recordedAt, ref);
    if (mins >= 0 && mins <= 10) {
      violations.push({
        type:     "REVENGE_TRADE",
        severity: "HIGH",
        tradeRef: `#${next.index}`,
        detail:   `Trade #${next.index} entered ~${mins.toFixed(1)} min after Loss #${loss.index} — within 10-min revenge window`,
        exact:    next.entryTimeIsExact,
      });
    }
  }

  // Loss limit
  if (stats.losses >= 3) {
    violations.push({
      type:     "LOSS_LIMIT_HIT",
      severity: "HIGH",
      tradeRef: null,
      detail:   `Daily loss limit reached: ${stats.losses} losses — session halted`,
    });
  }

  // Overtrading
  if (stats.totalTrades >= 7) {
    violations.push({
      type:     "OVERTRADING_HARD",
      severity: "HIGH",
      tradeRef: null,
      detail:   `${stats.totalTrades} trades taken — hard overtrading limit (7) reached`,
    });
  } else if (stats.totalTrades >= 5) {
    violations.push({
      type:     "OVERTRADING_WARNING",
      severity: "MEDIUM",
      tradeRef: null,
      detail:   `${stats.totalTrades} trades taken — overtrading territory (normal: 1-3/session)`,
    });
  }

  return violations;
}

// ── Session Grade ─────────────────────────────────────────────────

function calcSessionGrade(stats, violations) {
  const { totalTrades, winRate, losses } = stats;
  const wRate = winRate || 0;

  if (totalTrades === 0) return { grade: "N/A", reason: "No trades taken today" };

  const highViolations = violations.filter(v => v.severity === "HIGH").length;

  if (losses >= 3) {
    return { grade: "F", reason: `Daily loss limit hit — ${losses} losses. Hard stop enforced.` };
  }
  if (wRate >= 80 && totalTrades >= 2 && highViolations === 0) {
    return { grade: "A+", reason: `Win rate ${wRate}% with ${totalTrades} trades — clean execution, no violations` };
  }
  if (wRate >= 70 && highViolations === 0) {
    return { grade: "A", reason: `Win rate ${wRate}% — strong session, stayed within risk rules` };
  }
  if (wRate >= 60) {
    return { grade: "B+", reason: `Win rate ${wRate}% — solid above-average session` };
  }
  if (wRate >= 50) {
    const extra = highViolations > 0 ? ` (${highViolations} violation(s) noted)` : "";
    return { grade: "B", reason: `Win rate ${wRate}% — positive session${extra}` };
  }
  if (wRate >= 30) {
    return { grade: "C", reason: `Win rate ${wRate}% — below average, review setup selection` };
  }
  return { grade: "F", reason: `Win rate ${wRate}% — poor session, significant improvement needed` };
}

// ── AI Coaching Sections ──────────────────────────────────────────

function buildAIPrompt(date, stats, enriched, biasAccuracy, bestTrade, worstTrade, violations, grade) {
  const tradeLines = enriched.length > 0
    ? enriched.map(t => {
        const rrStr  = t.rr1    ? ` | R:${t.rr1}`          : "";
        const dirStr = t.direction ? ` ${t.direction}` : "";
        const etStr  = t.entryTime ? ` (entered ${new Date(t.entryTime).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" })} ET)` : "";
        return `  Trade #${t.index}: ${t.setup || "Unknown"}${dirStr} | ${t.outcome}${rrStr}${etStr}`;
      }).join("\n")
    : "  No trades today";

  const biasLine = biasAccuracy?.available
    ? `Predicted: ${biasAccuracy.predicted} (${biasAccuracy.predictedConfidence}% confidence) | ` +
      `Actual: ${biasAccuracy.actual} (${biasAccuracy.nqChangePct >= 0 ? "+" : ""}${biasAccuracy.nqChangePct}%) | ${biasAccuracy.correctLabel}`
    : "Bias data unavailable";

  const violationLines = violations.length > 0
    ? violations.map(v => `  - [${v.severity}] ${v.detail}`).join("\n")
    : "  None";

  const bestLine  = bestTrade  ? `${bestTrade.tradeRef}: ${bestTrade.description}`  : "None";
  const worstLine = worstTrade ? `${worstTrade.tradeRef}: ${worstTrade.description}` : "None";

  return `You are a professional NQ futures trading coach. Review this session and provide sharp, specific feedback.

DATE: ${date}
SESSION: ${stats.totalTrades} trades | ${stats.wins}W ${stats.losses}L ${stats.breakevens}BE | Win rate: ${stats.winRate ?? 0}% | Grade: ${grade.grade}

DAILY BIAS:
${biasLine}

TRADES (chronological):
${tradeLines}

RISK VIOLATIONS:
${violationLines}

BEST TRADE: ${bestLine}
WORST TRADE: ${worstLine}

Return ONLY valid JSON — no markdown, no explanation outside the JSON:
{
  "mistakes": [
    { "trade": "#2 or null", "description": "exact description of the mistake — be specific" }
  ],
  "lessons": ["concrete lesson derived from today's actual data"],
  "improvementTomorrow": ["specific, actionable step for tomorrow's session"]
}

Rules: 2-4 mistakes (use null trade ref if session-level), 2-3 lessons, 2-3 improvements.
If the session was clean (grade A/A+), reflect that — fewer/no mistakes is fine.
Always reference actual trade numbers (#1, #2, etc.) when the mistake applies to a specific trade.
No generic platitudes — every item must be specific to today's data.`;
}

async function generateAISections(prompt) {
  try {
    const raw = await analyzeJSON(prompt, 700);

    // Validate structure
    const mistakes = Array.isArray(raw.mistakes)
      ? raw.mistakes.map(m => typeof m === "string"
          ? { trade: null, description: m }
          : { trade: m.trade || null, description: m.description || String(m) })
      : [];

    const lessons = Array.isArray(raw.lessons)
      ? raw.lessons.map(String)
      : [];

    const improvements = Array.isArray(raw.improvementTomorrow)
      ? raw.improvementTomorrow.map(String)
      : [];

    return { generated: true, mistakes, lessons, improvementTomorrow: improvements };
  } catch (err) {
    logger.warn(`[eodReview] AI section generation failed: ${err.message}`);
    return {
      generated: false,
      reason: err.message.includes("OPENAI_API_KEY")
        ? "OpenAI API key not configured — set OPENAI_API_KEY in .env to enable AI coaching"
        : `AI generation failed: ${err.message}`,
      mistakes:            [],
      lessons:             [],
      improvementTomorrow: [],
    };
  }
}

// ── Review Persistence ────────────────────────────────────────────

function reviewPath(date) {
  // date format "05/30/2026" → "2026-05-30" for the filename
  const [m, d, y] = date.split("/");
  return path.join(REVIEWS_DIR, `${y}-${m}-${d}.json`);
}

function saveReview(review) {
  try {
    if (!fs.existsSync(REVIEWS_DIR)) fs.mkdirSync(REVIEWS_DIR, { recursive: true });
    fs.writeFileSync(reviewPath(review.date), JSON.stringify(review, null, 2));
    logger.info(`[eodReview] Saved review for ${review.date}`);
  } catch (err) {
    logger.error(`[eodReview] Save failed: ${err.message}`);
  }
}

function loadReview(date) {
  try {
    const p = reviewPath(date);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    logger.warn(`[eodReview] Could not load review for ${date}: ${err.message}`);
  }
  return null;
}

function listReviews() {
  try {
    if (!fs.existsSync(REVIEWS_DIR)) return [];
    return fs.readdirSync(REVIEWS_DIR)
      .filter(f => f.endsWith(".json"))
      .sort()
      .reverse()
      .map(f => f.replace(".json", ""));
  } catch (err) {
    logger.warn(`[eodReview] Could not list reviews: ${err.message}`);
    return [];
  }
}

// ── Main Export ───────────────────────────────────────────────────

/**
 * Generate the end-of-day review.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.date]         — ET date "MM/DD/YYYY" (defaults to today)
 * @param {boolean} [opts.forceRefresh] — re-generate even if review already saved
 */
async function generateReview({ date, forceRefresh } = {}) {
  const targetDate = date || todayET();

  logger.info(`[eodReview] Generating review for ${targetDate}...`);

  // Return cached review unless forceRefresh
  if (!forceRefresh) {
    const cached = loadReview(targetDate);
    if (cached) {
      logger.info(`[eodReview] Returning cached review for ${targetDate}`);
      return cached;
    }
  }

  // ── 1. Load session data ──────────────────────────────────────
  const sessionData = loadSessionData(targetDate);
  const stats = {
    date:          sessionData.date,
    totalTrades:   sessionData.trades.length,
    wins:          sessionData.wins,
    losses:        sessionData.losses,
    breakevens:    sessionData.breakevens,
    winRate:       sessionData.trades.length > 0
      ? +((sessionData.wins / sessionData.trades.length) * 100).toFixed(1)
      : null,
  };

  // ── 2. Enrich trades with signal data ─────────────────────────
  const enriched = enrichTrades(sessionData.trades);

  // ── 3. Best / worst trade ─────────────────────────────────────
  const bestTrade  = findBestTrade(enriched);
  const worstTrade = findWorstTrade(enriched);

  // ── 4. Bias accuracy (async, non-blocking on failure) ─────────
  const biasAccuracy = await calcBiasAccuracy();

  // ── 5. Risk violations ────────────────────────────────────────
  const riskViolations = detectRiskViolations(enriched, stats);

  // ── 6. Session grade ──────────────────────────────────────────
  const sessionGrade = calcSessionGrade(stats, riskViolations);

  // ── 7. AI coaching sections ───────────────────────────────────
  const aiPrompt   = buildAIPrompt(targetDate, stats, enriched, biasAccuracy, bestTrade, worstTrade, riskViolations, sessionGrade);
  const aiSections = await generateAISections(aiPrompt);

  // ── 8. Assemble and save ──────────────────────────────────────
  const review = {
    date:         targetDate,
    generatedAt:  new Date().toISOString(),

    sessionGrade,

    session: {
      ...stats,
      finalStatus: stats.losses >= 3
        ? "HALTED"
        : stats.losses >= 2
          ? "RESTRICTED"
          : "NORMAL",
    },

    bestTrade,
    worstTrade,
    biasAccuracy,
    riskViolations,

    // AI coaching (may have generated: false if no OpenAI key)
    mistakes:            aiSections.mistakes,
    lessons:             aiSections.lessons,
    improvementTomorrow: aiSections.improvementTomorrow,
    aiMeta:              {
      generated: aiSections.generated,
      reason:    aiSections.generated ? null : aiSections.reason,
    },

    // Full trade log with signal context
    trades: enriched,
  };

  saveReview(review);

  logger.info(
    `[eodReview] Review complete — Grade: ${sessionGrade.grade} | ` +
    `${stats.wins}W ${stats.losses}L | AI: ${aiSections.generated}`
  );

  return review;
}

module.exports = { generateReview, loadReview, listReviews };
