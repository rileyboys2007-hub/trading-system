/**
 * routes/index.js — Route Registry
 */

const express = require("express");
const router  = express.Router();

const webhookRoutes   = require("./webhook");
const signalRoutes    = require("./signals");
const biasRoutes      = require("./bias");
const levelsRoutes    = require("./levels");
const internalsRoutes = require("./internals");
const liquidityRoutes  = require("./liquidity");
const playbookRoutes   = require("./playbooks");
const scoringRoutes    = require("./scoring");
const decisionRoutes   = require("./decision");
const tradeMgmtRoutes  = require("./tradeManagement");
const riskRoutes       = require("./riskManagement");
const eodRoutes        = require("./eodReview");
const scannerRoutes    = require("./scanner");
const vwapRoutes       = require("./vwap");

// Health check
router.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

router.use("/webhook",   webhookRoutes);
router.use("/signals",   signalRoutes);
router.use("/bias",      biasRoutes);
router.use("/levels",    levelsRoutes);
router.use("/internals", internalsRoutes);
router.use("/liquidity", liquidityRoutes);
router.use("/playbooks", playbookRoutes);
router.use("/score",     scoringRoutes);
router.use("/decision",        decisionRoutes);
router.use("/trade-management", tradeMgmtRoutes);
router.use("/risk",             riskRoutes);
router.use("/eod",              eodRoutes);
router.use("/scanner",          scannerRoutes);
router.use("/vwap",             vwapRoutes);

module.exports = router;
