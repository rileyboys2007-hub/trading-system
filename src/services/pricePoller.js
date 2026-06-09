/**
 * services/pricePoller.js — Lightweight Trade Outcome Poller
 *
 * Polls the current NQ=F price every 2 minutes during market hours
 * and checks all open trades for TP1 / TP2 / SL hits.
 *
 * This is intentionally minimal: no analysis, no scoring, no AI calls —
 * just a price fetch and a call to tradeTracker.updateOutcomes().
 *
 * The market scanner (marketScanner.js) is disabled (DISABLE_MARKET_SCANNER=true).
 * This service takes over its outcome-tracking responsibility only —
 * it does NOT re-scan for new signals.
 *
 * Price source: Yahoo Finance quote (yf.quote). A ~30-second delay is
 * acceptable for outcome detection on 5-minute NQ trades.
 * Day high/low is intentionally NOT passed — using current price only
 * avoids false positives from stale day-range data after open.
 */

const YahooFinance  = require("yahoo-finance2").default;
const yf            = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const logger        = require("../utils/logger");
const discord       = require("./discordService");
const tradeTracker  = require("./tradeTracker");
const { isRTH }     = require("../analysis/scanner");

// ── Config ────────────────────────────────────────────────────────

const SYMBOL           = "NQ=F";
const POLL_INTERVAL_MS = 2 * 60 * 1000;   // 2 minutes

// ── State ─────────────────────────────────────────────────────────

let intervalHandle = null;
let lastPollAt     = null;
let pollCount      = 0;

// ── Outcome Discord Notification ─────────────────────────────────
// Mirrors the notifyOutcome() in marketScanner.js so format is consistent.

async function notifyOutcome(update) {
  const { trade, event } = update;
  const record = tradeTracker.recordLine();

  const pnl    = trade.pnlPoints;
  const pnlStr = pnl != null ? `${pnl >= 0 ? "+" : ""}${pnl} pts` : "—";

  let title, color;

  if      (event === "TP2_HIT")          { title = `✅ FULL WIN — ${trade.symbol} ${trade.direction} | ${pnlStr}`;                   color = "long"; }
  else if (event === "TP1_HIT")          { title = `🟡 TP1 HIT — ${trade.symbol} ${trade.direction} | Still running to TP2...`;      color = trade.direction === "LONG" ? "long" : "short"; }
  else if (event === "SL_HIT")           { title = `🔴 STOPPED OUT — ${trade.symbol} ${trade.direction} | ${pnlStr}`;               color = "warning"; }
  else if (event === "SL_HIT_AFTER_TP1") { title = `🟡 PARTIAL WIN — ${trade.symbol} ${trade.direction} | TP1 banked | ${pnlStr}`; color = trade.direction === "LONG" ? "long" : "short"; }
  else if (event === "EXPIRED")          { title = `⏰ TRADE EXPIRED — ${trade.symbol} ${trade.direction} | No resolution in 48h`;   color = "info"; }
  else return;   // unknown event — skip

  const openedET = new Date(trade.openedAt).toLocaleTimeString("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: true,
  });

  const fields = [
    {
      name:   "📐 Levels",
      value:  `Entry: **${trade.entry}** | SL: ${trade.sl} | TP1: ${trade.tp1} | TP2: ${trade.tp2}`,
      inline: false,
    },
    {
      name:   "📊 Trade",
      value:  `${trade.decision} | Score: ${trade.score ?? "N/A"}/100 | ${trade.setup ?? "—"}`,
      inline: true,
    },
    {
      name:   "💰 P&L",
      value:  pnlStr,
      inline: true,
    },
    {
      name:   "📈 Running Record",
      value:  record,
      inline: false,
    },
  ];

  await discord.send(title, `Alert opened: ${openedET} ET`, color, fields);
}

// ── Main Tick ─────────────────────────────────────────────────────

async function tick() {
  // Skip entirely if no open trades — saves an API call
  const stats = tradeTracker.getStats();
  if (stats.openTrades.length === 0) {
    logger.debug("[pricePoller] No open trades — skipping poll");
    return;
  }

  if (!isRTH()) {
    logger.debug("[pricePoller] Outside RTH — skipping poll");
    return;
  }

  pollCount++;
  lastPollAt = new Date().toISOString();

  try {
    const quote = await yf.quote(SYMBOL, {}, { validateResult: false });
    const price = quote?.regularMarketPrice;

    if (!price) {
      logger.warn("[pricePoller] No price data from Yahoo Finance quote");
      return;
    }

    logger.info(
      `[pricePoller] Poll #${pollCount}: ${SYMBOL} @ ${price} | ` +
      `${stats.openTrades.length} open trade(s)`
    );

    // Pass current price only (no day H/L) to avoid false positives
    // from stale day-range data that pre-dates our trade entry.
    const updates = tradeTracker.updateOutcomes({ price });
    for (const update of updates) {
      await notifyOutcome(update).catch(err =>
        logger.warn(`[pricePoller] Outcome notify failed: ${err.message}`)
      );
    }

  } catch (err) {
    logger.error(`[pricePoller] Poll #${pollCount} failed: ${err.message}`);
  }
}

// ── Public API ────────────────────────────────────────────────────

function start() {
  if (intervalHandle) {
    logger.warn("[pricePoller] Already running");
    return false;
  }

  intervalHandle = setInterval(tick, POLL_INTERVAL_MS);
  logger.info(
    `[pricePoller] Started — polling ${SYMBOL} every ${POLL_INTERVAL_MS / 60000} min ` +
    `for open trade outcome detection`
  );

  // Run immediately so first TP/SL check doesn't wait 2 minutes
  tick();

  return true;
}

function stop() {
  if (!intervalHandle) return false;
  clearInterval(intervalHandle);
  intervalHandle = null;
  logger.info("[pricePoller] Stopped");
  return true;
}

function getStatus() {
  const stats = tradeTracker.getStats();
  return {
    running:         !!intervalHandle,
    symbol:          SYMBOL,
    pollIntervalMin: POLL_INTERVAL_MS / 60000,
    pollCount,
    lastPollAt,
    openTrades:      stats.openTrades,
    summary:         stats.summary,
  };
}

module.exports = { start, stop, getStatus, tick };
