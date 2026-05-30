/**
 * playbooks/index.js
 * Re-exports from the analysis engine.
 * Individual playbook logic lives in src/analysis/playbooks.js.
 */
const { detectPlaybooks } = require("../analysis/playbooks");
module.exports = { detectPlaybooks };
