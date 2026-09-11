const crypto = require('crypto');
const {
  listAccounts,
  getAccountById,
  findAccountByAuthid,
  createAccount,
  reassignAccountCreator,
  renewAccount,
  disableAccount,
  updateAccountPassword,
  deleteAccount,
} = require('../models/accountModel');
const {
  getResellerById,
  findAdminById,
  findAdminUsernamesByIds,
  listAdminsByRole,
} = require('../models/adminModel');
const { getWalletByResellerId, adjustWalletBalance } = require('../models/walletModel');
const { createLedgerEntry } = require('../models/walletLedgerModel');
const { getRenewalCost } = require('../models/settingsModel');
const { createNotification } = require('../models/notificationModel');
const { sendMail } = require('../utils/mailer');
const { renderBatchAccountRequestHtml, renderRenewalDeductionHtml } = require('../utils/emailTemplates');
const { isValidEmail, isValidUsername } = require('../utils/validators');

const REQUEST_RECIPIENT = 'enigma-admin@prometeolk.com';

function hashPassword(authid, domain, password) {
  return crypto.createHash('md5').update(`${authid}:${domain}:${password}`).digest('hex');
}

// balanceUsd can be negative (a renewal always proceeds regardless of
// balance - see applyRenewalDeduction); `$${value.toFixed(2)}` would render
// a negative one as "$-5.00" (sign in the wrong place) instead of the
// standard "-$5.00", so the sign is pulled out and placed before the `$`.
function formatUsd(amount) {
  const value = Number(amount);
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function defaultExpiresAt() {
  const date = new Date();
  date.setMonth(date.getMonth() + 6);
  return date;
}

function addMonths(date, months) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

// renewal_cost_usd (see settingsModel.js) is priced per 6-month period, not
// per renewal - a 1-year extension costs 2x, a 4-month extension still costs
// 1x (rounded up, never undercharged). Counted by repeatedly hopping 6
// months from the account's expiry *before* this renewal to its expiry
// *after* this renewal, rather than dividing day counts, so it exactly
// matches the calendar-month arithmetic defaultExpiresAt() itself uses (and
// isn't thrown off by 28-31 day month lengths or leap years).
function renewalUnitsForPeriod(previousExpiresAt, newExpiresAt) {
  const previous = new Date(previousExpiresAt);
  const next = new Date(newExpiresAt);

  let units = 0;
  let cursor = previous;
  while (cursor < next) {
    cursor = addMonths(cursor, 6);
    units += 1;
  }
  return Math.max(units, 1);
}

async function validateResellerId(resellerId) {
  if (resellerId === undefined || resellerId === null) {
    return { error: 'resellerId is required' };
  }

  const reseller = await getResellerById(resellerId);
  if (!reseller) {
    return { error: 'resellerId does not reference an existing reseller' };
  }
  if (reseller.status === 'disabled') {
    return { error: 'Cannot assign account to a disabled reseller' };
  }

  return { reseller };
}

function buildBatchRequestEmailBody({ resellerUsername, resellerEmail, requests }, submittedAt) {
  const lines = [
    `Submitted at: ${submittedAt}`,
    `Reseller: ${resellerUsername}${resellerEmail ? ` <${resellerEmail}>` : ''}`,
    `Requested accounts: ${requests.length}`,
    '',
  ];

  requests.forEach((entry, i) => {
    lines.push(`${i + 1}. ${entry.name}`);
    if (entry.email) lines.push(`   Email: ${entry.email}`);
    if (entry.phone) lines.push(`   Phone: ${entry.phone}`);
    if (entry.note) lines.push(`   Note: ${entry.note}`);
  });

  return lines.join('\n');
}

async function list(req, res) {
  const { status, search } = req.query;
  const accounts = await listAccounts(req.scopeFilter, { status, search });

  if (req.admin.role === 'admin') {
    const creatorIds = [...new Set(accounts.map((account) => account.creator_id))];
    const usernameMap = await findAdminUsernamesByIds(creatorIds);
    for (const account of accounts) {
      account.created_by = usernameMap[account.creator_id] || null;
    }
  }

  return res.json(accounts);
}

async function getOne(req, res) {
  const account = await getAccountById(req.params.id, req.scopeFilter);

  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  return res.json(account);
}

async function create(req, res) {
  const { authid, domain, password, status, expires_at, resellerId, email } = req.body;

  const errors = {};

  if (!isValidUsername(authid)) {
    errors.authid =
      'authid is required (1-64 characters) and may only contain letters, digits, ".", "_" and "-"';
  }

  if (!domain) {
    errors.domain = 'domain is required';
  }

  if (!password) {
    errors.password = 'password is required';
  }

  if (!isValidEmail(email)) {
    errors.email = 'a valid email is required';
  }

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ errors });
  }

  const { error: resellerError } = await validateResellerId(resellerId);
  if (resellerError) {
    return res.status(400).json({ error: resellerError });
  }

  const existing = await findAccountByAuthid(authid);
  if (existing) {
    return res.status(409).json({ error: 'An account with this authid already exists' });
  }

  const account = await createAccount({
    authid,
    domain,
    passwordHash: hashPassword(authid, domain, password),
    status: status || 'active',
    expiresAt: expires_at || defaultExpiresAt(),
    creatorId: resellerId,
    email,
  });

  try {
    await sendMail({
      to: email,
      subject: 'Your SIP account credentials',
      text: `Your SIP account has been created.\n\nUsername: ${authid}\nPassword: ${password}\n\nLog in at: ${process.env.ADMIN_PANEL_URL}`,
      html: `<p>Your SIP account has been created.</p><p><strong>Username:</strong> ${authid}<br><strong>Password:</strong> ${password}</p><p>Log in at <a href="${process.env.ADMIN_PANEL_URL}">${process.env.ADMIN_PANEL_URL}</a></p>`,
    });
  } catch (err) {
    console.error('Failed to send account credentials email:', err);
  }

  return res.status(201).json(account);
}

