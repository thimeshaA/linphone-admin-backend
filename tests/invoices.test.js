const request = require('supertest');
const { TEST_ADMIN_PASSWORD, TEST_ADMIN } = require('./helpers/fixtures');

jest.mock('../models/adminModel');
jest.mock('../models/accountModel');
jest.mock('../models/walletModel');
jest.mock('../models/walletLedgerModel');
jest.mock('../models/invoiceModel');
jest.mock('../models/notificationModel');
jest.mock('../utils/mailer');

const adminModel = require('../models/adminModel');
const accountModel = require('../models/accountModel');
const walletModel = require('../models/walletModel');
const walletLedgerModel = require('../models/walletLedgerModel');
const invoiceModel = require('../models/invoiceModel');
const notificationModel = require('../models/notificationModel');
const mailer = require('../utils/mailer');
const app = require('../index');

// In-memory fake tables backing every mocked model function, so the sequential
// steps below observe consistent state without a real DB. Mirrors the wiring
// style used in wallet.test.js/notifications.test.js.
let adminsByUsername;
let resellersById;
let walletsByResellerId;
let ledgerEntries;
let invoicesById;
let notificationsById;
let nextAdminId;
let nextLedgerId;
let nextInvoiceId;
let nextNotificationId;

function seedStore() {
  adminsByUsername = { [TEST_ADMIN.username]: TEST_ADMIN };
  resellersById = {};
  walletsByResellerId = {};
  ledgerEntries = [];
  invoicesById = {};
  notificationsById = {};
  nextAdminId = 100;
  nextLedgerId = 1;
  nextInvoiceId = 1;
  nextNotificationId = 1;
}

