/**
 * services/signalStore.js — Signal Storage
 * Stores all received signals in memory for fast access during a session.
 * Also persists to a JSON file so signals survive server restarts.
 *
 * In-memory store: Map keyed by signal ID
 * File store: src/data/signals.json (appended per signal)
 *
 * API:
 *   save(signal)          — store a new signal
 *   getById(id)           — fetch one signal
 *   getAll()              — fetch all signals (newest first)
 *   getBySymbol(symbol)   — filter by symbol
 *   getByStatus(status)   — filter by status
 *   update(id, changes)   — update fields on an existing signal
 *   getStats()            — summary counts by status/setup
 */

const fs     = require("fs");
const path   = require("path");
const logger = require("../utils/logger");

const DATA_FILE = path.join(__dirname, "../data/signals.json");

// ── In-memory store ───────────────────────────────────────
const store = new Map();

// ── Boot: load persisted signals into memory ──────────────
(function loadFromDisk() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const signals = JSON.parse(raw);
      if (Array.isArray(signals)) {
        signals.forEach((s) => store.set(s.id, s));
        logger.info(`[signalStore] Loaded ${signals.length} signals from disk`);
      }
    }
  } catch (err) {
    logger.warn(`[signalStore] Could not load signals from disk: ${err.message}`);
  }
})();

// ── Persist current store to disk ────────────────────────
function saveToDisk() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const all = Array.from(store.values());
    fs.writeFileSync(DATA_FILE, JSON.stringify(all, null, 2));
  } catch (err) {
    logger.error(`[signalStore] Disk write failed: ${err.message}`);
  }
}

// ── Public API ────────────────────────────────────────────

function save(signal) {
  store.set(signal.id, signal);
  saveToDisk();
  logger.info(`[signalStore] Saved signal ${signal.id} | ${signal.symbol} ${signal.setup} @ ${signal.entry}`);
  return signal;
}

function getById(id) {
  return store.get(id) || null;
}

function getAll() {
  return Array.from(store.values())
    .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
}

function getBySymbol(symbol) {
  return getAll().filter((s) => s.symbol === symbol.toUpperCase());
}

function getByStatus(status) {
  return getAll().filter((s) => s.status === status);
}

function update(id, changes) {
  const signal = store.get(id);
  if (!signal) {
    logger.warn(`[signalStore] update() called on unknown ID: ${id}`);
    return null;
  }
  const updated = { ...signal, ...changes };
  store.set(id, updated);
  saveToDisk();
  return updated;
}

function getStats() {
  const all = getAll();
  const byStatus = {};
  const bySetup  = {};

  for (const s of all) {
    byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    bySetup[s.setup]   = (bySetup[s.setup]   || 0) + 1;
  }

  return { total: all.length, byStatus, bySetup };
}

module.exports = { save, getById, getAll, getBySymbol, getByStatus, update, getStats };
