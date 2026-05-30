/**
 * services/discordService.js — Discord Notification Service
 * Sends formatted embed messages to a Discord channel via webhook.
 * Used by the decision engine to push trade alerts and summaries.
 */

const axios  = require("axios");
const logger = require("../utils/logger");

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
      footer: { text: `Trading System • ${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET` },
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
