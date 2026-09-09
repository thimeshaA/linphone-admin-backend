const { adminPool } = require('../config/db');

// Single-row config table (id is always 1, enforced by a DB check
// constraint - see sql/wallets.sql). Only one setting exists so far.
async function getRenewalCost() {
  const [rows] = await adminPool.query('SELECT renewal_cost_usd FROM settings WHERE id = 1 LIMIT 1');
  return rows[0] ? rows[0].renewal_cost_usd : 0;
}

async function setRenewalCost(renewalCostUsd) {
  await adminPool.query('UPDATE settings SET renewal_cost_usd = ? WHERE id = 1', [renewalCostUsd]);
  return renewalCostUsd;
}

module.exports = { getRenewalCost, setRenewalCost };
