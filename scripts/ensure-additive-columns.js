require('dotenv').config({ quiet: true });
const { flexisipPool, adminPool } = require('../config/db');

// The 4 columns this migration added on top of the supervisor's original
// `accounts` schema (see db/schema/accounts.sql) - kept as an explicit,
// manually-invoked command (`npm run db:ensure-columns`) rather than
// anything automatic, since unlike a fresh empty table (AUTO_CREATE_SCHEMA),
// altering an existing, possibly-production table is not something that
// should ever happen as a side effect of starting the app.
const ACCOUNTS_ADDITIVE_COLUMNS = {
  creator_id: 'ALTER TABLE accounts ADD COLUMN creator_id char(36) DEFAULT NULL',
  email: 'ALTER TABLE accounts ADD COLUMN email varchar(255) DEFAULT NULL',
  disabled_at: 'ALTER TABLE accounts ADD COLUMN disabled_at datetime DEFAULT NULL',
  renewed_at: 'ALTER TABLE accounts ADD COLUMN renewed_at datetime DEFAULT NULL',
};

// token_version backs server-side JWT revocation (see models/adminModel.js /
// middlewares/auth.js): logout bumps it, and any token issued against an
// older value is rejected even though it's otherwise still signature-valid
// and unexpired. DEFAULT 0 so every pre-existing admin row starts at the
// same value new logins are signed against.
const ADMINS_ADDITIVE_COLUMNS = {
  token_version: 'ALTER TABLE admins ADD COLUMN token_version int unsigned NOT NULL DEFAULT 0',
};

async function ensureAdditiveColumns(pool, databaseName, tableName, additiveColumns) {
  const [rows] = await pool.query(
    'SELECT column_name AS name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
    [databaseName, tableName]
  );
  const existing = new Set(rows.map((r) => r.name));

  const added = [];
  for (const [column, statement] of Object.entries(additiveColumns)) {
    if (existing.has(column)) continue;
    await pool.query(statement);
    added.push(column);
  }
  return added;
}

async function main() {
  const addedToAccounts = await ensureAdditiveColumns(
    flexisipPool,
    process.env.FLEXISIP_DB_NAME,
    'accounts',
    ACCOUNTS_ADDITIVE_COLUMNS
  );
  if (addedToAccounts.length === 0) {
    console.log("Nothing to do - all additive columns already exist on 'accounts'.");
  } else {
    console.log(`Added missing column(s) to 'accounts': ${addedToAccounts.join(', ')}`);
  }

  const addedToAdmins = await ensureAdditiveColumns(
    adminPool,
    process.env.ADMIN_DB_NAME,
    'admins',
    ADMINS_ADDITIVE_COLUMNS
  );
  if (addedToAdmins.length === 0) {
    console.log("Nothing to do - all additive columns already exist on 'admins'.");
  } else {
    console.log(`Added missing column(s) to 'admins': ${addedToAdmins.join(', ')}`);
  }

  await flexisipPool.end();
  await adminPool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Failed to ensure additive columns:', err);
    process.exitCode = 1;
  });
}

module.exports = { ensureAdditiveColumns, ACCOUNTS_ADDITIVE_COLUMNS, ADMINS_ADDITIVE_COLUMNS };
