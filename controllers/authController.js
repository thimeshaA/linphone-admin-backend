const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { findAdminByUsername, findAdminById, updatePasswordById } = require('../models/adminModel');

const COOKIE_NAME = 'token';
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const SALT_ROUNDS = 10;

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

module.exports = { login, logout, getCurrentAdmin, changePassword };
