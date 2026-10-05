const { v4: uuidv4 } = require('uuid');
const { adminPool } = require('../config/db');

// Matches on username OR email so login accepts either interchangeably.
// Safe to reuse for username-uniqueness checks too: usernames can never
// contain '@', so a username value can never spuriously match the email side.
const ADMIN_AUTH_COLUMNS =
  'id, username, password_hash, role, status, expires_at, expired_at, email, created_at, ' +
  'password_changed_at, failed_login_attempts, locked_until, token_version';

async function findAdminByUsername(identifier) {
  const [rows] = await adminPool.query(
    `SELECT ${ADMIN_AUTH_COLUMNS} FROM admins WHERE username = ? OR email = ? LIMIT 1`,
    [identifier, identifier]
  );
  return rows[0] || null;
}

async function findAdminByEmail(email) {
  const [rows] = await adminPool.query(`SELECT ${ADMIN_AUTH_COLUMNS} FROM admins WHERE email = ? LIMIT 1`, [
    email,
  ]);
  return rows[0] || null;
}

async function adminExistsById(id) {
  const [rows] = await adminPool.query('SELECT id FROM admins WHERE id = ? LIMIT 1', [id]);
  return rows.length > 0;
}

async function findAdminUsernamesByIds(ids) {
  if (!ids.length) return {};
  const [rows] = await adminPool.query(
    `SELECT id, username FROM admins WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  return rows.reduce((map, row) => {
    map[row.id] = row.username;
    return map;
  }, {});
}

async function findAdminById(id) {
  const [rows] = await adminPool.query(`SELECT ${ADMIN_AUTH_COLUMNS} FROM admins WHERE id = ? LIMIT 1`, [
    id,
  ]);
  return rows[0] || null;
}

// A password change is treated as clearing any in-progress lockout too - it's
// the standard "prove you're the owner" recovery path, same as a successful
// login would.
async function updatePasswordById(id, passwordHash) {
  const [result] = await adminPool.query(
    'UPDATE admins SET password_hash = ?, password_changed_at = NOW(), failed_login_attempts = 0, locked_until = NULL WHERE id = ?',
    [passwordHash, id]
  );
  return result.affectedRows > 0;
}

// Lightweight read used on every authenticated request (see verifyToken) to
// check whether a JWT predates the account's most recent password change
// (`pwc` claim) or explicit logout (`tv` claim) - deliberately not the full
// ADMIN_AUTH_COLUMNS read.
async function getSessionInvalidationState(id) {
  const [rows] = await adminPool.query(
    'SELECT password_changed_at, token_version FROM admins WHERE id = ? LIMIT 1',
    [id]
  );
  return rows[0] || null;
}

// Bumping token_version makes every JWT issued before this call fail the
// `tv` check in verifyToken, regardless of its expiry - this is what gives
// logout (and any future "sign out everywhere") actual server-side effect
// instead of just clearing the cookie client-side.
async function incrementTokenVersion(id) {
  await adminPool.query('UPDATE admins SET token_version = token_version + 1 WHERE id = ?', [id]);
}

// Threshold/lockout-duration policy lives in the controller; this just
// persists whatever attempt count and lock expiry it's given.
async function recordFailedLogin(id, { attempts, lockedUntil }) {
  await adminPool.query('UPDATE admins SET failed_login_attempts = ?, locked_until = ? WHERE id = ?', [
    attempts,
    lockedUntil,
    id,
  ]);
}

async function clearLoginLockout(id) {
  await adminPool.query('UPDATE admins SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?', [
    id,
  ]);
}

async function listResellers(status) {
  let query =
    "SELECT id, username, role, status, expires_at, expired_at, email, created_at FROM admins WHERE role = 'reseller'";
  const params = [];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC';

  const [rows] = await adminPool.query(query, params);
  return rows;
}

// Queried by role rather than a fixed id/username so notification code
// (e.g. renewal-deduction emails) keeps working unchanged if a second admin
// row is ever added.
async function listAdminsByRole(role) {
  const [rows] = await adminPool.query('SELECT id, username, email FROM admins WHERE role = ?', [role]);
  return rows;
}

async function getResellerById(id) {
  const [rows] = await adminPool.query(
    "SELECT id, username, role, status, expires_at, expired_at, email, created_at FROM admins WHERE id = ? AND role = 'reseller' LIMIT 1",
    [id]
  );
  return rows[0] || null;
}

async function createReseller({ username, passwordHash, expiresAt, email }) {
  // admins.id is UUID, not AUTO_INCREMENT - the app must generate it.
  const id = uuidv4();
  await adminPool.query(
    "INSERT INTO admins (id, username, password_hash, role, status, expires_at, email) VALUES (?, ?, ?, 'reseller', 'active', ?, ?)",
    [id, username, passwordHash, expiresAt, email]
  );
  return getResellerById(id);
}

async function renewReseller(id, expiresAt) {
  const isFuture = new Date(expiresAt) > new Date();

  let sql = "UPDATE admins SET expires_at = ?";
  const params = [expiresAt];

  if (isFuture) {
    sql += ", status = 'active', expired_at = NULL";
  }

  sql += " WHERE id = ? AND role = 'reseller'";
  params.push(id);

  const [result] = await adminPool.query(sql, params);

  if (result.affectedRows === 0) return null;
  return getResellerById(id);
}

async function markResellerExpired(id) {
  await adminPool.query(
    "UPDATE admins SET status = 'expired', expired_at = NOW() WHERE id = ? AND role = 'reseller' AND status = 'active'",
    [id]
  );
}

async function updateResellerStatus(id, status) {
  const [result] = await adminPool.query(
    "UPDATE admins SET status = ? WHERE id = ? AND role = 'reseller'",
    [status, id]
  );
  if (result.affectedRows === 0) return null;
  return getResellerById(id);
}

async function updateResellerEmail(id, email) {
  const [result] = await adminPool.query(
    "UPDATE admins SET email = ? WHERE id = ? AND role = 'reseller'",
    [email, id]
  );
  if (result.affectedRows === 0) return null;
  return getResellerById(id);
}

async function updateResellerPassword(id, passwordHash) {
  const [result] = await adminPool.query(
    "UPDATE admins SET password_hash = ?, password_changed_at = NOW(), failed_login_attempts = 0, locked_until = NULL WHERE id = ? AND role = 'reseller'",
    [passwordHash, id]
  );
  return result.affectedRows > 0;
}

async function deleteReseller(id) {
  const [result] = await adminPool.query("DELETE FROM admins WHERE id = ? AND role = 'reseller'", [
    id,
  ]);
  return result.affectedRows > 0;
}

module.exports = {
  findAdminByUsername,
  findAdminByEmail,
  adminExistsById,
  findAdminUsernamesByIds,
  findAdminById,
  updatePasswordById,
  getSessionInvalidationState,
  incrementTokenVersion,
  recordFailedLogin,
  clearLoginLockout,
  listResellers,
  listAdminsByRole,
  getResellerById,
  createReseller,
  updateResellerStatus,
  updateResellerEmail,
  updateResellerPassword,
  deleteReseller,
  renewReseller,
  markResellerExpired,
};
