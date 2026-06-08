/**
 * server.js — Entry Point
 * Boots the Express app and starts listening on the configured port.
 * Auto-starts the market scanner if DISCORD_WEBHOOK is configured.
 */

require("dotenv").config();
const app = require("./app");
const logger = require("./src/utils/logger");
const marketScanner = require("./src/services/marketScanner");

const PORT = process.env.PORT || 80;

app.listen(PORT, () => {
  logger.info(`Trading system running on port ${PORT} [${process.env.NODE_ENV}]`);

  // Start market scanner unless explicitly disabled.
  // Set DISABLE_MARKET_SCANNER=true in .env to suppress independent Yahoo Finance scans
  // while TradingView webhooks are the primary signal source.
  if (process.env.DISABLE_MARKET_SCANNER === "true") {
    logger.info("[startup] Market scanner disabled via DISABLE_MARKET_SCANNER=true");
  } else if (process.env.DISCORD_WEBHOOK && !process.env.DISCORD_WEBHOOK.includes("YOUR_WEBHOOK")) {
    logger.info("[startup] Starting market scanner...");
    marketScanner.start();
  } else {
    logger.warn("[startup] DISCORD_WEBHOOK not configured — market scanner disabled");
  }
});
