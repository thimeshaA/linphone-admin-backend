const { adminPool } = require('../config/db');

async function createRequest({ type, requesterName, requesterEmail, payload }) {
  const [result] = await adminPool.query(
    'INSERT INTO requests (type, requester_name, requester_email, payload) VALUES (?, ?, ?, ?)',
    [type, requesterName, requesterEmail, JSON.stringify(payload || {})]
  );
  return getRequestById(result.insertId);
}

async function listRequests({ type, status } = {}) {
  let query = 'SELECT * FROM requests WHERE 1=1';
  const params = [];

  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC';

  const [rows] = await adminPool.query(query, params);
  return rows;
}

async function getRequestById(id) {
  const [rows] = await adminPool.query('SELECT * FROM requests WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function approveRequest(id, reviewedBy) {
  const [result] = await adminPool.query(
    "UPDATE requests SET status = 'approved', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?",
    [reviewedBy, id]
  );
  if (result.affectedRows === 0) return null;
  return getRequestById(id);
}

async function rejectRequest(id, reviewedBy) {
  const [result] = await adminPool.query(
    "UPDATE requests SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW() WHERE id = ?",
    [reviewedBy, id]
  );
  if (result.affectedRows === 0) return null;
  return getRequestById(id);
}

module.exports = {
  createRequest,
  listRequests,
  getRequestById,
  approveRequest,
  rejectRequest,
};
