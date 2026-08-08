const jwt = require('jsonwebtoken');

function verifyToken(req, res, next) {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.admin = { id: payload.id, username: payload.username, role: payload.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
}

module.exports = { verifyToken };
