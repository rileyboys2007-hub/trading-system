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
const tradeTracker   = require("./tradeTracker");
const { SIGNAL_STATUS } = require("../models/signal");

const { getDailyBias }          = require("../analysis/bias");
const { getKeyLevels }          = require("../analysis/levels");
const { getMarketInternals }    = require("../analysis/internals");
const { detectLiquiditySweeps } = require("../analysis/liquidity");
const { detectPlaybooks }       = require("../analysis/playbooks");
const { calculateVWAP }         = require("../analysis/vwap");
const { getTrendAlignment }     = require("../analysis/trendAlignment");
const { scoreSignal }           = require("../analysis/scoring");
const { makeDecision }          = require("../analysis/decision");
const { checkPreTrade }         = require("../analysis/riskManagement");
const { getNewsRisk }           = require("../services/newsRisk");

// ── Helpers ───────────────────────────────────────────────────────

/**
 * TradingView uses continuous-contract symbols like "NQ1!" but Yahoo Finance
 * requires "NQ=F". This mapping ensures all analysis modules that rely on
 * Yahoo Finance data (VWAP, liquidity, playbooks, levels, trend) get real
 * data instead of failing silently and falling back to neutral defaults.
 */
const TV_TO_YAHOO = {
  "NQ1!":  "NQ=F",
  "MNQ1!": "NQ=F",   // Micro NQ — same underlying
  "ES1!":  "ES=F",
  "MES1!": "ES=F",   // Micro ES
  "YM1!":  "YM=F",
  "MYM1!": "YM=F",   // Micro YM
  "RTY1!": "RTY=F",
  "M2K1!": "RTY=F",  // Micro Russell
  "CL1!":  "CL=F",
  "GC1!":  "GC=F",
  "SI1!":  "SI=F",
  "ZB1!":  "ZB=F",
};

function toYahooSymbol(tvSymbol) {
  return TV_TO_YAHOO[tvSymbol] || tvSymbol;
}

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

// ── TradingView-Native Module Builders ───────────────────────────
// Pine Script sends real-time NQ data in the webhook payload.
// These functions build the exact same shaped objects that the Yahoo Finance
// modules would return — so the scoring engine receives identical inputs —
// but sourced from TradingView's live feed instead of a 15-min delayed Yahoo quote.
//
// Fallback: if the required fields aren't present (old payload or pre-update Pine Script),
// each builder returns null and alertService falls back to Yahoo Finance automatically.

/**
 * VWAP — from vp (price), vslope, vpos sent by Pine Script.
 * When vwapPos is provided by Pine Script it is used as-is.
 * Otherwise position is derived from distance vs ATR.
 */
function buildTVVwap(signal) {
  if (!signal.vwapPrice) return null;

  const vwap         = signal.vwapPrice;
  const currentPrice = signal.entry;
  const distancePts  = +Math.abs(currentPrice - vwap).toFixed(2);
  const aboveVWAP    = currentPrice > vwap;

  const position = signal.vwapPos || (() => {
    const far = (signal.atr || 20) * 0.75;
    if (distancePts <= 3)                     return "AT";
    if (aboveVWAP && distancePts > far)       return "FAR_ABOVE";
    if (aboveVWAP)                            return "ABOVE";
    if (!aboveVWAP && distancePts > far)      return "FAR_BELOW";
    return "BELOW";
  })();

  return {
    vwap:         +vwap.toFixed(2),
    currentPrice: +currentPrice.toFixed(2),
    aboveVWAP,
    position,
    slopeDir:     signal.vwapSlope || "FLAT",
    distancePts,
    source:       "TradingView",
  };
}

/**
 * Key Levels — from pdh/pdl/pdc/onh/onl/orh/orl/pmh/pml sent by Pine Script.
 * Returns null if pdh isn't present (levels not yet populated by Pine Script update).
 */
