/**
 * routes/tradeManagement.js — Trade Management Endpoints
 *
 * Two modes of operation:
 *
 *   Mode A — Stored signal (from TradingView webhook):
 *     GET  /trade-management/:signalId?price=21500
 *     POST /trade-management  { signalId, currentPrice }
 *
 *   Mode B — Inline signal (ad-hoc, no prior webhook required):
 *     POST /trade-management  {
 *       signal: { direction, entry, sl, tp1, tp2, symbol },
 *       currentPrice
 *     }
 *
 * Response includes:
 *   tradeState     — ENTRY_PENDING | IN_TRADE_INITIAL | BREAKEVEN_QUEUED |
 *                    TP1_HIT | TRAILING | TP2_HIT | STOPPED_OUT | EARLY_EXITED
 *   stopToBE       — whether / how to move stop to breakeven
 *   tp1Action      — what to do at TP1
 *   tp2Action      — what to do at TP2
 *   earlyExit      — conditions that warrant closing before targets
 *   pnl            — P&L reference at each outcome
 *   summary        — one-line human-readable status
 */

const express       = require("express");
const router        = express.Router();
const { manageTrade }  = require("../analysis/tradeManagement");
const { getById }      = require("../services/signalStore");

// ── Helpers ───────────────────────────────────────────────────────

function parsePrice(raw) {
  const n = parseFloat(raw);
  return isNaN(n) || n <= 0 ? null : n;
}

function extractSignal(stored) {
  // Pull only the fields manageTrade needs from a stored signal object
  return {
    direction: stored.direction,
    entry:     stored.entry,
    sl:        stored.sl,
    tp1:       stored.tp1,
    tp2:       stored.tp2,
    symbol:    stored.symbol || "NQ=F",
  };
}

// ── GET /trade-management/:signalId?price=21500 ───────────────────

router.get("/:signalId", async (req, res, next) => {
  try {
    const { signalId } = req.params;
    const currentPrice = parsePrice(req.query.price);

    if (!currentPrice) {
      return res.status(400).json({
        success: false,
        error:   "Query param `price` is required and must be a positive number (e.g. ?price=21500)",
      });
    }

    const stored = getById(signalId);
    if (!stored) {
      return res.status(404).json({
        success: false,
        error:   `Signal not found: ${signalId}`,
      });
    }

    const signal = extractSignal(stored);
    const result = await manageTrade(signal, currentPrice);

    res.json({ success: true, signalId, ...result });
  } catch (err) {
    next(err);
  }
});

// ── POST /trade-management ────────────────────────────────────────

router.post("/", async (req, res, next) => {
  try {
    const body = req.body || {};

    // ── Mode A: stored signal ──────────────────────────────────
    if (body.signalId) {
      const currentPrice = parsePrice(body.currentPrice);

      if (!currentPrice) {
        return res.status(400).json({
          success: false,
          error:   "`currentPrice` is required and must be a positive number",
        });
      }

      const stored = getById(body.signalId);
      if (!stored) {
        return res.status(404).json({
          success: false,
          error:   `Signal not found: ${body.signalId}`,
        });
      }

      const signal = extractSignal(stored);
      const result = await manageTrade(signal, currentPrice);

      return res.json({ success: true, signalId: body.signalId, ...result });
    }

    // ── Mode B: inline signal ──────────────────────────────────
    if (body.signal) {
      const currentPrice = parsePrice(body.currentPrice);

      if (!currentPrice) {
        return res.status(400).json({
          success: false,
          error:   "`currentPrice` is required and must be a positive number",
        });
      }

      const { direction, entry, sl, tp1, tp2, symbol } = body.signal;

      if (!direction || !entry || !sl || !tp1 || !tp2) {
        return res.status(400).json({
          success: false,
          error:   "Inline signal requires: direction, entry, sl, tp1, tp2",
        });
      }

      const signal = {
        direction: direction.toUpperCase(),
        entry:     parseFloat(entry),
        sl:        parseFloat(sl),
        tp1:       parseFloat(tp1),
        tp2:       parseFloat(tp2),
        symbol:    (symbol || "NQ=F").toUpperCase(),
      };

      const result = await manageTrade(signal, currentPrice);

      return res.json({ success: true, mode: "inline", ...result });
    }

    // ── Neither mode supplied ──────────────────────────────────
    return res.status(400).json({
      success: false,
      error:   "Provide either `signalId` (Mode A) or `signal` object (Mode B) in the request body",
      example: {
        modeA: {
          signalId:     "sig_abc123",
          currentPrice: 21500,
        },
        modeB: {
          signal: {
            direction: "LONG",
            entry:     21450,
            sl:        21400,
            tp1:       21520,
            tp2:       21600,
            symbol:    "NQ=F",
          },
          currentPrice: 21480,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
