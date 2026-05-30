/**
 * services/alertService.js — Alert Orchestrator
 * Receives a normalized Signal and routes it through the analysis pipeline.
 * Each step is stubbed — filled in as modules are built.
 *
 * Pipeline order:
 *  1. Daily Bias check
 *  2. Key Levels check
 *  3. Market Internals check
 *  4. Liquidity Sweep detection
 *  5. Playbook matching
 *  6. Scoring
 *  7. Decision Engine
 *  8. Trade Management
 *  9. Risk Management
 * 10. Notification (Discord)
 */

const logger      = require("../utils/logger");
const signalStore = require("./signalStore");
const { SIGNAL_STATUS } = require("../models/signal");

async function process(signal) {
  logger.info(`[alertService] Processing signal ${signal.id} | ${signal.symbol} ${signal.setup}`);

  // Mark as analyzing
  signalStore.update(signal.id, { status: SIGNAL_STATUS.ANALYZING });

  // TODO: Step 1 — Daily Bias
  // TODO: Step 2 — Key Levels
  // TODO: Step 3 — Market Internals
  // TODO: Step 4 — Liquidity Sweeps
  // TODO: Step 5 — Playbook Match
  // TODO: Step 6 — Scoring
  // TODO: Step 7 — Decision Engine
  // TODO: Step 8 — Trade Management
  // TODO: Step 9 — Risk Management
  // TODO: Step 10 — Discord Notification

  // For now: mark as received and return
  const updated = signalStore.update(signal.id, { status: SIGNAL_STATUS.RECEIVED });

  logger.info(`[alertService] Signal ${signal.id} queued — awaiting analysis modules`);
  return { status: updated.status, id: signal.id };
}

module.exports = { process };
