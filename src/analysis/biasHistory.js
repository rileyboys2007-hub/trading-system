/**
 * analysis/biasHistory.js — Bias Persistence
 * Saves each bias reading to src/data/bias-history.json.
 * Lets you review past daily bias calls and track accuracy over time.
 */

const fs   = require("fs");
const path = require("path");
const logger = require("../utils/logger");

const FILE = path.join(__dirname, "../data/bias-history.json");

function load() {
  try {
    if (fs.existsSync(FILE)) {
      return JSON.parse(fs.readFileSync(FILE, "utf8"));
    }
  } catch (e) {
    logger.warn(`[biasHistory] Could not load: ${e.message}`);
  }
  return [];
}

function save(biasResult) {
  try {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const history = load();
    // Avoid duplicate entries for the same date
    const today = biasResult.cachedAt.split("T")[0];
    const filtered = history.filter(h => h.cachedAt.split("T")[0] !== today);
    filtered.push(biasResult);

    // Keep last 90 days
    const trimmed = filtered.slice(-90);
    fs.writeFileSync(FILE, JSON.stringify(trimmed, null, 2));
    logger.info(`[biasHistory] Saved bias for ${today}`);
  } catch (e) {
    logger.error(`[biasHistory] Save failed: ${e.message}`);
  }
}

function getAll() {
  return load();
}

function getByDate(dateStr) {
  return load().find(h => h.cachedAt.startsWith(dateStr)) || null;
}

module.exports = { save, getAll, getByDate };
