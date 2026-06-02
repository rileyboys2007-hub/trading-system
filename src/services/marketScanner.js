/**
 * services/marketScanner.js — Automatic Market Scanner
 *
 * Runs runScan() every 5 minutes during RTH (9:30–4:00 ET, weekdays).
 * Sends Discord alerts when a TAKE or STRONG TAKE is detected.
 *
 * Deduplication: cooldown per direction+level combo (default 30 min).
 * Only starts if DISCORD_WEBHOOK is configured — scanning without Discord is pointless.
 */

const logger        = require("../utils/logger");
const discord       = require("./discordService");
const { runScan, isRTH } = require("../analysis/scanner");
const tradeTracker  = require("./tradeTracker");

// ── Config ────────────────────────────────────────────────────────

const SCAN_INTERVAL_MS  = 5 * 60 * 1000;   // 5 minutes
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;  // 30 min per setup
const SYMBOL            = "NQ=F";

// ── State ─────────────────────────────────────────────────────────

let intervalHandle  = null;
let lastScanAt      = null;
let lastScanResult  = null;
let scanCount       = 0;
let alertCount      = 0;
const cooldowns     = new Map();   // key → timestamp last alerted

// ── Helpers ───────────────────────────────────────────────────────

function dedupKey(result) {
  const level = result.triggers?.sweep?.level ?? "no-sweep";
  return `${result.symbol}_${result.direction}_${level}`;
}

function isCoolingDown(key) {
  const last = cooldowns.get(key);
  if (!last) return false;
  return Date.now() - last < ALERT_COOLDOWN_MS;
}

function decisionEmoji(d) {
  return { "STRONG TAKE": "🔥", "TAKE": "✅", "WAIT": "⏳", "AVOID": "❌" }[d] || "❓";
}

function dirColor(direction, decision) {
  if (["AVOID", "WAIT"].includes(decision)) return "warning";
  return direction === "LONG" ? "long" : "short";
}

// ── Discord Builder ───────────────────────────────────────────────

async function sendAlert(result) {
  const { direction, signal, scoreResult, decision, riskCheck, levels, vwap, trend, atr, triggerSummary } = result;
  const dec     = decision.decision;
  const emoji   = decisionEmoji(dec);
  const color   = dirColor(direction, dec);
  const blocked = riskCheck && !riskCheck.allowed;

  const title = blocked
    ? `🛑 RISK BLOCKED (was ${dec}) — ${SYMBOL} ${direction}`
    : `${emoji} ${dec} — ${SYMBOL} ${direction}`;

  const description = decision.primaryReason || triggerSummary;

  const priceTag = levels?.priceSource === "bid_ask_mid"   ? "🟢 live"
                 : levels?.priceSource === "quote_delayed" ? "🟡 ~10m delay"
                 : "🔴 bar close";

  const fields = [
    {
      name:   "📊 Score",
      value:  `**${scoreResult?.grade ?? "?"}** — ${scoreResult?.totalScore ?? "N/A"}/100`,
      inline: true,
    },
    {
      name:   "⏱ Session",
      value:  scoreResult?.factors?.sessionQuality?.session ?? "—",
      inline: true,
    },
    {
      name:   "🎯 Suggested Levels",
      value:  [
        `Entry: **${signal.entry}** ${priceTag}`,
        `SL: ${signal.sl} (${signal.slPoints} pts)`,
        `TP1: ${signal.tp1} (R:${signal.rr1})`,
        `TP2: ${signal.tp2} (R:${signal.rr2})`,
        signal.slNote ? `⚠️ ${signal.slNote}` : null,
      ].filter(Boolean).join("\n"),
      inline: false,
    },
    {
      name:   "🔍 Triggers",
      value:  triggerSummary || "—",
      inline: false,
    },
    ...(vwap ? [{
      name:   "📈 VWAP",
      value:  `${vwap.vwap} | ${vwap.position} by ${vwap.distancePts} pts | Slope: ${vwap.slopeDir}`,
      inline: true,
    }] : []),
    ...(trend ? [{
      name:   "🕐 Trend",
      value:  `1H: **${trend.trend1H}** | 15m: **${trend.trend15m}**${trend.aligned ? " ✓" : ""}`,
      inline: true,
    }] : []),
    ...(atr ? [{
      name:   "📏 ATR",
      value:  `${atr.atr} pts (5m) → SL buffer: ${atr.suggestedSL} pts`,
      inline: true,
    }] : []),
  ];

  if (decision.reasons?.for?.length > 0) {
    fields.push({
      name:   "✓ Supporting",
      value:  decision.reasons.for.slice(0, 3).map(r => `• ${r}`).join("\n"),
      inline: false,
    });
  }

  if (decision.reasons?.against?.length > 0) {
    fields.push({
      name:   "✗ Against",
      value:  decision.reasons.against.slice(0, 2).map(r => `• ${r}`).join("\n"),
      inline: false,
    });
  }

  if (riskCheck) {
    fields.push({
      name:   "🛡 Risk Gate",
      value:  `${riskCheck.sessionStatus} | Losses: ${riskCheck.stats?.losses ?? 0} | ${riskCheck.requiresAPlus ? "⚠️ A+ only" : "✓ Clear"}`,
      inline: false,
    });
  }

  if (levels?.nearestResistance || levels?.nearestSupport) {
    fields.push({
      name:   "📐 Key Levels",
      value:  [
        levels.nearestResistance ? `Resistance: ${levels.nearestResistance.name} @ ${levels.nearestResistance.price}` : null,
        levels.nearestSupport    ? `Support: ${levels.nearestSupport.name} @ ${levels.nearestSupport.price}`       : null,
      ].filter(Boolean).join("\n"),
      inline: false,
    });
  }

  if (decision.blockedBy?.length > 0) {
    fields.push({
      name:   "🚫 Blocked By",
      value:  decision.blockedBy.map(b => `• ${b.label}`).join("\n"),
      inline: false,
    });
  }

  // Append running win rate to every alert
  fields.push({
    name:   "📈 Win Rate",
    value:  tradeTracker.recordLine(),
    inline: false,
  });

  await discord.send(title, description, color, fields);
  alertCount++;
  logger.info(`[marketScanner] Discord alert sent: ${dec} ${direction} | total alerts today: ${alertCount}`);

  // Record trade for outcome tracking
  try {
    tradeTracker.recordTrade(signal, result.decision, result.scoreResult);
  } catch (err) {
    logger.warn(`[marketScanner] Trade tracker record failed: ${err.message}`);
  }
}