async function reassign(req, res) {
  const { resellerId } = req.body;

  const { error } = await validateResellerId(resellerId);
  if (error) {
    return res.status(400).json({ error });
  }

  const account = await reassignAccountCreator(req.params.id, resellerId);
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  return res.json(account);
}

async function requestAccounts(req, res) {
  const { requests } = req.body;

  if (!Array.isArray(requests) || requests.length === 0) {
    return res.status(400).json({ error: 'requests must be a non-empty array of end-users' });
  }

  const errors = [];
  requests.forEach((entry, i) => {
    if (!entry || !String(entry.name || '').trim()) {
      errors.push(`requests[${i}].name is required`);
      return;
    }
    if (entry.email && !isValidEmail(entry.email)) {
      errors.push(`requests[${i}].email is invalid`);
      return;
    }
    const hasPhone = entry.phone && String(entry.phone).trim();
    if (!entry.email && !hasPhone) {
      errors.push(`requests[${i}] must include a valid email or a phone`);
    }
  });

  if (errors.length > 0) {
    return res.status(400).json({ errors });
  }

  const requester = await findAdminById(req.admin.id);
  const resellerUsername = requester ? requester.username : req.admin.username;
  const resellerEmail = requester ? requester.email : null;

  const submittedAt = new Date().toISOString();
  const fields = { resellerUsername, resellerEmail, requests };

  try {
    await sendMail({
      to: REQUEST_RECIPIENT,
      subject: `New SIP account request from ${resellerUsername} (${requests.length})`,
      text: buildBatchRequestEmailBody(fields, submittedAt),
      html: renderBatchAccountRequestHtml(fields, submittedAt),
      replyTo: resellerEmail || undefined,
    });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to send request email' });
  }

  return res.status(201).json({ message: 'Request submitted successfully' });
}

async function notifyRenewalDeduction({ account, reseller, amountUsd, balanceUsd }) {
  const admins = await listAdminsByRole('admin');
  const subject = `Wallet charged for renewal of ${account.authid}@${account.domain}`;
  const text = `Account ${account.authid}@${account.domain} was renewed. ${formatUsd(amountUsd)} was deducted from ${reseller.username}'s wallet. New balance: ${formatUsd(balanceUsd)}.`;

  // { accountId, authid, domain, amountUsd, balanceUsd } - the frontend can use
  // accountId to deep-link into the account, and amountUsd/balanceUsd to render
  // the amounts without re-parsing them out of `message`.
  const payload = {
    accountId: account.id,
    authid: account.authid,
    domain: account.domain,
    amountUsd,
    balanceUsd,
  };

  const recipientIds = [reseller.id, ...admins.map((admin) => admin.id)];
  await Promise.all(
    recipientIds.map((recipientId) =>
      createNotification(recipientId, 'renewal_deduction', subject, text, payload).catch((err) => {
        console.error('Failed to create renewal-deduction notification:', err);
      })
    )
  );

  const emailRecipients = [reseller.email, ...admins.map((admin) => admin.email)].filter(Boolean);
  if (emailRecipients.length === 0) {
    return;
  }

  const html = renderRenewalDeductionHtml({
    authid: account.authid,
    domain: account.domain,
    resellerUsername: reseller.username,
    amountUsd,
    balanceUsd,
  });

  try {
    await sendMail({
      to: emailRecipients.join(', '),
      subject,
      text,
      html,
    });
  } catch (err) {
    console.error('Failed to send renewal-deduction notification email:', err);
  }
}

