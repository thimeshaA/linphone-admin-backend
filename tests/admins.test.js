const request = require('supertest');
const bcrypt = require('bcrypt');
const { TEST_ADMIN_PASSWORD, TEST_ADMIN } = require('./helpers/fixtures');

jest.mock('../models/adminModel');

const adminModel = require('../models/adminModel');
const app = require('../index');

// In-memory fake "admins" table backing every mocked adminModel function, so
// sequential steps in this flow observe consistent state without a real DB.
let adminsByUsername;
let resellersById;
let nextId;

function seedStore() {
  adminsByUsername = { [TEST_ADMIN.username]: TEST_ADMIN };
  resellersById = {};
  nextId = 100;
}

function wireMocks() {
  adminModel.findAdminByUsername.mockImplementation(async (username) => adminsByUsername[username] || null);

  adminModel.listResellers.mockImplementation(async (status) => {
    let rows = Object.values(resellersById);
    if (status) rows = rows.filter((r) => r.status === status);
    return rows.map((r) => ({ ...r }));
  });

  adminModel.getResellerById.mockImplementation(async (id) => {
    const row = resellersById[id];
    return row ? { ...row } : null;
  });

  adminModel.createReseller.mockImplementation(async ({ username, passwordHash }) => {
    const id = nextId++;
    const publicRow = { id, username, role: 'reseller', status: 'active', created_at: new Date() };
    resellersById[id] = publicRow;
    adminsByUsername[username] = { ...publicRow, password_hash: passwordHash };
    return { id: publicRow.id, username: publicRow.username, role: publicRow.role, status: publicRow.status };
  });

  adminModel.updateResellerStatus.mockImplementation(async (id, status) => {
    const row = resellersById[id];
    if (!row) return null;
    row.status = status;
    if (adminsByUsername[row.username]) adminsByUsername[row.username].status = status;
    return { ...row };
  });

  adminModel.updateResellerPassword.mockImplementation(async (id, passwordHash) => {
    const row = resellersById[id];
    if (!row) return false;
    if (adminsByUsername[row.username]) adminsByUsername[row.username].password_hash = passwordHash;
    return true;
  });

  adminModel.deleteReseller.mockImplementation(async (id) => {
    const row = resellersById[id];
    if (!row) return false;
    delete resellersById[id];
    delete adminsByUsername[row.username];
    return true;
  });
}

describe('Admins (reseller management) flow', () => {
  const adminAgent = request.agent(app);
  let resellerId;
  const resellerUsername = `testreseller_${Date.now()}`;
  const resellerPassword = 'ResellerPass123!';
  const newResellerPassword = 'ResellerPassReset456!';

  beforeAll(() => {
    seedStore();
    wireMocks();
  });

  test('1. login as admin (agent persists cookie for the rest of the file)', async () => {
    const res = await adminAgent
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
  });

  test('2. create a reseller; role is forced to "reseller" even though "admin" was sent', async () => {
    const res = await adminAgent
      .post('/api/admins')
      .send({ username: resellerUsername, password: resellerPassword, role: 'admin' });

    expect(res.status).toBe(201);
    expect(res.body.username).toBe(resellerUsername);
    expect(res.body.role).toBe('reseller');
    expect(res.body).not.toHaveProperty('password_hash');

    resellerId = res.body.id;
    expect(resellerId).toBeDefined();
  });

  test('3. creating the same username again is rejected with 409', async () => {
    const res = await adminAgent
      .post('/api/admins')
      .send({ username: resellerUsername, password: 'SomeOtherPass1!' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Username already exists' });
  });

  test('4. list resellers includes the new one', async () => {
    const res = await adminAgent.get('/api/admins');

    expect(res.status).toBe(200);
    expect(res.body.some((r) => r.id === resellerId && r.username === resellerUsername)).toBe(true);
  });

  test('5. get that reseller by id returns correct data with no password_hash', async () => {
    const res = await adminAgent.get(`/api/admins/${resellerId}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: resellerId, username: resellerUsername, role: 'reseller', status: 'active' });
    expect(res.body).not.toHaveProperty('password_hash');
  });

  test('6. update status to disabled', async () => {
    const res = await adminAgent.patch(`/api/admins/${resellerId}`).send({ status: 'disabled' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('disabled');
  });

  test('7. login as that reseller fails with 403 while disabled', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: resellerUsername, password: resellerPassword });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Account is disabled' });
  });

  test('8. reset that reseller\'s password as admin', async () => {
    const res = await adminAgent
      .patch(`/api/admins/${resellerId}/reset-password`)
      .send({ newPassword: newResellerPassword });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Password reset successfully' });

    // Sanity check the mock actually stored a real bcrypt hash of the new password.
    const stored = adminsByUsername[resellerUsername].password_hash;
    expect(bcrypt.compareSync(newResellerPassword, stored)).toBe(true);
  });

  test('9. update status back to active', async () => {
    const res = await adminAgent.patch(`/api/admins/${resellerId}`).send({ status: 'active' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
  });

  let resellerAgent;

  test('10. login as that reseller with the NEW password succeeds', async () => {
    resellerAgent = request.agent(app);

    const res = await resellerAgent
      .post('/api/auth/login')
      .send({ username: resellerUsername, password: newResellerPassword });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('reseller');
  });

  test('11. as the reseller, GET /api/admins is forbidden', async () => {
    const res = await resellerAgent.get('/api/admins');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Admin access required' });
  });

  test('12. as the reseller, DELETE /api/admins/:id is forbidden', async () => {
    const res = await resellerAgent.delete(`/api/admins/${resellerId}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Admin access required' });
  });

  test('13. deleting a non-existent reseller returns 404', async () => {
    const res = await adminAgent.delete('/api/admins/999999');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Reseller not found' });
  });

  test('14. as admin, delete the reseller', async () => {
    const res = await adminAgent.delete(`/api/admins/${resellerId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Reseller deleted successfully' });
  });

  test('15. the deleted reseller no longer appears', async () => {
    const res = await adminAgent.get(`/api/admins/${resellerId}`);

    expect(res.status).toBe(404);
  });
});
