/**
 * routes/vwap.js — VWAP endpoint
 * GET /vwap?symbol=NQ=F
 */

const express = require("express");
const router  = express.Router();
const { calculateVWAP } = require("../analysis/vwap");

router.get("/", async (req, res, next) => {
  try {
    const symbol = req.query.symbol || "NQ=F";
    const result = await calculateVWAP(symbol);
    if (!result) {
      return res.json({ success: false, message: "VWAP unavailable — market likely closed or insufficient bars" });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