function buildTVLevels(signal) {
  if (signal.pdh == null) return null;

  const entry  = signal.entry;
  const levels = [
    signal.pdh != null && { name: "PDH", price: signal.pdh, type: "resistance" },
    signal.pdl != null && { name: "PDL", price: signal.pdl, type: "support"    },
    signal.pdc != null && { name: "PDC", price: signal.pdc, type: "pivot"      },
    signal.onh != null && { name: "ONH", price: signal.onh, type: "resistance" },
    signal.onl != null && { name: "ONL", price: signal.onl, type: "support"    },
    signal.orh != null && { name: "ORH", price: signal.orh, type: "resistance" },
    signal.orl != null && { name: "ORL", price: signal.orl, type: "support"    },
    signal.pmh != null && { name: "PMH", price: signal.pmh, type: "resistance" },
    signal.pml != null && { name: "PML", price: signal.pml, type: "support"    },
  ]
    .filter(Boolean)
    .map(l => ({ ...l, distance: +Math.abs(l.price - entry).toFixed(2) }))
    .sort((a, b) => a.distance - b.distance);

  const nearestResistance = levels.find(l => l.type === "resistance" && l.price > entry) || null;
  const nearestSupport    = levels.find(l => l.type === "support"    && l.price < entry) || null;

  return { levels, nearestResistance, nearestSupport, source: "TradingView" };
}

/**
 * Liquidity Sweep — derived from the setup name, which encodes the swept level.
 * Every sweep setup fired by Pine Script IS a confirmed sweep + rejection.
 * Non-sweep setups (ORB, pullback) return an empty result, not null, so Yahoo
 * Finance is never called for these either.
 * Rejection strength is parsed from the notes field ("rej=85%").
 */
function buildTVSweep(signal) {
  const SWEEP_LEVELS = {
    PDH_SWEEP_REVERSAL_SHORT:  "PDH",
    PDL_SWEEP_REVERSAL_LONG:   "PDL",
    ONH_SWEEP_REVERSAL_SHORT:  "ONH",
    ONL_SWEEP_REVERSAL_LONG:   "ONL",
    ORH_SWEEP_REVERSAL_SHORT:  "ORH",
    ORL_SWEEP_REVERSAL_LONG:   "ORL",
    PMH_SWEEP_REVERSAL_SHORT:  "PMH",
    PML_SWEEP_REVERSAL_LONG:   "PML",
  };

  const level = SWEEP_LEVELS[signal.setup];
  if (!level) {
    // ORB, pullback, continuation — no sweep; empty valid result (not null)
    return { activeSignal: null, sweepCount: 0, rejections: [], source: "TradingView" };
  }

  // Parse rejection strength from notes: "PDH swept 3.5pts rej=85%"
  const rejMatch         = signal.notes?.match(/rej=(\d+)%/);
  const rejectionStrength = rejMatch ? parseInt(rejMatch[1], 10) / 100 : 0.70;

  const sweepSignal = {
    result:            "REJECTED",
    impliedBias:       signal.direction,
    level,
    rejectionStrength,
    barsAgo:           0,
  };

  return {
    activeSignal: sweepSignal,
    sweepCount:   1,
    rejections:   [sweepSignal],
    source:       "TradingView",
  };
}

/**
 * Playbook — derived from the setup name.
 * Pine Script already ran the playbook detection; we just map the setup
 * name to the shape scoring.js expects.
 */
function buildTVPlaybook(signal) {
  const SETUP_TO_PLAYBOOK = {
    PDH_SWEEP_REVERSAL_SHORT:          { name: "PDH Sweep Reversal",                confidence: 82 },
    PDL_SWEEP_REVERSAL_LONG:           { name: "PDL Sweep Reversal",                confidence: 82 },
    ONH_SWEEP_REVERSAL_SHORT:          { name: "ONH Sweep Reversal",                confidence: 78 },
    ONL_SWEEP_REVERSAL_LONG:           { name: "ONL Sweep Reversal",                confidence: 78 },
    ORH_SWEEP_REVERSAL_SHORT:          { name: "ORH Sweep Reversal",                confidence: 76 },
    ORL_SWEEP_REVERSAL_LONG:           { name: "ORL Sweep Reversal",                confidence: 76 },
    PMH_SWEEP_REVERSAL_SHORT:          { name: "PMH Sweep Reversal",                confidence: 74 },
    PML_SWEEP_REVERSAL_LONG:           { name: "PML Sweep Reversal",                confidence: 74 },
    BULLISH_ORB_LONG:                  { name: "Bullish Opening Range Breakout",    confidence: 80 },
    BEARISH_ORB_SHORT:                 { name: "Bearish Opening Range Breakout",    confidence: 80 },
    ONH_BREAKOUT_CONTINUATION_LONG:    { name: "ONH Breakout Continuation",         confidence: 75 },
    ONL_BREAKDOWN_CONTINUATION_SHORT:  { name: "ONL Breakdown Continuation",        confidence: 75 },
    BULLISH_TREND_PULLBACK_LONG:       { name: "Bullish Trend Pullback",            confidence: 70 },
    BEARISH_TREND_PULLBACK_SHORT:      { name: "Bearish Trend Pullback",            confidence: 70 },
  };

  const info = SETUP_TO_PLAYBOOK[signal.setup];
  if (!info) {
    return { primaryMatch: null, matchedPlaybooks: [], allPlaybooks: [], source: "TradingView" };
  }

  const match = { name: info.name, direction: signal.direction, confidence: info.confidence };
  return {
    primaryMatch:     match,
    matchedPlaybooks: [match],
    allPlaybooks:     [match],
    source:           "TradingView",
  };
}

