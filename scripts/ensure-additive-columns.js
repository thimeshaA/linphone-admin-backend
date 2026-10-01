require('dotenv').config({ quiet: true });
const { flexisipPool } = require('../config/db');

// The 4 columns this migration added on top of the supervisor's original
// `accounts` schema (see db/schema/accounts.sql) - kept as an explicit,
// manually-invoked command (`npm run db:ensure-columns`) rather than
// anything automatic, since unlike a fresh empty table (AUTO_CREATE_SCHEMA),
// altering an existing, possibly-production table is not something that
// should ever happen as a side effect of starting the app.
const ADDITIVE_COLUMNS = {
  creator_id: 'ALTER TABLE accounts ADD COLUMN creator_id char(36) DEFAULT NULL',
  email: 'ALTER TABLE accounts ADD COLUMN email varchar(255) DEFAULT NULL',
  disabled_at: 'ALTER TABLE accounts ADD COLUMN disabled_at datetime DEFAULT NULL',
  renewed_at: 'ALTER TABLE accounts ADD COLUMN renewed_at datetime DEFAULT NULL',
};

async function ensureAdditiveColumns(pool, databaseName) {
  const [rows] = await pool.query(
    'SELECT column_name AS name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
    [databaseName, 'accounts']
  );
  const existing = new Set(rows.map((r) => r.name));

  const added = [];
  for (const [column, statement] of Object.entries(ADDITIVE_COLUMNS)) {
    if (existing.has(column)) continue;
    await pool.query(statement);
    added.push(column);
  }
  return added;
}

async function main() {
  const databaseName = process.env.FLEXISIP_DB_NAME;
  const added = await ensureAdditiveColumns(flexisipPool, databaseName);

  if (added.length === 0) {
    console.log("Nothing to do - all 4 additive columns already exist on 'accounts'.");
  } else {
    console.log(`Added missing column(s) to 'accounts': ${added.join(', ')}`);
  }

  await flexisipPool.end();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Failed to ensure additive columns:', err);
    process.exitCode = 1;
  });
}

module.exports = { ensureAdditiveColumns, ADDITIVE_COLUMNS };
