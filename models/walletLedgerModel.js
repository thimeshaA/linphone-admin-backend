const { adminPool } = require('../config/db');
const { buildScopedWhereClause } = require('./walletModel');

const LEDGER_COLUMNS =
  'id, reseller_id, type, amount_usd, related_account_id, invoiced, invoice_id, created_by, note, created_at';

async function createLedgerEntry({ resellerId, type, amountUsd, relatedAccountId, invoiceId, createdBy, note }) {
  const [result] = await adminPool.query(
    'INSERT INTO wallet_ledger (reseller_id, type, amount_usd, related_account_id, invoice_id, created_by, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [resellerId, type, amountUsd, relatedAccountId ?? null, invoiceId ?? null, createdBy ?? null, note ?? null]
  );

  const [rows] = await adminPool.query(`SELECT ${LEDGER_COLUMNS} FROM wallet_ledger WHERE id = ?`, [
    result.insertId,
  ]);
  return rows[0];
}

async function listLedgerForReseller(resellerId, { page, limit }) {
  const offset = (page - 1) * limit;

  const [rows] = await adminPool.query(
    `SELECT ${LEDGER_COLUMNS} FROM wallet_ledger WHERE reseller_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [resellerId, limit, offset]
  );
  const [countRows] = await adminPool.query(
    'SELECT COUNT(*) AS total FROM wallet_ledger WHERE reseller_id = ?',
    [resellerId]
  );

  return { rows, total: countRows[0].total };
}

// Backs GET /api/resellers/:id/wallet/uninvoiced - what's billable right now
// for this reseller, so the admin can choose what to include in a new invoice.
async function listUninvoicedRenewalDeductions(resellerId) {
  const [rows] = await adminPool.query(
    `SELECT ${LEDGER_COLUMNS} FROM wallet_ledger WHERE reseller_id = ? AND type = 'renewal_deduction' AND invoiced = 0 ORDER BY created_at ASC`,
    [resellerId]
  );
  return rows;
}

async function getLedgerEntriesByIds(ids) {
  if (!ids.length) return [];
  const [rows] = await adminPool.query(
    `SELECT ${LEDGER_COLUMNS} FROM wallet_ledger WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  return rows;
}

async function linkLedgerEntriesToInvoice(ids, invoiceId) {
  if (!ids.length) return;
  await adminPool.query(
    `UPDATE wallet_ledger SET invoiced = 1, invoice_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
    [invoiceId, ...ids]
  );
}

async function getLedgerEntriesForInvoice(invoiceId) {
  const [rows] = await adminPool.query(
    `SELECT ${LEDGER_COLUMNS} FROM wallet_ledger WHERE invoice_id = ? AND type = 'renewal_deduction' ORDER BY created_at ASC`,
    [invoiceId]
  );
  return rows;
}

// Source of truth for full-vs-partial payment status: summed live from every
// payment_received entry linked to this invoice, rather than a separate
// "amount paid" counter on the invoices row, so a payment made twice can never
// drift out of sync with the ledger.
async function sumPaymentsForInvoice(invoiceId) {
  const [rows] = await adminPool.query(
    "SELECT COALESCE(SUM(amount_usd), 0) AS total FROM wallet_ledger WHERE invoice_id = ? AND type = 'payment_received'",
    [invoiceId]
  );
  return rows[0].total;
}

// Billing section of the account/reseller reports (Phase 5) - period-scoped
// totals grouped by ledger type, e.g. [{ type: 'renewal_deduction', total: -45 }, ...].
// Scoped per-reseller (report's own scopeFilter) or platform-wide ({}).
async function getLedgerTotalsByType(scopeFilter, periodStart, periodEnd) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  const [rows] = await adminPool.query(
    `SELECT type, COALESCE(SUM(amount_usd), 0) AS total FROM wallet_ledger
     WHERE ${condition} AND created_at >= ? AND created_at < ? GROUP BY type`,
    [...params, periodStart, periodEnd]
  );
  return rows;
}

// Same as getLedgerTotalsByType but broken out per reseller, for the reseller
// report's per-reseller billing breakdown table (admin-only, always platform-wide).
async function getLedgerTotalsByTypeAndReseller(periodStart, periodEnd) {
  const [rows] = await adminPool.query(
    `SELECT reseller_id, type, COALESCE(SUM(amount_usd), 0) AS total FROM wallet_ledger
     WHERE created_at >= ? AND created_at < ? GROUP BY reseller_id, type`,
    [periodStart, periodEnd]
  );
  return rows;
}

// Reconstructs a wallet's balance as of a point in time - the cumulative sum
// of every ledger entry created strictly before it, not just entries within
// the reporting period. Needed because `wallets.balance_usd` only reflects
// the *current* balance, which isn't what a past report period should show.
async function getBalanceAsOf(scopeFilter, asOf) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  const [rows] = await adminPool.query(
    `SELECT COALESCE(SUM(amount_usd), 0) AS balance FROM wallet_ledger WHERE ${condition} AND created_at < ?`,
    [...params, asOf]
  );
  return rows[0].balance;
}

async function getBalancesAsOfByReseller(asOf) {
  const [rows] = await adminPool.query(
    'SELECT reseller_id, COALESCE(SUM(amount_usd), 0) AS balance FROM wallet_ledger WHERE created_at < ? GROUP BY reseller_id',
    [asOf]
  );
  return rows;
}

module.exports = {
  createLedgerEntry,
  listLedgerForReseller,
  listUninvoicedRenewalDeductions,
  getLedgerEntriesByIds,
  linkLedgerEntriesToInvoice,
  getLedgerEntriesForInvoice,
  sumPaymentsForInvoice,
  getLedgerTotalsByType,
  getLedgerTotalsByTypeAndReseller,
  getBalanceAsOf,
  getBalancesAsOfByReseller,
};
