const { adminPool } = require('../config/db');
const { buildScopedWhereClause } = require('./walletModel');

const LEDGER_COLUMNS =
  'id, reseller_id, type, amount_usd, related_account_id, account_sip_id, invoiced, invoice_id, created_by, note, created_at';

async function createLedgerEntry({
  resellerId,
  type,
  amountUsd,
  relatedAccountId,
  accountSipId,
  invoiceId,
  createdBy,
  note,
}) {
  const [result] = await adminPool.query(
    'INSERT INTO wallet_ledger (reseller_id, type, amount_usd, related_account_id, account_sip_id, invoice_id, created_by, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      resellerId,
      type,
      amountUsd,
      relatedAccountId ?? null,
      accountSipId ?? null,
      invoiceId ?? null,
      createdBy ?? null,
      note ?? null,
    ]
  );

  const [rows] = await adminPool.query(`SELECT ${LEDGER_COLUMNS} FROM wallet_ledger WHERE id = ?`, [
    result.insertId,
  ]);
  return rows[0];
}

// Self-heals rows written before account_sip_id existed (or any other row
// that somehow ended up without one): called from walletController.getWallet
// whenever a returned row's account_sip_id is still NULL and its account
// hasn't been deleted, so historical rows fill in the first time anyone
// views that reseller's ledger - no separate backfill step required.
async function backfillAccountSipId(id, accountSipId) {
  await adminPool.query('UPDATE wallet_ledger SET account_sip_id = ? WHERE id = ? AND account_sip_id IS NULL', [
    accountSipId,
    id,
  ]);
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

// Backs monthly invoice generation (POST /api/invoices): every
// renewal_deduction for this reseller within the exact period, not yet
// claimed by another invoice. The `invoiced = 0` filter is what makes
// overlapping-but-different periods never double-*claim* the same entry -
// each entry can only ever be linked to one invoice. It does NOT protect
// against re-running the *same* period twice; that's guarded separately at
// the invoice level (see invoiceModel.findInvoiceByResellerAndPeriod) so a
// no-op regeneration can't create an empty duplicate once everything in the
// period is already claimed.
//
// Annual invoices do NOT use this for their total/line items (see
// getRenewalDeductionsForResellerInPeriod below) - they're a full-year
// rollup that counts every entry in the year regardless of claim status.
async function getUninvoicedRenewalDeductionsInPeriod(resellerId, periodStart, periodEnd) {
  const [rows] = await adminPool.query(
    `SELECT ${LEDGER_COLUMNS} FROM wallet_ledger
     WHERE reseller_id = ? AND type = 'renewal_deduction' AND invoiced = 0
       AND created_at >= ? AND created_at < ?
     ORDER BY created_at ASC`,
    [resellerId, periodStart, periodEnd]
  );
  return rows;
}

// Backs annual invoices (POST /api/invoices and GET /api/invoices/:id/pdf
// for period_type='annual'): every renewal_deduction for this reseller in
// the year, regardless of whether a monthly invoice already claimed it. An
// annual invoice is a full-year statement, not a claim on the remainder -
// entries a monthly invoice already claimed stay linked to that monthly
// invoice (see create() in invoicesController.js, which only links the
// still-unclaimed subset to the annual invoice, never reassigns others).
async function getRenewalDeductionsForResellerInPeriod(resellerId, periodStart, periodEnd) {
  const [rows] = await adminPool.query(
    `SELECT ${LEDGER_COLUMNS} FROM wallet_ledger
     WHERE reseller_id = ? AND type = 'renewal_deduction'
       AND created_at >= ? AND created_at < ?
     ORDER BY created_at ASC`,
    [resellerId, periodStart, periodEnd]
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

// Backs invoice regeneration (POST /api/invoices replacing an existing
// invoice for the same reseller+period): releases every entry currently
// claimed by that invoice back to unclaimed (invoiced = 0, invoice_id NULL)
// so getUninvoicedRenewalDeductionsInPeriod can freshly re-gather the full
// set for the period - the released entries plus any new renewals recorded
// since the invoice was first generated - rather than leaving them claimed
// by an invoice that's about to be recomputed.
async function unlinkLedgerEntriesFromInvoice(invoiceId) {
  await adminPool.query('UPDATE wallet_ledger SET invoiced = 0, invoice_id = NULL WHERE invoice_id = ?', [
    invoiceId,
  ]);
}

async function getLedgerEntriesForInvoice(invoiceId) {
  const [rows] = await adminPool.query(
    `SELECT ${LEDGER_COLUMNS} FROM wallet_ledger WHERE invoice_id = ? AND type = 'renewal_deduction' ORDER BY created_at ASC`,
    [invoiceId]
  );
  return rows;
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
  backfillAccountSipId,
  listLedgerForReseller,
  getUninvoicedRenewalDeductionsInPeriod,
  getRenewalDeductionsForResellerInPeriod,
  linkLedgerEntriesToInvoice,
  unlinkLedgerEntriesFromInvoice,
  getLedgerEntriesForInvoice,
  getLedgerTotalsByType,
  getLedgerTotalsByTypeAndReseller,
  getBalanceAsOf,
  getBalancesAsOfByReseller,
};
