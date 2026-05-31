/**
 * routes/scanner.js — Market Scanner Control & Status
 */

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");
const marketScanner = require("../services/marketScanner");

// GET /scanner/status
router.get("/status", (_req, res) => {
  const status = marketScanner.getStatus();
  res.json(status);
});

// POST /scanner/start
router.post("/start", (_req, res) => {
  const ok = marketScanner.start();
  if (ok) {
    logger.info("[scanner-route] Started");
    res.json({ status: "started", running: true });
  } else {
    res.json({ status: "already running or misconfigured", running: marketScanner.getStatus().running });
  }
});

// POST /scanner/stop
router.post("/stop", (_req, res) => {
  const ok = marketScanner.stop();
  if (ok) {
    logger.info("[scanner-route] Stopped");
    res.json({ status: "stopped", running: false });
  } else {
    res.json({ status: "not running", running: false });
  }
});

module.exports = router;
