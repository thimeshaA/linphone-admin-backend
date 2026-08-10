const request = require('supertest');
const { TEST_ADMIN_PASSWORD, TEST_ADMIN } = require('./helpers/fixtures');

jest.mock('../models/adminModel');
jest.mock('../models/accountModel');

const adminModel = require('../models/adminModel');
const accountModel = require('../models/accountModel');
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
let adminStatusById;
let resellersById;
let accountsById;
let nextAdminId;
let nextAccountId;

function seedStore() {
  adminsByUsername = { [TEST_ADMIN.username]: TEST_ADMIN };
  adminStatusById = { [TEST_ADMIN.id]: { id: TEST_ADMIN.id, status: 'active' } };
  resellersById = {};
  accountsById = {};
  nextAdminId = 100;
  nextAccountId = 1000;
}

function wireMocks() {
  adminModel.findAdminByUsername.mockImplementation(async (username) => adminsByUsername[username] || null);
  adminModel.getAdminStatusById.mockImplementation(async (id) => adminStatusById[id] || null);
  adminModel.findAdminUsernamesByIds.mockImplementation(async (ids) => {
    const allAdmins = Object.values(adminsByUsername);
    const map = {};
    for (const id of ids) {
      const found = allAdmins.find((a) => a.id === id);
      if (found) map[id] = found.username;
    }
    return map;
  });
  adminModel.createReseller.mockImplementation(async ({ username, passwordHash }) => {
    const id = nextAdminId++;
    const publicRow = { id, username, role: 'reseller', status: 'active', created_at: new Date() };
    resellersById[id] = publicRow;
    adminStatusById[id] = { id, status: 'active' };
    adminsByUsername[username] = { ...publicRow, password_hash: passwordHash };
    return { id: publicRow.id, username: publicRow.username, role: publicRow.role, status: publicRow.status };
  });

  function scopedRow(id, scopeFilter) {
    const row = accountsById[id];
    if (!row) return null;
    if (scopeFilter && scopeFilter.creator_id !== undefined && row.creator_id !== scopeFilter.creator_id) {
      return null;
    }
    return row;
  }

  accountModel.findAccountByAuthidDomain.mockImplementation(async (authid, domain) => {
    const row = Object.values(accountsById).find((r) => r.authid === authid && r.domain === domain);
    return row ? { id: row.id } : null;
  });

  accountModel.createAccount.mockImplementation(async ({ authid, domain, status, expiresAt, creatorId }) => {
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

  let accountId;
  const accountAuthid = `testuser_${Date.now()}`;
  const accountDomain = 'test.example.com';

  let otherAccountId;

  beforeAll(() => {
    seedStore();
    wireMocks();
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
      .send({ username: resellerUsername, password: resellerPassword });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe('reseller');
    resellerId = res.body.id;
  });

  test('3. as admin: create an account assigned to the reseller creator_id', async () => {
    const res = await adminAgent.post('/api/accounts').send({
      authid: accountAuthid,
      domain: accountDomain,
      password: 'AccountPass123!',
      creator_id: resellerId,
    });

    expect(res.status).toBe(201);
    expect(res.body.creator_id).toBe(resellerId);
    accountId = res.body.id;
  });

  test('3b. as admin: create a second throwaway account owned by a different creator', async () => {
    const res = await adminAgent.post('/api/accounts').send({
      authid: `otheruser_${Date.now()}`,
      domain: accountDomain,
      password: 'AccountPass123!',
      creator_id: TEST_ADMIN.id,
    });

    expect(res.status).toBe(201);
    expect(res.body.creator_id).toBe(TEST_ADMIN.id);
    otherAccountId = res.body.id;
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

    const getRes = await adminAgent.get(`/api/accounts/${accountId}`);
    expect(getRes.status).toBe(404);
  });
});
