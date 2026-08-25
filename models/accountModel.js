const { flexisipPool } = require('../config/db');

const PUBLIC_COLUMNS =
  'id, authid, domain, created_at, status, expires_at, disabled_at, expired_at, creator_id, email';

function buildScopedWhereClause(scopeFilter) {
  if (scopeFilter && scopeFilter.creator_id !== undefined) {
    return { condition: 'creator_id = ?', params: [scopeFilter.creator_id] };
  }
  return { condition: '1=1', params: [] };
}

async function listAccounts(scopeFilter, { status, search } = {}) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  let sql = `SELECT ${PUBLIC_COLUMNS} FROM auth_users WHERE ${condition}`;
  const queryParams = [...params];

  if (status) {
    sql += ' AND status = ?';
    queryParams.push(status);
  }

  if (search) {
    sql += ' AND (authid LIKE ? OR domain LIKE ?)';
    const term = `%${search}%`;
    queryParams.push(term, term);
  }

  sql += ' ORDER BY created_at DESC';

  const [rows] = await flexisipPool.query(sql, queryParams);
  return rows;
}

async function getAccountById(id, scopeFilter) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  const [rows] = await flexisipPool.query(
    `SELECT ${PUBLIC_COLUMNS} FROM auth_users WHERE id = ? AND ${condition}`,
    [id, ...params]
  );
  return rows[0] || null;
}

async function findAccountByAuthidDomain(authid, domain) {
  const [rows] = await flexisipPool.query(
    'SELECT id FROM auth_users WHERE authid = ? AND domain = ? LIMIT 1',
    [authid, domain]
  );
  return rows[0] || null;
}

async function createAccount({ authid, domain, passwordHash, status, expiresAt, creatorId, email }) {
  const [result] = await flexisipPool.query(
    'INSERT INTO auth_users (authid, domain, password, status, expires_at, creator_id, email) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [authid, domain, passwordHash, status, expiresAt, creatorId, email]
  );

  const [rows] = await flexisipPool.query(`SELECT ${PUBLIC_COLUMNS} FROM auth_users WHERE id = ?`, [
    result.insertId,
  ]);
  return rows[0];
}

async function renewAccount(id, scopeFilter, expiresAt) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  const isFuture = new Date(expiresAt) > new Date();

  let sql = 'UPDATE auth_users SET expires_at = ?';
  const queryParams = [expiresAt];

  if (isFuture) {
    sql += ", status = 'active', expired_at = NULL";
  }

  sql += ` WHERE id = ? AND ${condition}`;
  queryParams.push(id, ...params);

  const [result] = await flexisipPool.query(sql, queryParams);

  if (result.affectedRows === 0) return null;
  return getAccountById(id, scopeFilter);
}

async function disableAccount(id, scopeFilter) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  const [result] = await flexisipPool.query(
    `UPDATE auth_users SET disabled_at = NOW(), status = 'disabled' WHERE id = ? AND ${condition}`,
    [id, ...params]
  );

  if (result.affectedRows === 0) return null;
  return getAccountById(id, scopeFilter);
}

async function updateAccountPassword(id, scopeFilter, passwordHash) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  const [result] = await flexisipPool.query(
    `UPDATE auth_users SET password = ? WHERE id = ? AND ${condition}`,
    [passwordHash, id, ...params]
  );

  return result.affectedRows > 0;
}

async function deleteAccount(id) {
  const [result] = await flexisipPool.query('DELETE FROM auth_users WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

module.exports = {
  buildScopedWhereClause,
  listAccounts,
  getAccountById,
  findAccountByAuthidDomain,
  createAccount,
  renewAccount,
  disableAccount,
  updateAccountPassword,
  deleteAccount,
};
