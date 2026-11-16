const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, 'schema', 'accounts.sql');

async function accountsTableExists(pool, databaseName) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
    [databaseName, 'accounts']
  );
  return Number(rows[0].count) > 0;
}

// Called once at real process startup (index.js's require.main guard) -
// never during tests, and never as a side effect of merely requiring this
// module. When the table is missing: creates it from db/schema/accounts.sql
// if AUTO_CREATE_SCHEMA=true (local/test convenience only), otherwise fails
// loudly instead of silently doing nothing or, worse, silently creating a
// table somewhere it shouldn't.
async function ensureAccountsSchema(pool, databaseName, { autoCreate } = {}) {
  const exists = await accountsTableExists(pool, databaseName);
  if (exists) {
    return;
  }

  if (!autoCreate) {
    throw new Error(
      `Startup check failed: the 'accounts' table does not exist in database '${databaseName}'. ` +
        `Create it manually (see db/schema/accounts.sql), or set AUTO_CREATE_SCHEMA=true in .env for ` +
        `local/test convenience only - never in production.`
    );
  }

  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  await pool.query(schemaSql);
  console.log("⚠️  AUTO_CREATE_SCHEMA is enabled — created missing 'accounts' table from db/schema/accounts.sql");
}

module.exports = { ensureAccountsSchema, accountsTableExists, SCHEMA_PATH };
