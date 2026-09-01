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
const { getResellerById, findAdminById, findAdminUsernamesByIds } = require('../models/adminModel');
const { sendMail } = require('../utils/mailer');
const { renderBatchAccountRequestHtml } = require('../utils/emailTemplates');
const { isValidEmail, isValidUsername } = require('../utils/validators');

const REQUEST_RECIPIENT = 'enigma-admin@prometeolk.com';

function hashPassword(authid, domain, password) {
  return crypto.createHash('md5').update(`${authid}:${domain}:${password}`).digest('hex');
}

function defaultExpiresAt() {
  const date = new Date();
  date.setMonth(date.getMonth() + 6);
  return date;
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