function wireMocks() {
  adminModel.findAdminByUsername.mockImplementation(async (identifier) => adminsByUsername[identifier] || null);
  adminModel.findAdminById.mockImplementation(async (id) =>
    String(id) === String(TEST_ADMIN.id) ? TEST_ADMIN : null
  );
  adminModel.getResellerById.mockImplementation(async (id) => {
    const row = resellersById[id];
    return row ? { ...row } : null;
  });
  adminModel.createReseller.mockImplementation(async ({ username, passwordHash, expiresAt, email }) => {
    const id = nextAdminId++;
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
    return { ...publicRow };
  });

  accountModel.findAccountLabelsByIds.mockImplementation(async (ids) =>
    ids.reduce((map, id) => {
      map[id] = `acct${id}@sip.example.com`;
      return map;
    }, {})
  );

  walletModel.createWallet.mockImplementation(async (resellerId, balanceUsd) => {
    walletsByResellerId[resellerId] = { reseller_id: Number(resellerId), balance_usd: balanceUsd };
  });
  walletModel.adjustWalletBalance.mockImplementation(async (resellerId, deltaUsd) => {
    const wallet = walletsByResellerId[resellerId];
    if (!wallet) return false;
    wallet.balance_usd += deltaUsd;
    return true;
  });

  walletLedgerModel.getUninvoicedRenewalDeductionsInPeriod.mockImplementation(
    async (resellerId, periodStart, periodEnd) =>
      ledgerEntries
        .filter(
          (e) =>
            e.reseller_id === Number(resellerId) &&
            e.type === 'renewal_deduction' &&
            !e.invoiced &&
            e.created_at >= periodStart &&
            e.created_at < periodEnd
        )
        .map((e) => ({ ...e }))
  );

  walletLedgerModel.linkLedgerEntriesToInvoice.mockImplementation(async (ids, invoiceId) => {
    ledgerEntries.forEach((e) => {
      if (ids.includes(e.id)) {
        e.invoiced = 1;
        e.invoice_id = invoiceId;
      }
    });
  });

  walletLedgerModel.getLedgerEntriesForInvoice.mockImplementation(async (invoiceId) =>
    ledgerEntries
      .filter((e) => e.invoice_id === invoiceId && e.type === 'renewal_deduction')
      .map((e) => ({ ...e }))
  );

  invoiceModel.findInvoiceByResellerAndPeriod.mockImplementation(async (resellerId, periodType, periodValue) => {
    const invoice = Object.values(invoicesById).find(
      (inv) =>
        Number(inv.reseller_id) === Number(resellerId) &&
        inv.period_type === periodType &&
        inv.period_value === periodValue
    );
    return invoice ? { ...invoice } : null;
  });

  invoiceModel.createInvoice.mockImplementation(async ({ resellerId, periodType, periodValue, totalAmountUsd }) => {
    const id = nextInvoiceId++;
    const invoice = {
      id,
      reseller_id: Number(resellerId),
      period_type: periodType,
      period_value: periodValue,
      total_amount_usd: totalAmountUsd,
      created_at: new Date(),
      sent_at: null,
    };
    invoicesById[id] = invoice;
    return { ...invoice };
  });

  invoiceModel.getInvoiceById.mockImplementation(async (id, scopeFilter) => {
    const invoice = invoicesById[id];
    if (!invoice) return null;
    if (
      scopeFilter &&
      scopeFilter.creator_id !== undefined &&
      Number(scopeFilter.creator_id) !== Number(invoice.reseller_id)
    ) {
      return null;
    }
    return { ...invoice };
  });

  invoiceModel.listInvoices.mockImplementation(async (scopeFilter, { resellerId, sentOnly } = {}) => {
    let rows = Object.values(invoicesById);
    if (scopeFilter && scopeFilter.creator_id !== undefined) {
      rows = rows.filter((r) => Number(r.reseller_id) === Number(scopeFilter.creator_id));
    }
    if (resellerId) rows = rows.filter((r) => Number(r.reseller_id) === Number(resellerId));
    if (sentOnly) rows = rows.filter((r) => r.sent_at !== null);
    return rows.map((r) => ({ ...r })).sort((a, b) => b.id - a.id);
  });

  invoiceModel.markInvoiceSent.mockImplementation(async (id) => {
    const invoice = invoicesById[id];
    if (invoice) {
      invoice.sent_at = new Date();
    }
  });

  notificationModel.createNotification.mockImplementation(async (recipientId, type, title, message, payload) => {
    const notification = {
      id: nextNotificationId++,
      recipient_id: Number(recipientId),
      type,
      title,
      message,
      payload: payload ?? null,
      read_at: null,
      created_at: new Date(),
    };
    notificationsById[notification.id] = notification;
    return { ...notification };
  });
}

async function createReseller(adminAgent, { username, password, email }) {
  const res = await adminAgent.post('/api/admins').send({ username, password, email });
  expect(res.status).toBe(201);
  return res.body;
}

async function loginAs(username, password) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ username, password });
  expect(res.status).toBe(200);
  return agent;
}

// Bypasses the createLedgerEntry model entirely (it always stamps
// created_at = NOW() in the real DB) so tests can place a deduction into a
// specific period, exactly what generating an invoice needs to filter on.
function seedRenewalDeduction(resellerId, amountUsd, relatedAccountId, createdAt) {
  const entry = {
    id: nextLedgerId++,
    reseller_id: Number(resellerId),
    type: 'renewal_deduction',
    amount_usd: -Math.abs(amountUsd),
    related_account_id: relatedAccountId,
    invoiced: 0,
    invoice_id: null,
    created_by: TEST_ADMIN.id,
    note: null,
    created_at: createdAt,
  };
  ledgerEntries.push(entry);
  return { ...entry };
}

function pdfBuffer(res) {
  return Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.text || '', 'binary');
}

