/**
 * routes/internals.js — Market Internals Endpoints
 *
 * GET /internals       — full market internals reading
 * GET /internals/quick — sentiment + confidence only (lightweight)
 */

const express  = require("express");
const router   = express.Router();
const { getMarketInternals } = require("../analysis/internals");

router.get("/", async (req, res, next) => {
  try {
    const result = await getMarketInternals();
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.get("/quick", async (req, res, next) => {
  try {
    const result = await getMarketInternals();
    res.json({
      success:        true,
      sentiment:      result.sentiment,
      confidence:     result.confidence,
      aggregateScore: result.aggregateScore,
      summary:        result.summary,
      calculatedAt:   result.calculatedAt,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
