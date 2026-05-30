/**
 * app.js — Express App Setup
 * Configures middleware, mounts all routes, and attaches error handling.
 */

require("dotenv").config();
const express = require("express");
const logger  = require("./src/utils/logger");
const { errorHandler, notFound } = require("./src/utils/errorHandler");
const routes  = require("./src/routes/index");

const app = express();

// ── Middleware ────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logger
app.use((req, _res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// ── Routes ────────────────────────────────────────────────
app.use("/", routes);

// ── Error Handling ────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

module.exports = app;
