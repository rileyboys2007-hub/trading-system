/**
 * services/tradeTracker.js — Trade Outcome Tracker
 *
 * Records every TAKE / STRONG TAKE alert and monitors whether price
 * subsequently hits Stop Loss, TP1, or TP2. Sends Discord updates on
 * each closure and maintains a running win-rate record.
 *
 * Outcome states:
 *   OPEN         — alert fired, monitoring in progress
 *   TP1_PENDING  — TP1 reached, now watching for TP2 or SL reversal
 *   CLOSED       — final outcome recorded (see .outcome field)
 *
 * Final outcomes:
 *   TP2_HIT      — Full win: price hit TP2                   (+rr2 × slPts)
 *   TP1_THEN_SL  — Partial win: TP1 banked, came back to SL  (+rr1 × slPts)
 *   SL_HIT       — Loss: stopped out before TP1              (–slPts)
 *   EXPIRED      — No resolution in 48 h (closed at neutral) (0)
 *
 * Win rate = (TP2_HIT + TP1_THEN_SL) / total closed (excl. EXPIRED)
 */

const fs     = require("fs");
const path   = require("path");
const logger = require("../utils/logger");

const DATA_FILE = path.join(__dirname, "../data/trades.json");
const EXPIRE_HOURS = 48;   // auto-close open trades after 48 hours

// ── Persistence ───────────────────────────────────────────────────

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    }
  } catch { /* ignore parse errors — start fresh */ }
  return [];
}

function save(trades) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(trades, null, 2));
  } catch (err) {
    logger.error(`[tradeTracker] Save failed: ${err.message}`);
  }
}

// ── Record a new alert ────────────────────────────────────────────

/**
 * Called immediately when a TAKE / STRONG TAKE alert fires.
 * @param {object} signal     — from scanner / alertService
 * @param {object} decision   — from makeDecision
 * @param {object} scoreResult — from scoreSignal (may be null)
 * @returns {object} trade record
 */
function recordTrade(signal, decision, scoreResult) {
  const trade = {
    id:          `trade_${Date.now()}`,
    symbol:      signal.symbol   ?? "NQ=F",
    direction:   signal.direction,
    entry:       signal.entry,
    sl:          signal.sl,
    tp1:         signal.tp1,
    tp2:         signal.tp2,
    slPoints:    signal.slPoints,
    rr1:         signal.rr1,
    rr2:         signal.rr2,
    decision:    decision?.decision    ?? "TAKE",
    score:       scoreResult?.totalScore ?? null,
    grade:       scoreResult?.grade      ?? null,
    setup:       signal.setup           ?? null,

    openedAt:    new Date().toISOString(),
    closedAt:    null,
    status:      "OPEN",           // OPEN | TP1_PENDING | CLOSED
    outcome:     null,             // TP2_HIT | TP1_THEN_SL | SL_HIT | EXPIRED
    tp1HitAt:    null,
    tp2HitAt:    null,
    slHitAt:     null,
    pnlPoints:   null,
  };

  const trades = load();
  trades.push(trade);
  save(trades);

  logger.info(
    `[tradeTracker] Recorded trade ${trade.id} | ${trade.direction} ${trade.symbol} ` +
    `@ ${trade.entry} | SL: ${trade.sl} | TP1: ${trade.tp1} | TP2: ${trade.tp2}`
  );

  return trade;
}

// ── Price-level hit detection ─────────────────────────────────────

/**
 * Checks a price bar (or just current price) against a trade's levels.
 * Uses high/low when available for accurate wick detection.
 */
function checkLevels(trade, { price, high, low } = {}) {
  const h = high  ?? price;
  const l = low   ?? price;
  const isLong = trade.direction === "LONG";

  return {
    hitSL:  isLong ? l <= trade.sl  : h >= trade.sl,
    hitTP1: isLong ? h >= trade.tp1 : l <= trade.tp1,
    hitTP2: isLong ? h >= trade.tp2 : l <= trade.tp2,
  };
}

// ── Update open trades against current bar ────────────────────────

/**
 * Called on every scanner tick.
 * Checks all open trades and closes any that hit SL / TP1 / TP2.
 *
 * @param {{ price:number, high?:number, low?:number }} bar  latest price data
 * @returns {Array} updates — each { trade, event } for Discord notifications
 */
