const { flexisipPool, adminPool } = require('../config/db');
const { buildScopedWhereClause } = require('./accountModel');

// `status` is only flipped to 'expired' lazily (on login, for resellers; never
// for accounts), so counts here are computed live against expires_at instead
// of trusting the stored status column.
const LIVE_STATUS_CASE = `
  SUM(CASE WHEN status != 'disabled' AND (expires_at IS NULL OR expires_at > NOW()) THEN 1 ELSE 0 END) AS active,
  SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled,
  SUM(CASE WHEN status != 'disabled' AND expires_at IS NOT NULL AND expires_at <= NOW() THEN 1 ELSE 0 END) AS expired
`;

function normalizeStats(row, extraKeys = []) {
  const stats = {
    total: Number(row.total) || 0,
    active: Number(row.active) || 0,
    disabled: Number(row.disabled) || 0,
    expired: Number(row.expired) || 0,
  };
  for (const key of extraKeys) {
    stats[key] = Number(row[key]) || 0;
  }
  return stats;
}

async function getAccountStats(scopeFilter, periodStart, periodEnd) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  const [rows] = await flexisipPool.query(
    `SELECT
      COUNT(*) AS total,
      ${LIVE_STATUS_CASE},
      SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END) AS created_in_period,
      SUM(CASE WHEN renewed_at >= ? AND renewed_at < ? THEN 1 ELSE 0 END) AS renewed_in_period
     FROM auth_users WHERE ${condition}`,
    [periodStart, periodEnd, periodStart, periodEnd, ...params]
  );
  return normalizeStats(rows[0], ['created_in_period', 'renewed_in_period']);
}

async function getAccountCountsByReseller(periodStart, periodEnd) {
  const [rows] = await flexisipPool.query(
    `SELECT creator_id, COUNT(*) AS count
     FROM auth_users
     WHERE created_at >= ? AND created_at < ?
     GROUP BY creator_id`,
    [periodStart, periodEnd]
  );
  return rows.map((row) => ({ creatorId: row.creator_id, count: Number(row.count) || 0 }));
}

async function getResellerStats(periodStart, periodEnd) {
  const [rows] = await adminPool.query(
    `SELECT
      COUNT(*) AS total,
      ${LIVE_STATUS_CASE},
      SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END) AS created_in_period
     FROM admins WHERE role = 'reseller'`,
    [periodStart, periodEnd]
  );
  return normalizeStats(rows[0], ['created_in_period']);
}

// Per-reseller assigned-account counts, keyed by creator_id. Mirrors the
// frontend's getResellerAccountStats (lib/telephony/derived.ts), which
// computes this client-side from GET /accounts + GET /admins; there is no
// shared backend query for it yet, so this is the first server-side version.
async function getResellerAccountAssignments() {
  const [rows] = await flexisipPool.query(
    `SELECT creator_id,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled
     FROM auth_users
     GROUP BY creator_id`
  );
  return rows.map((row) => ({
    creatorId: row.creator_id,
    total: Number(row.total) || 0,
    active: Number(row.active) || 0,
    disabled: Number(row.disabled) || 0,
  }));
}

module.exports = {
  getAccountStats,
  getAccountCountsByReseller,
  getResellerStats,
  getResellerAccountAssignments,
};
