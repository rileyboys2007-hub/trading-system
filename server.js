/**
 * server.js — Entry Point
 * Boots the Express app and starts listening on the configured port.
 */

require("dotenv").config();
const app = require("./app");
const logger = require("./src/utils/logger");

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info(`Trading system running on port ${PORT} [${process.env.NODE_ENV}]`);
});
