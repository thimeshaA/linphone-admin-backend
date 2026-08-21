const { adminPool } = require('../config/db');

async function findAdminByUsername(username) {
  const [rows] = await adminPool.query(
    'SELECT id, username, password_hash, role, status, expires_at, expired_at, created_at FROM admins WHERE username = ? LIMIT 1',
    [username]
  );
  return rows[0] || null;
}

async function adminExistsById(id) {
  const [rows] = await adminPool.query('SELECT id FROM admins WHERE id = ? LIMIT 1', [id]);
  return rows.length > 0;
}

async function getAdminStatusById(id) {
  const [rows] = await adminPool.query('SELECT id, status FROM admins WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
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
  const [rows] = await adminPool.query(
    'SELECT id, username, password_hash, role, status, expires_at, expired_at, created_at FROM admins WHERE id = ? LIMIT 1',
    [id]
  );
  return rows[0] || null;
}

async function updatePasswordById(id, passwordHash) {
  const [result] = await adminPool.query('UPDATE admins SET password_hash = ? WHERE id = ?', [
    passwordHash,
    id,
  ]);
  return result.affectedRows > 0;
}

async function listResellers(status) {
  let query =
    "SELECT id, username, role, status, expires_at, expired_at, created_at FROM admins WHERE role = 'reseller'";
  const params = [];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC';

  const [rows] = await adminPool.query(query, params);
  return rows;
}

async function getResellerById(id) {
  const [rows] = await adminPool.query(
    "SELECT id, username, role, status, expires_at, expired_at, created_at FROM admins WHERE id = ? AND role = 'reseller' LIMIT 1",
    [id]
  );
  return rows[0] || null;
}

async function createReseller({ username, passwordHash, expiresAt }) {
  const [result] = await adminPool.query(
    "INSERT INTO admins (username, password_hash, role, status, expires_at) VALUES (?, ?, 'reseller', 'active', ?)",
    [username, passwordHash, expiresAt]
  );
  return { id: result.insertId, username, role: 'reseller', status: 'active', expires_at: expiresAt, expired_at: null };
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

async function updateResellerPassword(id, passwordHash) {
  const [result] = await adminPool.query(
    "UPDATE admins SET password_hash = ? WHERE id = ? AND role = 'reseller'",
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
  adminExistsById,
  getAdminStatusById,
  findAdminUsernamesByIds,
  findAdminById,
  updatePasswordById,
  listResellers,
  getResellerById,
  createReseller,
  updateResellerStatus,
  updateResellerPassword,
  deleteReseller,
  renewReseller,
  markResellerExpired,
};
