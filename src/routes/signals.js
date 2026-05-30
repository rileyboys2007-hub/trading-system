/**
 * routes/signals.js — Signal Query Endpoints
 * Read-only routes for inspecting stored signals.
 *
 * GET /signals              — all signals (newest first)
 * GET /signals/stats        — counts by status and setup type
 * GET /signals/:id          — single signal by ID
 * GET /signals/symbol/:sym  — all signals for a symbol (e.g. /signals/symbol/NQ1!)
 * GET /signals/status/:s    — filter by status (RECEIVED, VALID, FILTERED, etc.)
 */

const express     = require("express");
const router      = express.Router();
const signalStore = require("../services/signalStore");

router.get("/", (_req, res) => {
  res.json({ success: true, signals: signalStore.getAll() });
});

router.get("/stats", (_req, res) => {
  res.json({ success: true, stats: signalStore.getStats() });
});

router.get("/symbol/:sym", (req, res) => {
  const signals = signalStore.getBySymbol(req.params.sym);
  res.json({ success: true, symbol: req.params.sym.toUpperCase(), count: signals.length, signals });
});

router.get("/status/:status", (req, res) => {
  const signals = signalStore.getByStatus(req.params.status.toUpperCase());
  res.json({ success: true, status: req.params.status.toUpperCase(), count: signals.length, signals });
});

router.get("/:id", (req, res) => {
  const signal = signalStore.getById(req.params.id);
  if (!signal) return res.status(404).json({ success: false, error: "Signal not found" });
  res.json({ success: true, signal });
});

module.exports = router;
