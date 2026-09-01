const request = require('supertest');
const { TEST_ADMIN_PASSWORD, TEST_ADMIN } = require('./helpers/fixtures');

jest.mock('../models/adminModel');
jest.mock('../models/accountModel');
jest.mock('../utils/mailer');

const adminModel = require('../models/adminModel');
const mailer = require('../utils/mailer');
const app = require('../index');

// In-memory fake tables backing every mocked model function.
let adminsByUsername;
let nextAdminId;

function seedStore() {
  adminsByUsername = { [TEST_ADMIN.username]: TEST_ADMIN };
  nextAdminId = 200;
}

function wireMocks() {
  adminModel.findAdminByUsername.mockImplementation(async (username) => adminsByUsername[username] || null);
  adminModel.findAdminById.mockImplementation(async (id) => {
    const found = Object.values(adminsByUsername).find((a) => a.id === id);
    return found || null;
  });
  adminModel.createReseller.mockImplementation(async ({ username, passwordHash, email }) => {
    const id = nextAdminId++;
    const publicRow = { id, username, role: 'reseller', status: 'active', email, created_at: new Date() };
    adminsByUsername[username] = { ...publicRow, password_hash: passwordHash };
    return { ...publicRow };
  });
}

describe('POST /api/accounts/request (authenticated reseller batch request)', () => {
  const adminAgent = request.agent(app);
  let resellerAgent;
  let resellerNoEmailAgent;

  const resellerUsername = `batchreseller_${Date.now()}`;
  const resellerPassword = 'ResellerPass123!';
  const resellerEmail = 'batchreseller@example.com';

  const resellerNoEmailUsername = `batchresellernoemail_${Date.now()}`;
  const resellerNoEmailPassword = 'ResellerPass456!';

  const validBatch = [
    { name: 'Alice Enduser', email: 'alice@example.com', note: 'Priority customer' },
    { name: 'Bob Enduser', phone: '+94770000002' },
  ];

  beforeAll(async () => {
    seedStore();
    wireMocks();
    mailer.sendMail.mockResolvedValue(undefined);

    const adminLogin = await adminAgent
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN_PASSWORD });
    expect(adminLogin.status).toBe(200);

    const resellerCreate = await adminAgent
      .post('/api/admins')
      .send({ username: resellerUsername, password: resellerPassword, email: resellerEmail });
    expect(resellerCreate.status).toBe(201);

    const resellerNoEmailCreate = await adminAgent
      .post('/api/admins')
      .send({ username: resellerNoEmailUsername, password: resellerNoEmailPassword, email: 'placeholder@example.com' });
    expect(resellerNoEmailCreate.status).toBe(201);
    // Simulate a reseller row with no email on file, without a real DB.
    delete adminsByUsername[resellerNoEmailUsername].email;

    resellerAgent = request.agent(app);
    const resellerLogin = await resellerAgent
      .post('/api/auth/login')
      .send({ username: resellerUsername, password: resellerPassword });
    expect(resellerLogin.status).toBe(200);

    resellerNoEmailAgent = request.agent(app);
    const resellerNoEmailLogin = await resellerNoEmailAgent
      .post('/api/auth/login')
      .send({ username: resellerNoEmailUsername, password: resellerNoEmailPassword });
    expect(resellerNoEmailLogin.status).toBe(200);
  });

  beforeEach(() => {
    mailer.sendMail.mockClear();
    mailer.sendMail.mockResolvedValue(undefined);
  });

  test('rejects an unauthenticated call with 401', async () => {
    const res = await request(app).post('/api/accounts/request').send({ requests: validBatch });

    expect(res.status).toBe(401);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  test('rejects a non-reseller (admin) caller with 403', async () => {
    const res = await adminAgent.post('/api/accounts/request').send({ requests: validBatch });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Reseller access required' });
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  test('as reseller: submitting a batch sends exactly one email to operations, listing every end-user and the requester', async () => {
    const res = await resellerAgent.post('/api/accounts/request').send({ requests: validBatch });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ message: 'Request submitted successfully' });
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(mailer.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'enigma-admin@prometeolk.com',
        replyTo: resellerEmail,
        text: expect.stringContaining('Alice Enduser'),
      })
    );
    const sentText = mailer.sendMail.mock.calls[0][0].text;
    expect(sentText).toContain('Bob Enduser');
    expect(sentText).toContain(resellerUsername);
  });

  test('sends exactly one email regardless of batch size (single entry)', async () => {
    const res = await resellerAgent.post('/api/accounts/request').send({ requests: [validBatch[0]] });

    expect(res.status).toBe(201);
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
  });

  test('sends exactly one email regardless of batch size (five entries)', async () => {
    const bigBatch = Array.from({ length: 5 }, (_, i) => ({
      name: `Bulk Enduser ${i}`,
      email: `bulk${i}@example.com`,
    }));

    const res = await resellerAgent.post('/api/accounts/request').send({ requests: bigBatch });

    expect(res.status).toBe(201);
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
  });

  test('omits Reply-To when the reseller has no email on their admins row', async () => {
    const res = await resellerNoEmailAgent.post('/api/accounts/request').send({ requests: validBatch });

    expect(res.status).toBe(201);
    expect(mailer.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ replyTo: undefined })
    );
  });

  test('rejects an empty requests array with 400 and sends no email', async () => {
    const res = await resellerAgent.post('/api/accounts/request').send({ requests: [] });

    expect(res.status).toBe(400);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  test('rejects a batch entry missing both a name with 400 and sends no email', async () => {
    const res = await resellerAgent
      .post('/api/accounts/request')
      .send({ requests: [{ email: 'noname@example.com' }] });

    expect(res.status).toBe(400);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  test('rejects a batch entry with neither email nor phone with 400 and sends no email', async () => {
    const res = await resellerAgent
      .post('/api/accounts/request')
      .send({ requests: [{ name: 'No Contact' }] });

    expect(res.status).toBe(400);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  test('returns 502 (not a false success) when the operations email fails to send', async () => {
    mailer.sendMail.mockRejectedValue(new Error('SMTP connection refused'));

    const res = await resellerAgent.post('/api/accounts/request').send({ requests: validBatch });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Failed to send request email' });
  });
});
