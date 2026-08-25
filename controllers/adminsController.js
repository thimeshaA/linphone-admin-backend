const bcrypt = require('bcrypt');
const {
  findAdminByUsername,
  listResellers,
  getResellerById,
  createReseller,
  updateResellerStatus,
  updateResellerPassword,
  deleteReseller,
  renewReseller,
} = require('../models/adminModel');
const { sendMail } = require('../utils/mailer');
const { isValidEmail } = require('../utils/validators');

const SALT_ROUNDS = 10;

function defaultExpiresAt() {
  const date = new Date();
  date.setMonth(date.getMonth() + 6);
  return date;
}

async function list(req, res) {
  const { status } = req.query;

  if (status && status !== 'active' && status !== 'disabled') {
    return res.status(400).json({ error: 'status must be "active" or "disabled"' });
  }

  const resellers = await listResellers(status);
  return res.json(resellers);
}

async function getOne(req, res) {
  const reseller = await getResellerById(req.params.id);

  if (!reseller) {
    return res.status(404).json({ error: 'Reseller not found' });
  }

  return res.json(reseller);
}

async function create(req, res) {
  const { username, password, expires_at, email } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'a valid email is required' });
  }

  const existing = await findAdminByUsername(username);
  if (existing) {
    return res.status(409).json({ error: 'Username already exists' });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const reseller = await createReseller({
    username,
    passwordHash,
    expiresAt: expires_at || defaultExpiresAt(),
    email,
  });

  try {
    await sendMail({
      to: email,
      subject: 'Your reseller account credentials',
      text: `Your reseller account has been created.\n\nUsername: ${username}\nPassword: ${password}\n\nLog in at: ${process.env.ADMIN_PANEL_URL}`,
      html: `<p>Your reseller account has been created.</p><p><strong>Username:</strong> ${username}<br><strong>Password:</strong> ${password}</p><p>Log in at <a href="${process.env.ADMIN_PANEL_URL}">${process.env.ADMIN_PANEL_URL}</a></p>`,
    });
  } catch (err) {
    console.error('Failed to send reseller credentials email:', err);
  }

  return res.status(201).json(reseller);
}

async function renew(req, res) {
  const { expires_at } = req.body;
  const expiresAt = expires_at || defaultExpiresAt();

  const reseller = await renewReseller(req.params.id, expiresAt);
  if (!reseller) {
    return res.status(404).json({ error: 'Reseller not found' });
  }

  return res.json(reseller);
}

async function updateStatus(req, res) {
  const { status } = req.body;

  if (status !== 'active' && status !== 'disabled') {
    return res.status(400).json({ error: 'status must be "active" or "disabled"' });
  }

  const updated = await updateResellerStatus(req.params.id, status);
  if (!updated) {
    return res.status(404).json({ error: 'Reseller not found' });
  }

  return res.json(updated);
}

async function resetPassword(req, res) {
  const { newPassword } = req.body;

  if (!newPassword) {
    return res.status(400).json({ error: 'newPassword is required' });
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  const updated = await updateResellerPassword(req.params.id, passwordHash);

  if (!updated) {
    return res.status(404).json({ error: 'Reseller not found' });
  }

  return res.json({ message: 'Password reset successfully' });
}

async function remove(req, res) {
  const deleted = await deleteReseller(req.params.id);

  if (!deleted) {
    return res.status(404).json({ error: 'Reseller not found' });
  }

  return res.json({ message: 'Reseller deleted successfully' });
}

module.exports = { list, getOne, create, updateStatus, resetPassword, remove, renew };
