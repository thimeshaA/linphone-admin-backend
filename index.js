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

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
}
