/**
 * routes/playbooks.js — Playbook Detection Endpoints
 *
 * GET /playbooks           — full scan, all 8 playbooks (NQ=F)
 * GET /playbooks/matched   — only matched playbooks
 * GET /playbooks/:symbol   — scan any symbol
 */

const express  = require("express");
const router   = express.Router();
const { detectPlaybooks } = require("../analysis/playbooks");

router.get("/", async (req, res, next) => {
  try {
    const result = await detectPlaybooks("NQ=F");
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

router.get("/matched", async (req, res, next) => {
  try {
    const result = await detectPlaybooks("NQ=F");
    res.json({
      success:          true,
      hasMatch:         result.hasMatch,
      primaryMatch:     result.primaryMatch,
      matchedPlaybooks: result.matchedPlaybooks,
      currentPrice:     result.currentPrice,
      calculatedAt:     result.calculatedAt,
    });
  } catch (err) { next(err); }
});

router.get("/:symbol", async (req, res, next) => {
  try {
    const result = await detectPlaybooks(req.params.symbol.toUpperCase());
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

module.exports = router;
