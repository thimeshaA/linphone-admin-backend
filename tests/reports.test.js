const request = require('supertest');
const { TEST_ADMIN_PASSWORD, TEST_ADMIN, hashOf } = require('./helpers/fixtures');

jest.mock('../models/reportsModel');
jest.mock('../models/adminModel');
jest.mock('../utils/mailer');

const reportsModel = require('../models/reportsModel');
const adminModel = require('../models/adminModel');
const app = require('../index');

const TEST_RESELLER_PASSWORD = 'ResellerPass123!';
const TEST_RESELLER = {
  id: 42,
  username: 'testreseller_reports',
  email: 'reseller-reports@example.com',
  password_hash: hashOf(TEST_RESELLER_PASSWORD),
  role: 'reseller',
  status: 'active',
  created_at: new Date('2024-01-01T00:00:00Z'),
};

function pdfBuffer(res) {
  return Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.text || '', 'binary');
}

describe('Reports', () => {
  const adminAgent = request.agent(app);
  const resellerAgent = request.agent(app);

  beforeAll(() => {
    adminModel.findAdminByUsername.mockImplementation(async (identifier) => {
      if (identifier === TEST_ADMIN.username) return TEST_ADMIN;
      if (identifier === TEST_RESELLER.username) return TEST_RESELLER;
      return null;
    });

    adminModel.findAdminUsernamesByIds.mockImplementation(async (ids) => {
      const map = {};
      if (ids.includes(TEST_RESELLER.id)) map[TEST_RESELLER.id] = TEST_RESELLER.username;
      return map;
    });

    adminModel.listResellers.mockResolvedValue([
      { id: TEST_RESELLER.id, username: TEST_RESELLER.username, role: 'reseller', status: 'active' },
    ]);

    reportsModel.getAccountStats.mockResolvedValue({
      total: 10,
      active: 6,
      disabled: 2,
      expired: 2,
      created_in_period: 3,
      renewed_in_period: 1,
    });
    reportsModel.getAccountCountsByReseller.mockResolvedValue([{ creatorId: TEST_RESELLER.id, count: 3 }]);
    reportsModel.getResellerStats.mockResolvedValue({
      total: 5,
      active: 4,
      disabled: 1,
      expired: 0,
      created_in_period: 2,
    });
    reportsModel.getResellerAccountAssignments.mockResolvedValue([
      { creatorId: TEST_RESELLER.id, total: 3, active: 2, disabled: 1 },
    ]);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks wipes call history only; re-wire the implementations lost
    // between test files is unnecessary since mockImplementation/mockResolvedValue
    // set in beforeAll survive clearAllMocks (only mock.calls are reset).
  });

  test('1. login as admin', async () => {
    const res = await adminAgent
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
  });

  test('2. login as reseller', async () => {
    const res = await resellerAgent
      .post('/api/auth/login')
      .send({ username: TEST_RESELLER.username, password: TEST_RESELLER_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('reseller');
  });

  describe('GET /api/reports/accounts', () => {
    test('3. admin: monthly report succeeds with correct PDF headers and includes the per-reseller breakdown', async () => {
      const res = await adminAgent.get('/api/reports/accounts?period=monthly&month=2026-08');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/pdf/);
      expect(res.headers['content-disposition']).toBe('attachment; filename="account-report-2026-08.pdf"');
      expect(pdfBuffer(res).slice(0, 4).toString()).toBe('%PDF');

      expect(reportsModel.getAccountStats).toHaveBeenCalledWith({}, new Date(2026, 7, 1), new Date(2026, 8, 1));
      expect(reportsModel.getAccountCountsByReseller).toHaveBeenCalledWith(new Date(2026, 7, 1), new Date(2026, 8, 1));
    });

    test('4. admin: annual report succeeds with a year-based filename', async () => {
      const res = await adminAgent.get('/api/reports/accounts?period=annual&year=2026');

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe('attachment; filename="account-report-2026.pdf"');
      expect(reportsModel.getAccountStats).toHaveBeenCalledWith({}, new Date(2026, 0, 1), new Date(2027, 0, 1));
    });

    test('5. reseller: monthly report succeeds, scoped to their own creator_id, with no per-reseller breakdown fetched', async () => {
      const res = await resellerAgent.get('/api/reports/accounts?period=monthly&month=2026-08');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/pdf/);
      expect(res.headers['content-disposition']).toBe('attachment; filename="account-report-2026-08.pdf"');
      expect(pdfBuffer(res).slice(0, 4).toString()).toBe('%PDF');

      expect(reportsModel.getAccountStats).toHaveBeenCalledWith(
        { creator_id: TEST_RESELLER.id },
        new Date(2026, 7, 1),
        new Date(2026, 8, 1)
      );
      expect(reportsModel.getAccountCountsByReseller).not.toHaveBeenCalled();
    });

    test('6. reseller: annual report also succeeds', async () => {
      const res = await resellerAgent.get('/api/reports/accounts?period=annual&year=2026');
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe('attachment; filename="account-report-2026.pdf"');
    });

    test('7. missing period is rejected with 400', async () => {
      const res = await adminAgent.get('/api/reports/accounts');
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    test('8. invalid period value is rejected with 400', async () => {
      const res = await adminAgent.get('/api/reports/accounts?period=weekly&month=2026-08');
      expect(res.status).toBe(400);
    });

    test('9. monthly without month is rejected with 400', async () => {
      const res = await adminAgent.get('/api/reports/accounts?period=monthly');
      expect(res.status).toBe(400);
    });

    test('10. annual with a malformed year is rejected with 400', async () => {
      const res = await adminAgent.get('/api/reports/accounts?period=annual&year=abcd');
      expect(res.status).toBe(400);
    });

    test('11. unauthenticated request is rejected with 401', async () => {
      const res = await request(app).get('/api/reports/accounts?period=monthly&month=2026-08');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/reports/resellers', () => {
    test('12. admin: monthly report succeeds with correct PDF headers', async () => {
      const res = await adminAgent.get('/api/reports/resellers?period=monthly&month=2026-08');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/pdf/);
      expect(res.headers['content-disposition']).toBe('attachment; filename="reseller-report-2026-08.pdf"');
      expect(pdfBuffer(res).slice(0, 4).toString()).toBe('%PDF');

      expect(reportsModel.getResellerStats).toHaveBeenCalledWith(new Date(2026, 7, 1), new Date(2026, 8, 1));
      expect(adminModel.listResellers).toHaveBeenCalled();
      expect(reportsModel.getResellerAccountAssignments).toHaveBeenCalled();
    });

    test('13. admin: annual report succeeds with a year-based filename', async () => {
      const res = await adminAgent.get('/api/reports/resellers?period=annual&year=2026');
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe('attachment; filename="reseller-report-2026.pdf"');
    });

    test('14. reseller: forbidden with 403', async () => {
      const res = await resellerAgent.get('/api/reports/resellers?period=monthly&month=2026-08');
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Admin access required' });
    });

    test('15. missing period is rejected with 400 even for admin', async () => {
      const res = await adminAgent.get('/api/reports/resellers');
      expect(res.status).toBe(400);
    });
  });
});