// ── Outcome Discord Notifications ─────────────────────────────────

async function notifyOutcome(update) {
  const { trade, event } = update;
  const stats = tradeTracker.getStats().summary;
  const record = tradeTracker.recordLine();

  let title, color, pnlStr;

  const pnl = trade.pnlPoints;
  pnlStr = pnl != null ? `${pnl >= 0 ? "+" : ""}${pnl} pts` : "—";

  if (event === "TP2_HIT") {
    title = `✅ FULL WIN — ${trade.symbol} ${trade.direction} | ${pnlStr}`;
    color = "long";
  } else if (event === "TP1_HIT") {
    title = `🟡 TP1 HIT — ${trade.symbol} ${trade.direction} | Still running to TP2...`;
    color = trade.direction === "LONG" ? "long" : "short";
  } else if (event === "SL_HIT") {
    title = `🔴 STOPPED OUT — ${trade.symbol} ${trade.direction} | ${pnlStr}`;
    color = "warning";
  } else if (event === "SL_HIT_AFTER_TP1") {
    title = `🟡 PARTIAL WIN — ${trade.symbol} ${trade.direction} | TP1 banked | ${pnlStr}`;
    color = trade.direction === "LONG" ? "long" : "short";
  } else if (event === "EXPIRED") {
    title = `⏰ TRADE EXPIRED — ${trade.symbol} ${trade.direction} | No resolution in 48h`;
    color = "info";
  } else {
    return;  // unknown event
  }

  const fields = [
    {
      name:   "📐 Entry → Levels",
      value:  `Entry: **${trade.entry}** | SL: ${trade.sl} | TP1: ${trade.tp1} | TP2: ${trade.tp2}`,
      inline: false,
    },
    {
      name:   "📊 Trade Details",
      value:  `${trade.decision} | Score: ${trade.score ?? "N/A"}/100 | Risk: ${trade.slPoints} pts`,
      inline: true,
    },
    {
      name:   "💰 P&L",
      value:  pnlStr,
      inline: true,
    },
    {
      name:   "📈 Running Record",
      value:  record,
      inline: false,
    },
  ];

  await discord.send(title, `Opened: ${new Date(trade.openedAt).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit" })} PT`, color, fields);
}

// ── Main Tick ────────────────────────────────────────────────────

