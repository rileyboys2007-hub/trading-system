/**
 * services/newsRisk.js — News Risk Checker
 * Fetches the Forex Factory RSS feed and finds the next
 * high-impact USD event. Returns minutes until that event
 * so the scoring engine can penalize trades near news.
 *
 * Risk levels:
 *   EXTREME  — event within 10 min  (score: 0)
 *   HIGH     — event within 30 min  (score: 20)
 *   MEDIUM   — event within 60 min  (score: 50)
 *   LOW      — event within 120 min (score: 75)
 *   CLEAR    — no event in 2 hours  (score: 100)
 *
 * Caches for 10 minutes to avoid hammering the feed.
 */

const axios              = require("axios");
const { parseStringPromise } = require("xml2js");
const logger             = require("../utils/logger");
const { ZoneInfo }       = (() => {
  try { return require("zoneinfo"); } catch { return {}; }
})();

const FF_RSS_URL  = "https://nfs.faireconomy.media/ff_calendar_thisweek.xml";
const ET_ZONE     = "America/New_York";
const CACHE_TTL   = 10 * 60 * 1000; // 10 minutes

let _cache = { fetchedAt: 0, events: [] };

// ── ET Helpers ────────────────────────────────────────────────────

function nowET() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: ET_ZONE }));
}

function parseEventTime(dateStr, timeStr) {
  // FF format: date "01-29-2026", time "8:30am"
  try {
    const dt = new Date(`${dateStr} ${timeStr}`);
    return new Date(dt.toLocaleString("en-US", { timeZone: ET_ZONE }));
  } catch {
    return null;
  }
}

// ── Feed Fetcher ──────────────────────────────────────────────────

async function fetchEvents() {
  const now = Date.now();
  if (now - _cache.fetchedAt < CACHE_TTL && _cache.events.length) {
    return _cache.events;
  }

  try {
    const resp   = await axios.get(FF_RSS_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TradingSystem/1.0)" },
      timeout: 8000,
    });
    const parsed = await parseStringPromise(resp.data);
    const raw    = parsed?.weeklyevents?.event || [];

    const events = raw.map(e => ({
      title:   (e.title   || [""])[0],
      country: (e.country || [""])[0],
      date:    (e.date    || [""])[0],
      time:    (e.time    || [""])[0],
      impact:  (e.impact  || [""])[0],
    }));

    _cache = { fetchedAt: now, events };
    logger.info(`[newsRisk] Fetched ${events.length} events from FF RSS`);
    return events;

  } catch (err) {
    logger.warn(`[newsRisk] FF RSS fetch failed: ${err.message} — returning CLEAR`);
    return _cache.events; // use stale cache if available
  }
}

// ── Risk Assessor ─────────────────────────────────────────────────

async function getNewsRisk() {
  const events = await fetchEvents();
  const now    = nowET();

  const highImpact = events.filter(e =>
    e.country.toUpperCase() === "USD" &&
    ["high", "red"].includes(e.impact.toLowerCase()) &&
    e.date && e.time
  );

  // Find the next upcoming event
  let nextEvent    = null;
  let minutesUntil = Infinity;

  for (const ev of highImpact) {
    const evTime = parseEventTime(ev.date, ev.time);
    if (!evTime) continue;
    const diff = (evTime - now) / 60000; // in minutes
    if (diff >= -5 && diff < minutesUntil) { // allow 5 min past (actual release window)
      minutesUntil = diff;
      nextEvent    = ev;
    }
  }

  // Score based on proximity
  let score, riskLevel;

  if (!nextEvent || minutesUntil === Infinity) {
    score = 100; riskLevel = "CLEAR";
  } else if (minutesUntil <= 10) {
    score = 0;   riskLevel = "EXTREME";
  } else if (minutesUntil <= 30) {
    score = 20;  riskLevel = "HIGH";
  } else if (minutesUntil <= 60) {
    score = 50;  riskLevel = "MEDIUM";
  } else if (minutesUntil <= 120) {
    score = 75;  riskLevel = "LOW";
  } else {
    score = 100; riskLevel = "CLEAR";
  }

  return {
    riskLevel,
    score,
    minutesUntil: minutesUntil === Infinity ? null : Math.round(minutesUntil),
    nextEvent: nextEvent
      ? { title: nextEvent.title, time: nextEvent.time, date: nextEvent.date }
      : null,
    explanation: nextEvent
      ? `${nextEvent.title} in ${Math.round(minutesUntil)} min — risk level: ${riskLevel}`
      : "No high-impact USD events in the next 2 hours",
  };
}

module.exports = { getNewsRisk };
