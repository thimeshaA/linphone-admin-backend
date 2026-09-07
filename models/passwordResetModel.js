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

// Called right before issuing a new token so at most one reset link is ever
// valid for a given admin at a time - otherwise requesting forgot-password
// multiple times in the rate-limit window leaves several simultaneously-valid
// tokens outstanding.
async function invalidateUnusedResetsForAdmin(adminId) {
  await adminPool.query('UPDATE password_resets SET used_at = NOW() WHERE admin_id = ? AND used_at IS NULL', [
    adminId,
  ]);
}

module.exports = {
  createPasswordReset,
  findPasswordResetByTokenHash,
  markPasswordResetUsed,
  invalidateUnusedResetsForAdmin,
};
