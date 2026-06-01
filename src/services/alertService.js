/**
 * services/alertService.js — Alert Orchestrator
 *
 * Called by the webhook route every time TradingView fires a signal.
 * Runs the full analysis pipeline and sends a Discord alert if actionable.
 *
 * Pipeline:
 *  1. Daily Bias
 *  2. Key Levels
 *  3. Market Internals
 *  4. Liquidity Sweep
 *  5. Playbook Match
 *  6. Scoring + Decision
 *  7. Risk Gate
 *  8. Discord Notification (TAKE / STRONG TAKE only)
 */

const logger         = require("../utils/logger");
const signalStore    = require("./signalStore");
const discord        = require("./discordService");
const { SIGNAL_STATUS } = require("../models/signal");

const { getDailyBias }          = require("../analysis/bias");
const { getKeyLevels }          = require("../analysis/levels");
const { getMarketInternals }    = require("../analysis/internals");
const { detectLiquiditySweeps } = require("../analysis/liquidity");
const { detectPlaybooks }       = require("../analysis/playbooks");
const { calculateVWAP }         = require("../analysis/vwap");
const { scoreSignal }           = require("../analysis/scoring");
const { makeDecision }          = require("../analysis/decision");
const { checkPreTrade }         = require("../analysis/riskManagement");
const { getNewsRisk }           = require("../services/newsRisk");

// ── Helpers ───────────────────────────────────────────────────────

function safe(label, fn) {
  return fn().catch(err => {
    logger.warn(`[alertService] ${label} failed: ${err.message}`);
    return null;
  });
}

function decisionEmoji(decision) {
  const map = {
    "STRONG TAKE": "🔥",
    "TAKE":        "✅",
    "WAIT":        "⏳",
    "AVOID":       "❌",
  };
  return map[decision] || "❓";
}

function directionColor(direction, decision) {
  if (decision === "AVOID" || decision === "WAIT") return "warning";
  return direction === "LONG" ? "long" : "short";
}

// ── Discord Message Builder ───────────────────────────────────────

function buildDiscordMessage(signal, decision, scoreResult, riskCheck, levels, vwapData) {
  const { direction, entry, sl, tp1, tp2, symbol, setup, rr1, rr2, slPoints } = signal;
  const emoji  = decisionEmoji(decision.decision);
  const color  = directionColor(direction, decision.decision);

  const title = `${emoji} ${decision.decision} — ${symbol} ${direction}`;
  const description = decision.primaryReason;

  const fields = [
    {
      name:   "📊 Score",
      value:  `**${scoreResult.grade}** — ${scoreResult.totalScore}/100\n${scoreResult.recommendation}`,
      inline: true,
    },
    {
      name:   "⏱ Session",
      value:  scoreResult.factors?.sessionQuality?.session || "—",
      inline: true,
    },
    {
      name:   "🎯 Levels",
      value:  `Entry: **${entry}**\nSL: ${sl || "—"} (${slPoints || "—"} pts)\nTP1: ${tp1 || "—"} (R:${rr1 || "—"})\nTP2: ${tp2 || "—"} (R:${rr2 || "—"})`,
      inline: false,
    },
  ];

  // Reasons for
  if (decision.reasons?.for?.length > 0) {
    fields.push({
      name:   "✓ Supporting",
      value:  decision.reasons.for.slice(0, 3).map(r => `• ${r}`).join("\n"),
      inline: false,
    });
  }

  // Reasons against
  if (decision.reasons?.against?.length > 0) {
    fields.push({
      name:   "✗ Against",
      value:  decision.reasons.against.slice(0, 2).map(r => `• ${r}`).join("\n"),
      inline: false,
    });
  }

  // Risk gate
  const riskLine = riskCheck
    ? `${riskCheck.sessionStatus} | Losses today: ${riskCheck.stats?.losses ?? 0} | ${riskCheck.requiresAPlus ? "⚠️ A+ only" : "✓ Clear"}`
    : "Risk check unavailable";
  fields.push({
    name:   "🛡 Risk Gate",
    value:  riskLine,
    inline: false,
  });

  // VWAP field
  if (vwapData) {
    fields.push({
      name:   "📈 VWAP",
      value:  `${vwapData.vwap} | Price ${vwapData.position} by ${vwapData.distancePts} pts | Slope: ${vwapData.slopeDir}`,
      inline: false,
    });
  }

  // Nearest key levels if available
  if (levels) {
    const res = levels.nearestResistance;
    const sup = levels.nearestSupport;
    if (res || sup) {
      fields.push({
        name:   "📐 Key Levels",
        value:  [
          res ? `Resistance: ${res.name} @ ${res.price} (${res.distance} pts away)` : null,
          sup ? `Support: ${sup.name} @ ${sup.price} (${sup.distance} pts away)` : null,
        ].filter(Boolean).join("\n"),
        inline: false,
      });
    }
  }

  // Blocking rules
  if (decision.blockedBy?.length > 0) {
    fields.push({
      name:   "🚫 Blocked By",
      value:  decision.blockedBy.map(b => `• ${b.label}`).join("\n"),
      inline: false,
    });
  }

  fields.push({
    name:   "🏷 Setup",
    value:  setup || "Unknown",
    inline: true,
  });
  fields.push({
    name:   "🟢 Green Factors",
    value:  `${decision.greenFactors}/${decision.totalFactors}`,
    inline: true,
  });

  return { title, description, color, fields };
}

