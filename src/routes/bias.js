/**
 * routes/bias.js — Daily Bias Endpoints
 *
 * GET  /bias              — get today's bias (uses cache if already run today)
 * GET  /bias/refresh      — force a fresh bias run (ignores cache)
 * GET  /bias/history      — all past bias readings (last 90 days)
 * GET  /bias/history/:date — single day (format: 2026-05-29)
 */

const express     = require("express");
const router      = express.Router();
const logger      = require("../utils/logger");
const { getDailyBias } = require("../analysis/bias");
const biasHistory = require("../analysis/biasHistory");

// ── GET /bias ─────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const result = await getDailyBias(false);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// ── GET /bias/refresh ────────────────────────────────────
router.get("/refresh", async (req, res, next) => {
  try {
    logger.info("[bias/refresh] Force refresh requested");
    const result = await getDailyBias(true);
    res.json({ success: true, refreshed: true, ...result });
  } catch (err) {
    next(err);
  }
});

// ── GET /bias/history ─────────────────────────────────────
router.get("/history", (_req, res) => {
  const history = biasHistory.getAll().map(h => ({
    date:       h.cachedAt.split("T")[0],
    bias:       h.bias,
    confidence: h.confidence,
    drivers:    h.drivers,
    summary:    h.summary,
  })).reverse();   // newest first

  res.json({ success: true, count: history.length, history });
});

// ── GET /bias/history/:date ───────────────────────────────
router.get("/history/:date", (req, res) => {
  const entry = biasHistory.getByDate(req.params.date);
  if (!entry) {
    return res.status(404).json({ success: false, error: `No bias found for ${req.params.date}` });
  }
  res.json({ success: true, ...entry });
});

module.exports = router;
