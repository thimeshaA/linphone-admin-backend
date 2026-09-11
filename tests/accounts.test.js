const request = require('supertest');
const { TEST_ADMIN_PASSWORD, TEST_ADMIN } = require('./helpers/fixtures');

jest.mock('../models/adminModel');
jest.mock('../models/accountModel');
jest.mock('../models/walletModel');
jest.mock('../models/walletLedgerModel');
jest.mock('../models/settingsModel');
jest.mock('../models/notificationModel');
jest.mock('../utils/mailer');

const adminModel = require('../models/adminModel');
const accountModel = require('../models/accountModel');
const walletModel = require('../models/walletModel');
const walletLedgerModel = require('../models/walletLedgerModel');
const settingsModel = require('../models/settingsModel');
const notificationModel = require('../models/notificationModel');
const mailer = require('../utils/mailer');
const app = require('../index');

// buildScopedWhereClause is a pure function with no DB access, so it's tested
// against the real implementation instead of the mock.
const { buildScopedWhereClause } = jest.requireActual('../models/accountModel');

describe('buildScopedWhereClause (pure function)', () => {
  test('returns an unfiltered condition for admins (no creator_id in scope)', () => {
    expect(buildScopedWhereClause({})).toEqual({ condition: '1=1', params: [] });
  });

  test('scopes to creator_id for resellers', () => {
    expect(buildScopedWhereClause({ creator_id: 42 })).toEqual({
      condition: 'creator_id = ?',
      params: [42],
    });
  });
});

// In-memory fake tables backing every mocked model function, so the
// sequential steps below observe consistent state without a real DB.
let adminsByUsername;
let resellersById;
let accountsById;
let walletsByResellerId;
let ledgerEntries;
let nextAdminId;
let nextAccountId;
let nextLedgerId;
let renewalCost;
let notifications;
let nextNotificationId;

function seedStore() {
  adminsByUsername = { [TEST_ADMIN.username]: TEST_ADMIN };
  resellersById = {};
  accountsById = {};
  walletsByResellerId = {};
  ledgerEntries = [];
  nextAdminId = 100;
  nextAccountId = 1000;
  nextLedgerId = 1;
  renewalCost = 0;
  notifications = [];
  nextNotificationId = 1;
}

