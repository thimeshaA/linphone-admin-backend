const request = require('supertest');
const jwt = require('jsonwebtoken');
const { TEST_ADMIN_PASSWORD, TEST_ADMIN, hashOf } = require('./helpers/fixtures');
const { resetRateLimitStores } = require('./helpers/resetRateLimits');

jest.mock('../models/adminModel');
jest.mock('../models/auditLogModel');
jest.mock('../utils/mailer');

const adminModel = require('../models/adminModel');
const auditLogModel = require('../models/auditLogModel');
const mailer = require('../utils/mailer');
const app = require('../index');

describe('Auth flow', () => {
  const agent = request.agent(app);

  beforeEach(async () => {
    // Several scenarios below legitimately log in as the same fixture user
    // many times in one file; without this, the loginLimiter (max 3/hour,
    // shared across the whole file's module registry) would start rejecting
    // later tests with 429s meant for actual brute-force abuse.
    await resetRateLimitStores();
    mailer.sendMail.mockResolvedValue(undefined);
  });

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

  test('2b. login with the email instead of the username also succeeds', async () => {
    adminModel.findAdminByUsername.mockImplementation(async (identifier) =>
      identifier === TEST_ADMIN.username || identifier === TEST_ADMIN.email ? TEST_ADMIN : null
    );

    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.email, password: TEST_ADMIN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.username).toBe(TEST_ADMIN.username);
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

    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(mailer.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: TEST_ADMIN.email }));

    expect(auditLogModel.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: TEST_ADMIN.id, actorRole: TEST_ADMIN.role, action: 'password_change' })
    );
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

  test('12. change-password rejects a too-short new password', async () => {
    adminModel.findAdminById.mockResolvedValue(TEST_ADMIN);

    const res = await agent
      .patch('/api/auth/change-password')
      .send({ currentPassword: TEST_ADMIN_PASSWORD, newPassword: 'short1!' });

    expect(res.status).toBe(400);
    expect(adminModel.updatePasswordById).not.toHaveBeenCalled();
  });

  test('13. change-password rejects a too-long new password', async () => {
    adminModel.findAdminById.mockResolvedValue(TEST_ADMIN);

    const res = await agent
      .patch('/api/auth/change-password')
      .send({ currentPassword: TEST_ADMIN_PASSWORD, newPassword: `Aa1!${'x'.repeat(126)}` });

    expect(res.status).toBe(400);
    expect(adminModel.updatePasswordById).not.toHaveBeenCalled();
  });

  test('14. change-password rejects a common/blocklisted new password', async () => {
    adminModel.findAdminById.mockResolvedValue(TEST_ADMIN);

    const res = await agent
      .patch('/api/auth/change-password')
      .send({ currentPassword: TEST_ADMIN_PASSWORD, newPassword: 'password123' });

    expect(res.status).toBe(400);
    expect(adminModel.updatePasswordById).not.toHaveBeenCalled();
  });

  test('15. jwt.verify rejects a token signed with a different algorithm', async () => {
    const forgedToken = jwt.sign(
      { id: TEST_ADMIN.id, username: TEST_ADMIN.username, role: TEST_ADMIN.role, pwc: 0 },
      process.env.JWT_SECRET,
      { algorithm: 'HS384', expiresIn: '1h' }
    );

    const res = await request(app).get('/api/auth/me').set('Cookie', [`token=${forgedToken}`]);

    expect(res.status).toBe(401);
  });

  test('16. login is blocked after 3 consecutive failed attempts, and recovers once the lock window passes', async () => {
    const lockableAdmin = { ...TEST_ADMIN, failed_login_attempts: 0, locked_until: null };
    adminModel.findAdminByUsername.mockImplementation(async () => lockableAdmin);
    adminModel.recordFailedLogin.mockImplementation(async (id, { attempts, lockedUntil }) => {
      lockableAdmin.failed_login_attempts = attempts;
      lockableAdmin.locked_until = lockedUntil;
    });
    adminModel.clearLoginLockout.mockImplementation(async () => {
      lockableAdmin.failed_login_attempts = 0;
      lockableAdmin.locked_until = null;
    });

    for (let i = 0; i < 3; i += 1) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: TEST_ADMIN.username, password: 'WrongPassword!' });
      expect(res.status).toBe(401);
    }

    expect(lockableAdmin.locked_until).not.toBeNull();

    // This test is isolating the per-account lockout from the separate
    // IP+username loginLimiter (also exercised below) - reset it so the 4
    // remaining requests here aren't themselves counted as rate-limit abuse.
    await resetRateLimitStores();

    // Even the CORRECT password is blocked while locked.
    const lockedRes = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN_PASSWORD });
    expect(lockedRes.status).toBe(403);
    expect(lockedRes.body.error).toMatch(/temporarily locked/);

    // Recovers once the lock window has passed.
    lockableAdmin.locked_until = new Date(Date.now() - 1000);
    const recoveredRes = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN_PASSWORD });
    expect(recoveredRes.status).toBe(200);
  });

  test('17. a token issued before a password change is rejected after the change; a token issued after still works', async () => {
    adminModel.findAdminByUsername.mockResolvedValue(TEST_ADMIN);
    const firstAgent = request.agent(app);
    const firstLogin = await firstAgent
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN_PASSWORD });
    expect(firstLogin.status).toBe(200);

    // Simulate a password change that completed AFTER this token was issued.
    const changedAt = new Date(Date.now() + 2000);
    adminModel.getPasswordChangedAt.mockResolvedValue(changedAt);

    const afterChange = await firstAgent.get('/api/auth/me');
    expect(afterChange.status).toBe(401);

    // A token issued (i.e. logged in) with that same changed-at value baked
    // in still works - it isn't stale relative to the change.
    adminModel.findAdminByUsername.mockResolvedValue({ ...TEST_ADMIN, password_changed_at: changedAt });
    const secondAgent = request.agent(app);
    const secondLogin = await secondAgent
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN_PASSWORD });
    expect(secondLogin.status).toBe(200);

    const stillWorks = await secondAgent.get('/api/auth/me');
    expect(stillWorks.status).toBe(200);
  });

  test('18. a 4th login attempt for the same username within the window is rate-limited', async () => {
    adminModel.findAdminByUsername.mockResolvedValue(null);
    const username = 'rate-limited-login-user';

    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).post('/api/auth/login').send({ username, password: 'whatever123' });
      expect(res.status).toBe(401);
    }

    const res = await request(app).post('/api/auth/login').send({ username, password: 'whatever123' });
    expect(res.status).toBe(429);
  });

  test('19. successful logins do not count toward the login rate limit - only failed attempts do', async () => {
    adminModel.findAdminByUsername.mockResolvedValue(TEST_ADMIN);

    // More than MAX_ATTEMPTS (3) successful logins in a row for the same
    // username - none of these should ever trip the limiter.
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: TEST_ADMIN.username, password: TEST_ADMIN_PASSWORD });
      expect(res.status).toBe(200);
    }

    // Failed attempts against the same username still count as usual, and
    // still trip the limiter on the same budget as test 18 above.
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: TEST_ADMIN.username, password: 'WrongPassword!' });
      expect(res.status).toBe(401);
    }
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: 'WrongPassword!' });
    expect(res.status).toBe(429);
  });
});
