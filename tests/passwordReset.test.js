const request = require('supertest');
const { resetRateLimitStores } = require('./helpers/resetRateLimits');

jest.mock('../models/adminModel');
jest.mock('../models/passwordResetModel');
jest.mock('../models/auditLogModel');
jest.mock('../utils/mailer');

const adminModel = require('../models/adminModel');
const passwordResetModel = require('../models/passwordResetModel');
const auditLogModel = require('../models/auditLogModel');
const mailer = require('../utils/mailer');
const app = require('../index');

const GENERIC_MESSAGE =
  "If that email is associated with an account, we've sent a link to reset the password.";

const TEST_ADMIN = {
  id: 42,
  username: 'reseller1',
  email: 'reseller1@example.com',
  password_hash: 'irrelevant-for-these-tests',
  role: 'reseller',
};

// resetPasswordLimiter is IP-only (no per-identity key, since reset tokens
// carry no user-facing identifier of their own), so every test below that
// hits POST /api/auth/reset-password shares one bucket - without this reset,
// tests past the 3rd in that describe block would get 429s instead of the
// status codes they're actually asserting on.
beforeEach(async () => {
  await resetRateLimitStores();
});

describe('POST /api/auth/forgot-password', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mailer.sendMail.mockResolvedValue(undefined);
  });

  test('known email creates a reset token and emails a reset link, with the generic message', async () => {
    adminModel.findAdminByEmail.mockResolvedValue(TEST_ADMIN);
    passwordResetModel.createPasswordReset.mockResolvedValue(1);

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'known-1@example.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: GENERIC_MESSAGE });
    expect(passwordResetModel.createPasswordReset).toHaveBeenCalledWith(
      expect.objectContaining({ adminId: TEST_ADMIN.id })
    );
    expect(mailer.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: TEST_ADMIN.email,
        subject: expect.stringContaining('Reset'),
        text: expect.stringContaining('/reset-password?token='),
      })
    );
  });

  test('unknown email returns the identical 200 response and never creates a token or sends an email', async () => {
    adminModel.findAdminByEmail.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'unknown-1@example.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: GENERIC_MESSAGE });
    expect(passwordResetModel.createPasswordReset).not.toHaveBeenCalled();
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  test('a failure sending the email still returns the generic 200 (never reveals internal state)', async () => {
    adminModel.findAdminByEmail.mockResolvedValue(TEST_ADMIN);
    passwordResetModel.createPasswordReset.mockResolvedValue(1);
    mailer.sendMail.mockRejectedValue(new Error('SMTP connection refused'));

    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'known-2@example.com' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: GENERIC_MESSAGE });
  });

  test('invalid email format returns 400', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'not-an-email' });

    expect(res.status).toBe(400);
    expect(adminModel.findAdminByEmail).not.toHaveBeenCalled();
  });

  test('a 4th request for the same email within the window is rate-limited', async () => {
    adminModel.findAdminByEmail.mockResolvedValue(null);
    const email = 'rate-limited@example.com';

    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).post('/api/auth/forgot-password').send({ email });
      expect(res.status).toBe(200);
    }

    const res = await request(app).post('/api/auth/forgot-password').send({ email });
    expect(res.status).toBe(429);
  });

  test('requesting a new token invalidates any previously issued, unused token for that admin', async () => {
    adminModel.findAdminByEmail.mockResolvedValue(TEST_ADMIN);
    passwordResetModel.createPasswordReset.mockResolvedValue(1);

    await request(app).post('/api/auth/forgot-password').send({ email: 'known-invalidate@example.com' });
    expect(passwordResetModel.invalidateUnusedResetsForAdmin).toHaveBeenNthCalledWith(1, TEST_ADMIN.id);

    await request(app).post('/api/auth/forgot-password').send({ email: 'known-invalidate@example.com' });
    expect(passwordResetModel.invalidateUnusedResetsForAdmin).toHaveBeenNthCalledWith(2, TEST_ADMIN.id);

    // Invalidation always runs before the new token is created, never after.
    expect(passwordResetModel.invalidateUnusedResetsForAdmin.mock.invocationCallOrder[1]).toBeLessThan(
      passwordResetModel.createPasswordReset.mock.invocationCallOrder[1]
    );
  });
});

describe('POST /api/auth/reset-password', () => {
  const RAW_TOKEN = 'a-raw-token-value';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('valid, unused, unexpired token updates the password and consumes the token', async () => {
    passwordResetModel.findPasswordResetByTokenHash.mockResolvedValue({
      id: 7,
      admin_id: TEST_ADMIN.id,
      used_at: null,
      expires_at: new Date(Date.now() + 30 * 60 * 1000),
    });
    adminModel.updatePasswordById.mockResolvedValue(true);
    adminModel.findAdminById.mockResolvedValue(TEST_ADMIN);
    mailer.sendMail.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: RAW_TOKEN, password: 'BrandNewPassword123!' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Password updated.' });
    expect(adminModel.updatePasswordById).toHaveBeenCalledWith(TEST_ADMIN.id, expect.any(String));
    expect(passwordResetModel.markPasswordResetUsed).toHaveBeenCalledWith(7);

    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(mailer.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: TEST_ADMIN.email }));
    expect(auditLogModel.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: TEST_ADMIN.id, action: 'password_reset_completed' })
    );
  });

  test('a weak new password is rejected even with a valid token, and the password is left unchanged', async () => {
    passwordResetModel.findPasswordResetByTokenHash.mockResolvedValue({
      id: 10,
      admin_id: TEST_ADMIN.id,
      used_at: null,
      expires_at: new Date(Date.now() + 30 * 60 * 1000),
    });

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: RAW_TOKEN, password: 'short1!' });

    expect(res.status).toBe(400);
    expect(adminModel.updatePasswordById).not.toHaveBeenCalled();
    expect(passwordResetModel.markPasswordResetUsed).not.toHaveBeenCalled();
  });

  test('unknown token is rejected with 400 and no password change', async () => {
    passwordResetModel.findPasswordResetByTokenHash.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'does-not-exist', password: 'whatever123' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'This reset link is invalid or has expired.' });
    expect(adminModel.updatePasswordById).not.toHaveBeenCalled();
  });

  test('already-used token is rejected with 400', async () => {
    passwordResetModel.findPasswordResetByTokenHash.mockResolvedValue({
      id: 8,
      admin_id: TEST_ADMIN.id,
      used_at: new Date(),
      expires_at: new Date(Date.now() + 30 * 60 * 1000),
    });

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: RAW_TOKEN, password: 'whatever123' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'This reset link is invalid or has expired.' });
    expect(adminModel.updatePasswordById).not.toHaveBeenCalled();
  });

  test('expired token is rejected with 400', async () => {
    passwordResetModel.findPasswordResetByTokenHash.mockResolvedValue({
      id: 9,
      admin_id: TEST_ADMIN.id,
      used_at: null,
      expires_at: new Date(Date.now() - 60 * 1000),
    });

    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: RAW_TOKEN, password: 'whatever123' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'This reset link is invalid or has expired.' });
    expect(adminModel.updatePasswordById).not.toHaveBeenCalled();
  });

  test('missing token or password returns 400', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({ password: 'whatever123' });

    expect(res.status).toBe(400);
    expect(passwordResetModel.findPasswordResetByTokenHash).not.toHaveBeenCalled();
  });
});
