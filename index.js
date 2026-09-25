require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/auth');
const accountsRoutes = require('./routes/accounts');
const adminsRoutes = require('./routes/admins');
const requestsRoutes = require('./routes/requests');
const reportsRoutes = require('./routes/reports');
const settingsRoutes = require('./routes/settings');
const walletRoutes = require('./routes/wallet');
const notificationsRoutes = require('./routes/notifications');
const invoicesRoutes = require('./routes/invoices');

const app = express();

// Exactly one reverse proxy (nginx) sits in front of this app in every real
// deployment (see docker-compose.yml: nginx -> 127.0.0.1:8083 -> container:4000).
// Trusting exactly 1 hop means X-Forwarded-For is honored for the client IP
// that express-rate-limit keys on, but only the value nginx itself supplied -
// a client can't append extra spoofed hops to escape rate limiting.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountsRoutes);
app.use('/api/admins', adminsRoutes);
app.use('/api/requests', requestsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/resellers', walletRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/invoices', invoicesRoutes);

// Catch-all error handler: without this, an uncaught error (thrown
// synchronously, or a rejected promise in an Express 5 async route handler)
// falls through to Express's own default handler, which renders the raw
// error message and full stack trace to the client whenever NODE_ENV isn't
// exactly 'production' - which is exactly the state of every deployment of
// this app today (NODE_ENV is never set in .env or docker-compose.yml). This
// always logs the real error server-side and always answers the client with
// a generic message, regardless of NODE_ENV.
app.use((err, req, res, next) => {
  console.error(err);

  if (res.headersSent) {
    return next(err);
  }

  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  return res.status(err.status || err.statusCode || 500).json({ error: 'Internal server error' });
});

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
}
