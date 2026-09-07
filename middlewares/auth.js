const jwt = require('jsonwebtoken');
const { getPasswordChangedAt } = require('../models/adminModel');

async function verifyToken(req, res, next) {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    // Pin the algorithm explicitly rather than trusting the token's own
    // header, so a forged token can't switch families (e.g. to `none`) and
    // slip past verification.
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    // JWTs are otherwise stateless, so without this a stolen cookie would
    // keep working for the rest of its 1h lifetime even after the real owner
    // changes their password. `pwc` is the password_changed_at timestamp (ms)
    // this token was issued against; if the account's password has changed
    // since, the token predates that change and is rejected.
    const currentChangedAt = await getPasswordChangedAt(payload.id);
    const currentChangedAtMs = currentChangedAt ? new Date(currentChangedAt).getTime() : 0;
    if (currentChangedAtMs > (payload.pwc || 0)) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    req.admin = { id: payload.id, username: payload.username, role: payload.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
}

module.exports = { verifyToken };
