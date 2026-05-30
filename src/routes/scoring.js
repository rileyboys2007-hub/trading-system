/**
 * routes/scoring.js — Trade Scoring Endpoints
 *
 * GET  /score?direction=LONG           — score a hypothetical trade right now
 * GET  /score?direction=SHORT&symbol=ES=F
 * POST /score  { direction, symbol }   — same, via POST body
 */

const express  = require("express");
const router   = express.Router();
const { scoreSignal } = require("../analysis/scoring");

async function runScore(req, res, next) {
  try {
    const direction = (req.body?.direction || req.query.direction || "LONG").toUpperCase();
    const symbol    = (req.body?.symbol    || req.query.symbol    || "NQ=F").toUpperCase();

    if (!["LONG", "SHORT"].includes(direction)) {
      return res.status(400).json({ success: false, error: "direction must be LONG or SHORT" });
    }

    const result = await scoreSignal({ direction, symbol });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

router.get("/",  runScore);
router.post("/", runScore);

module.exports = router;
