/**
 * routes/riskManagement.js — Daily Risk Management Endpoints
 *
 * GET  /risk                    — current session risk status (full report)
 * POST /risk/check              — pre-trade gate check (pass score before entering)
 * POST /risk/outcome            — record a trade result (WIN / LOSS / BREAKEVEN)
 * GET  /risk/session            — full session with complete trade history
 * POST /risk/reset              — reset today's session (testing / manual override)
 *
 * ── Typical Workflow ──────────────────────────────────────────────
 *
 *   1. GET  /decision?direction=LONG    — decision engine evaluates setup
 *      → decision response now includes riskGate field
 *
 *   2. POST /risk/check                 — final risk gate before pulling trigger
 *      { tradeScore: 91, tradeGrade: "A+", direction: "LONG" }
 *      → { allowed: true/false, recommendation, ... }
 *
 *   3. [trade executes — outcome determined]
 *
 *   4. POST /risk/outcome               — record the result
 *      { outcome: "LOSS", signalId: "sig_abc", symbol: "NQ=F" }
 *      → session stats update, loss count increments
 *
 *   5. GET  /risk                       — check if still allowed to trade
 *      → sessionStatus may now be RESTRICTED or HALTED
 */

const express  = require("express");
const router   = express.Router();
const { assessRisk, checkPreTrade }  = require("../analysis/riskManagement");
const { recordOutcome, getTodaySession, resetSession } = require("../services/sessionTracker");

// ── GET /risk ─────────────────────────────────────────────────────

router.get("/", async (req, res, next) => {
  try {
    const report = assessRisk();
    res.json({ success: true, ...report });
  } catch (err) {
    next(err);
  }
});

// ── POST /risk/check ──────────────────────────────────────────────
//
// Body: { tradeScore, tradeGrade, proposedEntryTime, direction, symbol }
//
// tradeScore is optional but strongly recommended in RESTRICTED mode.
// Without it, a RESTRICTED session will block all trades (can't verify A+).

router.post("/check", (req, res, next) => {
  try {
    const {
      tradeScore,
      tradeGrade,
      proposedEntryTime,
      direction,
      symbol,
    } = req.body || {};

    const result = checkPreTrade({
      tradeScore:       tradeScore !== undefined ? Number(tradeScore) : undefined,
      tradeGrade:       tradeGrade || null,
      proposedEntryTime: proposedEntryTime || null,
      direction:        direction ? direction.toUpperCase() : undefined,
      symbol:           symbol    ? symbol.toUpperCase()    : undefined,
    });

    // Use 200 for allowed, 403 for blocked — makes it easy to detect programmatically
    const status = result.allowed ? 200 : 403;
    res.status(status).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// ── POST /risk/outcome ────────────────────────────────────────────
//
// Body: { outcome, signalId?, symbol?, setup?, entryTime?, notes? }
//
// outcome: "WIN" | "LOSS" | "BREAKEVEN"
// entryTime: ISO string of when you ENTERED the trade.
//   Supplying this makes revenge-trade detection accurate.
//   Without it, recordedAt is used as a fallback (less precise).

router.post("/outcome", (req, res, next) => {
  try {
    const { outcome, signalId, symbol, setup, entryTime, notes } = req.body || {};

    if (!outcome) {
      return res.status(400).json({
        success: false,
        error:   "`outcome` is required. Values: WIN | LOSS | BREAKEVEN",
      });
    }

    const trade = recordOutcome({ outcome, signalId, symbol, setup, entryTime, notes });

    // Return the updated risk state along with the recorded trade
    const risk = assessRisk();

    res.json({
      success:     true,
      recorded:    trade,
      riskUpdate:  {
        sessionStatus:  risk.sessionStatus,
        canTrade:       risk.canTrade,
        requiresAPlus:  risk.requiresAPlus,
        stats:          risk.stats,
        recommendation: risk.recommendation,
      },
    });
  } catch (err) {
    // recordOutcome throws for invalid outcomes — return 400 not 500
    if (err.message.startsWith("Invalid outcome")) {
      return res.status(400).json({ success: false, error: err.message });
    }
    next(err);
  }
});

// ── GET /risk/session ─────────────────────────────────────────────

router.get("/session", (req, res, next) => {
  try {
    const session = getTodaySession();
    const risk    = assessRisk();
    res.json({
      success:      true,
      session,
      currentRisk:  {
        sessionStatus: risk.sessionStatus,
        canTrade:      risk.canTrade,
        requiresAPlus: risk.requiresAPlus,
        recommendation: risk.recommendation,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /risk/reset ──────────────────────────────────────────────
//
// Wipes today's session — use for testing or if data is corrupt.
// Requires confirmation body: { confirm: "RESET_SESSION" }

router.post("/reset", (req, res, next) => {
  try {
    const { confirm } = req.body || {};

    if (confirm !== "RESET_SESSION") {
      return res.status(400).json({
        success: false,
        error:   'Pass { confirm: "RESET_SESSION" } to reset the session',
      });
    }

    const fresh = resetSession();
    res.json({
      success: true,
      message: "Session reset — all trade outcomes cleared for today",
      session: fresh,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
