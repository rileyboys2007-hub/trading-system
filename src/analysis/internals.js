/**
 * analysis/internals.js — Market Internals Engine
 *
 * Reads QQQ, NVDA, MSFT, AAPL and aggregates a real-time
 * market health reading for NQ futures trading.
 *
 * Why these four:
 *   QQQ  — Direct Nasdaq 100 proxy. Most important single signal.
 *   NVDA — Largest NQ component (~9%). Leads tech momentum.
 *   MSFT — Second largest NQ component (~8%). More stable leader.
 *   AAPL — Third largest (~7%). Broad consumer/institutional signal.
 *
 * Scoring per instrument (normalized −1 to +1):
 *   changePct     — how much is it up/down today            (weight 40%)
 *   volumeRatio   — is the move confirmed by volume?        (weight 25%)
 *   dayRangePos   — where did price close in today's range? (weight 20%)
 *   vs50DayMA     — structural trend position               (weight 15%)
 *
 * Instrument weights in aggregate:
 *   QQQ: 40% | NVDA: 25% | MSFT: 20% | AAPL: 15%
 *
 * Sentiment thresholds (weighted aggregate score):
 *   > +0.45  → STRONG_BULLISH
 *   > +0.15  → BULLISH
 *   ±0.15    → MIXED
 *   < −0.15  → BEARISH
 *   < −0.45  → STRONG_BEARISH
 */

const YahooFinance = require("yahoo-finance2").default;
const yf    = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const logger = require("../utils/logger");

// ── Config ────────────────────────────────────────────────────────

const INSTRUMENTS = [
  { symbol: "QQQ",  label: "Nasdaq 100 ETF", weight: 0.40 },
  { symbol: "NVDA", label: "NVIDIA",         weight: 0.25 },
  { symbol: "MSFT", label: "Microsoft",      weight: 0.20 },
  { symbol: "AAPL", label: "Apple",          weight: 0.15 },
];

const FACTOR_WEIGHTS = {
  changePct:   0.40,
  volumeRatio: 0.25,
  dayRangePos: 0.20,
  vs50DayMA:   0.15,
};

const SENTIMENT_THRESHOLDS = [
  { min:  0.45, label: "STRONG_BULLISH" },
  { min:  0.15, label: "BULLISH"        },
  { min: -0.15, label: "MIXED"          },
  { min: -0.45, label: "BEARISH"        },
  { min: -Infinity, label: "STRONG_BEARISH" },
];

// ── Data Fetcher ──────────────────────────────────────────────────

async function fetchQuote(symbol) {
  try {
    const q = await yf.quote(symbol, {}, { validateResult: false });
    return {
      symbol,
      price:        q.regularMarketPrice,
      changePct:    q.regularMarketChangePercent,
      change:       q.regularMarketChange,
      volume:       q.regularMarketVolume,
      avgVolume:    q.averageDailyVolume3Month,
      dayHigh:      q.regularMarketDayHigh,
      dayLow:       q.regularMarketDayLow,
      prevClose:    q.regularMarketPreviousClose,
      ma50:         q.fiftyDayAverage,
      ma200:        q.twoHundredDayAverage,
      marketState:  q.marketState,
    };
  } catch (err) {
    logger.warn(`[internals] Failed to fetch ${symbol}: ${err.message}`);
    return null;
  }
}

// ── Individual Factor Scorers (each returns −1 to +1) ────────────

/** Price change % — scaled so ±2% maps to ±1.0. */
function scoreChangePct(changePct) {
  return Math.max(-1, Math.min(1, changePct / 2));
}

/**
 * Volume ratio — amplifies price direction signal.
 * High volume UP = more bullish. High volume DOWN = more bearish.
 * Low volume = dilutes the signal toward 0.
 */
function scoreVolumeRatio(volume, avgVolume, changePct) {
  if (!volume || !avgVolume) return 0;
  const ratio     = volume / avgVolume;
  const direction = changePct >= 0 ? 1 : -1;

  if (ratio >= 1.5) return direction * 1.0;   // heavy volume — strong confirmation
  if (ratio >= 1.2) return direction * 0.6;
  if (ratio >= 0.8) return direction * 0.3;   // average volume — mild confirmation
  if (ratio >= 0.5) return direction * 0.1;   // light volume — weak confirmation
  return 0;                                    // very low volume — no signal
}

