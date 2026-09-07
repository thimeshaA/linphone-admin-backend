const { adminPool } = require('../config/db');

// No foreign keys on actor_id/target_id: audit rows must outlive the admin
// or reseller row they reference (e.g. after a reseller is deleted), so
// referential integrity is intentionally not enforced at the DB level here.
//
// Swallows its own errors (logging only) rather than letting callers decide
// whether to try/catch it - this is called from every auth-sensitive
// controller path, and a logging failure must never block the underlying
// security operation (e.g. a login should still succeed if the audit write
// fails). Mirrors how email-send failures are already handled in this
// codebase (see authController.forgotPassword).
async function createAuditLog({ actorId, actorRole, action, targetId, ip }) {
  try {
    await adminPool.query(
      'INSERT INTO audit_logs (actor_id, actor_role, action, target_id, ip_address) VALUES (?, ?, ?, ?, ?)',
      [actorId ?? null, actorRole ?? null, action, targetId ?? null, ip ?? null]
    );
  } catch (err) {
    console.error('Failed to write audit log:', err);
  }
}

module.exports = { createAuditLog };