function wireMocks() {
  adminModel.findAdminByUsername.mockImplementation(async (username) => adminsByUsername[username] || null);
  adminModel.getResellerById.mockImplementation(async (id) => resellersById[id] || null);
  adminModel.findAdminById.mockImplementation(async (id) => {
    const allAdmins = Object.values(adminsByUsername);
    return allAdmins.find((a) => a.id === id) || null;
  });
  adminModel.findAdminUsernamesByIds.mockImplementation(async (ids) => {
    const allAdmins = Object.values(adminsByUsername);
    const map = {};
    for (const id of ids) {
      const found = allAdmins.find((a) => a.id === id);
      if (found) map[id] = found.username;
    }
    return map;
  });
  adminModel.createReseller.mockImplementation(async ({ username, passwordHash, email }) => {
    const id = nextAdminId++;
    const publicRow = { id, username, role: 'reseller', status: 'active', email, created_at: new Date() };
    resellersById[id] = publicRow;
    adminsByUsername[username] = { ...publicRow, password_hash: passwordHash };
    return { ...publicRow };
  });
  adminModel.listAdminsByRole.mockImplementation(async (role) =>
    Object.values(adminsByUsername)
      .filter((admin) => admin.role === role)
      .map(({ id, username, email }) => ({ id, username, email }))
  );

  walletModel.createWallet.mockImplementation(async (resellerId, balanceUsd) => {
    walletsByResellerId[resellerId] = {
      reseller_id: Number(resellerId),
      balance_usd: balanceUsd,
      updated_at: new Date(),
    };
  });

  walletModel.getWalletByResellerId.mockImplementation(async (resellerId) => {
    const wallet = walletsByResellerId[resellerId];
    return wallet ? { ...wallet } : null;
  });

  walletModel.adjustWalletBalance.mockImplementation(async (resellerId, deltaUsd) => {
    const wallet = walletsByResellerId[resellerId];
    if (!wallet) return false;
    wallet.balance_usd += deltaUsd;
    wallet.updated_at = new Date();
    return true;
  });

  walletLedgerModel.createLedgerEntry.mockImplementation(
    async ({ resellerId, type, amountUsd, relatedAccountId, createdBy, note }) => {
      const entry = {
        id: nextLedgerId++,
        reseller_id: Number(resellerId),
        type,
        amount_usd: amountUsd,
        related_account_id: relatedAccountId ?? null,
        invoiced: 0,
        invoice_id: null,
        created_by: createdBy ?? null,
        note: note ?? null,
        created_at: new Date(),
      };
      ledgerEntries.push(entry);
      return entry;
    }
  );

  walletLedgerModel.listLedgerForReseller.mockImplementation(async (resellerId, { page, limit }) => {
    const rows = ledgerEntries
      .filter((entry) => entry.reseller_id === Number(resellerId))
      .sort((a, b) => b.id - a.id);
    const start = (page - 1) * limit;
    return { rows: rows.slice(start, start + limit).map((r) => ({ ...r })), total: rows.length };
  });

  settingsModel.getRenewalCost.mockImplementation(async () => renewalCost);
  settingsModel.setRenewalCost.mockImplementation(async (value) => {
    renewalCost = value;
    return value;
  });

  notificationModel.createNotification.mockImplementation(async (recipientId, type, title, message, payload) => {
    const notification = {
      id: nextNotificationId++,
      recipient_id: Number(recipientId),
      type,
      title,
      message,
      payload: payload ?? null,
      read_at: null,
      created_at: new Date(),
    };
    notifications.push(notification);
    return { ...notification };
  });

  function scopedRow(id, scopeFilter) {
    const row = accountsById[id];
    if (!row) return null;
    if (scopeFilter && scopeFilter.creator_id !== undefined && row.creator_id !== scopeFilter.creator_id) {
      return null;
    }
    return row;
  }

  accountModel.findAccountByAuthid.mockImplementation(async (authid) => {
    const row = Object.values(accountsById).find((r) => r.authid === authid);
    return row ? { id: row.id } : null;
  });

  accountModel.createAccount.mockImplementation(async ({ authid, domain, status, expiresAt, creatorId, email }) => {
    const id = nextAccountId++;
    const row = {
      id,
      authid,
      domain,
      created_at: new Date(),
      status,
      expires_at: expiresAt,
      disabled_at: null,
      expired_at: null,
      creator_id: creatorId,
      email,
    };
    accountsById[id] = row;
    return { ...row };
  });

  accountModel.listAccounts.mockImplementation(async (scopeFilter, { status, search } = {}) => {
    let rows = Object.values(accountsById);
    if (scopeFilter && scopeFilter.creator_id !== undefined) {
      rows = rows.filter((r) => r.creator_id === scopeFilter.creator_id);
    }
    if (status) rows = rows.filter((r) => r.status === status);
    if (search) {
      rows = rows.filter((r) => r.authid.includes(search) || r.domain.includes(search));
    }
    return rows.map((r) => ({ ...r }));
  });

  accountModel.getAccountById.mockImplementation(async (id, scopeFilter) => {
    const row = scopedRow(Number(id), scopeFilter);
    return row ? { ...row } : null;
  });

  accountModel.reassignAccountCreator.mockImplementation(async (id, resellerId) => {
    const row = accountsById[Number(id)];
    if (!row) return null;
    row.creator_id = resellerId;
    return { ...row };
  });

  accountModel.renewAccount.mockImplementation(async (id, scopeFilter, expiresAt) => {
    const row = scopedRow(Number(id), scopeFilter);
    if (!row) return null;
    row.expires_at = expiresAt;
    if (new Date(expiresAt) > new Date()) {
      row.status = 'active';
      row.expired_at = null;
    }
    return { ...row };
  });

  accountModel.disableAccount.mockImplementation(async (id, scopeFilter) => {
    const row = scopedRow(Number(id), scopeFilter);
    if (!row) return null;
    row.disabled_at = new Date();
    row.status = 'disabled';
    return { ...row };
  });

  accountModel.updateAccountPassword.mockImplementation(async (id, scopeFilter) => {
    const row = scopedRow(Number(id), scopeFilter);
    return !!row;
  });

  accountModel.deleteAccount.mockImplementation(async (id) => {
    const existed = !!accountsById[Number(id)];
    delete accountsById[Number(id)];
    return existed;
  });
}

