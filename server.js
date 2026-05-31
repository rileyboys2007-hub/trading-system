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

  // Start market scanner if Discord is configured
  if (process.env.DISCORD_WEBHOOK && !process.env.DISCORD_WEBHOOK.includes("YOUR_WEBHOOK")) {
    logger.info("[startup] Starting market scanner...");
    marketScanner.start();
  } else {
    logger.warn("[startup] DISCORD_WEBHOOK not configured — market scanner disabled");
  }
});
