const rateLimit = require('express-rate-limit');

// Same window/threshold convention throughout this file (1 hour, 3 attempts)
// so every password-adjacent endpoint is protected consistently.
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_ATTEMPTS = 3;

// Each limiter gets its own explicit store (rather than the implicit default)
// so tests can fully reset rate-limit state between cases via `_stores` below
// - production code never touches `_stores`.
const forgotPasswordStore = new rateLimit.MemoryStore();
const loginStore = new rateLimit.MemoryStore();
const changePasswordStore = new rateLimit.MemoryStore();
const resetPasswordStore = new rateLimit.MemoryStore();

// Keyed on IP + email together so one abusive IP can't exhaust the limit for
// every address it tries, and one email can't be spammed from many IPs.
const forgotPasswordLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_ATTEMPTS,
  standardHeaders: true,
  legacyHeaders: false,
  store: forgotPasswordStore,
  keyGenerator: (req) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    return `${rateLimit.ipKeyGenerator(req.ip)}:${email}`;
  },
  message: { error: 'Too many password reset requests. Please try again later.' },
});

// Keyed on IP + username/email together, same reasoning as above - this is
// the primary brute-force/credential-stuffing guard on the login endpoint,
// separate from and in addition to the per-account lockout in authController.
// skipSuccessfulRequests means only failed attempts count toward the limit -
// without it, a legitimate user logging in/out repeatedly (or a token expiring
// and re-logging in) burns through the same budget as a brute-force attempt
// and gets locked out despite never once failing.
const loginLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_ATTEMPTS,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  store: loginStore,
  keyGenerator: (req) => {
    const identifier = String(req.body?.username || '').trim().toLowerCase();
    return `${rateLimit.ipKeyGenerator(req.ip)}:${identifier}`;
  },
  message: { error: 'Too many login attempts. Please try again later.' },
});

// Runs after verifyToken, so it's keyed on the authenticated admin's own id
// rather than a request body field.
const changePasswordLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_ATTEMPTS,
  standardHeaders: true,
  legacyHeaders: false,
  store: changePasswordStore,
  keyGenerator: (req) => `${rateLimit.ipKeyGenerator(req.ip)}:${req.admin?.id ?? 'anon'}`,
  message: { error: 'Too many password change attempts. Please try again later.' },
});

// Reset tokens are unauthenticated and high-entropy (brute-forcing one is
// infeasible), so this is IP-only defense-in-depth against automated abuse.
const resetPasswordLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_ATTEMPTS,
  standardHeaders: true,
  legacyHeaders: false,
  store: resetPasswordStore,
  message: { error: 'Too many password reset attempts. Please try again later.' },
});

module.exports = {
  forgotPasswordLimiter,
  loginLimiter,
  changePasswordLimiter,
  resetPasswordLimiter,
  _stores: { forgotPasswordStore, loginStore, changePasswordStore, resetPasswordStore },
};
