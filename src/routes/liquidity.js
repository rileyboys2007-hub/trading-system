/**
 * routes/liquidity.js — Liquidity Sweep Detection Endpoints
 *
 * GET /liquidity              — full sweep scan (NQ=F, last 10 bars)
 * GET /liquidity/active       — only active signals (rejections within 2 bars)
 * GET /liquidity/:symbol      — sweep scan for any symbol
 * GET /liquidity/examples     — documented example scenarios
 */

const express  = require("express");
const router   = express.Router();
const { detectLiquiditySweeps } = require("../analysis/liquidity");

router.get("/", async (req, res, next) => {
  try {
    const result = await detectLiquiditySweeps({
      symbol:       "NQ=F",
      lookbackBars: Number(req.query.bars) || 10,
      minSweepPts:  Number(req.query.min)  || 1.0,
    });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

router.get("/active", async (req, res, next) => {
  try {
    const result = await detectLiquiditySweeps({ symbol: "NQ=F", lookbackBars: 5 });
    res.json({
      success:      true,
      hasSignal:    !!result.activeSignal,
      activeSignal: result.activeSignal,
      currentPrice: result.currentPrice,
      levels:       result.levels,
      calculatedAt: result.calculatedAt,
    });
  } catch (err) { next(err); }
});

router.get("/examples", (_req, res) => {
  res.json(require("../../examples/sweep-scenarios.json"));
});

router.get("/:symbol", async (req, res, next) => {
  try {
    const result = await detectLiquiditySweeps({
      symbol:       req.params.symbol.toUpperCase(),
      lookbackBars: Number(req.query.bars) || 10,
      minSweepPts:  Number(req.query.min)  || 1.0,
    });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

module.exports = router;
