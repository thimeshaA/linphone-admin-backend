const request = require('supertest');
const { TEST_ADMIN_PASSWORD, TEST_ADMIN, hashOf } = require('./helpers/fixtures');

jest.mock('../models/adminModel');

const adminModel = require('../models/adminModel');
const app = require('../index');

describe('Auth flow', () => {
  const agent = request.agent(app);

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('1. login with correct credentials succeeds and sets a cookie', async () => {
    adminModel.findAdminByUsername.mockResolvedValue(TEST_ADMIN);

    const res = await agent
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: TEST_ADMIN.id,
      username: TEST_ADMIN.username,
      role: TEST_ADMIN.role,
    });
    expect(res.headers['set-cookie']).toBeDefined();
    expect(res.headers['set-cookie'].some((c) => c.startsWith('token='))).toBe(true);
  });

  test('2. GET /me returns the correct identity for the logged-in admin', async () => {
    const res = await agent.get('/api/auth/me');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: TEST_ADMIN.id,
      username: TEST_ADMIN.username,
      role: TEST_ADMIN.role,
    });
  });

  test('3. login with the wrong password fails with 401', async () => {
    adminModel.findAdminByUsername.mockResolvedValue(TEST_ADMIN);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: 'WrongPassword!' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid username or password' });
  });

  test('4. login with a nonexistent username fails with 401 (same shape as #3)', async () => {
    adminModel.findAdminByUsername.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'doesnotexist', password: 'whatever123' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid username or password' });
  });

  test('5. login as a disabled admin fails with 403', async () => {
    adminModel.findAdminByUsername.mockResolvedValue({ ...TEST_ADMIN, status: 'disabled' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN_PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Account is disabled' });
  });

  test('5b. login as a reseller whose expires_at has passed fails with 403 and flips status to expired', async () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    adminModel.findAdminByUsername.mockResolvedValue({
      ...TEST_ADMIN,
      role: 'reseller',
      status: 'active',
      expires_at: pastDate,
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN_PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Account has expired' });
    expect(adminModel.markResellerExpired).toHaveBeenCalledWith(TEST_ADMIN.id);
  });

  test('5c. login as a reseller with a future expires_at succeeds normally', async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    adminModel.findAdminByUsername.mockResolvedValue({
      ...TEST_ADMIN,
      role: 'reseller',
      status: 'active',
      expires_at: futureDate,
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('reseller');
  });

  test('6. logout succeeds and clears the cookie', async () => {
    const res = await agent.post('/api/auth/logout');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Logged out successfully' });
  });

  test('7. GET /me after logout is 401', async () => {
    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  test('8. change-password with the wrong currentPassword is rejected, password left unchanged', async () => {
    adminModel.findAdminByUsername.mockResolvedValue(TEST_ADMIN);
    const loginRes = await agent
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN_PASSWORD });
    expect(loginRes.status).toBe(200);

    adminModel.findAdminById.mockResolvedValue(TEST_ADMIN);

    const res = await agent
      .patch('/api/auth/change-password')
      .send({ currentPassword: 'WrongCurrent!', newPassword: 'NewPassword456!' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Current password is incorrect' });
    expect(adminModel.updatePasswordById).not.toHaveBeenCalled();
  });

  const NEW_PASSWORD = 'NewPassword456!';

  test('9. change-password with the correct currentPassword succeeds', async () => {
    adminModel.findAdminById.mockResolvedValue(TEST_ADMIN);
    adminModel.updatePasswordById.mockResolvedValue(true);

    const res = await agent
      .patch('/api/auth/change-password')
      .send({ currentPassword: TEST_ADMIN_PASSWORD, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Password changed successfully' });
    expect(adminModel.updatePasswordById).toHaveBeenCalledWith(TEST_ADMIN.id, expect.any(String));
  });

  test('10. logout, then login with the NEW password succeeds', async () => {
    await agent.post('/api/auth/logout');

    // Simulates the DB now holding the hash for NEW_PASSWORD after step 9's update.
    adminModel.findAdminByUsername.mockResolvedValue({
      ...TEST_ADMIN,
      password_hash: hashOf(NEW_PASSWORD),
    });

    const res = await agent
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: NEW_PASSWORD });

    expect(res.status).toBe(200);
  });

  test('11. change-password again to revert back to the original password', async () => {
    adminModel.findAdminById.mockResolvedValue({
      ...TEST_ADMIN,
      password_hash: hashOf(NEW_PASSWORD),
    });
    adminModel.updatePasswordById.mockResolvedValue(true);

    const res = await agent
      .patch('/api/auth/change-password')
      .send({ currentPassword: NEW_PASSWORD, newPassword: TEST_ADMIN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Password changed successfully' });
  });
});
