const { flexisipPool } = require('../config/db');

// status is never stored - it's derived live from disabled_at/scadenza on
// every read, same pattern already used by reportsController's classifyStatus
// (which has never trusted a stored status value for expiry). creazione/
// scadenza are varchar(10) 'YYYY-MM-DD' columns, aliased to the app-facing
// created_at/expires_at names so no consuming code needs to know about the
// underlying column names.
const PUBLIC_COLUMNS = `
  registerID AS id,
  authid,
  domain,
  creazione AS created_at,
  scadenza AS expires_at,
  disabled_at,
  renewed_at,
  creator_id,
  email,
  CASE
    WHEN disabled_at IS NOT NULL THEN 'disabled'
    WHEN STR_TO_DATE(scadenza, '%Y-%m-%d') < CURDATE() THEN 'expired'
    ELSE 'active'
  END AS status
`;

function buildScopedWhereClause(scopeFilter) {
  if (scopeFilter && scopeFilter.creator_id !== undefined) {
    return { condition: 'creator_id = ?', params: [scopeFilter.creator_id] };
  }
  return { condition: '1=1', params: [] };
}

function toDateOnlyString(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}

async function listAccounts(scopeFilter, { status, search } = {}) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  let sql = `SELECT ${PUBLIC_COLUMNS} FROM accounts WHERE ${condition}`;
  const queryParams = [...params];

  if (search) {
    sql += ' AND (authid LIKE ? OR domain LIKE ?)';
    const term = `%${search}%`;
    queryParams.push(term, term);
  }

  // status is a SELECT-aliased computed column, not a real one, so it can't
  // be filtered in WHERE - MySQL allows HAVING to reference a SELECT alias
  // even without a GROUP BY, which is what makes this work.
  if (status) {
    sql += ' HAVING status = ?';
    queryParams.push(status);
  }

  sql += ' ORDER BY created_at DESC';

  const [rows] = await flexisipPool.query(sql, queryParams);
  return rows;
}

async function getAccountById(id, scopeFilter) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  const [rows] = await flexisipPool.query(
    `SELECT ${PUBLIC_COLUMNS} FROM accounts WHERE registerID = ? AND ${condition}`,
    [id, ...params]
  );
  return rows[0] || null;
}

async function findAccountByAuthid(authid) {
  const [rows] = await flexisipPool.query('SELECT registerID AS id FROM accounts WHERE authid = ? LIMIT 1', [
    authid,
  ]);
  return rows[0] || null;
}

// Bulk authid@domain lookup for invoice line items (wallet_ledger.related_account_id
// points into this database's accounts, not the admin one - see the cross-database
// note on related_account_id in sql/wallets.sql - so it can't be joined in SQL and
// has to be resolved with a separate query, same pattern as adminModel.findAdminUsernamesByIds).
async function findAccountLabelsByIds(ids) {
  if (!ids.length) return {};
  const [rows] = await flexisipPool.query(
    `SELECT registerID AS id, authid, domain FROM accounts WHERE registerID IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  return rows.reduce((map, row) => {
    map[row.id] = `${row.authid}@${row.domain}`;
    return map;
  }, {});
}

async function createAccount({ authid, domain, passwordHash, phone, expiresAt, creatorId, email }) {
  const creazione = toDateOnlyString(new Date());
  const scadenza = toDateOnlyString(expiresAt);

  // login always mirrors authid (no separate app-facing field for it);
  // algorithm is always written explicitly - never rely on the column's
  // 'SHA-256' default, since password hashes here are MD5 (see hashPassword
  // in accountsController.js).
  const [result] = await flexisipPool.query(
    `INSERT INTO accounts (authid, login, domain, password, algorithm, phone, creazione, scadenza, creator_id, email)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [authid, authid, domain, passwordHash, 'MD5', phone, creazione, scadenza, creatorId, email]
  );

  const [rows] = await flexisipPool.query(`SELECT ${PUBLIC_COLUMNS} FROM accounts WHERE registerID = ?`, [
    result.insertId,
  ]);
  return rows[0];
}

async function renewAccount(id, scopeFilter, expiresAt) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  const scadenza = toDateOnlyString(expiresAt);

  const [result] = await flexisipPool.query(
    `UPDATE accounts SET scadenza = ?, renewed_at = NOW() WHERE registerID = ? AND ${condition}`,
    [scadenza, id, ...params]
  );

  if (result.affectedRows === 0) return null;
  return getAccountById(id, scopeFilter);
}

async function reassignAccountCreator(id, resellerId) {
  const [result] = await flexisipPool.query('UPDATE accounts SET creator_id = ? WHERE registerID = ?', [
    resellerId,
    id,
  ]);

  if (result.affectedRows === 0) return null;
  return getAccountById(id, {});
}

async function disableAccount(id, scopeFilter) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  const [result] = await flexisipPool.query(
    `UPDATE accounts SET disabled_at = NOW() WHERE registerID = ? AND ${condition}`,
    [id, ...params]
  );

  if (result.affectedRows === 0) return null;
  return getAccountById(id, scopeFilter);
}

async function updateAccountPassword(id, scopeFilter, passwordHash) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  const [result] = await flexisipPool.query(
    `UPDATE accounts SET password = ? WHERE registerID = ? AND ${condition}`,
    [passwordHash, id, ...params]
  );

  return result.affectedRows > 0;
}

async function deleteAccount(id) {
  const [result] = await flexisipPool.query('DELETE FROM accounts WHERE registerID = ?', [id]);
  return result.affectedRows > 0;
}

module.exports = {
  buildScopedWhereClause,
  listAccounts,
  getAccountById,
  findAccountByAuthid,
  findAccountLabelsByIds,
  createAccount,
  reassignAccountCreator,
  renewAccount,
  disableAccount,
  updateAccountPassword,
  deleteAccount,
};
