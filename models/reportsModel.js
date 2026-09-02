const { flexisipPool } = require('../config/db');
const { buildScopedWhereClause } = require('./accountModel');

// Every non-sensitive auth_users column (password/password hash excluded).
const ACCOUNT_ROW_COLUMNS =
  'id, authid, domain, email, status, created_at, expires_at, disabled_at, expired_at, renewed_at, creator_id';

async function getAccountRows(scopeFilter, periodStart, periodEnd) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  const [rows] = await flexisipPool.query(
    `SELECT ${ACCOUNT_ROW_COLUMNS}
     FROM auth_users
     WHERE ${condition} AND created_at >= ? AND created_at < ?
     ORDER BY created_at ASC`,
    [...params, periodStart, periodEnd]
  );
  return rows;
}

module.exports = {
  getAccountRows,
};
