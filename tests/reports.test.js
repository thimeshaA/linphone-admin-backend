const request = require('supertest');
const { TEST_ADMIN_PASSWORD, TEST_ADMIN, hashOf } = require('./helpers/fixtures');

jest.mock('../models/reportsModel');
jest.mock('../models/adminModel');
jest.mock('../models/walletLedgerModel');
jest.mock('../utils/mailer');

const reportsModel = require('../models/reportsModel');
const adminModel = require('../models/adminModel');
const walletLedgerModel = require('../models/walletLedgerModel');
const pdfReport = require('../utils/pdfReport');
const app = require('../index');

// pdfkit deflates its content streams by default, so a raw byte-search for a
// leaked string on the response body would never find it either way (false
// confidence, not a real check) - spy on the renderer instead and inspect the
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

const OTHER_RESELLER_ID = 43;

function pdfBuffer(res) {
  return Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.text || '', 'binary');
}

// Backs the billing section (Phase 5): a fake wallet_ledger/invoices table so
// the mocked model functions can compute real aggregates from real rows,
// rather than just returning canned totals - that's what lets the tests below
// actually catch the section reporting the wrong figures.
const LEDGER_ENTRIES = [
  // Within the Aug 2026 report period, for TEST_RESELLER.
  { id: 1, reseller_id: TEST_RESELLER.id, type: 'initial_credit', amount_usd: 100, created_at: new Date('2026-08-01T00:00:00Z') },
  { id: 2, reseller_id: TEST_RESELLER.id, type: 'admin_topup', amount_usd: 50, created_at: new Date('2026-08-10T00:00:00Z') },
  {
    id: 3,
    reseller_id: TEST_RESELLER.id,
    type: 'renewal_deduction',
    amount_usd: -30,
    account_sip_id: 'user1@sip.example.com',
    created_at: new Date('2026-08-15T00:00:00Z'),
  },
  // Before the period - must count toward "balance at period end" but not
  // toward the period's own credited/deducted totals.
  { id: 4, reseller_id: TEST_RESELLER.id, type: 'initial_credit', amount_usd: 10, created_at: new Date('2026-07-01T00:00:00Z') },
  // A second reseller, within the period - only shows up in platform-wide figures.
  { id: 5, reseller_id: OTHER_RESELLER_ID, type: 'renewal_deduction', amount_usd: -5, created_at: new Date('2026-08-08T00:00:00Z') },
];

function scopedRows(rows, scopeFilter) {
  if (scopeFilter && scopeFilter.creator_id !== undefined) {
    return rows.filter((r) => r.reseller_id === scopeFilter.creator_id);
  }
  return rows;
}

function groupSum(rows, keyFn) {
  const totals = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    totals.set(key, (totals.get(key) || 0) + row.amount_usd);
  });
  return totals;
}

function wireBillingMocks() {
  walletLedgerModel.getLedgerTotalsByType.mockImplementation(async (scopeFilter, start, end) => {
    const rows = scopedRows(LEDGER_ENTRIES, scopeFilter).filter((r) => r.created_at >= start && r.created_at < end);
    const totals = groupSum(rows, (r) => r.type);
    return [...totals.entries()].map(([type, total]) => ({ type, total }));
  });

  walletLedgerModel.getBalanceAsOf.mockImplementation(async (scopeFilter, asOf) => {
    const rows = scopedRows(LEDGER_ENTRIES, scopeFilter).filter((r) => r.created_at < asOf);
    return rows.reduce((sum, r) => sum + r.amount_usd, 0);
  });

  walletLedgerModel.getLedgerTotalsByTypeAndReseller.mockImplementation(async (start, end) => {
    const rows = LEDGER_ENTRIES.filter((r) => r.created_at >= start && r.created_at < end);
    const totals = groupSum(rows, (r) => `${r.reseller_id}:${r.type}`);
    return [...totals.entries()].map(([key, total]) => {
      const [resellerId, type] = key.split(':');
      return { reseller_id: Number(resellerId), type, total };
    });
  });

  walletLedgerModel.getBalancesAsOfByReseller.mockImplementation(async (asOf) => {
    const rows = LEDGER_ENTRIES.filter((r) => r.created_at < asOf);
    const totals = groupSum(rows, (r) => r.reseller_id);
    return [...totals.entries()].map(([resellerId, balance]) => ({ reseller_id: resellerId, balance }));
  });

  // Backs the billing statement table - real ledger rows, oldest first,
  // exactly like the real `ORDER BY created_at ASC, id ASC` query.
  walletLedgerModel.getLedgerEntriesInPeriod.mockImplementation(async (scopeFilter, start, end) =>
    scopedRows(LEDGER_ENTRIES, scopeFilter)
      .filter((r) => r.created_at >= start && r.created_at < end)
      .slice()
      .sort((a, b) => a.created_at - b.created_at || a.id - b.id)
  );
}

