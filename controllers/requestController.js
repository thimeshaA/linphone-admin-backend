const bcrypt = require('bcrypt');
const {
  createRequest,
  listRequests,
  getRequestById,
  approveRequest,
  rejectRequest,
} = require('../models/requestModel');
const { findAdminByUsername, createReseller } = require('../models/adminModel');
const { sendResellerCredentialsEmail } = require('../utils/mailer');

const SALT_ROUNDS = 10;
const REQUEST_TYPES = ['reseller', 'esim'];
const REQUEST_STATUSES = ['pending', 'approved', 'rejected'];

async function create(req, res) {
  const { type, requester_name, requester_email, payload } = req.body;

  if (!REQUEST_TYPES.includes(type)) {
    return res.status(400).json({ error: 'type must be "reseller" or "esim"' });
  }
  if (!requester_email) {
    return res.status(400).json({ error: 'requester_email is required' });
  }

  const created = await createRequest({
    type,
    requesterName: requester_name,
    requesterEmail: requester_email,
    payload,
  });

  return res.status(201).json(created);
}

async function list(req, res) {
  const { type, status } = req.query;

  if (type && !REQUEST_TYPES.includes(type)) {
    return res.status(400).json({ error: 'type must be "reseller" or "esim"' });
  }
  if (status && !REQUEST_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'status must be "pending", "approved" or "rejected"' });
  }

  const requests = await listRequests({ type, status });
  return res.json(requests);
}

async function getOne(req, res) {
  const request = await getRequestById(req.params.id);

  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }

  return res.json(request);
}

async function approve(req, res) {
  const request = await getRequestById(req.params.id);
  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }
  if (request.type !== 'reseller') {
    return res.status(400).json({ error: 'Only reseller requests can be approved this way' });
  }
  if (request.status !== 'pending') {
    return res.status(400).json({ error: 'Request has already been reviewed' });
  }

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const existing = await findAdminByUsername(username);
  if (existing) {
    return res.status(409).json({ error: 'Username already exists' });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  await createReseller({ username, passwordHash });

  try {
    await sendResellerCredentialsEmail(request.requester_email, username, password);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to send credentials email' });
  }

  const updated = await approveRequest(req.params.id, req.admin.id);
  return res.json(updated);
}

async function reject(req, res) {
  const request = await getRequestById(req.params.id);
  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }
  if (request.status !== 'pending') {
    return res.status(400).json({ error: 'Request has already been reviewed' });
  }

  const updated = await rejectRequest(req.params.id, req.admin.id);
  return res.json(updated);
}

module.exports = { create, list, getOne, approve, reject };