// ── Immediate Signal Notification ────────────────────────────────
/**
 * Builds and sends a Discord embed the moment a signal is received —
 * BEFORE any AI analysis runs. This ensures the entry/SL/TP prices shown
 * in Discord match what the TradingView bar-close fired, rather than
 * drifting by the 8+ second analysis pipeline latency.
 *
 * A second "analysis" embed is sent afterward (only for TAKE / STRONG TAKE)
 * with the full score, bias, session quality, etc.
 */
function buildImmediateSignalMessage(signal) {
  const { symbol, direction, setup, entry, sl, tp1, tp2, slPoints, rr1, rr2 } = signal;
  const dirIcon = direction === "LONG" ? "🟢" : "🔴";
  const title   = `⚡ ${symbol} ${dirIcon} ${direction} — Signal Received`;

  // Human-readable setup name: PDH_SWEEP_REVERSAL_SHORT → PDH Sweep Reversal Short
  const setupLabel = (setup || "Unknown")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());

  const fields = [
    {
      name:   "📋 Setup",
      value:  setupLabel,
      inline: false,
    },
    {
      name:   "🎯 Trade Levels",
      value:  [
        `Entry: **${entry}**`,
        `SL:    ${sl}  (${slPoints ?? "?"} pts risk)`,
        `TP1:   ${tp1}  (R:${rr1 ?? "?"})`,
        `TP2:   ${tp2}  (R:${rr2 ?? "?"})`,
      ].join("\n"),
      inline: false,
    },
    {
      name:   "⏳ Analysis",
      value:  "Running AI analysis… score + decision coming shortly",
      inline: false,
    },
  ];

  return {
    title,
    description: "Prices captured at bar close — act quickly or wait for the analysis.",
    color:  direction === "LONG" ? "long" : "short",
    fields,
  };
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

// ── Phase 1 Quality Filters ───────────────────────────────────────
// Applied BEFORE any Discord message or expensive analysis runs.
// Goal: only pass signals that have a realistic chance of being A+ setups.

/**
 * Parse the 4H trend from the MTF context string sent by Pine Script.
 * Format: "4H:bull|1H:bull|15m:bear"
 * Returns "bull", "bear", or null if the field is missing.
 */
