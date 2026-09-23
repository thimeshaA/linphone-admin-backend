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

// Backs invoice generation (POST /api/invoices and GET /api/invoices/:id/pdf,
// both monthly and annual): every renewal_deduction for this reseller within
// the exact period, regardless of whether some other invoice already covers
// it. A wallet_ledger entry is never "claimed" by one invoice to the
// exclusion of another - the wallet was already debited once at renewal
// time (see applyRenewalDeduction), so an invoice is just a statement of
// that period's activity, and the same entry legitimately appears on both
// its month's invoice and that year's annual invoice with no double-billing
// risk. Regenerating an invoice (see invoicesController.create) always
// recomputes fresh from this, so it reflects everything recorded as of that
// moment.
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

// Backs the reports' billing statement: every ledger entry in the scope+
// period, oldest first, so a report can render an actual itemized statement
// (with a running balance) rather than only the pre-aggregated totals above -
// every figure in the billing section should be traceable back to real rows
// here, never a number that only exists as a separate computation.
async function getLedgerEntriesInPeriod(scopeFilter, periodStart, periodEnd) {
  const { condition, params } = buildScopedWhereClause(scopeFilter);
  const [rows] = await adminPool.query(
    `SELECT id, reseller_id, type, amount_usd, related_account_id, account_sip_id, note, created_at
     FROM wallet_ledger
     WHERE ${condition} AND created_at >= ? AND created_at < ?
     ORDER BY created_at ASC, id ASC`,
    [...params, periodStart, periodEnd]
  );
  return rows;
}

module.exports = {
  createLedgerEntry,
  backfillAccountSipId,
  listLedgerForReseller,
  getRenewalDeductionsForResellerInPeriod,
  getLedgerTotalsByType,
  getLedgerTotalsByTypeAndReseller,
  getBalanceAsOf,
  getBalancesAsOfByReseller,
  getLedgerEntriesInPeriod,
};