function updateOutcomes(bar) {
  const trades  = load();
  const updates = [];
  const now     = new Date().toISOString();

  for (const trade of trades) {
    if (trade.status === "CLOSED") continue;

    // Expire stale trades
    const ageHours = (Date.now() - new Date(trade.openedAt).getTime()) / 3_600_000;
    if (ageHours > EXPIRE_HOURS) {
      trade.status   = "CLOSED";
      trade.outcome  = "EXPIRED";
      trade.pnlPoints = 0;
      trade.closedAt = now;
      updates.push({ trade, event: "EXPIRED" });
      continue;
    }

    const { hitSL, hitTP1, hitTP2 } = checkLevels(trade, bar);

    if (trade.status === "OPEN") {
      if (hitTP2) {
        // Best case: jumped straight to TP2
        trade.tp1HitAt = now;
        trade.tp2HitAt = now;
        trade.status   = "CLOSED";
        trade.outcome  = "TP2_HIT";
        trade.pnlPoints = +(trade.slPoints * trade.rr2).toFixed(2);
        trade.closedAt = now;
        updates.push({ trade, event: "TP2_HIT" });
      } else if (hitTP1) {
        // TP1 touched — keep watching for TP2 or reversal
        trade.tp1HitAt = now;
        trade.status   = "TP1_PENDING";
        updates.push({ trade, event: "TP1_HIT" });
      } else if (hitSL) {
        // Stopped out before TP1
        trade.slHitAt  = now;
        trade.status   = "CLOSED";
        trade.outcome  = "SL_HIT";
        trade.pnlPoints = +(-trade.slPoints).toFixed(2);
        trade.closedAt = now;
        updates.push({ trade, event: "SL_HIT" });
      }
    } else if (trade.status === "TP1_PENDING") {
      if (hitTP2) {
        trade.tp2HitAt = now;
        trade.status   = "CLOSED";
        trade.outcome  = "TP2_HIT";
        trade.pnlPoints = +(trade.slPoints * trade.rr2).toFixed(2);
        trade.closedAt = now;
        updates.push({ trade, event: "TP2_HIT" });
      } else if (hitSL) {
        // TP1 banked but runner came back to SL
        trade.slHitAt  = now;
        trade.status   = "CLOSED";
        trade.outcome  = "TP1_THEN_SL";
        // Credit TP1 profits (conservative: assume you closed runner at SL breakeven)
        trade.pnlPoints = +(trade.slPoints * trade.rr1).toFixed(2);
        trade.closedAt = now;
        updates.push({ trade, event: "SL_HIT_AFTER_TP1" });
      }
    }
  }

  if (updates.length > 0) {
    save(trades);
    logger.info(`[tradeTracker] ${updates.length} trade(s) updated: ${updates.map(u => u.event).join(", ")}`);
  }

  return updates;
}

// ── Stats ─────────────────────────────────────────────────────────

function getStats() {
  const trades = load();

  const open    = trades.filter(t => t.status !== "CLOSED");
  const closed  = trades.filter(t => t.status === "CLOSED" && t.outcome !== "EXPIRED");
  const expired = trades.filter(t => t.outcome === "EXPIRED");

  const tp2Wins    = closed.filter(t => t.outcome === "TP2_HIT").length;
  const partialWins = closed.filter(t => t.outcome === "TP1_THEN_SL").length;
  const losses      = closed.filter(t => t.outcome === "SL_HIT").length;
  const wins        = tp2Wins + partialWins;
  const total       = closed.length;
  const winRatePct  = total > 0 ? Math.round((wins / total) * 100) : null;

  const totalPnl  = closed.reduce((s, t) => s + (t.pnlPoints ?? 0), 0);
  const avgPnl    = total > 0 ? +(totalPnl / total).toFixed(2) : null;

  // Best and worst trades
  const byPnl  = [...closed].sort((a, b) => (b.pnlPoints ?? 0) - (a.pnlPoints ?? 0));
  const best   = byPnl[0]  ?? null;
  const worst  = byPnl[byPnl.length - 1] ?? null;

  // Recent trades (last 10)
  const recent = trades.slice(-10).reverse().map(t => ({
    id:        t.id,
    direction: t.direction,
    decision:  t.decision,
    score:     t.score,
    entry:     t.entry,
    sl:        t.sl,
    tp1:       t.tp1,
    tp2:       t.tp2,
    status:    t.status,
    outcome:   t.outcome,
    pnlPoints: t.pnlPoints,
    openedAt:  t.openedAt,
    closedAt:  t.closedAt,
  }));

  return {
    summary: {
      total,
      open:        open.length,
      closed:      total,
      expired:     expired.length,
      wins,
      losses,
      fullWins:    tp2Wins,
      partialWins,
      winRatePct,
      totalPnlPoints: +totalPnl.toFixed(2),
      avgPnlPoints:   avgPnl,
    },
    best:   best  ? { outcome: best.outcome,  pnlPoints: best.pnlPoints,  direction: best.direction,  entry: best.entry }  : null,
    worst:  worst ? { outcome: worst.outcome, pnlPoints: worst.pnlPoints, direction: worst.direction, entry: worst.entry } : null,
    recent,
    openTrades: open.map(t => ({
      id: t.id, direction: t.direction, entry: t.entry,
      sl: t.sl, tp1: t.tp1, tp2: t.tp2, status: t.status, openedAt: t.openedAt,
    })),
  };
}

/** One-liner for embedding the record in Discord messages */
function recordLine() {
  const s = getStats().summary;
  if (s.total === 0) return "No trades recorded yet";
  const bar = s.winRatePct >= 60 ? "🟢" : s.winRatePct >= 40 ? "🟡" : "🔴";
  return `${bar} **${s.winRatePct}% win rate** (${s.wins}W / ${s.losses}L of ${s.total} trades) | PnL: ${s.totalPnlPoints > 0 ? "+" : ""}${s.totalPnlPoints} pts`;
}

module.exports = { recordTrade, updateOutcomes, getStats, recordLine };
