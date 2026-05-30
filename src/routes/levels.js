/**
 * routes/levels.js — Key Levels Endpoints
 *
 * GET /levels              — NQ key levels (default: NQ=F)
 * GET /levels/:symbol      — key levels for any symbol (e.g. /levels/ES=F)
 */

const express  = require("express");
const router   = express.Router();
const { getKeyLevels } = require("../analysis/levels");

router.get("/", async (req, res, next) => {
  try {
    const result = await getKeyLevels("NQ=F");
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.get("/:symbol", async (req, res, next) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const result = await getKeyLevels(symbol);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
