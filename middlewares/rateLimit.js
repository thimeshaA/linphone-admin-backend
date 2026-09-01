const rateLimit = require('express-rate-limit');

// Keyed on IP + email together so one abusive IP can't exhaust the limit for
// every address it tries, and one email can't be spammed from many IPs.
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    return `${rateLimit.ipKeyGenerator(req.ip)}:${email}`;
  },
  message: { error: 'Too many password reset requests. Please try again later.' },
});

module.exports = { forgotPasswordLimiter };