/**
 * Day range position — where did price close relative to today's H/L?
 * 1.0 = closed at high of day (strong), 0.0 = closed at low (weak)
 * Normalized to −1 to +1.
 */
function scoreDayRangePos(price, dayHigh, dayLow) {
  if (!dayHigh || !dayLow || dayHigh === dayLow) return 0;
  const position = (price - dayLow) / (dayHigh - dayLow);   // 0.0 to 1.0
  return (position - 0.5) * 2;                               // −1 to +1
}

/**
 * Distance from 50-day MA — structural trend health.
 * Scaled so ±10% maps to ±1.0.
 */
function scoreVs50MA(price, ma50) {
  if (!price || !ma50) return 0;
  const pctAbove = ((price - ma50) / ma50) * 100;
  return Math.max(-1, Math.min(1, pctAbove / 10));
}

// ── Per-Instrument Scorer ─────────────────────────────────────────

function scoreInstrument(quote) {
  if (!quote || !quote.price) {
    return { score: 0, factors: {}, sentiment: "NEUTRAL", available: false };
  }

  const factors = {
    changePct:   scoreChangePct(quote.changePct   ?? 0),
    volumeRatio: scoreVolumeRatio(quote.volume, quote.avgVolume, quote.changePct ?? 0),
    dayRangePos: scoreDayRangePos(quote.price, quote.dayHigh, quote.dayLow),
    vs50DayMA:   scoreVs50MA(quote.price, quote.ma50),
  };

  const score = Object.entries(factors).reduce(
    (sum, [key, val]) => sum + val * FACTOR_WEIGHTS[key],
    0
  );

  const volumeRatio = quote.avgVolume ? +(quote.volume / quote.avgVolume).toFixed(2) : null;
  const vs50Pct     = quote.ma50 ? +(((quote.price - quote.ma50) / quote.ma50) * 100).toFixed(2) : null;
  const dayRangePct = (quote.dayHigh && quote.dayLow && quote.dayHigh !== quote.dayLow)
    ? +(((quote.price - quote.dayLow) / (quote.dayHigh - quote.dayLow)) * 100).toFixed(1)
    : null;

  return {
    available:   true,
    symbol:      quote.symbol,
    price:       quote.price,
    changePct:   +(quote.changePct?.toFixed(3) ?? 0),
    volumeRatio,
    dayRangePct,
    vs50Pct,
    score:       +score.toFixed(4),
    factors,
  };
}

// ── Sentiment Label ───────────────────────────────────────────────

function getSentimentLabel(score) {
  for (const t of SENTIMENT_THRESHOLDS) {
    if (score >= t.min) return t.label;
  }
  return "STRONG_BEARISH";
}

// ── Confidence Score ──────────────────────────────────────────────

function calcConfidence(instrumentScores, aggregateScore) {
  // 1. Signal strength (how far from zero?)
  const strengthBonus = Math.abs(aggregateScore) * 35;

  // 2. Agreement across instruments
  const available = instrumentScores.filter(i => i.available);
  if (!available.length) return 50;

  const direction    = aggregateScore >= 0 ? 1 : -1;
  const agreeing     = available.filter(i => (i.score >= 0 ? 1 : -1) === direction).length;
  const agreementPct = agreeing / available.length;
  const agreementBonus = (agreementPct - 0.5) * 30; // −15 to +15

  // 3. Volume confirmation (avg volume ratio across instruments)
  const volRatios = available.filter(i => i.volumeRatio).map(i => i.volumeRatio);
  const avgVolRatio = volRatios.length ? volRatios.reduce((a,b) => a+b, 0) / volRatios.length : 1;
  const volBonus = avgVolRatio >= 1.3 ? 10 : avgVolRatio <= 0.7 ? -5 : 0;

  const confidence = Math.round(Math.max(20, Math.min(95, 50 + strengthBonus + agreementBonus + volBonus)));
  return confidence;
}