function parse4HTrend(mtfStr) {
  const m = (mtfStr || "").match(/4H:(bull|bear)/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Returns true if the signal arrived during a high-probability session window.
 * Windows (ET):
 *   9:30 – 11:00 AM  — opening range expansion / morning momentum
 *   2:30 –  4:00 PM  — afternoon momentum / power hour
 */
function inHighProbSession(isoTimestamp) {
  const dt    = new Date(isoTimestamp);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(dt);
  const h    = Number(parts.find(p => p.type === "hour").value);
  const m    = Number(parts.find(p => p.type === "minute").value);
  const mins = h * 60 + m;
  const MORNING_START    = 9  * 60 + 30;  // 570 min
  const MORNING_END      = 11 * 60;       // 660 min
  const AFTERNOON_START  = 14 * 60 + 30;  // 870 min
  const AFTERNOON_END    = 16 * 60;       // 960 min
  return (mins >= MORNING_START && mins < MORNING_END) ||
         (mins >= AFTERNOON_START && mins < AFTERNOON_END);
}

/**
 * Setup types blocked until outcome data proves they have edge.
 * BULLISH/BEARISH_TREND_PULLBACK signals are pure trend-follow momentum plays
 * that generate noise in choppy sessions and lack a clear sweep/reversal anchor.
 */
const BLOCKED_SETUP_TYPES = new Set([
  "BULLISH_TREND_PULLBACK_LONG",
  "BEARISH_TREND_PULLBACK_SHORT",
]);

// ── Main Pipeline ─────────────────────────────────────────────────

async function process(signal) {
  const startAt = Date.now();
  logger.info(`[alertService] Processing ${signal.id} | ${signal.symbol} ${signal.setup} ${signal.direction}`);

  signalStore.update(signal.id, { status: SIGNAL_STATUS.ANALYZING });

  try {
    // ── Step 1: News gate — abort before expensive calls if EXTREME ──
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

    // ── Step 1b: 4H trend hard filter ────────────────────────────────
    // Block any trade that goes against the 4-hour trend.
    // 4H is the highest-confidence trend available from Pine Script.
    // Counter-trend trades on 5m have far lower win rates at current thresholds.
    const trend4H = parse4HTrend(signal.mtf);
    if (trend4H) {
      const counterTrend = (signal.direction === "LONG"  && trend4H === "bear") ||
                           (signal.direction === "SHORT" && trend4H === "bull");
      if (counterTrend) {
        logger.info(`[alertService] 4H BLOCK — ${signal.direction} signal vs 4H:${trend4H} — ${signal.id}`);
        signalStore.update(signal.id, { status: SIGNAL_STATUS.FILTERED, filteredBy: "4H_COUNTER_TREND" });
        return { signalId: signal.id, decision: "FILTERED", reason: `4H counter-trend (4H:${trend4H})` };
      }
    }

    // ── Step 1c: Session window filter ───────────────────────────────
    // Only process signals inside high-probability windows.
    // Outside these windows signals are more likely to be chop / low-conviction.
    if (!inHighProbSession(signal.receivedAt)) {
      const etStr = new Date(signal.receivedAt).toLocaleTimeString("en-US", {
        timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: true,
      });
      logger.info(`[alertService] SESSION BLOCK — ${etStr} ET outside 9:30–11:00 AM / 2:30–4:00 PM windows — ${signal.id}`);
      signalStore.update(signal.id, { status: SIGNAL_STATUS.FILTERED, filteredBy: "SESSION_WINDOW" });
      return { signalId: signal.id, decision: "FILTERED", reason: `Outside session window (${etStr} ET)` };
    }

    // ── Step 1d: Blocked setup types ─────────────────────────────────
    // Trend-pullback setups have no sweep/reversal anchor.
    // Block until we have enough outcome data to prove they have edge.
    if (BLOCKED_SETUP_TYPES.has(signal.setup)) {
      logger.info(`[alertService] SETUP BLOCK — ${signal.setup} is disabled pending outcome data — ${signal.id}`);
      signalStore.update(signal.id, { status: SIGNAL_STATUS.FILTERED, filteredBy: "BLOCKED_SETUP" });
      return { signalId: signal.id, decision: "FILTERED", reason: `Setup blocked: ${signal.setup}` };
    }

    // ── Step 2: Send IMMEDIATE signal notification (before 8-sec analysis) ──
    // Entry/SL/TP are captured from the Pine Script bar-close — these are the
    // accurate prices. Sending now avoids the latency drift caused by analysis.
    const imm = buildImmediateSignalMessage(signal);
    await discord.send(imm.title, imm.description, imm.color, imm.fields);

    // ── Step 3: Run all analysis modules in parallel ─────────────
    // Pine Script sends "NQ1!" but Yahoo Finance requires "NQ=F".
    // Translate before passing to any Yahoo-Finance-backed module so they
    // get real data instead of silently falling back to neutral defaults.
    const yahooSym = toYahooSymbol(signal.symbol);

    // If Pine Script sent t5/t15/t60, build a trendData object from those values
    // directly — TradingView's own EMA calculation is real-time and more accurate
    // than a delayed Yahoo Finance fetch. Fall back to Yahoo only if TV data absent.
    const tvTrend = (signal.trend5m || signal.trend15m || signal.trend1h) ? {
      trend5m:      signal.trend5m  || "NEUTRAL",
      trend15m:     signal.trend15m || "NEUTRAL",
      trend1H:      signal.trend1h  || "NEUTRAL",
      source:       "TradingView",
      calculatedAt: new Date().toISOString(),
    } : null;

    if (tvTrend) {
      logger.info(`[alertService] TV trend — 5m: ${tvTrend.trend5m} | 15m: ${tvTrend.trend15m} | 1H: ${tvTrend.trend1H}`);
    }

    // Build TradingView-native objects from the webhook payload.
    // Sweep and playbook are ALWAYS available (derived from the setup name alone).
    // VWAP and levels require the updated Pine Script that sends vp/pdh/etc.
    const tvVwap     = buildTVVwap(signal);
    const tvLevels   = buildTVLevels(signal);
    const tvSweep    = buildTVSweep(signal);
    const tvPlaybook = buildTVPlaybook(signal);

    if (tvVwap)                  logger.info(`[alertService] TV VWAP  — ${tvVwap.vwap} | pos: ${tvVwap.position} | slope: ${tvVwap.slopeDir} | dist: ${tvVwap.distancePts}pts`);
    else                         logger.info(`[alertService] TV VWAP  — no vp field, falling back to Yahoo Finance`);
    if (tvLevels)                logger.info(`[alertService] TV Levels — ${tvLevels.levels.map(l => `${l.name}:${l.price}`).join(" | ")}`);
    else                         logger.info(`[alertService] TV Levels — no pdh field, falling back to Yahoo Finance`);
    if (tvSweep.activeSignal)    logger.info(`[alertService] TV Sweep  — ${tvSweep.activeSignal.level} rej:${(tvSweep.activeSignal.rejectionStrength * 100).toFixed(0)}%`);
    else                         logger.info(`[alertService] TV Sweep  — no sweep (${signal.setup})`);
    logger.info(`[alertService] TV Playbook — ${tvPlaybook.primaryMatch?.name ?? "unknown setup"}`);

    const [bias, levels, internals, sweepResult, playbookResult, vwapData, trendData] = await Promise.all([
      safe("bias",      () => getDailyBias()),
      tvLevels   ? Promise.resolve(tvLevels)   : safe("levels",    () => getKeyLevels(yahooSym)),
      safe("internals", () => getMarketInternals()),
      // Sweep and playbook always use TV data — setup name is all we need
      Promise.resolve(tvSweep),
      Promise.resolve(tvPlaybook),
      tvVwap     ? Promise.resolve(tvVwap)     : safe("vwap",      () => calculateVWAP(yahooSym)),
      tvTrend    ? Promise.resolve(tvTrend)    : safe("trend",     () => getTrendAlignment(yahooSym)),
    ]);

    // ── Step 4: Score and decide ──────────────────────────────────
    const scoreResult = await safe("scoring", () => scoreSignal({
      direction: signal.direction,
      symbol:    yahooSym,  // normalized so any internal re-fetches also use Yahoo symbol
      bias,
      internals,
      sweep:     sweepResult,
      playbook:  playbookResult,
      vwap:      vwapData,
      newsRisk:  newsCheck,
      trend:     trendData,     // pass pre-fetched trend — avoids duplicate API call
    }));

    const decision = await safe("decision", () => makeDecision({
      direction:   signal.direction,
      symbol:      signal.symbol,
      scoreResult: scoreResult ?? undefined,
    }));

    // ── Step 5: Risk gate ─────────────────────────────────────────
    const resolvedRisk = await safe("risk", () => Promise.resolve(
      checkPreTrade({
        tradeScore: scoreResult?.totalScore,
        tradeGrade: scoreResult?.grade,
        direction:  signal.direction,
        symbol:     signal.symbol,
      })
    ));

    // ── Step 6: Update signal status ──────────────────────────────
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

    // ── Step 7: Always send analysis follow-up ───────────────────────
    // The immediate message (Step 2) delivered the accurate entry/SL/TP prices.
    // Now deliver the full analysis — score, grade, bias, session, risk — for
    // every decision so the user can judge whether to take the trade.
    if (decision) {
      const { title, description, color, fields } = buildDiscordMessage(
        signal,
        decision,
        scoreResult ?? { grade: "?", totalScore: 0, recommendation: "No score", factors: {} },
        resolvedRisk,
        levels,
        vwapData,
      );

      const finalTitle = blocked
        ? `🛑 RISK BLOCKED — was ${title}`
        : title;

      await discord.send(finalTitle, description, color, fields);
    }

    // ── Step 8: Record actionable trades for outcome tracking ─────────
    // Only record if the signal passed the risk gate AND scored high enough
    // to be a TAKE or STRONG TAKE. The price poller will watch these and
    // fire Discord notifications when TP1, TP2, or SL is hit.
    if (!blocked && (finalDecision === "TAKE" || finalDecision === "STRONG TAKE")) {
      tradeTracker.recordTrade(signal, decision, scoreResult ?? null);
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