// ── Main Pipeline ─────────────────────────────────────────────────

async function process(signal) {
  const startAt = Date.now();
  logger.info(`[alertService] Processing ${signal.id} | ${signal.symbol} ${signal.setup} ${signal.direction}`);

  signalStore.update(signal.id, { status: SIGNAL_STATUS.ANALYZING });

  try {
    // ── News gate first — abort before expensive calls if EXTREME ──
    const newsCheck = await safe("news", () => getNewsRisk());
    if (newsCheck?.riskLevel === "EXTREME") {
      await discord.send(
        `⛔ NEWS BLOCK — ${signal.symbol} ${signal.direction}`,
        `TradingView alert received but blocked: ${newsCheck.explanation}`,
        "warning",
        [{ name: "📅 Event", value: newsCheck.nextEvent?.title ?? "Unknown event", inline: false }]
      );
      signalStore.update(signal.id, { status: SIGNAL_STATUS.RECEIVED, newsBlocked: true });
      return { signalId: signal.id, decision: "AVOID", newsBlocked: true };
    }

    // ── Run all modules in parallel ──────────────────────────────
    const [bias, levels, internals, sweepResult, playbookResult, vwapData] = await Promise.all([
      safe("bias",      () => getDailyBias()),
      safe("levels",    () => getKeyLevels(signal.symbol)),
      safe("internals", () => getMarketInternals()),
      safe("liquidity", () => detectLiquiditySweeps({ direction: signal.direction, symbol: signal.symbol })),
      safe("playbooks", () => detectPlaybooks(signal.symbol)),  // fixed: pass string, not object
      safe("vwap",      () => calculateVWAP(signal.symbol)),
    ]);

    // ── Score and decide ─────────────────────────────────────────
    const scoreResult = await safe("scoring", () => scoreSignal({
      direction: signal.direction,
      symbol:    signal.symbol,
      bias,
      internals,
      sweep:     sweepResult,      // fixed: full result, not raw activeSignal
      playbook:  playbookResult,   // fixed: full result, not bestMatch
      vwap:      vwapData,
      newsRisk:  newsCheck,
    }));

    const decision = await safe("decision", () => makeDecision({
      direction:   signal.direction,
      symbol:      signal.symbol,
      scoreResult: scoreResult ?? undefined,
    }));

    // ── Risk gate ─────────────────────────────────────────────────
    const riskCheck = safe("risk", () => Promise.resolve(
      checkPreTrade({
        tradeScore: scoreResult?.totalScore,
        tradeGrade: scoreResult?.grade,
        direction:  signal.direction,
        symbol:     signal.symbol,
      })
    ));

    const resolvedRisk = await riskCheck;

    // ── Update signal status ──────────────────────────────────────
    const finalDecision = decision?.decision ?? "UNKNOWN";
    const blocked       = resolvedRisk && !resolvedRisk.allowed;

    signalStore.update(signal.id, {
      status:    SIGNAL_STATUS.VALID,
      decision:  finalDecision,
      score:     scoreResult?.totalScore ?? null,
      grade:     scoreResult?.grade ?? null,
      riskBlocked: blocked,
      analyzedAt: new Date().toISOString(),
    });

    const elapsed = Date.now() - startAt;
    logger.info(
      `[alertService] ${signal.id} → ${finalDecision} | ` +
      `Score: ${scoreResult?.totalScore ?? "N/A"} | ` +
      `Risk: ${blocked ? "BLOCKED" : "CLEAR"} | ` +
      `${elapsed}ms`
    );

    // ── Send Discord notification ────────────────────────────────
    // Send for TAKE and STRONG TAKE (unless risk blocked)
    // Also send WAIT/AVOID so you know the signal was evaluated

    if (decision) {
      const { title, description, color, fields } = buildDiscordMessage(
        signal,
        decision,
        scoreResult ?? { grade: "?", totalScore: 0, recommendation: "No score", factors: {} },
        resolvedRisk,
        levels,
        vwapData,
      );

      // Add risk block warning to title if blocked
      const finalTitle = blocked
        ? `🛑 RISK BLOCKED — was ${title}`
        : title;

      await discord.send(finalTitle, description, color, fields);
    }

    return {
      signalId:  signal.id,
      decision:  finalDecision,
      score:     scoreResult?.totalScore ?? null,
      grade:     scoreResult?.grade ?? null,
      riskBlocked: blocked,
      elapsed,
    };

  } catch (err) {
    logger.error(`[alertService] Pipeline failed for ${signal.id}: ${err.message}`);
    signalStore.update(signal.id, { status: SIGNAL_STATUS.RECEIVED });
    return { signalId: signal.id, error: err.message };
  }
}

module.exports = { process };
