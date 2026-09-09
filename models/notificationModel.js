const { adminPool } = require('../config/db');

const NOTIFICATION_COLUMNS = 'id, recipient_id, type, title, message, payload, read_at, created_at';

async function createNotification(recipientId, type, title, message, payload) {
  const [result] = await adminPool.query(
    'INSERT INTO notifications (recipient_id, type, title, message, payload) VALUES (?, ?, ?, ?, ?)',
    [recipientId, type, title, message, payload ?? null]
  );

  const [rows] = await adminPool.query(`SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE id = ?`, [
    result.insertId,
  ]);
  return rows[0];
}

async function listNotificationsForRecipient(recipientId, { page, limit, unreadOnly }) {
  const offset = (page - 1) * limit;
  const unreadCondition = unreadOnly ? 'AND read_at IS NULL' : '';

  const [rows] = await adminPool.query(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE recipient_id = ? ${unreadCondition} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [recipientId, limit, offset]
  );
  const [countRows] = await adminPool.query(
    `SELECT COUNT(*) AS total FROM notifications WHERE recipient_id = ? ${unreadCondition}`,
    [recipientId]
  );

  return { rows, total: countRows[0].total };
}

async function getNotificationForRecipient(id, recipientId) {
  const [rows] = await adminPool.query(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE id = ? AND recipient_id = ? LIMIT 1`,
    [id, recipientId]
  );
  return rows[0] || null;
}

// Guarded by `read_at IS NULL` so re-marking an already-read notification
// doesn't stomp its original read_at with a later timestamp.
async function markNotificationRead(id, recipientId) {
  await adminPool.query(
    'UPDATE notifications SET read_at = NOW() WHERE id = ? AND recipient_id = ? AND read_at IS NULL',
    [id, recipientId]
  );
}

async function markAllNotificationsRead(recipientId) {
  await adminPool.query('UPDATE notifications SET read_at = NOW() WHERE recipient_id = ? AND read_at IS NULL', [
    recipientId,
  ]);
}

module.exports = {
  createNotification,
  listNotificationsForRecipient,
  getNotificationForRecipient,
  markNotificationRead,
  markAllNotificationsRead,
};