function billingStat(sections, label) {
  const billing = sections.find((s) => s.title === 'Billing');
  return billing.stats.find((s) => s.label === label).value;
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
    reportsModel.getAccountCreationCounts.mockResolvedValue([]);

    wireBillingMocks();
  });

  beforeEach(() => {
    // clearAllMocks wipes call history only; mockImplementation/mockResolvedValue
    // set in beforeAll survive it (only mockReset/mockRestore remove those).
    jest.clearAllMocks();
  });

  afterEach(() => {
    // A spy created mid-test (spyOnRenderedTables) must never survive past its
    // test even if an assertion above it throws first - otherwise a mocked
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
      expect(res.headers['content-disposition']).toBe('attachment; filename="account-report-platform-2026-08.pdf"');
      expect(pdfBuffer(res).slice(0, 4).toString()).toBe('%PDF');

      expect(reportsModel.getAccountRows).toHaveBeenCalledWith({}, new Date(2026, 7, 1), new Date(2026, 8, 1));
      expect(adminModel.findAdminUsernamesByIds).toHaveBeenCalledWith([TEST_RESELLER.id]);
    });

    test('4. admin: annual report succeeds with a year-based filename', async () => {
      const res = await adminAgent.get('/api/reports/accounts?period=annual&year=2026');

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe('attachment; filename="account-report-platform-2026.pdf"');
      expect(reportsModel.getAccountRows).toHaveBeenCalledWith({}, new Date(2026, 0, 1), new Date(2027, 0, 1));
    });

    test('5. reseller: monthly report succeeds, scoped to their own creator_id, no username lookup performed', async () => {
      const res = await resellerAgent.get('/api/reports/accounts?period=monthly&month=2026-08');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/pdf/);
      expect(res.headers['content-disposition']).toBe('attachment; filename="account-report-testresellerreports-2026-08.pdf"');
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
      expect(res.headers['content-disposition']).toBe('attachment; filename="account-report-testresellerreports-2026.pdf"');
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
      expect(res.headers['content-disposition']).toBe('attachment; filename="reseller-report-platform-2026-08.pdf"');
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
      expect(res.headers['content-disposition']).toBe('attachment; filename="reseller-report-platform-2026.pdf"');
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

  // Phase 5 (and its later real-records rework): the billing section on both
  // reports, checked against the fake wallet_ledger rows in LEDGER_ENTRIES
  // above rather than against canned totals - so a wrong period boundary or
  // a mixed-up credited/deducted category would actually fail these.
  // "Amount Owed" is now derived from wallet_ledger itself (as of "now", not
  // the wallets.balance_usd snapshot column) - both TEST_RESELLER and
  // OTHER_RESELLER's ledger entries here are all in the past relative to
  // whenever this suite runs, so "as of now" and "as of period end" agree
  // unless a test adds later activity.
  describe('Billing section', () => {
    test("18. reseller's own account report shows only their figures for the period", async () => {
      const spy = spyOnRenderedTables();
      const res = await resellerAgent.get('/api/reports/accounts?period=monthly&month=2026-08');
      expect(res.status).toBe(200);

      const [, options] = spy.mock.calls[0];
      expect(billingStat(options.sections, 'Wallet Balance (Period End)')).toBe('$130.00');
      expect(billingStat(options.sections, 'Total Credited')).toBe('$150.00');
      expect(billingStat(options.sections, 'Total Deducted')).toBe('$30.00');
      // TEST_RESELLER's ledger balance is +$130 (net credit), so they owe
      // nothing - unlike the old wallets.balance_usd-based figure, which
      // could disagree with the ledger and was never checked here for it.
      expect(billingStat(options.sections, 'Amount Owed')).toBe('$0.00');
    });

    test("19. admin's platform-wide account report rolls up every reseller's figures for the period", async () => {
      const spy = spyOnRenderedTables();
      const res = await adminAgent.get('/api/reports/accounts?period=monthly&month=2026-08');
      expect(res.status).toBe(200);

      const [, options] = spy.mock.calls[0];
      expect(billingStat(options.sections, 'Wallet Balance (Period End)')).toBe('$125.00');
      expect(billingStat(options.sections, 'Total Credited')).toBe('$150.00');
      expect(billingStat(options.sections, 'Total Deducted')).toBe('$35.00');
      // Platform-wide owed sums only resellers actually in debt (OTHER_RESELLER's
      // $5) - it must never net TEST_RESELLER's +$130 credit against that debt.
      expect(billingStat(options.sections, 'Amount Owed')).toBe('$5.00');
    });

    test('20. reseller report breaks billing figures out per reseller, plus a platform total row that matches the account report platform figures', async () => {
      adminModel.listResellers.mockResolvedValueOnce([
        {
          id: TEST_RESELLER.id,
          username: TEST_RESELLER.username,
          email: TEST_RESELLER.email,
          status: 'active',
          created_at: new Date('2024-01-01T00:00:00Z'),
          expires_at: new Date('2027-01-01T00:00:00Z'),
          expired_at: null,
        },
        {
          id: OTHER_RESELLER_ID,
          username: 'other_reseller',
          email: 'other@example.com',
          status: 'active',
          created_at: new Date('2024-01-01T00:00:00Z'),
          expires_at: new Date('2027-01-01T00:00:00Z'),
          expired_at: null,
        },
      ]);
      const spy = spyOnRenderedTables();

      const res = await adminAgent.get('/api/reports/resellers?period=monthly&month=2026-08');
      expect(res.status).toBe(200);

      const [, options] = spy.mock.calls[0];
      const billing = options.sections.find((s) => s.title === 'Billing');
      const rowFor = (label) => billing.rows.find((r) => r.reseller === label);

      expect(rowFor(TEST_RESELLER.username)).toMatchObject({
        balance_period_end: '$130.00',
        credited: '$150.00',
        deducted: '$30.00',
        owed: '$0.00',
      });

      expect(rowFor('other_reseller')).toMatchObject({
        balance_period_end: '-$5.00', // sign belongs outside the currency symbol, not "$-5.00"
        credited: '$0.00',
        deducted: '$5.00',
        owed: '$5.00',
      });

      expect(rowFor('Platform Total')).toMatchObject({
        balance_period_end: '$125.00',
        credited: '$150.00',
        deducted: '$35.00',
        owed: '$5.00',
      });
    });
  });

  // The billing statement is a real itemized ledger, not just the
  // pre-aggregated KPIs/table above - every row here should be traceable
  // back to an actual LEDGER_ENTRIES fixture row, in chronological order,
  // with a running balance that ends at exactly the KPI's period-end figure.
  describe('Billing statement', () => {
    function statementSection(sections) {
      return sections.find((s) => s.title === 'Billing Statement');
    }

    test("21. reseller's own statement lists only their own entries, oldest first, with a running balance and no reseller column", async () => {
      const spy = spyOnRenderedTables();
      const res = await resellerAgent.get('/api/reports/accounts?period=monthly&month=2026-08');
      expect(res.status).toBe(200);

      const [, options] = spy.mock.calls[0];
      const statement = statementSection(options.sections);
      expect(statement.columns.some((c) => c.key === 'reseller')).toBe(false);

      // Opening balance (the July $10 initial_credit, before this period)
      // rolls forward through each of TEST_RESELLER's three August entries.
      expect(statement.rows).toEqual([
        { date: '2026-08-01', type: 'Initial Credit', description: '-', amount: '+$100.00', balance: '$110.00' },
        { date: '2026-08-10', type: 'Top-Up', description: '-', amount: '+$50.00', balance: '$160.00' },
        {
          date: '2026-08-15',
          type: 'Renewal Deduction',
          description: 'user1@sip.example.com',
          amount: '-$30.00',
          balance: '$130.00',
        },
      ]);
      // The statement's own ending balance matches the KPI right above it.
      expect(statement.rows.at(-1).balance).toBe(billingStat(options.sections, 'Wallet Balance (Period End)'));
    });

    test("22. admin's platform-wide statement interleaves every reseller's entries chronologically, each with its own running balance and a reseller column", async () => {
      const spy = spyOnRenderedTables();
      const res = await adminAgent.get('/api/reports/accounts?period=monthly&month=2026-08');
      expect(res.status).toBe(200);

      const [, options] = spy.mock.calls[0];
      const statement = statementSection(options.sections);
      expect(statement.columns.some((c) => c.key === 'reseller')).toBe(true);

      expect(statement.rows).toEqual([
        {
          date: '2026-08-01',
          reseller: TEST_RESELLER.username,
          type: 'Initial Credit',
          description: '-',
          amount: '+$100.00',
          balance: '$110.00',
        },
        {
          // OTHER_RESELLER has no username in the mocked lookup, and no
          // opening balance before the period - both fall back correctly.
          date: '2026-08-08',
          reseller: `Reseller #${OTHER_RESELLER_ID}`,
          type: 'Renewal Deduction',
          description: '-',
          amount: '-$5.00',
          balance: '-$5.00',
        },
        {
          date: '2026-08-10',
          reseller: TEST_RESELLER.username,
          type: 'Top-Up',
          description: '-',
          amount: '+$50.00',
          balance: '$160.00',
        },
        {
          date: '2026-08-15',
          reseller: TEST_RESELLER.username,
          type: 'Renewal Deduction',
          description: 'user1@sip.example.com',
          amount: '-$30.00',
          balance: '$130.00',
        },
      ]);
    });

    test('23. a period with no ledger activity still renders a statement section, empty rather than absent', async () => {
      const spy = spyOnRenderedTables();
      const res = await resellerAgent.get('/api/reports/accounts?period=monthly&month=2025-01');
      expect(res.status).toBe(200);

      const [, options] = spy.mock.calls[0];
      expect(statementSection(options.sections).rows).toEqual([]);
    });

    test("24. the reseller report's platform-wide statement matches the account report's platform statement", async () => {
      const spy = spyOnRenderedTables();
      const res = await adminAgent.get('/api/reports/resellers?period=monthly&month=2026-08');
      expect(res.status).toBe(200);

      const [, options] = spy.mock.calls[0];
      expect(statementSection(options.sections).rows).toHaveLength(4);
    });
  });
});
