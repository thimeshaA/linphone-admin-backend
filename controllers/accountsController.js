const crypto = require('crypto');
const {
  listAccounts,
  getAccountById,
  findAccountByAuthid,
  createAccount,
  renewAccount,
  disableAccount,
  updateAccountPassword,
  deleteAccount,
} = require('../models/accountModel');
const { getAdminStatusById, findAdminUsernamesByIds } = require('../models/adminModel');
const { sendMail } = require('../utils/mailer');
const { isValidEmail, isValidUsername } = require('../utils/validators');

function hashPassword(authid, domain, password) {
  return crypto.createHash('md5').update(`${authid}:${domain}:${password}`).digest('hex');
}

function defaultExpiresAt() {
  const date = new Date();
  date.setMonth(date.getMonth() + 6);
  return date;
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
  const { authid, domain, password, status, expires_at, creator_id, email } = req.body;

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

  const creator = await getAdminStatusById(creator_id);
  if (!creator) {
    return res.status(400).json({ error: 'creator_id does not reference an existing admin' });
  }
  if (creator.status === 'disabled') {
    return res.status(400).json({ error: 'Cannot assign account to a disabled reseller' });
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
    creatorId: creator_id,
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

async function renew(req, res) {
  const { expires_at } = req.body;
  const expiresAt = expires_at || defaultExpiresAt();

  const account = await renewAccount(req.params.id, req.scopeFilter, expiresAt);
  if (!account) {
    return res.status(404).json({ error: 'Account not found' });
  }

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

module.exports = { list, getOne, create, renew, disable, updatePassword, remove };
