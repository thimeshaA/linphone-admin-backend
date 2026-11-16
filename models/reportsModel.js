const { flexisipPool } = require('../config/db');
const { buildScopedWhereClause } = require('./accountModel');

// Every non-sensitive accounts column (password/password hash excluded).
// creazione/scadenza are varchar(10) 'YYYY-MM-DD' - aliased to the same
// created_at/expires_at names the rest of the app already expects, and
// status is derived live rather than read from a stored column, same as
// accountModel.js's PUBLIC_COLUMNS.
const ACCOUNT_ROW_COLUMNS = `
  registerID AS id,
  authid,
  domain,
  email,
  disabled_at,
  creazione AS created_at,
  scadenza AS expires_at,
  renewed_at,
  creator_id,
  CASE
    WHEN disabled_at IS NOT NULL THEN 'disabled'
    WHEN STR_TO_DATE(scadenza, '%Y-%m-%d') < CURDATE() THEN 'expired'
    ELSE 'active'
  END AS status
`;

// creazione is a varchar(10) date string, not a real DATE/TIMESTAMP column -
// range comparisons against it are done through STR_TO_DATE explicitly rather
// than relying on MySQL to implicitly coerce the string, since a bare string
// comparison against a datetime-formatted parameter is only correct by
// coincidence at day-granularity boundaries.
async function getAccountRows(scopeFilter, periodStart, periodEnd) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  const [rows] = await flexisipPool.query(
    `SELECT ${ACCOUNT_ROW_COLUMNS}
     FROM accounts
     WHERE ${condition}
       AND STR_TO_DATE(creazione, '%Y-%m-%d') >= ?
       AND STR_TO_DATE(creazione, '%Y-%m-%d') < ?
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
    bucketUnit === 'day'
      ? "DATE_FORMAT(STR_TO_DATE(creazione, '%Y-%m-%d'), '%Y-%m-%d')"
      : "DATE_FORMAT(STR_TO_DATE(creazione, '%Y-%m-%d'), '%Y-%m')";
  const [rows] = await flexisipPool.query(
    `SELECT ${bucketExpr} AS bucket, COUNT(*) AS count
     FROM accounts
     WHERE ${condition}
       AND STR_TO_DATE(creazione, '%Y-%m-%d') >= ?
       AND STR_TO_DATE(creazione, '%Y-%m-%d') < ?
     GROUP BY bucket`,
    [...params, periodStart, periodEnd]
  );
  return rows;
}

module.exports = {
  getAccountRows,
  getAccountCreationCounts,
};
