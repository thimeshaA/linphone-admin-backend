const { adminPool } = require('../config/db');

const INVOICE_COLUMNS = 'id, reseller_id, status, total_amount_usd, created_at, sent_at, paid_at';

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

async function createInvoice({ resellerId, totalAmountUsd }) {
  const [result] = await adminPool.query(
    "INSERT INTO invoices (reseller_id, status, total_amount_usd) VALUES (?, 'draft', ?)",
    [resellerId, totalAmountUsd]
  );

  const [rows] = await adminPool.query(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE id = ?`, [
    result.insertId,
  ]);
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

async function listInvoices(scopeFilter, { resellerId, status } = {}) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  let sql = `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE ${condition}`;
  const queryParams = [...params];

  if (resellerId) {
    sql += ' AND reseller_id = ?';
    queryParams.push(resellerId);
  }

  if (status) {
    sql += ' AND status = ?';
    queryParams.push(status);
  }

  sql += ' ORDER BY created_at DESC';

  const [rows] = await adminPool.query(sql, queryParams);
  return rows;
}

async function markInvoiceSent(id) {
  await adminPool.query("UPDATE invoices SET status = 'sent', sent_at = NOW() WHERE id = ?", [id]);
}

async function updateInvoiceStatus(id, status) {
  const paidClause = status === 'paid' ? ', paid_at = NOW()' : '';
  await adminPool.query(`UPDATE invoices SET status = ?${paidClause} WHERE id = ?`, [status, id]);
}

// Billing section of the account/reseller reports (Phase 5) - how many
// invoices were issued (sent_at) and how many were paid off (paid_at) within
// the report's period. Scoped per-reseller (report's own scopeFilter) or
// platform-wide ({}).
async function getInvoiceEventCounts(scopeFilter, periodStart, periodEnd) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  const [issuedRows] = await adminPool.query(
    `SELECT COUNT(*) AS count FROM invoices WHERE ${condition} AND sent_at >= ? AND sent_at < ?`,
    [...params, periodStart, periodEnd]
  );
  const [paidRows] = await adminPool.query(
    `SELECT COUNT(*) AS count FROM invoices WHERE ${condition} AND paid_at >= ? AND paid_at < ?`,
    [...params, periodStart, periodEnd]
  );
  return { issued: issuedRows[0].count, paid: paidRows[0].count };
}

// Same as getInvoiceEventCounts but broken out per reseller, for the reseller
// report's per-reseller billing breakdown table (admin-only, always platform-wide).
async function getInvoiceIssuedCountsByReseller(periodStart, periodEnd) {
  const [rows] = await adminPool.query(
    'SELECT reseller_id, COUNT(*) AS count FROM invoices WHERE sent_at >= ? AND sent_at < ? GROUP BY reseller_id',
    [periodStart, periodEnd]
  );
  return rows;
}

async function getInvoicePaidCountsByReseller(periodStart, periodEnd) {
  const [rows] = await adminPool.query(
    'SELECT reseller_id, COUNT(*) AS count FROM invoices WHERE paid_at >= ? AND paid_at < ? GROUP BY reseller_id',
    [periodStart, periodEnd]
  );
  return rows;
}

module.exports = {
  buildScopedWhereClause,
  createInvoice,
  getInvoiceById,
  listInvoices,
  markInvoiceSent,
  updateInvoiceStatus,
  getInvoiceEventCounts,
  getInvoiceIssuedCountsByReseller,
  getInvoicePaidCountsByReseller,
};
