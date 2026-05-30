/**
 * routes/decision.js — Final Decision Engine Endpoints
 *
 * GET  /decision?direction=LONG          — full pipeline → decision
 * GET  /decision?direction=SHORT&symbol=ES=F
 * POST /decision  { direction, symbol }  — same via POST
 *
 * Response always includes:
 *   decision       — STRONG TAKE | TAKE | WAIT | AVOID
 *   confidence     — 0–100 (how sure the engine is)
 *   primaryReason  — one-sentence explanation
 *   reasons.for    — factors supporting the trade
 *   reasons.against — factors opposing the trade
 *   reasons.blocking — hard rules that blocked a better decision
 *   reasons.watch  — risk items to monitor
 *   tradeScore     — grade, totalScore, recommendation
 *   factorSummary  — per-factor score and explanation
 *
 *   riskGate       — daily risk management overlay (always present)
 *     .sessionStatus  — NORMAL | RESTRICTED | HALTED | OVERTRADED
 *     .canTrade       — false overrides decision to AVOID regardless of score
 *     .requiresAPlus  — true means score must be ≥ 90 to proceed
 *     .overrode       — true if risk gate changed the original decision
 *     .originalDecision — the raw decision before risk gate applied
 */

const express  = require("express");
const router   = express.Router();
const { makeDecision }   = require("../analysis/decision");
const { checkPreTrade }  = require("../analysis/riskManagement");

async function runDecision(req, res, next) {
  try {
    const direction = (req.body?.direction || req.query.direction || "LONG").toUpperCase();
    const symbol    = (req.body?.symbol    || req.query.symbol    || "NQ=F").toUpperCase();

    if (!["LONG", "SHORT"].includes(direction)) {
      return res.status(400).json({ success: false, error: "direction must be LONG or SHORT" });
    }

    // ── 1. Run the full decision pipeline ─────────────────────
    const result = await makeDecision({ direction, symbol });

    // ── 2. Overlay the risk gate ───────────────────────────────
    const riskCheck = checkPreTrade({
      tradeScore: result.tradeScore?.totalScore,
      tradeGrade: result.tradeScore?.grade,
      direction,
      symbol,
    });

    const originalDecision = result.decision;
    let   finalDecision    = result.decision;
    let   riskOverrode     = false;

    if (!riskCheck.allowed) {
      // Risk gate blocks — force AVOID regardless of setup quality
      finalDecision = "AVOID";
      riskOverrode  = true;
    } else if (riskCheck.requiresAPlus && !riskCheck.scoreCheck?.passes) {
      // Score was below A+ threshold in restricted mode
      // (checkPreTrade already set allowed=false for this case; defensive guard)
      finalDecision = "AVOID";
      riskOverrode  = true;
    }

    const riskGate = {
      sessionStatus:    riskCheck.sessionStatus,
      canTrade:         riskCheck.canTrade,
      requiresAPlus:    riskCheck.requiresAPlus,
      aPlusMinScore:    riskCheck.aPlusMinScore,
      originalDecision,
      overrode:         riskOverrode,
      recommendation:   riskCheck.recommendation,
      stats:            riskCheck.stats,
      revengeAlert:     riskCheck.revengeAlert,
      overtradingAlert: riskCheck.overtradingAlert,
      reasons:          riskCheck.reasons,
    };

    // Patch primaryReason if overridden
    const primaryReason = riskOverrode
      ? `[RISK GATE] ${riskCheck.blockReason} — original decision: ${originalDecision}`
      : result.primaryReason;

    res.json({
      success: true,
      ...result,
      decision:      finalDecision,
      primaryReason,
      riskGate,
    });
  } catch (err) {
    next(err);
  }
}

router.get("/",  runDecision);
router.post("/", runDecision);

module.exports = router;
