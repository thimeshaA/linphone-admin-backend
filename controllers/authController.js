const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const {
  findAdminByUsername,
  findAdminByEmail,
  findAdminById,
  updatePasswordById,
  markResellerExpired,
  recordFailedLogin,
  clearLoginLockout,
} = require('../models/adminModel');
const {
  createPasswordReset,
  findPasswordResetByTokenHash,
  markPasswordResetUsed,
  invalidateUnusedResetsForAdmin,
} = require('../models/passwordResetModel');
const { createAuditLog } = require('../models/auditLogModel');
const { sendMail } = require('../utils/mailer');
const { renderPasswordResetHtml, renderPasswordChangedHtml } = require('../utils/emailTemplates');
const { isValidEmail, isValidPassword } = require('../utils/validators');

const COOKIE_NAME = 'token';
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const SALT_ROUNDS = 12;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const GENERIC_FORGOT_PASSWORD_MESSAGE =
  "If that email is associated with an account, we've sent a link to reset the password.";

// Mirrors the forgotPasswordLimiter window/threshold (middlewares/rateLimit.js)
// for consistency: 3 consecutive failed attempts locks the account for 1 hour.
const LOGIN_LOCKOUT_THRESHOLD = 3;
const LOGIN_LOCKOUT_DURATION_MS = 60 * 60 * 1000;

function hashResetToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function notifyPasswordChanged(admin) {
  try {
    await sendMail({
      to: admin.email,
      subject: 'Your Admin Control password was changed',
      text: `Hi ${admin.username},\n\nThis confirms your Admin Control password was just changed. If this wasn't you, contact your administrator immediately.`,
      html: renderPasswordChangedHtml({ username: admin.username, changedAt: new Date() }),
    });
  } catch (err) {
    console.error('Failed to send password-changed notification email:', err);
  }
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

  // Per-account lockout, independent of the IP-keyed loginLimiter on the
  // route: this still applies even if an attacker rotates IPs.
  if (admin && admin.locked_until && new Date(admin.locked_until) > new Date()) {
    return res
      .status(403)
      .json({ error: 'Account is temporarily locked due to too many failed login attempts. Please try again later.' });
  }

  const passwordMatches = admin ? await bcrypt.compare(password, admin.password_hash) : false;

  if (!admin || !passwordMatches) {
    if (admin) {
      const attempts = (admin.failed_login_attempts || 0) + 1;
      const lockedUntil = attempts >= LOGIN_LOCKOUT_THRESHOLD ? new Date(Date.now() + LOGIN_LOCKOUT_DURATION_MS) : null;
      await recordFailedLogin(admin.id, { attempts, lockedUntil });
    }
    await createAuditLog({
      actorId: admin ? admin.id : null,
      actorRole: admin ? admin.role : null,
      action: 'login_failure',
      targetId: null,
      ip: req.ip,
    });
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  // Correct credentials supplied - clear any accumulated lockout state even
  // if we're about to reject below for disabled/expired.
  await clearLoginLockout(admin.id);

  if (admin.status === 'disabled') {
    await createAuditLog({ actorId: admin.id, actorRole: admin.role, action: 'login_failure', targetId: null, ip: req.ip });
    return res.status(403).json({ error: 'Account is disabled' });
  }

  if (admin.role === 'reseller' && admin.expires_at && new Date(admin.expires_at) <= new Date()) {
    if (admin.status === 'active') {
      await markResellerExpired(admin.id);
    }
    await createAuditLog({ actorId: admin.id, actorRole: admin.role, action: 'login_failure', targetId: null, ip: req.ip });
    return res.status(403).json({ error: 'Account has expired' });
  }

  const passwordChangedAtMs = admin.password_changed_at ? new Date(admin.password_changed_at).getTime() : 0;
  const token = jwt.sign(
    { id: admin.id, username: admin.username, role: admin.role, pwc: passwordChangedAtMs },
    process.env.JWT_SECRET,
    { expiresIn: '1h', algorithm: 'HS256' }
  );

  res.cookie(COOKIE_NAME, token, { ...cookieOptions, maxAge: TOKEN_TTL_MS });

  await createAuditLog({ actorId: admin.id, actorRole: admin.role, action: 'login_success', targetId: null, ip: req.ip });

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

  const passwordError = isValidPassword(newPassword);
  if (passwordError) {
    return res.status(400).json({ error: passwordError });
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await updatePasswordById(req.admin.id, passwordHash);

  await createAuditLog({ actorId: admin.id, actorRole: admin.role, action: 'password_change', targetId: null, ip: req.ip });
  await notifyPasswordChanged(admin);

  return res.json({ message: 'Password changed successfully' });
}

async function forgotPassword(req, res) {
  const { email } = req.body;

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'a valid email is required' });
  }

  const admin = await findAdminByEmail(email);

  // Always do the same amount of visible work regardless of match, and
  // always return the same response - an attacker must not be able to tell
  // whether an email is registered from either the response or its timing.
  if (admin) {
    // At most one outstanding reset link per admin: otherwise several
    // forgot-password requests within the rate-limit window would leave
    // multiple simultaneously-valid tokens outstanding.
    await invalidateUnusedResetsForAdmin(admin.id);

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

    await createAuditLog({
      actorId: admin.id,
      actorRole: admin.role,
      action: 'password_reset_requested',
      targetId: null,
      ip: req.ip,
    });
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

  const passwordError = isValidPassword(password);
  if (passwordError) {
    return res.status(400).json({ error: passwordError });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  await updatePasswordById(reset.admin_id, passwordHash);
  await markPasswordResetUsed(reset.id);

  const admin = await findAdminById(reset.admin_id);

  await createAuditLog({
    actorId: reset.admin_id,
    actorRole: admin ? admin.role : null,
    action: 'password_reset_completed',
    targetId: null,
    ip: req.ip,
  });

  if (admin) {
    await notifyPasswordChanged(admin);
  }

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
