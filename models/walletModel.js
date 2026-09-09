const { adminPool } = require('../config/db');

// Mirrors accountModel.buildScopedWhereClause: req.scopeFilter is populated
// by the same applyOwnershipFilter middleware used for accounts, so it's
// keyed on `creator_id` there too even though the column being scoped here
// is `reseller_id` - that's the reseller's own admin id in both cases.
function buildScopedWhereClause(scopeFilter) {
  if (scopeFilter && scopeFilter.creator_id !== undefined) {
    return { condition: 'reseller_id = ?', params: [scopeFilter.creator_id] };
  }
  return { condition: '1=1', params: [] };
}

async function createWallet(resellerId, balanceUsd) {
  await adminPool.query('INSERT INTO wallets (reseller_id, balance_usd) VALUES (?, ?)', [
    resellerId,
    balanceUsd,
  ]);
}

async function getWalletByResellerId(resellerId, scopeFilter) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  const [rows] = await adminPool.query(
    `SELECT reseller_id, balance_usd, updated_at FROM wallets WHERE reseller_id = ? AND ${condition}`,
    [resellerId, ...params]
  );
  return rows[0] || null;
}

async function adjustWalletBalance(resellerId, deltaUsd) {
  const [result] = await adminPool.query(
    'UPDATE wallets SET balance_usd = balance_usd + ? WHERE reseller_id = ?',
    [deltaUsd, resellerId]
  );
  return result.affectedRows > 0;
}

// Bulk current-balance read for the reports' billing section (platform-wide
// "amount owed" needs every reseller's live balance, not just one).
async function listAllWalletBalances() {
  const [rows] = await adminPool.query('SELECT reseller_id, balance_usd FROM wallets');
  return rows;
}

module.exports = {
  buildScopedWhereClause,
  createWallet,
  getWalletByResellerId,
  adjustWalletBalance,
  listAllWalletBalances,
};
