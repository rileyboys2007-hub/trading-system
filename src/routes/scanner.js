/**
 * routes/scanner.js — Market Scanner Control & Status
 */

const express = require("express");
const router  = express.Router();
const logger  = require("../utils/logger");
const marketScanner        = require("../services/marketScanner");
const { runScanForced }    = require("../analysis/scanner");
const discord              = require("../services/discordService");

// GET /scanner/status
router.get("/status", (_req, res) => {
  const status = marketScanner.getStatus();
  res.json(status);
});

// POST /scanner/start
router.post("/start", (_req, res) => {
  const ok = marketScanner.start();
  if (ok) {
    logger.info("[scanner-route] Started");
    res.json({ status: "started", running: true });
  } else {
    res.json({ status: "already running or misconfigured", running: marketScanner.getStatus().running });
  }
});

// POST /scanner/stop
router.post("/stop", (_req, res) => {
  const ok = marketScanner.stop();
  if (ok) {
    logger.info("[scanner-route] Stopped");
    res.json({ status: "stopped", running: false });
  } else {
    res.json({ status: "not running", running: false });
  }
});

// POST /scanner/test — run full pipeline right now, bypass RTH, send real Discord alert
router.post("/test", async (_req, res) => {
  logger.info("[scanner-route] Manual test scan triggered");
  try {
    const result = await runScanForced("NQ=F");

    // Always send Discord on test so you can confirm it works
    const dec     = result.decision?.decision ?? "NO DECISION";
    const score   = result.scoreResult?.totalScore ?? "N/A";
    const grade   = result.scoreResult?.grade ?? "?";
    const dir     = result.direction ?? "—";
    const trigger = result.triggerSummary ?? result.reason ?? "No triggers detected";

    await discord.send(
      `🧪 TEST SCAN — NQ=F ${dir}`,
      `Manual test fired outside market hours.\nDecision: **${dec}** | Score: **${grade} ${score}/100**`,
      "info",
      [
        { name: "📋 Result", value: result.triggered ? "✅ Setup detected" : "⚪ No setup (normal outside RTH)", inline: false },
        { name: "🔍 Trigger", value: trigger, inline: false },
        { name: "📊 Score",   value: `${grade} — ${score}/100`, inline: true },
        { name: "📌 Decision", value: dec, inline: true },
        result.signal ? {
          name:  "🎯 Suggested Levels",
          value: `Entry: ${result.signal.entry} | SL: ${result.signal.sl} | TP1: ${result.signal.tp1} | TP2: ${result.signal.tp2}`,
          inline: false,
        } : { name: "🎯 Levels", value: "No signal generated", inline: false },
      ]
    );

    res.json({ ok: true, result });
  } catch (err) {
    logger.error(`[scanner-route] Test failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
