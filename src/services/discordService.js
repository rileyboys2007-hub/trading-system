/**
 * services/discordService.js — Discord Notification Service
 * Sends formatted embed messages to a Discord channel via webhook.
 * Used by the decision engine to push trade alerts and summaries.
 */

const axios  = require("axios");
const logger = require("../utils/logger");

// ── Timezone Helper ───────────────────────────────────────────────
/**
 * Returns a formatted PT time string, e.g. "02:34 PM PDT".
 * Uses Intl.DateTimeFormat.formatToParts() to avoid the VPS ICU fallback bug
 * that makes toLocaleTimeString() use the system clock timezone instead of PT.
 * Falls back to a manual DST-aware UTC calculation if Intl fails.
 *
 * PST = UTC-8, PDT = UTC-7  (same calendar dates as ET, different UTC offsets)
 *   DST start: 2nd Sunday March    at 2:00 AM PST = 10:00 UTC
 *   DST end:   1st Sunday November at 2:00 AM PDT = 09:00 UTC
 */
function getPTTimeString() {
  const now = new Date();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour:     "2-digit",
      minute:   "2-digit",
      hour12:   true,
    }).formatToParts(now);
    const hPart  = parts.find(p => p.type === "hour");
    const mPart  = parts.find(p => p.type === "minute");
    const amPart = parts.find(p => p.type === "dayPeriod");
    if (!hPart || !mPart) throw new Error("missing parts");

    // Determine PDT vs PST to show the correct abbreviation
    const isDST = (() => {
      const y       = now.getUTCFullYear();
      const mar1Day = new Date(Date.UTC(y, 2, 1)).getUTCDay();
      const nov1Day = new Date(Date.UTC(y, 10, 1)).getUTCDay();
      const start   = Date.UTC(y, 2,  8 + (7 - mar1Day) % 7, 10, 0, 0);
      const end     = Date.UTC(y, 10, 1 + (7 - nov1Day) % 7,  9, 0, 0);
      return now.getTime() >= start && now.getTime() < end;
    })();

    return `${hPart.value}:${mPart.value} ${amPart?.value ?? ""} P${isDST ? "D" : "S"}T`.trim();
  } catch (_) {
    // Manual fallback
    const y       = now.getUTCFullYear();
    const mar1Day = new Date(Date.UTC(y, 2, 1)).getUTCDay();
    const nov1Day = new Date(Date.UTC(y, 10, 1)).getUTCDay();
    const dstStart = Date.UTC(y, 2,  8 + (7 - mar1Day) % 7, 10, 0, 0);
    const dstEnd   = Date.UTC(y, 10, 1 + (7 - nov1Day) % 7,  9, 0, 0);
    const isDST    = now.getTime() >= dstStart && now.getTime() < dstEnd;
    const d        = new Date(now.getTime() + (isDST ? -7 : -8) * 3_600_000);
    const h12      = d.getUTCHours() % 12 || 12;
    const ampm     = d.getUTCHours() < 12 ? "AM" : "PM";
    const mm       = String(d.getUTCMinutes()).padStart(2, "0");
    return `${h12}:${mm} ${ampm} P${isDST ? "D" : "S"}T`;
  }
}

const COLORS = {
  long:    3066993,   // green
  short:   16711680,  // red
  neutral: 8421504,   // gray
  info:    3447003,   // blue
  warning: 16776960,  // yellow
};

/**
 * Send a Discord embed message.
 * @param {string} title
 * @param {string} description
 * @param {"long"|"short"|"neutral"|"info"|"warning"} type
 * @param {Array}  fields  — optional [{name, value, inline}]
 */
async function send(title, description, type = "info", fields = []) {
  const webhookUrl = process.env.DISCORD_WEBHOOK;
  if (!webhookUrl || webhookUrl.includes("YOUR_WEBHOOK")) {
    logger.warn("[discordService] No webhook configured — skipping notification");
    return;
  }

  const payload = {
    embeds: [{
      title,
      description,
      color:  COLORS[type] || COLORS.info,
      fields,
      footer: { text: `Trading System • ${getPTTimeString()}` },
    }],
  };

  try {
    await axios.post(webhookUrl, payload, { timeout: 5000 });
    logger.info(`[discordService] Sent: ${title}`);
  } catch (err) {
    logger.error(`[discordService] Failed to send: ${err.message}`);
  }
}

module.exports = { send };
