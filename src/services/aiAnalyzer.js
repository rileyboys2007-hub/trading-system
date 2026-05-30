/**
 * services/aiAnalyzer.js — OpenAI Analysis Wrapper
 * Wraps GPT-4o-mini calls used across the system.
 * Forces JSON output via response_format so results are always parseable.
 *
 * Used by:
 *   - bias.js (daily bias analysis)
 *   - Future: scoring, playbook, EOD review
 */

const OpenAI = require("openai");
const logger = require("../utils/logger");

let _client = null;

function getClient() {
  if (!_client) {
    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.includes("YOUR_KEY")) {
      throw new Error("OPENAI_API_KEY is not configured in .env");
    }
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

/**
 * Run a prompt through GPT-4o-mini and parse the JSON response.
 * @param {string} prompt
 * @param {number} maxTokens
 * @returns {object} parsed JSON
 */
async function analyzeJSON(prompt, maxTokens = 500) {
  const client = getClient();
  logger.info("[aiAnalyzer] Sending prompt to GPT-4o-mini...");

  const response = await client.chat.completions.create({
    model:           "gpt-4o-mini",
    messages:        [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    max_tokens:      maxTokens,
    temperature:     0.3,   // low temp = consistent, analytical responses
  });

  const raw = response.choices[0].message.content;
  logger.info(`[aiAnalyzer] Response received (${raw.length} chars, ${response.usage?.total_tokens} tokens)`);

  return JSON.parse(raw);
}

module.exports = { analyzeJSON };