// ── Driver Generator ──────────────────────────────────────────────

function buildDrivers(instrumentResults, aggregateScore) {
  const drivers = [];

  for (const { instrument, result } of instrumentResults) {
    if (!result.available) continue;

    const chg = result.changePct;
    const dir = chg >= 0 ? "▲" : "▼";
    const abs = Math.abs(chg).toFixed(2);

    // Flag notable moves
    if (Math.abs(chg) >= 1.5) {
      drivers.push(`${instrument.label} ${dir}${abs}% — significant ${chg >= 0 ? "strength" : "weakness"}`);
    } else if (result.volumeRatio && result.volumeRatio >= 1.5) {
      drivers.push(`${instrument.label} moving ${dir}${abs}% on ${result.volumeRatio}x volume`);
    } else if (result.vs50Pct !== null && Math.abs(result.vs50Pct) >= 8) {
      const side = result.vs50Pct >= 0 ? "above" : "below";
      drivers.push(`${instrument.label} ${Math.abs(result.vs50Pct)}% ${side} 50-day MA`);
    } else {
      drivers.push(`${instrument.label} ${dir}${abs}%`);
    }
  }

  return drivers.slice(0, 3);
}

// ── Main Export ───────────────────────────────────────────────────

async function getMarketInternals() {
  logger.info("[internals] Fetching market internals...");

  // Fetch all quotes in parallel
  const quotes = await Promise.all(INSTRUMENTS.map(i => fetchQuote(i.symbol)));

  // Score each instrument
  const instrumentResults = INSTRUMENTS.map((instrument, idx) => ({
    instrument,
    quote:  quotes[idx],
    result: scoreInstrument(quotes[idx]),
  }));

  // Weighted aggregate score
  let totalWeight = 0;
  let weightedSum = 0;

  for (const { instrument, result } of instrumentResults) {
    if (result.available) {
      weightedSum += result.score * instrument.weight;
      totalWeight += instrument.weight;
    }
  }

  const aggregateScore = totalWeight > 0
    ? +(weightedSum / totalWeight).toFixed(4)
    : 0;

  const sentiment   = getSentimentLabel(aggregateScore);
  const confidence  = calcConfidence(instrumentResults.map(i => i.result), aggregateScore);
  const drivers     = buildDrivers(instrumentResults, aggregateScore);

  // Build instruments output map
  const instruments = {};
  for (const { instrument, result } of instrumentResults) {
    instruments[instrument.symbol] = {
      label:       instrument.label,
      weight:      instrument.weight,
      available:   result.available,
      price:       result.price       ?? null,
      changePct:   result.changePct   ?? null,
      volumeRatio: result.volumeRatio ?? null,
      dayRangePct: result.dayRangePct ?? null,
      vs50Pct:     result.vs50Pct     ?? null,
      score:       result.score,
      sentiment:   result.available ? getSentimentLabel(result.score) : "UNAVAILABLE",
    };
  }

  const output = {
    sentiment,
    confidence,
    aggregateScore,
    calculatedAt: new Date().toISOString(),
    instruments,
    drivers,
    summary: buildSummary(sentiment, confidence, drivers),
  };

  logger.info(
    `[internals] ${sentiment} (${confidence}% confidence) | ` +
    `Score: ${aggregateScore} | ` +
    Object.entries(instruments)
      .map(([sym, d]) => `${sym}:${d.changePct >= 0 ? "+" : ""}${d.changePct}%`)
      .join(" ")
  );

  return output;
}

function buildSummary(sentiment, confidence, drivers) {
  const tone = {
    STRONG_BULLISH: "Market internals strongly support upside",
    BULLISH:        "Market internals lean bullish",
    MIXED:          "Market internals are mixed — no clear edge",
    BEARISH:        "Market internals lean bearish",
    STRONG_BEARISH: "Market internals strongly suggest downside",
  }[sentiment] || "Market internals unclear";
  return `${tone} (${confidence}% confidence). ${drivers[0] || ""}`;
}

module.exports = { getMarketInternals };
