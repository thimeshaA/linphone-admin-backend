const request = require('supertest');
const bcrypt = require('bcrypt');
const { TEST_ADMIN_PASSWORD, TEST_ADMIN } = require('./helpers/fixtures');

jest.mock('../models/adminModel');
jest.mock('../utils/mailer');

const adminModel = require('../models/adminModel');
const mailer = require('../utils/mailer');
const app = require('../index');

// In-memory fake "admins" table backing every mocked adminModel function, so
// sequential steps in this flow observe consistent state without a real DB.
let adminsByUsername;
let adminsByEmail;
let resellersById;
let nextId;

function seedStore() {
  adminsByUsername = { [TEST_ADMIN.username]: TEST_ADMIN };
  adminsByEmail = {};
  resellersById = {};
  nextId = 100;
}

function wireMocks() {
  adminModel.findAdminByUsername.mockImplementation(
    async (identifier) => adminsByUsername[identifier] || adminsByEmail[identifier] || null
  );

  adminModel.findAdminByEmail.mockImplementation(async (email) => adminsByEmail[email] || null);

  adminModel.listResellers.mockImplementation(async (status) => {
    let rows = Object.values(resellersById);
    if (status) rows = rows.filter((r) => r.status === status);
    return rows.map((r) => ({ ...r }));
  });

  adminModel.getResellerById.mockImplementation(async (id) => {
    const row = resellersById[id];
    return row ? { ...row } : null;
  });

  adminModel.createReseller.mockImplementation(async ({ username, passwordHash, expiresAt, email }) => {
    const id = nextId++;
    const publicRow = {
      id,
      username,
      role: 'reseller',
      status: 'active',
      expires_at: expiresAt,
      expired_at: null,
      email,
      created_at: new Date(),
    };
    resellersById[id] = publicRow;
    adminsByUsername[username] = { ...publicRow, password_hash: passwordHash };
    adminsByEmail[email] = adminsByUsername[username];
    return { ...publicRow };
  });

  adminModel.renewReseller.mockImplementation(async (id, expiresAt) => {
    const row = resellersById[id];
    if (!row) return null;
    row.expires_at = expiresAt;
    if (new Date(expiresAt) > new Date()) {
      row.status = 'active';
      row.expired_at = null;
    }
    if (adminsByUsername[row.username]) {
      adminsByUsername[row.username].expires_at = row.expires_at;
      adminsByUsername[row.username].status = row.status;
      adminsByUsername[row.username].expired_at = row.expired_at;
    }
    return { ...row };
  });

  adminModel.updateResellerStatus.mockImplementation(async (id, status) => {
    const row = resellersById[id];
    if (!row) return null;
    row.status = status;
    if (adminsByUsername[row.username]) adminsByUsername[row.username].status = status;
    return { ...row };
  });

  adminModel.updateResellerEmail.mockImplementation(async (id, email) => {
    const row = resellersById[id];
    if (!row) return null;
    delete adminsByEmail[row.email];
    row.email = email;
    if (adminsByUsername[row.username]) adminsByUsername[row.username].email = email;
    adminsByEmail[email] = adminsByUsername[row.username];
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
    delete adminsByEmail[row.email];
    return true;
  });
}

