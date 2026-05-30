/**
 * routes/webhook.js — TradingView Webhook Endpoint
 *
 * POST /webhook
 *   Receives signals from TradingView alerts.
 *   Validates secret + payload, normalizes to a Signal object,
 *   stores it, logs it, and hands off to alertService.
 *
 * GET /webhook/test
 *   Returns an example payload so you can test with Postman or curl.
 *
 * ── Expected TradingView alert message (JSON body) ────────
 * {
 *   "secret":    "{{strategy.order.comment}}",   ← set in .env as WEBHOOK_SECRET
 *   "symbol":    "{{ticker}}",
 *   "timeframe": "{{interval}}",
 *   "setup":     "REVERSAL_LONG",
 *   "entry":     {{close}},
 *   "sl":        {{strategy.position_avg_price}},
 *   "tp1":       {{plot_0}},
 *   "tp2":       {{plot_1}},
 *   "notes":     "RSI oversold + key support"
 * }
 */

const express        = require("express");
const router         = express.Router();
const logger         = require("../utils/logger");
const { validateSignal } = require("../utils/validator");
const { createSignal }   = require("../models/signal");
const signalStore    = require("../services/signalStore");
const alertService   = require("../services/alertService");

// ── POST /webhook ─────────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const payload = req.body;

    // 1. Validate secret
    if (!payload.secret || payload.secret !== process.env.WEBHOOK_SECRET) {
      logger.warn(`[webhook] Rejected — invalid secret from ${req.ip}`);
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    // 2. Validate payload fields
    const { valid, errors } = validateSignal(payload);
    if (!valid) {
      logger.warn(`[webhook] Rejected — validation failed: ${errors.join(" | ")}`);
      return res.status(400).json({ success: false, errors });
    }

    // 3. Normalize into Signal model
    const signal = createSignal(payload);

    // 4. Log the signal
    logger.info(
      `[webhook] SIGNAL IN ` +
      `| ${signal.symbol} ${signal.timeframe}m ` +
      `| ${signal.setup} ` +
      `| Entry: ${signal.entry} ` +
      `| SL: ${signal.sl} (${signal.slPoints} pts) ` +
      `| TP1: ${signal.tp1} (R:${signal.rr1}) ` +
      `| TP2: ${signal.tp2} (R:${signal.rr2}) ` +
      `| ID: ${signal.id}`
    );

    // 5. Persist to store
    signalStore.save(signal);

    // 6. Hand off to alertService (analysis happens here — stubbed for now)
    const result = await alertService.process(signal);

    res.status(200).json({ success: true, signalId: signal.id, result });

  } catch (err) {
    next(err);
  }
});

// ── GET /webhook/test ─────────────────────────────────────
router.get("/test", (_req, res) => {
  res.json({
    message: "Use these as your TradingView alert message body (JSON)",
    payloads: require("../../examples/webhook-payloads.json"),
  });
});

module.exports = router;