async function tick() {
  if (!isRTH()) {
    logger.info("[marketScanner] Outside RTH — skipping scan");
    return;
  }

  scanCount++;
  lastScanAt = new Date().toISOString();

  try {
    // ── 1. Check outcomes on open trades first ──────────────────
    const currentPrice = lastScanResult?.levels?.currentPrice ?? null;
    if (currentPrice) {
      const updates = tradeTracker.updateOutcomes({ price: currentPrice });
      for (const update of updates) {
        await notifyOutcome(update).catch(err =>
          logger.warn(`[marketScanner] Outcome notify failed: ${err.message}`)
        );
      }
    }

    // ── 2. Run next scan ────────────────────────────────────────
    const result = await runScan(SYMBOL);
    lastScanResult = result;

    if (!result.triggered) {
      logger.info(`[marketScanner] Scan #${scanCount}: no trigger — ${result.reason}`);

      // Still check outcomes with the fresh price from levels
      if (result.levels?.currentPrice) {
        const updates = tradeTracker.updateOutcomes({ price: result.levels.currentPrice });
        for (const update of updates) {
          await notifyOutcome(update).catch(err =>
            logger.warn(`[marketScanner] Outcome notify failed: ${err.message}`)
          );
        }
      }
      return;
    }

    const dec = result.decision?.decision;
    logger.info(`[marketScanner] Scan #${scanCount}: ${result.direction} | ${dec} | Score: ${result.scoreResult?.totalScore}`);

    // Check outcomes with precise fresh price before sending new alert
    if (result.levels?.currentPrice) {
      const updates = tradeTracker.updateOutcomes({ price: result.levels.currentPrice });
      for (const update of updates) {
        await notifyOutcome(update).catch(err =>
          logger.warn(`[marketScanner] Outcome notify failed: ${err.message}`)
        );
      }
    }

    // Only alert on TAKE or STRONG TAKE
    if (!["TAKE", "STRONG TAKE"].includes(dec)) {
      logger.info(`[marketScanner] ${dec} — no Discord alert (TAKE/STRONG TAKE only)`);
      return;
    }

    // Deduplication check
    const key = dedupKey(result);
    if (isCoolingDown(key)) {
      const minsAgo = Math.round((Date.now() - cooldowns.get(key)) / 60000);
      logger.info(`[marketScanner] Dedup: ${key} alerted ${minsAgo} min ago — skipping`);
      return;
    }

    // Send alert and mark cooldown (recordTrade is called inside sendAlert)
    await sendAlert(result);
    cooldowns.set(key, Date.now());

  } catch (err) {
    logger.error(`[marketScanner] Scan #${scanCount} failed: ${err.message}`);
  }
}

// ── Public API ────────────────────────────────────────────────────

function start() {
  const webhookConfigured = process.env.DISCORD_WEBHOOK &&
    !process.env.DISCORD_WEBHOOK.includes("YOUR_WEBHOOK");

  if (!webhookConfigured) {
    logger.warn("[marketScanner] DISCORD_WEBHOOK not configured — scanner disabled. Set it in .env to enable.");
    return false;
  }

  if (intervalHandle) {
    logger.warn("[marketScanner] Already running");
    return false;
  }

  intervalHandle = setInterval(tick, SCAN_INTERVAL_MS);
  logger.info(`[marketScanner] Started — scanning ${SYMBOL} every ${SCAN_INTERVAL_MS / 60000} min | 6:30 AM – 7:00 PM PT (pause 2:00–3:00 PM for CME maintenance)`);

  // Run immediately if in RTH, otherwise wait for first interval
  if (isRTH()) tick();

  return true;
}

function stop() {
  if (!intervalHandle) return false;
  clearInterval(intervalHandle);
  intervalHandle = null;
  logger.info("[marketScanner] Stopped");
  return true;
}

function getStatus() {
  return {
    running:        !!intervalHandle,
    symbol:         SYMBOL,
    scanIntervalMin: SCAN_INTERVAL_MS / 60000,
    cooldownMin:     ALERT_COOLDOWN_MS / 60000,
    scanCount,
    alertCount,
    lastScanAt,
    inRTH:          isRTH(),
    lastResult:     lastScanResult
      ? {
          triggered:      lastScanResult.triggered,
          reason:         lastScanResult.reason ?? null,
          direction:      lastScanResult.direction ?? null,
          decision:       lastScanResult.decision?.decision ?? null,
          score:          lastScanResult.scoreResult?.totalScore ?? null,
          triggerSummary: lastScanResult.triggerSummary ?? null,
          scannedAt:      lastScanResult.scannedAt ?? lastScanAt,
        }
      : null,
  };
}

module.exports = { start, stop, getStatus, tick };
