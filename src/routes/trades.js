/**
 * routes/trades.js — Trade Tracker API
 *
 * GET  /trades/stats          — win rate, P&L summary, recent trades
 * GET  /trades/open           — open trades currently being monitored
 * POST /trades/close/:id      — manually close a trade (provide outcome in body)
 */

const express      = require("express");
const router       = express.Router();
const tradeTracker = require("../services/tradeTracker");

// GET /trades/stats
router.get("/stats", (_req, res) => {
  res.json(tradeTracker.getStats());
});

// GET /trades/open
router.get("/open", (_req, res) => {
  const { openTrades } = tradeTracker.getStats();
  res.json({ count: openTrades.length, trades: openTrades });
});

// POST /trades/close/:id  — manual override
// body: { outcome: "TP2_HIT" | "TP1_THEN_SL" | "SL_HIT" | "EXPIRED", pnlPoints: 45 }
router.post("/close/:id", (req, res) => {
  const { id }     = req.params;
  const { outcome, pnlPoints } = req.body || {};

  if (!outcome) return res.status(400).json({ error: "outcome required" });

  const fs   = require("fs");
  const path = require("path");
  const file = path.join(__dirname, "../data/trades.json");

  try {
    const trades = JSON.parse(fs.readFileSync(file, "utf8"));
    const trade  = trades.find(t => t.id === id);
    if (!trade) return res.status(404).json({ error: "Trade not found" });

    trade.status    = "CLOSED";
    trade.outcome   = outcome;
    trade.pnlPoints = pnlPoints ?? 0;
    trade.closedAt  = new Date().toISOString();

    fs.writeFileSync(file, JSON.stringify(trades, null, 2));
    res.json({ ok: true, trade });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
