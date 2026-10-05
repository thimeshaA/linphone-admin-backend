require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');

const flexisipPool = mysql.createPool({
  host: process.env.FLEXISIP_DB_HOST,
  port: process.env.FLEXISIP_DB_PORT,
  user: process.env.FLEXISIP_DB_USER,
  password: process.env.FLEXISIP_DB_PASSWORD,
  database: process.env.FLEXISIP_DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

const adminPool = mysql.createPool({
  host: process.env.ADMIN_DB_HOST,
  port: process.env.ADMIN_DB_PORT,
  user: process.env.ADMIN_DB_USER,
  password: process.env.ADMIN_DB_PASSWORD,
  database: process.env.ADMIN_DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  // wallets/wallet_ledger/settings store DECIMAL columns (balance_usd,
  // amount_usd, renewal_cost_usd) - without this, mysql2 returns them as
  // strings, which would silently break arithmetic like balance comparisons
  // and the owed-accounts calculation.
  decimalNumbers: true,
  // ADMIN_DB_HOST is a real domain (test.kryptoline.com) now serving a
  // trusted (Let's Encrypt) cert for MySQL connections, so this both
  // encrypts the connection and, via verifyIdentity, confirms the
  // certificate actually belongs to that host - not just that it's signed
  // by a CA mysql2/Node trusts. rejectUnauthorized defaults to true
  // (mysql2's own default, not set here), so an untrusted/self-signed cert
  // is already rejected regardless.
  ssl: { verifyIdentity: true },
});

module.exports = { flexisipPool, adminPool };
