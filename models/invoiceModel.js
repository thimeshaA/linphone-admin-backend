const { adminPool } = require('../config/db');

const INVOICE_COLUMNS = 'id, reseller_id, period_type, period_value, total_amount_usd, created_at, sent_at';

// Mirrors walletModel.buildScopedWhereClause: req.scopeFilter is keyed on
// `creator_id` even though the column being scoped here is `reseller_id` -
// applyOwnershipFilter is shared across accounts/wallets/invoices and always
// populates it that way.
function buildScopedWhereClause(scopeFilter) {
  if (scopeFilter && scopeFilter.creator_id !== undefined) {
    return { condition: 'reseller_id = ?', params: [scopeFilter.creator_id] };
  }
  return { condition: '1=1', params: [] };
}

// Regeneration guard: an invoice is one document per reseller per exact
// period (see the UNIQUE KEY in sql/invoices.sql). The controller checks this
// before inserting so a duplicate attempt gets a clean 409 with the existing
// invoice's figures, instead of a raw DB constraint-violation error.
async function findInvoiceByResellerAndPeriod(resellerId, periodType, periodValue) {
  const [rows] = await adminPool.query(
    `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE reseller_id = ? AND period_type = ? AND period_value = ? LIMIT 1`,
    [resellerId, periodType, periodValue]
  );
  return rows[0] || null;
}

async function createInvoice({ resellerId, periodType, periodValue, totalAmountUsd }) {
  const [result] = await adminPool.query(
    'INSERT INTO invoices (reseller_id, period_type, period_value, total_amount_usd) VALUES (?, ?, ?, ?)',
    [resellerId, periodType, periodValue, totalAmountUsd]
  );

  const [rows] = await adminPool.query(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE id = ?`, [
    result.insertId,
  ]);
  return rows[0];
}

// Backs invoice regeneration: an existing invoice for this reseller+period
// gets its total recomputed from the freshly-gathered ledger entries and
// sent_at reset to NULL - the previously-emailed version (if any) no longer
// matches this content, so it reads as unsent again until an admin resends it.
async function replaceInvoiceContents(id, totalAmountUsd) {
  await adminPool.query('UPDATE invoices SET total_amount_usd = ?, sent_at = NULL WHERE id = ?', [
    totalAmountUsd,
    id,
  ]);

  const [rows] = await adminPool.query(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE id = ?`, [id]);
  return rows[0];
}

async function getInvoiceById(id, scopeFilter) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  const [rows] = await adminPool.query(
    `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE id = ? AND ${condition}`,
    [id, ...params]
  );
  return rows[0] || null;
}

// sentOnly restricts to invoices with sent_at set - used for the reseller's
// own view of GET /api/invoices, where an unsent invoice shouldn't appear at
// all (admins always get sentOnly: false).
async function listInvoices(scopeFilter, { resellerId, sentOnly } = {}) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  let sql = `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE ${condition}`;
  const queryParams = [...params];

  if (resellerId) {
    sql += ' AND reseller_id = ?';
    queryParams.push(resellerId);
  }

  if (sentOnly) {
    sql += ' AND sent_at IS NOT NULL';
  }

  sql += ' ORDER BY created_at DESC';

  const [rows] = await adminPool.query(sql, queryParams);
  return rows;
}

async function markInvoiceSent(id) {
  await adminPool.query('UPDATE invoices SET sent_at = NOW() WHERE id = ?', [id]);
}

// Billing section of the account/reseller reports (Phase 5) - how many
// invoices were sent within the report's period. Scoped per-reseller
// (report's own scopeFilter) or platform-wide ({}).
async function countInvoicesSentInPeriod(scopeFilter, periodStart, periodEnd) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  const [rows] = await adminPool.query(
    `SELECT COUNT(*) AS count FROM invoices WHERE ${condition} AND sent_at >= ? AND sent_at < ?`,
    [...params, periodStart, periodEnd]
  );
  return rows[0].count;
}

// Same as countInvoicesSentInPeriod but broken out per reseller, for the
// reseller report's per-reseller billing breakdown table (admin-only, always
// platform-wide).
async function getInvoicesSentCountsByReseller(periodStart, periodEnd) {
  const [rows] = await adminPool.query(
    'SELECT reseller_id, COUNT(*) AS count FROM invoices WHERE sent_at >= ? AND sent_at < ? GROUP BY reseller_id',
    [periodStart, periodEnd]
  );
  return rows;
}

module.exports = {
  buildScopedWhereClause,
  findInvoiceByResellerAndPeriod,
  createInvoice,
  replaceInvoiceContents,
  getInvoiceById,
  listInvoices,
  markInvoiceSent,
  countInvoicesSentInPeriod,
  getInvoicesSentCountsByReseller,
};
