const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const {
  findAdminByUsername,
  findAdminByEmail,
  findAdminById,
  updatePasswordById,
  markResellerExpired,
} = require('../models/adminModel');
const {
  createPasswordReset,
  findPasswordResetByTokenHash,
  markPasswordResetUsed,
} = require('../models/passwordResetModel');
const { sendMail } = require('../utils/mailer');
const { renderPasswordResetHtml } = require('../utils/emailTemplates');
const { isValidEmail } = require('../utils/validators');

const COOKIE_NAME = 'token';
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const SALT_ROUNDS = 10;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const GENERIC_FORGOT_PASSWORD_MESSAGE =
  "If that email is associated with an account, we've sent a link to reset the password.";

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
};

async function login(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const admin = await findAdminByUsername(username);
  if (!admin) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const passwordMatches = await bcrypt.compare(password, admin.password_hash);
  if (!passwordMatches) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  if (admin.status === 'disabled') {
    return res.status(403).json({ error: 'Account is disabled' });
  }

  if (admin.role === 'reseller' && admin.expires_at && new Date(admin.expires_at) <= new Date()) {
    if (admin.status === 'active') {
      await markResellerExpired(admin.id);
    }
    return res.status(403).json({ error: 'Account has expired' });
  }

  const token = jwt.sign(
    { id: admin.id, username: admin.username, role: admin.role },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: TOKEN_TTL_MS });

  return res.json({
    id: admin.id,
    username: admin.username,
    role: admin.role,
  });
}

function logout(req, res) {
  res.clearCookie(COOKIE_NAME, cookieOptions);
  return res.json({ message: 'Logged out successfully' });
}

function getCurrentAdmin(req, res) {
  return res.json(req.admin);
}

async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  }

  const admin = await findAdminById(req.admin.id);
  if (!admin) {
    return res.status(404).json({ error: 'Account not found' });
  }

  const passwordMatches = await bcrypt.compare(currentPassword, admin.password_hash);
  if (!passwordMatches) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await updatePasswordById(req.admin.id, passwordHash);

  return res.json({ message: 'Password changed successfully' });
}

async function forgotPassword(req, res) {
  const { email } = req.body;

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'a valid email is required' });
  }

  const admin = await findAdminByEmail(email);

  // Always do the same amount of visible work regardless of match, and
  // always return the same response — an attacker must not be able to tell
  // whether an email is registered from either the response or its timing.
  if (admin) {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashResetToken(rawToken);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await createPasswordReset({ adminId: admin.id, tokenHash, expiresAt });

    const resetUrl = `${process.env.ADMIN_PANEL_URL}/reset-password?token=${rawToken}`;

    try {
      await sendMail({
        to: admin.email,
        subject: 'Reset your Admin Control password',
        text: `We received a request to reset your Admin Control password.\n\nReset it here: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can ignore this email.`,
        html: renderPasswordResetHtml({ username: admin.username, resetUrl, expiresInMinutes: 60 }),
      });
    } catch (err) {
      console.error('Failed to send password reset email:', err);
    }
  }

  return res.json({ message: GENERIC_FORGOT_PASSWORD_MESSAGE });
}

async function resetPassword(req, res) {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ error: 'token and password are required' });
  }

  const reset = await findPasswordResetByTokenHash(hashResetToken(token));
  const isValid = reset && !reset.used_at && new Date(reset.expires_at) > new Date();

  if (!isValid) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  await updatePasswordById(reset.admin_id, passwordHash);
  await markPasswordResetUsed(reset.id);

  return res.json({ message: 'Password updated.' });
}

module.exports = {
  login,
  logout,
  getCurrentAdmin,
  changePassword,
  forgotPassword,
  resetPassword,
};
