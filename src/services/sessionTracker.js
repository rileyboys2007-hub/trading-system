/**
 * services/sessionTracker.js — Daily Session Tracker
 *
 * Tracks every trade outcome for the current ET trading day.
 * Automatically resets when a new ET date is detected.
 * Persists to src/data/session.json so restarts don't lose today's history.
 *
 * Each trade record stores:
 *   outcome   — WIN | LOSS | BREAKEVEN
 *   entryTime — when the trade was entered (caller-supplied; used for revenge detection)
 *   recordedAt — when the outcome was logged here (always set automatically)
 *
 * Revenge detection uses:
 *   recordedAt of the preceding LOSS  (when the loss was felt)
 *   entryTime  of the subsequent trade (when they jumped back in)
 *   If entryTime is not supplied, recordedAt is used as a fallback
 *   — the output flags this limitation so callers know the measurement may be imprecise.
 */

const fs     = require("fs");
const path   = require("path");
const logger = require("../utils/logger");

const DATA_FILE   = path.join(__dirname, "../data/session.json");
const ARCHIVE_DIR = path.join(__dirname, "../data/sessions");

// ── Helpers ───────────────────────────────────────────────────────

function todayET() {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
}

function freshSession() {
  return {
    date:       todayET(),
    trades:     [],
    wins:       0,
    losses:     0,
    breakevens: 0,
  };
}

// ── In-memory session ─────────────────────────────────────────────

let session = null;

function archiveSession(oldSession) {
  try {
    if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const dest = path.join(ARCHIVE_DIR, `${oldSession.date}.json`);
    if (!fs.existsSync(dest)) {
      fs.writeFileSync(dest, JSON.stringify(oldSession, null, 2));
      logger.info(`[sessionTracker] Archived session for ${oldSession.date}`);
    }
  } catch (err) {
    logger.warn(`[sessionTracker] Archive failed: ${err.message}`);
  }
}

function loadSession() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw   = fs.readFileSync(DATA_FILE, "utf8");
      const saved = JSON.parse(raw);
      if (saved.date === todayET()) {
        session = saved;
        logger.info(
          `[sessionTracker] Loaded ${saved.date} — ` +
          `${saved.trades.length} trades | ${saved.wins}W ${saved.losses}L ${saved.breakevens}BE`
        );
        return;
      }
      // Day rolled over — archive the old session before resetting
      archiveSession(saved);
      logger.info(`[sessionTracker] New ET day detected — resetting (archived: ${saved.date})`);
    }
  } catch (err) {
    logger.warn(`[sessionTracker] Could not load session: ${err.message}`);
  }
  session = freshSession();
}

/**
 * Load a session by ET date string (e.g. "05/30/2026").
 * Returns today's live session if date matches, archived data otherwise.
 */
function getSessionByDate(date) {
  ensureCurrentDay();
  if (date === session.date) return { ...session, trades: [...session.trades] };
  try {
    const archivePath = path.join(ARCHIVE_DIR, `${date}.json`);
    if (fs.existsSync(archivePath)) {
      return JSON.parse(fs.readFileSync(archivePath, "utf8"));
    }
  } catch (err) {
    logger.warn(`[sessionTracker] Could not load archived session for ${date}: ${err.message}`);
  }
  return null;
}

function persistSession() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(session, null, 2));
  } catch (err) {
    logger.error(`[sessionTracker] Persist failed: ${err.message}`);
  }
}

// Boot load
loadSession();

// ── Day-change guard ──────────────────────────────────────────────

function ensureCurrentDay() {
  if (!session || session.date !== todayET()) loadSession();
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Record a trade outcome for today.
 *
 * @param {object} opts
 * @param {string}  opts.outcome    — "WIN" | "LOSS" | "BREAKEVEN"  (case-insensitive)
 * @param {string}  [opts.signalId] — linked signal ID from signalStore
 * @param {string}  [opts.symbol]   — e.g. "NQ=F"
 * @param {string}  [opts.setup]    — e.g. "REVERSAL_LONG"
 * @param {string}  [opts.entryTime] — ISO timestamp of when trade was entered
 *                                     Important for accurate revenge-trade detection.
 *                                     Defaults to recordedAt if omitted.
 * @param {string}  [opts.notes]
 * @returns {object} the recorded trade
 */
function recordOutcome({ outcome, signalId, symbol, setup, notes, entryTime } = {}) {
  ensureCurrentDay();

  const valid = ["WIN", "LOSS", "BREAKEVEN"];
  const normalized = (outcome || "").toUpperCase();
  if (!valid.includes(normalized)) {
    throw new Error(`Invalid outcome "${outcome}". Must be: WIN, LOSS, or BREAKEVEN`);
  }

  const now  = new Date().toISOString();
  const trade = {
    id:               `trade_${Date.now()}`,
    signalId:         signalId  || null,
    symbol:           symbol    || null,
    setup:            setup     || null,
    outcome:          normalized,
    entryTime:        entryTime || null,  // null = caller did not supply
    entryTimeIsExact: !!entryTime,        // flag for revenge-detection accuracy
    recordedAt:       now,
    notes:            notes || "",
  };

  session.trades.push(trade);
  if (normalized === "WIN")           session.wins++;
  else if (normalized === "LOSS")     session.losses++;
  else                                session.breakevens++;

  persistSession();

  logger.info(
    `[sessionTracker] ${normalized} recorded — ` +
    `session: ${session.trades.length} trades | ${session.losses} losses`
  );

  return trade;
}

/**
 * Full session data for today.
 */
function getTodaySession() {
  ensureCurrentDay();
  return { ...session, trades: [...session.trades] };
}

/**
 * Computed stats for today.
 */
function getStats() {
  ensureCurrentDay();
  const total = session.trades.length;
  return {
    date:          session.date,
    totalTrades:   total,
    wins:          session.wins,
    losses:        session.losses,
    breakevens:    session.breakevens,
    winRate:       total > 0 ? +((session.wins / total) * 100).toFixed(1) : null,
    currentLossStreak: getCurrentLossStreak(),
    lastTradeAt:   total > 0 ? session.trades[total - 1].recordedAt : null,
    lastOutcome:   total > 0 ? session.trades[total - 1].outcome    : null,
  };
}

/**
 * Count consecutive losses counting backwards from the most recent trade.
 */
function getCurrentLossStreak() {
  ensureCurrentDay();
  let streak = 0;
  for (let i = session.trades.length - 1; i >= 0; i--) {
    if (session.trades[i].outcome === "LOSS") streak++;
    else break;
  }
  return streak;
}

/**
 * Most recent LOSS trade, or null if none today.
 */
function getLastLoss() {
  ensureCurrentDay();
  for (let i = session.trades.length - 1; i >= 0; i--) {
    if (session.trades[i].outcome === "LOSS") return session.trades[i];
  }
  return null;
}

/**
 * Reset session (manual override / testing).
 */
function resetSession() {
  session = freshSession();
  persistSession();
  logger.info("[sessionTracker] Session manually reset");
  return { ...session };
}

module.exports = {
  recordOutcome,
  getTodaySession,
  getSessionByDate,
  getStats,
  getCurrentLossStreak,
  getLastLoss,
  resetSession,
};
