const bcrypt = require('bcrypt');
const {
  findAdminByUsername,
  findAdminByEmail,
  listResellers,
  getResellerById,
  createReseller,
  updateResellerStatus,
  updateResellerEmail,
  updateResellerPassword,
  deleteReseller,
  renewReseller,
} = require('../models/adminModel');
const { sendMail } = require('../utils/mailer');
const { isValidEmail, isValidUsername } = require('../utils/validators');

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

  const errors = {};

  if (!isValidUsername(username)) {
    errors.username =
      'username is required (1-64 characters) and may only contain letters, digits, ".", "_" and "-"';
  }

  if (!isValidEmail(email)) {
    errors.email = 'a valid email is required';
  }

  if (!password) {
    errors.password = 'password is required';
  }

  if (expires_at !== undefined && expires_at !== null && Number.isNaN(new Date(expires_at).getTime())) {
    errors.expires_at = 'expires_at must be a valid date';
  }

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ errors });
  }

  const existingUsername = await findAdminByUsername(username);
  if (existingUsername) {
    return res.status(409).json({ error: 'Username already exists' });
  }

  const existingEmail = await findAdminByEmail(email);
  if (existingEmail) {
    return res.status(409).json({ error: 'Email already exists' });
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

async function update(req, res) {
  const { status, email, username } = req.body;

  if (username !== undefined) {
    return res.status(400).json({ errors: { username: 'username cannot be changed after creation' } });
  }

  if (status === undefined && email === undefined) {
    return res.status(400).json({ error: 'status or email is required' });
  }

  const errors = {};

  if (status !== undefined && status !== 'active' && status !== 'disabled') {
    errors.status = 'status must be "active" or "disabled"';
  }

  if (email !== undefined && !isValidEmail(email)) {
    errors.email = 'a valid email is required';
  }

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ errors });
  }

  if (email !== undefined) {
    const existingEmail = await findAdminByEmail(email);
    if (existingEmail && String(existingEmail.id) !== String(req.params.id)) {
      return res.status(409).json({ error: 'Email already exists' });
    }
  }

  let updated = null;

  if (status !== undefined) {
    updated = await updateResellerStatus(req.params.id, status);
    if (!updated) {
      return res.status(404).json({ error: 'Reseller not found' });
    }
  }

  if (email !== undefined) {
    updated = await updateResellerEmail(req.params.id, email);
    if (!updated) {
      return res.status(404).json({ error: 'Reseller not found' });
    }
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

module.exports = { list, getOne, create, update, resetPassword, remove, renew };
