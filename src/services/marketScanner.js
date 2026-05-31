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
  const { direction, signal, scoreResult, decision, riskCheck, levels, triggerSummary } = result;
  const dec     = decision.decision;
  const emoji   = decisionEmoji(dec);
  const color   = dirColor(direction, dec);
  const blocked = riskCheck && !riskCheck.allowed;

  const title = blocked
    ? `🛑 RISK BLOCKED (was ${dec}) — ${SYMBOL} ${direction}`
    : `${emoji} ${dec} — ${SYMBOL} ${direction}`;

  const description = decision.primaryReason || triggerSummary;

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
        `Entry: **${signal.entry}**`,
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

  await discord.send(title, description, color, fields);
  alertCount++;
  logger.info(`[marketScanner] Discord alert sent: ${dec} ${direction} | total alerts today: ${alertCount}`);
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
    const result = await runScan(SYMBOL);
    lastScanResult = result;

    if (!result.triggered) {
      logger.info(`[marketScanner] Scan #${scanCount}: no trigger — ${result.reason}`);
      return;
    }

    const dec = result.decision?.decision;
    logger.info(`[marketScanner] Scan #${scanCount}: ${result.direction} | ${dec} | Score: ${result.scoreResult?.totalScore}`);

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

    // Send alert and mark cooldown
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
