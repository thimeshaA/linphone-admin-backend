const bcrypt = require('bcrypt');
const {
  findAdminByUsername,
  findAdminByEmail,
  findAdminById,
  listResellers,
  getResellerById,
  createReseller,
  updateResellerStatus,
  updateResellerEmail,
  updateResellerPassword,
  deleteReseller,
  renewReseller,
} = require('../models/adminModel');
const { createAuditLog } = require('../models/auditLogModel');
const { createWallet } = require('../models/walletModel');
const { createLedgerEntry } = require('../models/walletLedgerModel');
const { sendMail } = require('../utils/mailer');
const { renderPasswordChangedHtml } = require('../utils/emailTemplates');
const { isValidEmail, isValidUsername, isValidPassword } = require('../utils/validators');

const SALT_ROUNDS = 12;

async function notifyPasswordChanged(reseller) {
  try {
    await sendMail({
      to: reseller.email,
      subject: 'Your Admin Control password was changed',
      text: `Hi ${reseller.username},\n\nAn administrator just reset your Admin Control password. If this wasn't expected, contact your administrator immediately.`,
      html: renderPasswordChangedHtml({ username: reseller.username, changedAt: new Date() }),
    });
  } catch (err) {
    console.error('Failed to send password-changed notification email:', err);
  }
}

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
  const { username, password, expires_at, email, initialCredit } = req.body;

  const errors = {};

  if (!isValidUsername(username)) {
    errors.username =
      'username is required (1-64 characters) and may only contain letters, digits, ".", "_" and "-"';
  }

  if (!isValidEmail(email)) {
    errors.email = 'a valid email is required';
  }

  const passwordError = isValidPassword(password);
  if (passwordError) {
    errors.password = passwordError;
  }

  if (expires_at !== undefined && expires_at !== null && Number.isNaN(new Date(expires_at).getTime())) {
    errors.expires_at = 'expires_at must be a valid date';
  }

  if (
    initialCredit !== undefined &&
    initialCredit !== null &&
    (typeof initialCredit !== 'number' || !Number.isFinite(initialCredit) || initialCredit < 0)
  ) {
    errors.initialCredit = 'initialCredit must be a non-negative number';
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

  const credit = initialCredit || 0;
  await createWallet(reseller.id, credit);
  if (credit > 0) {
    await createLedgerEntry({
      resellerId: reseller.id,
      type: 'initial_credit',
      amountUsd: credit,
      createdBy: req.admin.id,
      note: null,
    });
  }

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

// Step-up auth: resetting another account's password is a highly privileged
// action, so the acting admin must re-confirm their own current password
// (same check as the self-service changePassword flow) rather than just
// riding on an existing session cookie - this limits the blast radius of a
// hijacked admin session.
async function resetPassword(req, res) {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword) {
    return res.status(400).json({ error: 'currentPassword is required' });
  }

  const passwordError = isValidPassword(newPassword);
  if (passwordError) {
    return res.status(400).json({ error: passwordError });
  }

  const actingAdmin = await findAdminById(req.admin.id);
  if (!actingAdmin) {
    return res.status(404).json({ error: 'Account not found' });
  }

  const passwordMatches = await bcrypt.compare(currentPassword, actingAdmin.password_hash);
  if (!passwordMatches) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const reseller = await getResellerById(req.params.id);
  if (!reseller) {
    return res.status(404).json({ error: 'Reseller not found' });
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await updateResellerPassword(req.params.id, passwordHash);

  await createAuditLog({
    actorId: actingAdmin.id,
    actorRole: actingAdmin.role,
    action: 'admin_reset_password',
    targetId: req.params.id,
    ip: req.ip,
  });
  await notifyPasswordChanged(reseller);

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