// The wallet belongs to whoever owns the account (its creator_id), not to
// whoever clicked renew - so an admin renewing on a reseller's behalf still
// charges that reseller's wallet. Accounts with no owning reseller have no
// wallet to deduct from, so they're skipped entirely. Deduction always
// proceeds regardless of the resulting balance - renewals are never blocked
// for insufficient funds.
//
// The wallet is read *before* adjusting (not re-fetched after) so the
// resulting balance can be computed in-process - a reseller somehow missing
// its wallets row (e.g. one predating the wallet feature, not yet backfilled)
// must not crash the renewal after the ledger entry has already been
// written; it's logged instead so it surfaces as an operational data issue.
async function applyRenewalDeduction(account, actingAdminId, previousExpiresAt) {
  if (!account.creator_id) {
    return;
  }

  const reseller = await getResellerById(account.creator_id);
  if (!reseller) {
    return;
  }

  const renewalRate = await getRenewalCost();
  // null (missing settings row) or anything that isn't a valid non-negative
  // number is a misconfiguration, not a legitimate "free renewal" - writing
  // a $0 ledger entry in that case would look like a real transaction that
  // just happened to cost nothing, masking the actual problem. A genuinely
  // configured 0 (updateRenewalCostSetting accepts it) is not an error, but
  // is unusual enough to warn about loudly rather than deduct silently.
  if (renewalRate === null || typeof renewalRate !== 'number' || !Number.isFinite(renewalRate) || renewalRate < 0) {
    console.error(
      `Renewal deduction skipped for reseller ${reseller.id} (account ${account.id}): renewal cost setting is ${
        renewalRate === null ? 'missing' : `invalid (${renewalRate})`
      } - no wallet_ledger entry was written. Configure it via PUT /api/settings/renewal-cost.`
    );
    return;
  }
  if (renewalRate === 0) {
    console.warn(
      `Renewal deduction for reseller ${reseller.id} (account ${account.id}): renewal cost is configured at $0 - recording a zero-amount deduction. If unintentional, set a real value via PUT /api/settings/renewal-cost.`
    );
  }

  const units = renewalUnitsForPeriod(previousExpiresAt, account.expires_at);
  const renewalCost = renewalRate * units;
  const amountUsd = -renewalCost;

  const walletBefore = await getWalletByResellerId(reseller.id, {});
  if (!walletBefore) {
    console.error(
      `Renewal deduction for reseller ${reseller.id}: no wallets row exists - the deduction is still being recorded in wallet_ledger, but the balance won't reflect it until the wallet is backfilled (see sql/backfill-wallets.sql).`
    );
  }

  await adjustWalletBalance(reseller.id, amountUsd);
  await createLedgerEntry({
    resellerId: reseller.id,
    type: 'renewal_deduction',
    amountUsd,
    relatedAccountId: account.id,
    createdBy: actingAdminId,
    note: null,
  });

  const balanceUsd = (walletBefore ? Number(walletBefore.balance_usd) : 0) + amountUsd;
  await notifyRenewalDeduction({
    account,
    reseller,
    amountUsd: renewalCost,
    balanceUsd,
  });
}

async function renew(req, res) {
  const { expires_at } = req.body;
  const expiresAt = expires_at || defaultExpiresAt();

  // Captured before the update so the deduction can be priced off of how far
  // this renewal actually extends the account, not just the new expiry
  // taken in isolation (see renewalUnitsForPeriod).
  const existingAccount = await getAccountById(req.params.id, req.scopeFilter);
  if (!existingAccount) {
    return res.status(404).json({ error: 'Account not found' });
  }

  const account = await renewAccount(req.params.id, req.scopeFilter, expiresAt);
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  await applyRenewalDeduction(account, req.admin.id, existingAccount.expires_at);

  return res.json(account);
}

async function disable(req, res) {
  const account = await disableAccount(req.params.id, req.scopeFilter);
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  return res.json(account);
}

async function updatePassword(req, res) {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'password is required' });
  }

  const account = await getAccountById(req.params.id, req.scopeFilter);
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

  const passwordHash = hashPassword(account.authid, account.domain, password);
  await updateAccountPassword(req.params.id, req.scopeFilter, passwordHash);

  return res.json({ message: 'Password updated successfully' });
}

async function remove(req, res) {
  const deleted = await deleteAccount(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: 'Account not found' });
  }

  return res.json({ message: 'Account deleted successfully' });
}

module.exports = {
  list,
  getOne,
  create,
  reassign,
  renew,
  disable,
  updatePassword,
  remove,
  requestAccounts,
};
