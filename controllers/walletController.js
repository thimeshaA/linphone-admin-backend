const { getResellerById } = require('../models/adminModel');
const { getWalletByResellerId, adjustWalletBalance } = require('../models/walletModel');
const { createLedgerEntry, listLedgerForReseller, backfillAccountSipId } = require('../models/walletLedgerModel');
const { getRenewalCost } = require('../models/settingsModel');
const { findAccountLabelsByIds } = require('../models/accountModel');

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function owedAccountsCount(balanceUsd, renewalCost) {
  if (balanceUsd >= 0 || !renewalCost || renewalCost <= 0) {
    return 0;
  }
  return Math.ceil(Math.abs(balanceUsd) / renewalCost);
}

function parsePagination(query) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  return { page, limit };
}

// Rows written before account_sip_id existed have it NULL even though their
// account may still exist. Rather than a one-off backfill script, heal them
// here on read: look up the still-missing ones and persist the snapshot, so
// every reseller's ledger fixes itself the first time it's viewed. Rows
// whose account has since been hard-deleted (DELETE /accounts/:id) get no
// match and stay NULL - same "Deleted account" fallback as today.
async function healMissingAccountSipIds(rows) {
  const toHeal = rows.filter((r) => r.account_sip_id === null && r.related_account_id !== null);
  if (!toHeal.length) return;

  const accountIds = [...new Set(toHeal.map((r) => r.related_account_id))];
  const accountLabels = await findAccountLabelsByIds(accountIds);

  await Promise.all(
    toHeal.map(async (row) => {
      const sipId = accountLabels[row.related_account_id];
      if (!sipId) return;
      row.account_sip_id = sipId;
      await backfillAccountSipId(row.id, sipId);
    })
  );
}

async function getWallet(req, res) {
  const wallet = await getWalletByResellerId(req.params.id, req.scopeFilter);
  if (!wallet) {
    return res.status(404).json({ error: 'Wallet not found' });
  }

  const { page, limit } = parsePagination(req.query);
  const [renewalCost, ledger] = await Promise.all([
    getRenewalCost(),
    listLedgerForReseller(req.params.id, { page, limit }),
  ]);
  await healMissingAccountSipIds(ledger.rows);

  return res.json({
    resellerId: wallet.reseller_id,
    balanceUsd: wallet.balance_usd,
    owedAccounts: owedAccountsCount(wallet.balance_usd, renewalCost),
    updatedAt: wallet.updated_at,
    ledger: ledger.rows,
    pagination: { page, limit, total: ledger.total },
  });
}

async function topup(req, res) {
  const { amount, note } = req.body;

  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const reseller = await getResellerById(req.params.id);
  if (!reseller) {
    return res.status(404).json({ error: 'Reseller not found' });
  }

  const wallet = await getWalletByResellerId(req.params.id, {});
  if (!wallet) {
    return res.status(404).json({ error: 'Wallet not found' });
  }

  await adjustWalletBalance(req.params.id, amount);
  await createLedgerEntry({
    resellerId: req.params.id,
    type: 'admin_topup',
    amountUsd: amount,
    createdBy: req.admin.id,
    note: note || null,
  });

  return res.json({ resellerId: wallet.reseller_id, balanceUsd: Number(wallet.balance_usd) + amount });
}

module.exports = { getWallet, topup };
