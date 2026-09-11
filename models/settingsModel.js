const { adminPool } = require('../config/db');

// Single-row config table (id is always 1, enforced by a DB check
// constraint - see sql/wallets.sql). Only one setting exists so far.
//
// renewal_cost_usd is priced per 6-month period, not per renewal - see
// renewalUnitsForPeriod in accountsController.js, which multiplies this by
// however many 6-month units a given renewal actually covers (e.g. a 1-year
// renewal deducts 2x this value).
//
// Returns null (not 0) when the row is missing entirely - e.g. the schema
// was never fully initialized. 0 is a legitimate configured value (a
// deliberate free-renewals policy - see updateRenewalCostSetting, which
// accepts it), so the "unconfigured" case has to be distinguishable from it;
// collapsing both to 0 previously let a missing settings row silently
// produce $0 renewal deductions that looked like real transactions (see
// applyRenewalDeduction in accountsController.js, which treats null as a
// hard error and 0 as a loud-but-valid one).
async function getRenewalCost() {
  const [rows] = await adminPool.query('SELECT renewal_cost_usd FROM settings WHERE id = 1 LIMIT 1');
  return rows[0] ? rows[0].renewal_cost_usd : null;
}

async function setRenewalCost(renewalCostUsd) {
  await adminPool.query('UPDATE settings SET renewal_cost_usd = ? WHERE id = 1', [renewalCostUsd]);
  return renewalCostUsd;
}

module.exports = { getRenewalCost, setRenewalCost };
