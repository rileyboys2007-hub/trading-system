/**
 * routes/eodReview.js — End-of-Day Review Endpoints
 *
 * POST /eod/generate          — generate (or regenerate) today's review
 * POST /eod/generate?date=... — generate for a specific ET date (MM/DD/YYYY)
 * GET  /eod                   — get today's review (if already generated)
 * GET  /eod/:date             — get a specific review by date (YYYY-MM-DD or MM/DD/YYYY)
 * GET  /eod/history           — list all saved review dates
 *
 * ── Typical End-of-Day Flow ───────────────────────────────────────
 *
 *   [Trading day ends — all trades recorded via POST /risk/outcome]
 *
 *   POST /eod/generate
 *     → analyzes today's session + signals + bias + risk
 *     → calls GPT-4o-mini for mistakes/lessons/improvement
 *     → saves to src/data/reviews/YYYY-MM-DD.json
 *     → returns full review
 *
 *   GET  /eod               → retrieve saved review (instant, no AI call)
 *   GET  /eod/history       → see all past reviews
 *   GET  /eod/2026-05-30    → specific past date
 */

const express = require("express");
const router  = express.Router();
const { generateReview, loadReview, listReviews } = require("../analysis/eodReview");

// ── Normalize date param ──────────────────────────────────────────
// Accepts: "2026-05-30" (YYYY-MM-DD) or "05/30/2026" (MM/DD/YYYY)
// Returns: "MM/DD/YYYY" for internal use, or null if invalid

function normalizeDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-");
    return `${m}/${d}/${y}`;
  }
  // MM/DD/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;

  return null;
}

// ── POST /eod/generate ────────────────────────────────────────────

router.post("/generate", async (req, res, next) => {
  try {
    const rawDate      = req.body?.date || req.query.date || null;
    const date         = normalizeDate(rawDate);
    const forceRefresh = req.body?.forceRefresh === true || req.query.forceRefresh === "true";

    if (rawDate && !date) {
      return res.status(400).json({
        success: false,
        error:   `Invalid date format: "${rawDate}". Use YYYY-MM-DD or MM/DD/YYYY`,
      });
    }

    const review = await generateReview({ date: date || undefined, forceRefresh });
    res.json({ success: true, ...review });
  } catch (err) {
    if (err.message.includes("No session data found")) {
      return res.status(404).json({ success: false, error: err.message });
    }
    next(err);
  }
});

// ── GET /eod/history ──────────────────────────────────────────────
// Must be declared before /:date to avoid "history" matching as a date param

router.get("/history", (req, res, next) => {
  try {
    const dates = listReviews();
    res.json({
      success: true,
      count:   dates.length,
      reviews: dates.map(d => ({
        date:   d,
        url:    `/eod/${d}`,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /eod/:date ────────────────────────────────────────────────

router.get("/:date", (req, res, next) => {
  try {
    const date = normalizeDate(req.params.date);

    if (!date) {
      return res.status(400).json({
        success: false,
        error:   `Invalid date format: "${req.params.date}". Use YYYY-MM-DD or MM/DD/YYYY`,
      });
    }

    const review = loadReview(date);
    if (!review) {
      return res.status(404).json({
        success: false,
        error:   `No review found for ${req.params.date}. Run POST /eod/generate first.`,
      });
    }

    res.json({ success: true, ...review });
  } catch (err) {
    next(err);
  }
});

// ── GET /eod (today) ──────────────────────────────────────────────

router.get("/", (req, res, next) => {
  try {
    const today = new Date().toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
    });

    const review = loadReview(today);
    if (!review) {
      return res.status(404).json({
        success: false,
        error:   "No review generated for today yet. Run POST /eod/generate to create one.",
        hint:    "Reviews are generated at end of session — record your outcomes first via POST /risk/outcome",
      });
    }

    res.json({ success: true, ...review });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