describe('Invoices (Phase 4, corrected)', () => {
  const adminAgent = request.agent(app);
  const resellerPassword = 'ResellerPass123!';

  beforeAll(() => {
    seedStore();
    wireMocks();
    mailer.sendMail.mockResolvedValue(undefined);
  });

  test('login as admin', async () => {
    const res = await adminAgent
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN_PASSWORD });
    expect(res.status).toBe(200);
  });

  describe('generating an invoice for a period', () => {
    let reseller;
    let otherReseller;
    let augEntryOne;
    let augEntryTwo;
    let julEntry;
    let otherResellerAugEntry;

    beforeAll(async () => {
      reseller = await createReseller(adminAgent, {
        username: `inv_gen_${Date.now()}`,
        password: resellerPassword,
        email: `inv_gen_${Date.now()}@example.com`,
      });
      otherReseller = await createReseller(adminAgent, {
        username: `inv_gen_other_${Date.now()}`,
        password: resellerPassword,
        email: `inv_gen_other_${Date.now()}@example.com`,
      });

      augEntryOne = seedRenewalDeduction(reseller.id, 10, 1, new Date(2026, 7, 5));
      augEntryTwo = seedRenewalDeduction(reseller.id, 15, 2, new Date(2026, 7, 20));
      // Outside the August period entirely - must never be pulled into it.
      julEntry = seedRenewalDeduction(reseller.id, 99, 3, new Date(2026, 6, 31));
      // Belongs to a different reseller, same period - must never leak across resellers.
      otherResellerAugEntry = seedRenewalDeduction(otherReseller.id, 50, 4, new Date(2026, 7, 10));
    });

    test('sums only that reseller\'s deductions within the exact period', async () => {
      const res = await adminAgent
        .post('/api/invoices')
        .send({ resellerId: reseller.id, periodType: 'monthly', periodValue: '2026-08' });

      expect(res.status).toBe(201);
      expect(res.body.reseller_id).toBe(reseller.id);
      expect(res.body.period_type).toBe('monthly');
      expect(res.body.period_value).toBe('2026-08');
      expect(res.body.total_amount_usd).toBe(25); // 10 + 15, not the July or other-reseller entries
      expect(res.body.sent_at).toBeNull();

      expect(ledgerEntries.find((e) => e.id === augEntryOne.id)).toMatchObject({ invoiced: 1, invoice_id: res.body.id });
      expect(ledgerEntries.find((e) => e.id === augEntryTwo.id)).toMatchObject({ invoiced: 1, invoice_id: res.body.id });
      expect(ledgerEntries.find((e) => e.id === julEntry.id)).toMatchObject({ invoiced: 0, invoice_id: null });
      expect(ledgerEntries.find((e) => e.id === otherResellerAugEntry.id)).toMatchObject({
        invoiced: 0,
        invoice_id: null,
      });
    });

    test('regenerating the exact same reseller+period is rejected with 409 and no duplicate is created', async () => {
      const before = Object.keys(invoicesById).length;

      const res = await adminAgent
        .post('/api/invoices')
        .send({ resellerId: reseller.id, periodType: 'monthly', periodValue: '2026-08' });

      expect(res.status).toBe(409);
      expect(res.body.invoice).toMatchObject({ reseller_id: reseller.id, total_amount_usd: 25 });
      expect(Object.keys(invoicesById).length).toBe(before);
    });

    test('an overlapping annual invoice only picks up entries not already claimed by the monthly one', async () => {
      // A new deduction elsewhere in 2026, created after the monthly invoice
      // above was already generated - still un-invoiced.
      const marEntry = seedRenewalDeduction(reseller.id, 40, 5, new Date(2026, 2, 15));

      const res = await adminAgent
        .post('/api/invoices')
        .send({ resellerId: reseller.id, periodType: 'annual', periodValue: '2026' });

      expect(res.status).toBe(201);
      // julEntry (99) and marEntry (40) are both still un-invoiced and fall
      // within calendar year 2026, so both are swept in here (139 total) -
      // but augEntryOne/Two (25 total) are already claimed by the monthly
      // invoice and must not be double-counted.
      expect(res.body.total_amount_usd).toBe(139);

      expect(ledgerEntries.find((e) => e.id === marEntry.id)).toMatchObject({ invoiced: 1, invoice_id: res.body.id });
      expect(ledgerEntries.find((e) => e.id === julEntry.id)).toMatchObject({ invoiced: 1, invoice_id: res.body.id });
      expect(ledgerEntries.find((e) => e.id === augEntryOne.id).invoice_id).not.toBe(res.body.id);
    });

    test('a period with no deductions still generates a zero-total invoice', async () => {
      const res = await adminAgent
        .post('/api/invoices')
        .send({ resellerId: reseller.id, periodType: 'monthly', periodValue: '2025-01' });

      expect(res.status).toBe(201);
      expect(res.body.total_amount_usd).toBe(0);
    });

    test('an invalid period is rejected with 400', async () => {
      const res = await adminAgent
        .post('/api/invoices')
        .send({ resellerId: reseller.id, periodType: 'monthly', periodValue: 'not-a-month' });
      expect(res.status).toBe(400);
    });

    test('a non-existent reseller is rejected with 400', async () => {
      const res = await adminAgent
        .post('/api/invoices')
        .send({ resellerId: 999999, periodType: 'monthly', periodValue: '2026-08' });
      expect(res.status).toBe(400);
    });

    test('a reseller cannot generate an invoice', async () => {
      const agent = await loginAs(reseller.username, resellerPassword);
      const res = await agent
        .post('/api/invoices')
        .send({ resellerId: reseller.id, periodType: 'monthly', periodValue: '2026-09' });
      expect(res.status).toBe(403);
    });
  });

  describe('PDF generation and sending', () => {
    let reseller;
    let invoice;

    beforeAll(async () => {
      reseller = await createReseller(adminAgent, {
        username: `inv_send_${Date.now()}`,
        password: resellerPassword,
        email: `inv_send_${Date.now()}@example.com`,
      });

      seedRenewalDeduction(reseller.id, 12, 5, new Date(2026, 7, 5));
      const createRes = await adminAgent
        .post('/api/invoices')
        .send({ resellerId: reseller.id, periodType: 'monthly', periodValue: '2026-08' });
      invoice = createRes.body;
    });

    test('admin can fetch the PDF before it has been sent', async () => {
      const res = await adminAgent.get(`/api/invoices/${invoice.id}/pdf`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/pdf/);
      expect(pdfBuffer(res).slice(0, 4).toString()).toBe('%PDF');
    });

    test('the owning reseller cannot fetch the PDF before it has been sent', async () => {
      const agent = await loginAs(reseller.username, resellerPassword);
      const res = await agent.get(`/api/invoices/${invoice.id}/pdf`);
      expect(res.status).toBe(404);
    });

    test('a different reseller cannot fetch this invoice at all', async () => {
      const otherReseller = await createReseller(adminAgent, {
        username: `inv_other_${Date.now()}`,
        password: resellerPassword,
        email: `inv_other_${Date.now()}@example.com`,
      });
      const agent = await loginAs(otherReseller.username, resellerPassword);
      const res = await agent.get(`/api/invoices/${invoice.id}/pdf`);
      expect(res.status).toBe(404);
    });

    test('sending emails the PDF as an attachment, sets sent_at, and never touches the wallet balance', async () => {
      walletModel.adjustWalletBalance.mockClear();

      const res = await adminAgent.post(`/api/invoices/${invoice.id}/send`);
      expect(res.status).toBe(200);
      expect(res.body.sent_at).not.toBeNull();

      // Top-up remains the only credit mechanism (Phase 4 corrected) - sending
      // an invoice is purely informational, it must never adjust the wallet.
      expect(walletModel.adjustWalletBalance).not.toHaveBeenCalled();

      // Reseller creation above also sends a welcome email through the same
      // mocked sendMail, so pick out the invoice-send call specifically
      // rather than asserting a call count.
      const mailArgs = mailer.sendMail.mock.calls.map((call) => call[0]).find((args) => args.attachments);
      expect(mailArgs).toBeDefined();
      expect(mailArgs.to).toBe(reseller.email);
      expect(mailArgs.attachments).toHaveLength(1);
      expect(mailArgs.attachments[0].content.slice(0, 4).toString()).toBe('%PDF');

      expect(notificationModel.createNotification).toHaveBeenCalledWith(
        reseller.id,
        'invoice_issued',
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ invoiceId: invoice.id })
      );
    });

    test('the owning reseller can fetch the PDF now that it has been sent', async () => {
      const agent = await loginAs(reseller.username, resellerPassword);
      const res = await agent.get(`/api/invoices/${invoice.id}/pdf`);
      expect(res.status).toBe(200);
      expect(pdfBuffer(res).slice(0, 4).toString()).toBe('%PDF');
    });

    test('an already-sent invoice cannot be sent again', async () => {
      const res = await adminAgent.post(`/api/invoices/${invoice.id}/send`);
      expect(res.status).toBe(400);
    });

    test('a reseller cannot send an invoice', async () => {
      const agent = await loginAs(reseller.username, resellerPassword);
      const res = await agent.post(`/api/invoices/${invoice.id}/send`);
      expect(res.status).toBe(403);
    });
  });

  describe('no payment-tracking endpoint exists (Phase 4 corrected)', () => {
    test('POST /api/invoices/:id/payment is not a route', async () => {
      const res = await adminAgent.post('/api/invoices/1/payment').send({ amountPaid: 10 });
      expect(res.status).toBe(404);
    });
  });

  describe('listing invoices', () => {
    let resellerA;
    let resellerB;
    let sentInvoiceA;
    let unsentInvoiceA;
    let sentInvoiceB;

    beforeAll(async () => {
      resellerA = await createReseller(adminAgent, {
        username: `inv_list_a_${Date.now()}`,
        password: resellerPassword,
        email: `inv_list_a_${Date.now()}@example.com`,
      });
      resellerB = await createReseller(adminAgent, {
        username: `inv_list_b_${Date.now()}`,
        password: resellerPassword,
        email: `inv_list_b_${Date.now()}@example.com`,
      });

      seedRenewalDeduction(resellerA.id, 5, 11, new Date(2026, 0, 5));
      seedRenewalDeduction(resellerA.id, 6, 12, new Date(2026, 1, 5));
      seedRenewalDeduction(resellerB.id, 7, 13, new Date(2026, 0, 5));

      const createA1 = await adminAgent
        .post('/api/invoices')
        .send({ resellerId: resellerA.id, periodType: 'monthly', periodValue: '2026-01' });
      sentInvoiceA = createA1.body;
      await adminAgent.post(`/api/invoices/${sentInvoiceA.id}/send`);

      const createA2 = await adminAgent
        .post('/api/invoices')
        .send({ resellerId: resellerA.id, periodType: 'monthly', periodValue: '2026-02' });
      unsentInvoiceA = createA2.body; // deliberately left unsent

      const createB1 = await adminAgent
        .post('/api/invoices')
        .send({ resellerId: resellerB.id, periodType: 'monthly', periodValue: '2026-01' });
      sentInvoiceB = createB1.body;
      await adminAgent.post(`/api/invoices/${sentInvoiceB.id}/send`);
    });

    test('admin sees every invoice, sent or not', async () => {
      const res = await adminAgent.get('/api/invoices');
      expect(res.status).toBe(200);
      const ids = res.body.map((inv) => inv.id);
      expect(ids).toEqual(expect.arrayContaining([sentInvoiceA.id, unsentInvoiceA.id, sentInvoiceB.id]));
    });

    test('admin can filter by resellerId', async () => {
      const res = await adminAgent.get('/api/invoices').query({ resellerId: resellerA.id });
      expect(res.status).toBe(200);
      expect(res.body.every((inv) => inv.reseller_id === resellerA.id)).toBe(true);
    });

    test("a reseller sees only their own sent invoices - never another reseller's, and never an unsent one of their own", async () => {
      const agent = await loginAs(resellerA.username, resellerPassword);
      const res = await agent.get('/api/invoices');
      expect(res.status).toBe(200);

      const ids = res.body.map((inv) => inv.id);
      expect(ids).toEqual([sentInvoiceA.id]);
      expect(ids).not.toContain(unsentInvoiceA.id);
      expect(ids).not.toContain(sentInvoiceB.id);
    });
  });
});
