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

// Counts accounts created within the period, bucketed to one row per day
// (bucketUnit 'day', for monthly reports) or per month (bucketUnit 'month',
// for annual reports) - backs the accounts report's creation timeline chart.
// bucketUnit is caller-controlled (not user input), so it's safe to splice
// straight into the SQL rather than parameterizing it.
async function getAccountCreationCounts(scopeFilter, periodStart, periodEnd, bucketUnit) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  const bucketExpr =
    bucketUnit === 'day' ? "DATE_FORMAT(created_at, '%Y-%m-%d')" : "DATE_FORMAT(created_at, '%Y-%m')";
  const [rows] = await flexisipPool.query(
    `SELECT ${bucketExpr} AS bucket, COUNT(*) AS count
     FROM auth_users
     WHERE ${condition} AND created_at >= ? AND created_at < ?
     GROUP BY bucket`,
    [...params, periodStart, periodEnd]
  );
  return rows;
}

module.exports = {
  getAccountRows,
  getAccountCreationCounts,
};