function monthsFromNowCloseTo(date, months, toleranceDays = 1) {
  const expected = new Date();
  expected.setMonth(expected.getMonth() + months);
  const diffMs = Math.abs(new Date(date).getTime() - expected.getTime());
  return diffMs < toleranceDays * 24 * 60 * 60 * 1000;
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
    mailer.sendMail.mockResolvedValue(undefined);
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
      .send({ username: resellerUsername, password: resellerPassword, email: 'reseller@example.com', role: 'admin' });

    expect(res.status).toBe(201);
    expect(res.body.username).toBe(resellerUsername);
    expect(res.body.role).toBe('reseller');
    expect(res.body).not.toHaveProperty('password_hash');
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(mailer.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'reseller@example.com', subject: expect.stringContaining('reseller') })
    );

    resellerId = res.body.id;
    expect(resellerId).toBeDefined();
  });

  test('3. creating the same username again is rejected with 409', async () => {
    const res = await adminAgent
      .post('/api/admins')
      .send({ username: resellerUsername, password: 'SomeOtherPass1!', email: 'reseller2@example.com' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Username already exists' });
  });

  test('3b. creating with the same email but a different username is rejected with 409', async () => {
    const res = await adminAgent
      .post('/api/admins')
      .send({ username: `${resellerUsername}_other`, password: 'SomeOtherPass1!', email: 'reseller@example.com' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Email already exists' });
  });

  test('3c. an email-shaped username is rejected with a field-specific 400', async () => {
    const res = await adminAgent
      .post('/api/admins')
      .send({ username: 'not an email@example.com', password: 'SomeOtherPass1!', email: 'valid@example.com' });

    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveProperty('username');
    expect(res.body.errors).not.toHaveProperty('email');
  });

  test('3d. a malformed email is rejected with a field-specific 400', async () => {
    const res = await adminAgent
      .post('/api/admins')
      .send({ username: `${resellerUsername}_new`, password: 'SomeOtherPass1!', email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveProperty('email');
    expect(res.body.errors).not.toHaveProperty('username');
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

  test('6b. attempting to change username via PATCH is rejected with a field-specific 400', async () => {
    const res = await adminAgent
      .patch(`/api/admins/${resellerId}`)
      .send({ username: 'someone-else' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ errors: { username: 'username cannot be changed after creation' } });
    expect(adminsByUsername[resellerUsername]).toBeDefined();
  });

  test('6c. updating email via PATCH succeeds and is reflected in subsequent reads', async () => {
    const res = await adminAgent
      .patch(`/api/admins/${resellerId}`)
      .send({ email: 'reseller-updated@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.email).toBe('reseller-updated@example.com');

    const getRes = await adminAgent.get(`/api/admins/${resellerId}`);
    expect(getRes.body.email).toBe('reseller-updated@example.com');
  });

  test('6d. updating email to one already in use is rejected with 409', async () => {
    const takenEmail = 'someone-else@example.com';
    adminsByEmail[takenEmail] = { id: 999999 };

    const res = await adminAgent.patch(`/api/admins/${resellerId}`).send({ email: takenEmail });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Email already exists' });

    delete adminsByEmail[takenEmail];
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

  test('10. renew with a custom future date resets status to active and clears expired_at', async () => {
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const res = await adminAgent.patch(`/api/admins/${resellerId}/renew`).send({ expires_at: futureDate });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.expired_at).toBeNull();
    expect(new Date(res.body.expires_at).toISOString()).toBe(futureDate);
  });

  test('11. renew with no body defaults expires_at to ~6 months out', async () => {
    const res = await adminAgent.patch(`/api/admins/${resellerId}/renew`).send({});

    expect(res.status).toBe(200);
    expect(monthsFromNowCloseTo(res.body.expires_at, 6)).toBe(true);
  });

  test('12. renewing a non-existent reseller returns 404', async () => {
    const res = await adminAgent.patch('/api/admins/999999/renew').send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Reseller not found' });
  });

  let resellerAgent;

  test('13. login as that reseller with the NEW password succeeds', async () => {
    resellerAgent = request.agent(app);

    const res = await resellerAgent
      .post('/api/auth/login')
      .send({ username: resellerUsername, password: newResellerPassword });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('reseller');
  });

  test('14. as the reseller, GET /api/admins is forbidden', async () => {
    const res = await resellerAgent.get('/api/admins');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Admin access required' });
  });

  test('15. as the reseller, DELETE /api/admins/:id is forbidden', async () => {
    const res = await resellerAgent.delete(`/api/admins/${resellerId}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Admin access required' });
  });

  test('16. deleting a non-existent reseller returns 404', async () => {
    const res = await adminAgent.delete('/api/admins/999999');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Reseller not found' });
  });

  test('17. as admin, delete the reseller', async () => {
    const res = await adminAgent.delete(`/api/admins/${resellerId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Reseller deleted successfully' });
  });

  test('18. the deleted reseller no longer appears', async () => {
    const res = await adminAgent.get(`/api/admins/${resellerId}`);

    expect(res.status).toBe(404);
  });
});