function monthsFromNowCloseTo(date, months, toleranceDays = 1) {
  const expected = new Date();
  expected.setMonth(expected.getMonth() + months);
  const diffMs = Math.abs(new Date(date).getTime() - expected.getTime());
  return diffMs < toleranceDays * 24 * 60 * 60 * 1000;
}

describe('Accounts flow (admin + reseller)', () => {
  const adminAgent = request.agent(app);
  let resellerAgent;

  const resellerUsername = `testreseller_${Date.now()}`;
  const resellerPassword = 'ResellerPass123!';
  let resellerId;

  const reseller2Username = `testreseller2_${Date.now()}`;
  let reseller2Id;

  let accountId;
  const accountAuthid = `testuser_${Date.now()}`;
  const accountDomain = 'test.example.com';

  let otherAccountId;
  let reassignAccountId;

  beforeAll(() => {
    seedStore();
    wireMocks();
    mailer.sendMail.mockResolvedValue(undefined);
  });

  test('1. login as admin (agent A)', async () => {
    const res = await adminAgent
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
  });

  test('2. create a throwaway reseller to own the test accounts', async () => {
    const res = await adminAgent
      .post('/api/admins')
      .send({ username: resellerUsername, password: resellerPassword, email: 'reseller@example.com' });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('reseller');
    resellerId = res.body.id;
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
  });

  test('2b. create a second throwaway reseller for ownership/reassignment tests', async () => {
    const res = await adminAgent
      .post('/api/admins')
      .send({ username: reseller2Username, password: 'ResellerPass456!', email: 'reseller2@example.com' });

    expect(res.status).toBe(201);
    reseller2Id = res.body.id;
    expect(mailer.sendMail).toHaveBeenCalledTimes(2);
  });

  test('3. as admin: create an account assigned via resellerId', async () => {
    const res = await adminAgent.post('/api/accounts').send({
      authid: accountAuthid,
      domain: accountDomain,
      password: 'AccountPass123!',
      resellerId,
      email: 'enduser@example.com',
    });

    expect(res.status).toBe(201);
    expect(res.body.creator_id).toBe(resellerId);
    accountId = res.body.id;
    expect(mailer.sendMail).toHaveBeenCalledTimes(3);
  });

  test('3a. an email-shaped authid is rejected with a field-specific 400', async () => {
    const res = await adminAgent.post('/api/accounts').send({
      authid: 'not an authid@example.com',
      domain: accountDomain,
      password: 'AccountPass123!',
      resellerId,
      email: 'valid@example.com',
    });

    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveProperty('authid');
    expect(res.body.errors).not.toHaveProperty('email');
  });

  test('3a2. a malformed email is rejected with a field-specific 400', async () => {
    const res = await adminAgent.post('/api/accounts').send({
      authid: `testuser_${Date.now()}_bad_email`,
      domain: accountDomain,
      password: 'AccountPass123!',
      resellerId,
      email: 'not-an-email',
    });

    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveProperty('email');
    expect(res.body.errors).not.toHaveProperty('authid');
  });

  test('3c. reusing the same authid on a different domain is rejected with 409', async () => {
    const res = await adminAgent.post('/api/accounts').send({
      authid: accountAuthid,
      domain: 'a-completely-different-domain.example.com',
      password: 'AccountPass123!',
      resellerId,
      email: 'someoneelse@example.com',
    });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'An account with this authid already exists' });
  });

  test('3d. resellerId referencing a non-reseller admin is rejected with 400', async () => {
    const res = await adminAgent.post('/api/accounts').send({
      authid: `testuser_${Date.now()}_bad_owner`,
      domain: accountDomain,
      password: 'AccountPass123!',
      resellerId: TEST_ADMIN.id,
      email: 'someoneelse2@example.com',
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'resellerId does not reference an existing reseller' });
  });

  test('3e. missing resellerId is rejected with 400', async () => {
    const res = await adminAgent.post('/api/accounts').send({
      authid: `testuser_${Date.now()}_no_owner`,
      domain: accountDomain,
      password: 'AccountPass123!',
      email: 'someoneelse3@example.com',
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'resellerId is required' });
  });

  test('3b. as admin: create a second throwaway account owned by the second reseller', async () => {
    const res = await adminAgent.post('/api/accounts').send({
      authid: `otheruser_${Date.now()}`,
      domain: accountDomain,
      password: 'AccountPass123!',
      resellerId: reseller2Id,
      email: 'otherenduser@example.com',
    });

    expect(res.status).toBe(201);
    expect(res.body.creator_id).toBe(reseller2Id);
    otherAccountId = res.body.id;
    expect(mailer.sendMail).toHaveBeenCalledTimes(4);
  });

  test('3f. as admin: create a third throwaway account, owned by the first reseller, for reassignment tests', async () => {
    const res = await adminAgent.post('/api/accounts').send({
      authid: `reassignuser_${Date.now()}`,
      domain: accountDomain,
      password: 'AccountPass123!',
      resellerId,
      email: 'reassignenduser@example.com',
    });

    expect(res.status).toBe(201);
    expect(res.body.creator_id).toBe(resellerId);
    reassignAccountId = res.body.id;
    expect(mailer.sendMail).toHaveBeenCalledTimes(5);
  });

  test('4. as admin: list accounts, confirm created_by is present and correct', async () => {
    const res = await adminAgent.get('/api/accounts');

    expect(res.status).toBe(200);
    const created = res.body.find((a) => a.id === accountId);
    expect(created).toBeDefined();
    expect(created.created_by).toBe(resellerUsername);
  });

  test('5. as admin: get account by id', async () => {
    const res = await adminAgent.get(`/api/accounts/${accountId}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: accountId, authid: accountAuthid, domain: accountDomain });
  });

  test('6. as admin: renew with a custom future date resets status to active and clears expired_at', async () => {
    const futureDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

    const res = await adminAgent.patch(`/api/accounts/${accountId}/renew`).send({ expires_at: futureDate });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.expired_at).toBeNull();
    expect(new Date(res.body.expires_at).toISOString()).toBe(futureDate);
  });

  test('7. as admin: renew with no body defaults expires_at to ~6 months out', async () => {
    const res = await adminAgent.patch(`/api/accounts/${accountId}/renew`).send({});

    expect(res.status).toBe(200);
    expect(monthsFromNowCloseTo(res.body.expires_at, 6)).toBe(true);
  });

  test('8. as admin: disable sets disabled_at and status, leaves expires_at untouched', async () => {
    const before = await adminAgent.get(`/api/accounts/${accountId}`);
    const expiresAtBefore = before.body.expires_at;

    const res = await adminAgent.patch(`/api/accounts/${accountId}/disable`);

    expect(res.status).toBe(200);
    expect(res.body.disabled_at).not.toBeNull();
    expect(res.body.status).toBe('disabled');
    expect(res.body.expires_at).toBe(expiresAtBefore);
  });

  test('9. as admin: update password succeeds with no password in the response', async () => {
    const res = await adminAgent.patch(`/api/accounts/${accountId}/password`).send({ password: 'NewAcctPass456!' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Password updated successfully' });
    expect(res.body).not.toHaveProperty('password');
  });

  test('9b. as admin: reassign an account to a different reseller updates creator_id', async () => {
    const res = await adminAgent
      .patch(`/api/accounts/${reassignAccountId}/reassign`)
      .send({ resellerId: reseller2Id });

    expect(res.status).toBe(200);
    expect(res.body.creator_id).toBe(reseller2Id);
  });

  test('9c. as admin: reassign with a resellerId that is not a reseller is rejected with 400', async () => {
    const res = await adminAgent
      .patch(`/api/accounts/${reassignAccountId}/reassign`)
      .send({ resellerId: TEST_ADMIN.id });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'resellerId does not reference an existing reseller' });
  });

  test('9d. as admin: reassigning a nonexistent account returns 404', async () => {
    const res = await adminAgent
      .patch('/api/accounts/999999/reassign')
      .send({ resellerId: reseller2Id });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Account not found' });
  });

  test('10. login as the reseller who owns the account (agent B)', async () => {
    resellerAgent = request.agent(app);

    const res = await resellerAgent
      .post('/api/auth/login')
      .send({ username: resellerUsername, password: resellerPassword });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('reseller');
  });

  test('11. as reseller: list only shows their own account, with no created_by field', async () => {
    const res = await resellerAgent.get('/api/accounts');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(accountId);
    expect(res.body[0]).not.toHaveProperty('created_by');
  });

  test('12. as reseller: get the account they own succeeds', async () => {
    const res = await resellerAgent.get(`/api/accounts/${accountId}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(accountId);
  });

  test('13. as reseller: get/renew/disable an account they do not own each return 404', async () => {
    const getRes = await resellerAgent.get(`/api/accounts/${otherAccountId}`);
    expect(getRes.status).toBe(404);

    const renewRes = await resellerAgent.patch(`/api/accounts/${otherAccountId}/renew`).send({});
    expect(renewRes.status).toBe(404);

    const disableRes = await resellerAgent.patch(`/api/accounts/${otherAccountId}/disable`);
    expect(disableRes.status).toBe(404);
  });

  test('13b. as reseller: creating an account directly is forbidden', async () => {
    const res = await resellerAgent.post('/api/accounts').send({
      authid: `resellerattempt_${Date.now()}`,
      domain: accountDomain,
      password: 'AccountPass123!',
      resellerId,
      email: 'resellerattempt@example.com',
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Admin access required' });
  });

  test('13c. as reseller: reassigning an account is forbidden', async () => {
    const res = await resellerAgent
      .patch(`/api/accounts/${accountId}/reassign`)
      .send({ resellerId: reseller2Id });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Admin access required' });
  });

  test('14. as reseller: DELETE is forbidden', async () => {
    const res = await resellerAgent.delete(`/api/accounts/${accountId}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Admin access required' });
  });

  test('15. as admin: DELETE the test accounts succeeds, then GET returns 404', async () => {
    const del1 = await adminAgent.delete(`/api/accounts/${accountId}`);
    expect(del1.status).toBe(200);
    expect(del1.body).toEqual({ message: 'Account deleted successfully' });

    const del2 = await adminAgent.delete(`/api/accounts/${otherAccountId}`);
    expect(del2.status).toBe(200);

    const del3 = await adminAgent.delete(`/api/accounts/${reassignAccountId}`);
    expect(del3.status).toBe(200);

    const getRes = await adminAgent.get(`/api/accounts/${accountId}`);
    expect(getRes.status).toBe(404);
  });
});

describe('Renewal wallet deduction (Phase 2)', () => {
  const adminAgent = request.agent(app);
  const resellerPassword = 'ResellerPass123!';
  let reseller;
  let account;

  async function createReseller({ username, email, initialCredit }) {
    const res = await adminAgent
      .post('/api/admins')
      .send({ username, password: resellerPassword, email, initialCredit });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function createAccount({ authid, resellerId }) {
    const res = await adminAgent.post('/api/accounts').send({
      authid,
      domain: 'test.example.com',
      password: 'AccountPass123!',
      resellerId,
      email: `${authid}@example.com`,
    });
    expect(res.status).toBe(201);
    return res.body;
  }

  beforeAll(async () => {
    const loginRes = await adminAgent
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN_PASSWORD });
    expect(loginRes.status).toBe(200);

    const costRes = await adminAgent.put('/api/settings/renewal-cost').send({ renewalCost: 15 });
    expect(costRes.status).toBe(200);

    reseller = await createReseller({
      username: `deduct_reseller_${Date.now()}`,
      email: `deduct_reseller_${Date.now()}@example.com`,
      initialCredit: 10,
    });
    account = await createAccount({ authid: `deduct_account_${Date.now()}`, resellerId: reseller.id });

    mailer.sendMail.mockClear();
  });

  test('renewing deducts the renewal cost from the owning reseller wallet, pushing it negative', async () => {
    const res = await adminAgent.patch(`/api/accounts/${account.id}/renew`).send({});
    expect(res.status).toBe(200);

    const walletRes = await adminAgent.get(`/api/resellers/${reseller.id}/wallet`);
    expect(walletRes.body.balanceUsd).toBe(-5); // 10 initial - 15 renewal cost

    const entry = walletRes.body.ledger.find((e) => e.type === 'renewal_deduction');
    expect(entry).toMatchObject({
      amount_usd: -15,
      related_account_id: account.id,
      invoiced: 0,
    });
  });

  test('the renewal itself succeeds even though the wallet balance is already negative', async () => {
    const res = await adminAgent.patch(`/api/accounts/${account.id}/renew`).send({});
    expect(res.status).toBe(200);

    const walletRes = await adminAgent.get(`/api/resellers/${reseller.id}/wallet`);
    expect(walletRes.body.balanceUsd).toBe(-20); // -5 - 15
  });

  test('both the owning reseller and the admin receive the renewal-deduction email', async () => {
    expect(mailer.sendMail).toHaveBeenCalled();

    const lastCall = mailer.sendMail.mock.calls[mailer.sendMail.mock.calls.length - 1][0];
    const recipients = lastCall.to.split(',').map((s) => s.trim());
    expect(recipients).toEqual(expect.arrayContaining([reseller.email, TEST_ADMIN.email]));
    expect(lastCall.subject).toContain(account.authid);
  });

  test('both the owning reseller and the admin receive a renewal-deduction notification row', async () => {
    const recipientIds = notifications
      .filter((n) => n.type === 'renewal_deduction')
      .map((n) => n.recipient_id);
    expect(recipientIds).toEqual(expect.arrayContaining([reseller.id, TEST_ADMIN.id]));

    const resellerNotification = notifications.find(
      (n) => n.type === 'renewal_deduction' && n.recipient_id === reseller.id
    );
    expect(resellerNotification.title).toContain(account.authid);
    expect(resellerNotification.payload).toMatchObject({
      accountId: account.id,
      authid: account.authid,
      domain: account.domain,
    });
  });

  test('renewing an unassigned account succeeds without touching any wallet or sending mail', async () => {
    const unassignedId = 555555;
    accountsById[unassignedId] = {
      id: unassignedId,
      authid: `unassigned_${Date.now()}`,
      domain: 'test.example.com',
      created_at: new Date(),
      status: 'active',
      expires_at: new Date(),
      disabled_at: null,
      expired_at: null,
      creator_id: null,
      email: 'unassigned@example.com',
    };

    mailer.sendMail.mockClear();
    walletModel.adjustWalletBalance.mockClear();
    walletLedgerModel.createLedgerEntry.mockClear();
    notificationModel.createNotification.mockClear();

    const res = await adminAgent.patch(`/api/accounts/${unassignedId}/renew`).send({});

    expect(res.status).toBe(200);
    expect(walletModel.adjustWalletBalance).not.toHaveBeenCalled();
    expect(walletLedgerModel.createLedgerEntry).not.toHaveBeenCalled();
    expect(mailer.sendMail).not.toHaveBeenCalled();
    expect(notificationModel.createNotification).not.toHaveBeenCalled();
  });

  test('renewing when the owning reseller has no wallets row does not crash, and still records the ledger entry', async () => {
    const noWalletReseller = await createReseller({
      username: `deduct_nowallet_${Date.now()}`,
      email: `deduct_nowallet_${Date.now()}@example.com`,
    });
    // Simulates a reseller predating the wallet feature (or otherwise missing
    // its wallets row) - see sql/backfill-wallets.sql.
    delete walletsByResellerId[noWalletReseller.id];

    const noWalletAccount = await createAccount({
      authid: `deduct_nowallet_account_${Date.now()}`,
      resellerId: noWalletReseller.id,
    });

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await adminAgent.patch(`/api/accounts/${noWalletAccount.id}/renew`).send({});
    expect(res.status).toBe(200);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(`reseller ${noWalletReseller.id}`));
    errorSpy.mockRestore();

    // No wallets row means adjustWalletBalance is a no-op, but the ledger
    // entry itself must still be recorded (orphaned until backfilled).
    expect(walletsByResellerId[noWalletReseller.id]).toBeUndefined();
    const entry = ledgerEntries.find(
      (e) => e.reseller_id === noWalletReseller.id && e.related_account_id === noWalletAccount.id
    );
    expect(entry).toMatchObject({ type: 'renewal_deduction', amount_usd: -15 });
  });

  test('a missing renewal-cost setting skips the deduction entirely, loudly, instead of writing a $0 ledger entry', async () => {
    settingsModel.getRenewalCost.mockResolvedValueOnce(null);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    walletModel.adjustWalletBalance.mockClear();
    walletLedgerModel.createLedgerEntry.mockClear();
    const ledgerCountBefore = ledgerEntries.length;
    const balanceBefore = walletsByResellerId[reseller.id].balance_usd;

    const res = await adminAgent.patch(`/api/accounts/${account.id}/renew`).send({});
    expect(res.status).toBe(200); // the renewal itself still succeeds

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('renewal cost setting is missing'));
    errorSpy.mockRestore();

    expect(walletModel.adjustWalletBalance).not.toHaveBeenCalled();
    expect(walletLedgerModel.createLedgerEntry).not.toHaveBeenCalled();
    expect(ledgerEntries).toHaveLength(ledgerCountBefore);
    expect(walletsByResellerId[reseller.id].balance_usd).toBe(balanceBefore);
  });

  test('an explicitly-configured $0 renewal cost still records a real deduction, but warns loudly', async () => {
    settingsModel.getRenewalCost.mockResolvedValueOnce(0);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await adminAgent.patch(`/api/accounts/${account.id}/renew`).send({});
    expect(res.status).toBe(200);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('renewal cost is configured at $0'));
    warnSpy.mockRestore();

    const entry = ledgerEntries.find(
      (e) => e.reseller_id === reseller.id && e.related_account_id === account.id && e.amount_usd === 0
    );
    expect(entry).toBeDefined();
  });

  test('wallet balance after a real deduction equals the sum of that reseller\'s ledger entries', async () => {
    const resellerLedger = ledgerEntries.filter((e) => e.reseller_id === reseller.id);
    const expectedBalance = resellerLedger.reduce((sum, e) => sum + Number(e.amount_usd), 0);
    expect(walletsByResellerId[reseller.id].balance_usd).toBe(expectedBalance);
  });

  // These two use their own dedicated reseller/account rather than the
  // shared `reseller` above - both need to force an arbitrary starting
  // balance directly, which would otherwise corrupt the ledger-vs-balance
  // invariant just checked, and both trigger their own mail/notifications
  // that would otherwise be mistaken for the shared reseller's by the
  // "last call" assertions earlier in this block.
  test('renewal is never blocked for insufficient funds - it succeeds and correctly extends expires_at even with a deeply negative balance', async () => {
    const deepDebtReseller = await createReseller({
      username: `deduct_deepdebt_${Date.now()}`,
      email: `deduct_deepdebt_${Date.now()}@example.com`,
    });
    const deepDebtAccount = await createAccount({
      authid: `deduct_deepdebt_account_${Date.now()}`,
      resellerId: deepDebtReseller.id,
    });
    walletsByResellerId[deepDebtReseller.id].balance_usd = -100000;
    const balanceBefore = walletsByResellerId[deepDebtReseller.id].balance_usd;

    const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const res = await adminAgent
      .patch(`/api/accounts/${deepDebtAccount.id}/renew`)
      .send({ expires_at: newExpiresAt });

    expect(res.status).toBe(200);
    expect(res.body.expires_at).toBe(newExpiresAt);

    // Never blocked - the deduction still goes through, pushing the balance
    // even further negative rather than rejecting the renewal.
    const walletRes = await adminAgent.get(`/api/resellers/${deepDebtReseller.id}/wallet`);
    expect(walletRes.body.balanceUsd).toBeLessThan(balanceBefore);
  });

  test('a negative resulting balance renders correctly in both the email and the notification ("-$X.XX", never the garbled "$-X.XX")', async () => {
    const negBalanceReseller = await createReseller({
      username: `deduct_negfmt_${Date.now()}`,
      email: `deduct_negfmt_${Date.now()}@example.com`,
    });
    const negBalanceAccount = await createAccount({
      authid: `deduct_negfmt_account_${Date.now()}`,
      resellerId: negBalanceReseller.id,
    });
    walletsByResellerId[negBalanceReseller.id].balance_usd = -8; // 8 + 15 = 23, cleanly negative after this renewal
    mailer.sendMail.mockClear();
    const notificationsBefore = notifications.length;

    const res = await adminAgent.patch(`/api/accounts/${negBalanceAccount.id}/renew`).send({});
    expect(res.status).toBe(200);

    const walletRes = await adminAgent.get(`/api/resellers/${negBalanceReseller.id}/wallet`);
    expect(walletRes.body.balanceUsd).toBe(-23);
    const expectedBalanceStr = '-$23.00';

    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    const emailCall = mailer.sendMail.mock.calls[0][0];
    expect(emailCall.text).toContain(expectedBalanceStr);
    expect(emailCall.text).not.toMatch(/\$-/);
    expect(emailCall.html).toContain(expectedBalanceStr);
    expect(emailCall.html).not.toMatch(/\$-/);

    // Exactly one notification row for the reseller and one for the admin -
    // never more, never fewer.
    const newNotifications = notifications.slice(notificationsBefore).filter((n) => n.type === 'renewal_deduction');
    const resellerRows = newNotifications.filter((n) => n.recipient_id === negBalanceReseller.id);
    const adminRows = newNotifications.filter((n) => n.recipient_id === TEST_ADMIN.id);
    expect(resellerRows).toHaveLength(1);
    expect(adminRows).toHaveLength(1);
    expect(resellerRows[0].message).toContain(expectedBalanceStr);
    expect(resellerRows[0].message).not.toMatch(/\$-/);
  });

  describe('proportional pricing by renewal period', () => {
    let propReseller;
    let propAccount;

    // Mirrors the controller's own 6-month-hop loop (renewalUnitsForPeriod)
    // so the date this test sends matches exactly what N hops would produce,
    // regardless of day-of-month rollover quirks.
    function hopSixMonths(date, times) {
      const d = new Date(date);
      for (let i = 0; i < times; i++) {
        d.setMonth(d.getMonth() + 6);
      }
      return d.toISOString();
    }

    beforeAll(async () => {
      propReseller = await createReseller({
        username: `deduct_period_${Date.now()}`,
        email: `deduct_period_${Date.now()}@example.com`,
        initialCredit: 1000,
      });
      propAccount = await createAccount({
        authid: `deduct_period_account_${Date.now()}`,
        resellerId: propReseller.id,
      });

      // Pin to a known, safe day-of-month (the 15th, valid in every month) so
      // the hop math below is deterministic no matter what day this suite
      // actually runs on.
      const pinned = await adminAgent
        .patch(`/api/accounts/${propAccount.id}/renew`)
        .send({ expires_at: '2030-01-15T00:00:00.000Z' });
      expect(pinned.status).toBe(200);
      propAccount = pinned.body;
    });

    test('extending the expiry by exactly 12 months (two 6-month units) deducts 2x the configured rate', async () => {
      const newExpiresAt = hopSixMonths(propAccount.expires_at, 2);
      const balanceBefore = walletsByResellerId[propReseller.id].balance_usd;

      const res = await adminAgent.patch(`/api/accounts/${propAccount.id}/renew`).send({ expires_at: newExpiresAt });
      expect(res.status).toBe(200);
      propAccount = res.body;

      expect(walletsByResellerId[propReseller.id].balance_usd).toBe(balanceBefore - 30); // 2 * 15

      const entry = [...ledgerEntries]
        .reverse()
        .find((e) => e.reseller_id === propReseller.id && e.related_account_id === propAccount.id);
      expect(entry.amount_usd).toBe(-30);
    });

    test('extending the expiry by exactly 6 months (one unit) deducts 1x the configured rate', async () => {
      const newExpiresAt = hopSixMonths(propAccount.expires_at, 1);
      const balanceBefore = walletsByResellerId[propReseller.id].balance_usd;

      const res = await adminAgent.patch(`/api/accounts/${propAccount.id}/renew`).send({ expires_at: newExpiresAt });
      expect(res.status).toBe(200);
      propAccount = res.body;

      expect(walletsByResellerId[propReseller.id].balance_usd).toBe(balanceBefore - 15);
    });

    test('extending the expiry by a partial period (8 months - past 1 unit, short of 2) rounds up to 2x the rate', async () => {
      const base = new Date(propAccount.expires_at);
      base.setMonth(base.getMonth() + 8);
      const newExpiresAt = base.toISOString();

      const balanceBefore = walletsByResellerId[propReseller.id].balance_usd;
      const res = await adminAgent.patch(`/api/accounts/${propAccount.id}/renew`).send({ expires_at: newExpiresAt });
      expect(res.status).toBe(200);
      propAccount = res.body;

      expect(walletsByResellerId[propReseller.id].balance_usd).toBe(balanceBefore - 30);
    });
  });
});
