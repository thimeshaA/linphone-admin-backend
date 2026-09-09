const {
  listNotificationsForRecipient,
  getNotificationForRecipient,
  markNotificationRead,
  markAllNotificationsRead,
} = require('../models/notificationModel');

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function parsePagination(query) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  return { page, limit };
}

async function list(req, res) {
  const { page, limit } = parsePagination(req.query);
  const unreadOnly = req.query.unread === 'true';

  const { rows, total } = await listNotificationsForRecipient(req.admin.id, { page, limit, unreadOnly });

  return res.json({ notifications: rows, pagination: { page, limit, total } });
}

async function markRead(req, res) {
  const notification = await getNotificationForRecipient(req.params.id, req.admin.id);
  if (!notification) {
    return res.status(404).json({ error: 'Notification not found' });
  }

  if (!notification.read_at) {
    await markNotificationRead(req.params.id, req.admin.id);
  }

  const updated = await getNotificationForRecipient(req.params.id, req.admin.id);
  return res.json(updated);
}

async function markAllRead(req, res) {
  await markAllNotificationsRead(req.admin.id);
  return res.json({ message: 'All notifications marked as read' });
}

module.exports = { list, markRead, markAllRead };
