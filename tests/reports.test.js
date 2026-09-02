const request = require('supertest');
const { TEST_ADMIN_PASSWORD, TEST_ADMIN, hashOf } = require('./helpers/fixtures');

jest.mock('../models/reportsModel');
jest.mock('../models/adminModel');
jest.mock('../utils/mailer');

const reportsModel = require('../models/reportsModel');
const adminModel = require('../models/adminModel');
const pdfReport = require('../utils/pdfReport');
const app = require('../index');

// pdfkit deflates its content streams by default, so a raw byte-search for a
// leaked string on the response body would never find it either way (false
// confidence, not a real check) — spy on the renderer instead and inspect the
// actual row objects the controller handed it.
function spyOnRenderedTables() {
  const spy = jest.spyOn(pdfReport, 'renderReportPdf').mockImplementation((stream) => stream.end());
  return spy;
}

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

function accountRow(overrides) {
  return {
    id: 1,
    authid: 'user1',
    domain: 'sip.example.com',
    email: 'user1@example.com',
    status: 'active',
    created_at: new Date('2026-08-05T00:00:00Z'),
    expires_at: new Date('2027-02-01T00:00:00Z'),
    disabled_at: null,
    expired_at: null,
    renewed_at: null,
    creator_id: TEST_RESELLER.id,
    ...overrides,
  };
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
      {
        id: TEST_RESELLER.id,
        username: TEST_RESELLER.username,
        email: TEST_RESELLER.email,
        status: 'active',
        created_at: new Date('2024-01-01T00:00:00Z'),
        expires_at: new Date('2027-01-01T00:00:00Z'),
        expired_at: null,
      },
    ]);

    reportsModel.getAccountRows.mockResolvedValue([accountRow()]);
  });

  beforeEach(() => {
    // clearAllMocks wipes call history only; mockImplementation/mockResolvedValue
    // set in beforeAll survive it (only mockReset/mockRestore remove those).
    jest.clearAllMocks();
  });

  afterEach(() => {
    // A spy created mid-test (spyOnRenderedTables) must never survive past its
    // test even if an assertion above it throws first — otherwise a mocked
    // renderReportPdf silently leaks into every later test's real PDF checks.
    jest.restoreAllMocks();
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
    test('3. admin: monthly report succeeds, fetches unscoped rows and resolves reseller usernames', async () => {
      const res = await adminAgent.get('/api/reports/accounts?period=monthly&month=2026-08');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/pdf/);
      expect(res.headers['content-disposition']).toBe('attachment; filename="account-report-2026-08.pdf"');
      expect(pdfBuffer(res).slice(0, 4).toString()).toBe('%PDF');

      expect(reportsModel.getAccountRows).toHaveBeenCalledWith({}, new Date(2026, 7, 1), new Date(2026, 8, 1));
      expect(adminModel.findAdminUsernamesByIds).toHaveBeenCalledWith([TEST_RESELLER.id]);
    });

    test('4. admin: annual report succeeds with a year-based filename', async () => {
      const res = await adminAgent.get('/api/reports/accounts?period=annual&year=2026');

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe('attachment; filename="account-report-2026.pdf"');
      expect(reportsModel.getAccountRows).toHaveBeenCalledWith({}, new Date(2026, 0, 1), new Date(2027, 0, 1));
    });

    test('5. reseller: monthly report succeeds, scoped to their own creator_id, no username lookup performed', async () => {
      const res = await resellerAgent.get('/api/reports/accounts?period=monthly&month=2026-08');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/pdf/);
      expect(res.headers['content-disposition']).toBe('attachment; filename="account-report-2026-08.pdf"');
      expect(pdfBuffer(res).slice(0, 4).toString()).toBe('%PDF');

      expect(reportsModel.getAccountRows).toHaveBeenCalledWith(
        { creator_id: TEST_RESELLER.id },
        new Date(2026, 7, 1),
        new Date(2026, 8, 1)
      );
      expect(adminModel.findAdminUsernamesByIds).not.toHaveBeenCalled();
    });

    test('6. reseller: annual report also succeeds', async () => {
      const res = await resellerAgent.get('/api/reports/accounts?period=annual&year=2026');
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe('attachment; filename="account-report-2026.pdf"');
    });

    test('7. password/password_hash never reaches the PDF build even if the row carries it', async () => {
      reportsModel.getAccountRows.mockResolvedValueOnce([
        accountRow({ password: 'should-never-appear', password_hash: 'should-never-appear' }),
      ]);
      const spy = spyOnRenderedTables();

      const res = await adminAgent.get('/api/reports/accounts?period=monthly&month=2026-08');
      expect(res.status).toBe(200);

      const [, options] = spy.mock.calls[0];
      const serialized = JSON.stringify(options.sections);
      expect(serialized).not.toContain('password');
      expect(serialized).not.toContain('should-never-appear');
    });

    test('8. missing period is rejected with 400', async () => {
      const res = await adminAgent.get('/api/reports/accounts');
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    test('9. invalid period value is rejected with 400', async () => {
      const res = await adminAgent.get('/api/reports/accounts?period=weekly&month=2026-08');
      expect(res.status).toBe(400);
    });

    test('10. monthly without month is rejected with 400', async () => {
      const res = await adminAgent.get('/api/reports/accounts?period=monthly');
      expect(res.status).toBe(400);
    });

    test('11. annual with a malformed year is rejected with 400', async () => {
      const res = await adminAgent.get('/api/reports/accounts?period=annual&year=abcd');
      expect(res.status).toBe(400);
    });

    test('12. unauthenticated request is rejected with 401', async () => {
      const res = await request(app).get('/api/reports/accounts?period=monthly&month=2026-08');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/reports/resellers', () => {
    test('13. admin: monthly report succeeds, fetches unscoped account rows for the same period, and resolves reseller usernames for the account detail table', async () => {
      const res = await adminAgent.get('/api/reports/resellers?period=monthly&month=2026-08');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/pdf/);
      expect(res.headers['content-disposition']).toBe('attachment; filename="reseller-report-2026-08.pdf"');
      expect(pdfBuffer(res).slice(0, 4).toString()).toBe('%PDF');

      expect(adminModel.listResellers).toHaveBeenCalledWith();
      expect(reportsModel.getAccountRows).toHaveBeenCalledWith({}, new Date(2026, 7, 1), new Date(2026, 8, 1));
      expect(adminModel.findAdminUsernamesByIds).toHaveBeenCalledWith([TEST_RESELLER.id]);
    });

    test('13b. admin: a reseller with zero accounts in the period still appears with a 0 count, and an account whose reseller no longer exists still appears in the detail table', async () => {
      reportsModel.getAccountRows.mockResolvedValueOnce([accountRow({ id: 2, creator_id: 9999 })]);
      const spy = spyOnRenderedTables();

      const res = await adminAgent.get('/api/reports/resellers?period=monthly&month=2026-08');
      expect(res.status).toBe(200);

      const [, options] = spy.mock.calls[0];
      const resellersSection = options.sections.find((s) => s.title === 'Top Resellers');
      const accountsSection = options.sections.find((s) => s.title === 'Account Detail');
      expect(
        resellersSection.table.rows.find((r) => r.username === TEST_RESELLER.username).accounts_created
      ).toBe(0);
      expect(accountsSection.rows).toHaveLength(1);
      expect(accountsSection.rows[0].created_by).toBe('Reseller #9999');
    });

    test('14. admin: annual report succeeds with a year-based filename', async () => {
      const res = await adminAgent.get('/api/reports/resellers?period=annual&year=2026');
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe('attachment; filename="reseller-report-2026.pdf"');
    });

    test('15. password_hash never reaches the PDF build even if the reseller row carries it', async () => {
      adminModel.listResellers.mockResolvedValueOnce([
        {
          id: TEST_RESELLER.id,
          username: TEST_RESELLER.username,
          email: TEST_RESELLER.email,
          status: 'active',
          created_at: new Date('2024-01-01T00:00:00Z'),
          expires_at: new Date('2027-01-01T00:00:00Z'),
          expired_at: null,
          password_hash: 'should-never-appear',
        },
      ]);
      const spy = spyOnRenderedTables();

      const res = await adminAgent.get('/api/reports/resellers?period=monthly&month=2026-08');
      expect(res.status).toBe(200);

      const [, options] = spy.mock.calls[0];
      const serialized = JSON.stringify(options.sections);
      expect(serialized).not.toContain('password');
      expect(serialized).not.toContain('should-never-appear');
    });

    test('16. reseller: forbidden with 403', async () => {
      const res = await resellerAgent.get('/api/reports/resellers?period=monthly&month=2026-08');
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Admin access required' });
    });

    test('17. missing period is rejected with 400 even for admin', async () => {
      const res = await adminAgent.get('/api/reports/resellers');
      expect(res.status).toBe(400);
    });
  });
});
