const { adminPool } = require('../config/db');

async function createPasswordReset({ adminId, tokenHash, expiresAt }) {
  const [result] = await adminPool.query(
    'INSERT INTO password_resets (admin_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [adminId, tokenHash, expiresAt]
  );
  return result.insertId;
}

async function findPasswordResetByTokenHash(tokenHash) {
  const [rows] = await adminPool.query(
    'SELECT id, admin_id, expires_at, used_at FROM password_resets WHERE token_hash = ? LIMIT 1',
    [tokenHash]
  );
  return rows[0] || null;
}

async function markPasswordResetUsed(id) {
  await adminPool.query('UPDATE password_resets SET used_at = NOW() WHERE id = ?', [id]);
}

module.exports = { createPasswordReset, findPasswordResetByTokenHash, markPasswordResetUsed };
