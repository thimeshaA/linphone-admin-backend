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

  walletLedgerModel.createLedgerEntry.mockImplementation(
    async ({ resellerId, type, amountUsd, relatedAccountId, invoiceId, createdBy, note }) => {
      const entry = {
        id: nextLedgerId++,
        reseller_id: Number(resellerId),
        type,
        amount_usd: amountUsd,
        related_account_id: relatedAccountId ?? null,
        invoiced: 0,
        invoice_id: invoiceId ?? null,
        created_by: createdBy ?? null,
        note: note ?? null,
        created_at: new Date(),
      };
      ledgerEntries.push(entry);
      return { ...entry };
    }
  );

  walletLedgerModel.listUninvoicedRenewalDeductions.mockImplementation(async (resellerId) =>
    ledgerEntries
      .filter((e) => e.reseller_id === Number(resellerId) && e.type === 'renewal_deduction' && !e.invoiced)
      .map((e) => ({ ...e }))
  );

  walletLedgerModel.getLedgerEntriesByIds.mockImplementation(async (ids) =>
    ledgerEntries.filter((e) => ids.includes(e.id)).map((e) => ({ ...e }))
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

  walletLedgerModel.sumPaymentsForInvoice.mockImplementation(async (invoiceId) =>
    ledgerEntries
      .filter((e) => e.invoice_id === invoiceId && e.type === 'payment_received')
      .reduce((sum, e) => sum + Number(e.amount_usd), 0)
  );

  invoiceModel.createInvoice.mockImplementation(async ({ resellerId, totalAmountUsd }) => {
    const id = nextInvoiceId++;
    const invoice = {
      id,
      reseller_id: Number(resellerId),
      status: 'draft',
      total_amount_usd: totalAmountUsd,
      created_at: new Date(),
      sent_at: null,
      paid_at: null,
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

  invoiceModel.listInvoices.mockImplementation(async (scopeFilter, { resellerId, status } = {}) => {
    let rows = Object.values(invoicesById);
    if (scopeFilter && scopeFilter.creator_id !== undefined) {
      rows = rows.filter((r) => Number(r.reseller_id) === Number(scopeFilter.creator_id));
    }
    if (resellerId) rows = rows.filter((r) => Number(r.reseller_id) === Number(resellerId));
    if (status) rows = rows.filter((r) => r.status === status);
    return rows.map((r) => ({ ...r })).sort((a, b) => b.id - a.id);
  });

  invoiceModel.markInvoiceSent.mockImplementation(async (id) => {
    const invoice = invoicesById[id];
    if (invoice) {
      invoice.status = 'sent';
      invoice.sent_at = new Date();
    }
  });

  invoiceModel.updateInvoiceStatus.mockImplementation(async (id, status) => {
    const invoice = invoicesById[id];
    if (invoice) {
      invoice.status = status;
      if (status === 'paid') invoice.paid_at = new Date();
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

async function seedRenewalDeduction(resellerId, amountUsd, relatedAccountId) {
  return walletLedgerModel.createLedgerEntry({
    resellerId,
    type: 'renewal_deduction',
    amountUsd: -Math.abs(amountUsd),
    relatedAccountId,
    createdBy: TEST_ADMIN.id,
    note: null,
  });
}

function pdfBuffer(res) {
  return Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.text || '', 'binary');
}

describe('Invoices (Phase 4)', () => {
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

  describe('generating an invoice', () => {
    let reseller;
    let entryOne;
    let entryTwo;
    let entryThree;

    beforeAll(async () => {
      reseller = await createReseller(adminAgent, {
        username: `inv_gen_${Date.now()}`,
        password: resellerPassword,
        email: `inv_gen_${Date.now()}@example.com`,
      });

      entryOne = await seedRenewalDeduction(reseller.id, 10, 1);
      entryTwo = await seedRenewalDeduction(reseller.id, 15, 2);
      entryThree = await seedRenewalDeduction(reseller.id, 20, 3);
    });

    test('uninvoiced endpoint lists exactly the billable entries for that reseller', async () => {
      const res = await adminAgent.get(`/api/resellers/${reseller.id}/wallet/uninvoiced`);
      expect(res.status).toBe(200);
      expect(res.body.entries.map((e) => e.id).sort()).toEqual(
        [entryOne.id, entryTwo.id, entryThree.id].sort()
      );
    });

    test('creating an invoice with a subset of entries only includes those entries in the total', async () => {
      const res = await adminAgent
        .post('/api/invoices')
        .send({ resellerId: reseller.id, ledgerEntryIds: [entryOne.id, entryTwo.id] });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('draft');
      expect(res.body.total_amount_usd).toBe(25);

      // entryThree was never selected, so it must still show up as uninvoiced.
      const uninvoiced = await adminAgent.get(`/api/resellers/${reseller.id}/wallet/uninvoiced`);
      expect(uninvoiced.body.entries.map((e) => e.id)).toEqual([entryThree.id]);
    });

    test('an already-invoiced entry cannot be selected into a second invoice', async () => {
      const res = await adminAgent
        .post('/api/invoices')
        .send({ resellerId: reseller.id, ledgerEntryIds: [entryOne.id, entryThree.id] });

      expect(res.status).toBe(400);
      // entryThree must remain uninvoiced - the rejected request had no side effects.
      const uninvoiced = await adminAgent.get(`/api/resellers/${reseller.id}/wallet/uninvoiced`);
      expect(uninvoiced.body.entries.map((e) => e.id)).toEqual([entryThree.id]);
    });

    test('ledgerEntryIds must be a non-empty array', async () => {
      const res = await adminAgent.post('/api/invoices').send({ resellerId: reseller.id, ledgerEntryIds: [] });
      expect(res.status).toBe(400);
    });

    test('a reseller cannot create an invoice', async () => {
      const agent = await loginAs(reseller.username, resellerPassword);
      const res = await agent
        .post('/api/invoices')
        .send({ resellerId: reseller.id, ledgerEntryIds: [entryThree.id] });
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

      const entry = await seedRenewalDeduction(reseller.id, 12, 5);
      const createRes = await adminAgent
        .post('/api/invoices')
        .send({ resellerId: reseller.id, ledgerEntryIds: [entry.id] });
      invoice = createRes.body;
    });

    test('admin can fetch the PDF while the invoice is still a draft', async () => {
      const res = await adminAgent.get(`/api/invoices/${invoice.id}/pdf`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/pdf/);
      expect(pdfBuffer(res).slice(0, 4).toString()).toBe('%PDF');
    });

    test('the owning reseller cannot fetch the PDF while still draft', async () => {
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

    test('sending emails the PDF as an attachment and marks the invoice sent', async () => {
      const res = await adminAgent.post(`/api/invoices/${invoice.id}/send`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('sent');
      expect(res.body.sent_at).not.toBeNull();

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

  describe('recording payments', () => {
    let reseller;
    let invoice;

    beforeAll(async () => {
      reseller = await createReseller(adminAgent, {
        username: `inv_pay_${Date.now()}`,
        password: resellerPassword,
        email: `inv_pay_${Date.now()}@example.com`,
      });

      const entry = await seedRenewalDeduction(reseller.id, 30, 9);
      const createRes = await adminAgent
        .post('/api/invoices')
        .send({ resellerId: reseller.id, ledgerEntryIds: [entry.id] });
      invoice = createRes.body; // total_amount_usd: 30
    });

    test('a partial payment moves status to partially_paid and credits the wallet', async () => {
      const res = await adminAgent
        .post(`/api/invoices/${invoice.id}/payment`)
        .send({ amountPaid: 10, note: 'first installment' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('partially_paid');
      expect(res.body.paid_at).toBeNull();
      expect(walletsByResellerId[reseller.id].balance_usd).toBe(10);

      expect(notificationModel.createNotification).toHaveBeenCalledWith(
        reseller.id,
        'payment_recorded',
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ invoiceId: invoice.id, status: 'partially_paid' })
      );
    });

    test('a second payment that reaches the total moves status to paid', async () => {
      const res = await adminAgent.post(`/api/invoices/${invoice.id}/payment`).send({ amountPaid: 20 });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('paid');
      expect(res.body.paid_at).not.toBeNull();
      expect(walletsByResellerId[reseller.id].balance_usd).toBe(30);
    });

    test('amountPaid must be a positive number', async () => {
      const res = await adminAgent.post(`/api/invoices/${invoice.id}/payment`).send({ amountPaid: 0 });
      expect(res.status).toBe(400);
    });

    test('a reseller cannot record a payment', async () => {
      const agent = await loginAs(reseller.username, resellerPassword);
      const res = await agent.post(`/api/invoices/${invoice.id}/payment`).send({ amountPaid: 5 });
      expect(res.status).toBe(403);
    });
  });

  describe('listing invoices', () => {
    let resellerA;
    let resellerB;

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

      const entryA = await seedRenewalDeduction(resellerA.id, 5, 11);
      const entryB = await seedRenewalDeduction(resellerB.id, 7, 12);
      await adminAgent.post('/api/invoices').send({ resellerId: resellerA.id, ledgerEntryIds: [entryA.id] });
      await adminAgent.post('/api/invoices').send({ resellerId: resellerB.id, ledgerEntryIds: [entryB.id] });
    });

    test('admin sees invoices for every reseller', async () => {
      const res = await adminAgent.get('/api/invoices');
      expect(res.status).toBe(200);
      const sellerIds = res.body.map((inv) => inv.reseller_id);
      expect(sellerIds).toEqual(expect.arrayContaining([resellerA.id, resellerB.id]));
    });

    test('admin can filter by resellerId', async () => {
      const res = await adminAgent.get('/api/invoices').query({ resellerId: resellerA.id });
      expect(res.status).toBe(200);
      expect(res.body.every((inv) => inv.reseller_id === resellerA.id)).toBe(true);
    });

    test("a reseller only sees their own invoices, never another reseller's", async () => {
      const agent = await loginAs(resellerA.username, resellerPassword);
      const res = await agent.get('/api/invoices');
      expect(res.status).toBe(200);
      expect(res.body.every((inv) => inv.reseller_id === resellerA.id)).toBe(true);
      expect(res.body.some((inv) => inv.reseller_id === resellerB.id)).toBe(false);
    });
  });
});
