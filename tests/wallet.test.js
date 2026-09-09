const request = require('supertest');
const { TEST_ADMIN_PASSWORD, TEST_ADMIN } = require('./helpers/fixtures');

jest.mock('../models/adminModel');
jest.mock('../models/walletModel');
jest.mock('../models/walletLedgerModel');
jest.mock('../models/settingsModel');
jest.mock('../utils/mailer');

const adminModel = require('../models/adminModel');
const walletModel = require('../models/walletModel');
const walletLedgerModel = require('../models/walletLedgerModel');
const settingsModel = require('../models/settingsModel');
const mailer = require('../utils/mailer');
const app = require('../index');

// In-memory fake tables backing every mocked model function, so the
// sequential steps below observe consistent state without a real DB. Mirrors
// the wiring style used in admins.test.js/accounts.test.js.
let adminsByUsername;
let resellersById;
let walletsByResellerId;
let ledgerEntries;
let nextAdminId;
let nextLedgerId;
let renewalCost;

function seedStore() {
  adminsByUsername = { [TEST_ADMIN.username]: TEST_ADMIN };
  resellersById = {};
  walletsByResellerId = {};
  ledgerEntries = [];
  nextAdminId = 100;
  nextLedgerId = 1;
  renewalCost = 0;
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

  walletModel.createWallet.mockImplementation(async (resellerId, balanceUsd) => {
    walletsByResellerId[resellerId] = {
      reseller_id: Number(resellerId),
      balance_usd: balanceUsd,
      updated_at: new Date(),
    };
  });

  walletModel.getWalletByResellerId.mockImplementation(async (resellerId, scopeFilter) => {
    if (scopeFilter && scopeFilter.creator_id !== undefined && Number(scopeFilter.creator_id) !== Number(resellerId)) {
      return null;
    }
    const wallet = walletsByResellerId[resellerId];
    return wallet ? { ...wallet } : null;
  });

  walletModel.adjustWalletBalance.mockImplementation(async (resellerId, deltaUsd) => {
    const wallet = walletsByResellerId[resellerId];
    if (!wallet) return false;
    wallet.balance_usd += deltaUsd;
    wallet.updated_at = new Date();
    return true;
  });

  walletLedgerModel.createLedgerEntry.mockImplementation(
    async ({ resellerId, type, amountUsd, relatedAccountId, createdBy, note }) => {
      const entry = {
        id: nextLedgerId++,
        reseller_id: Number(resellerId),
        type,
        amount_usd: amountUsd,
        related_account_id: relatedAccountId ?? null,
        invoiced: 0,
        invoice_id: null,
        created_by: createdBy ?? null,
        note: note ?? null,
        created_at: new Date(),
      };
      ledgerEntries.push(entry);
      return entry;
    }
  );

  walletLedgerModel.listLedgerForReseller.mockImplementation(async (resellerId, { page, limit }) => {
    const rows = ledgerEntries
      .filter((e) => e.reseller_id === Number(resellerId))
      .sort((a, b) => b.id - a.id);
    const start = (page - 1) * limit;
    return { rows: rows.slice(start, start + limit).map((r) => ({ ...r })), total: rows.length };
  });

  settingsModel.getRenewalCost.mockImplementation(async () => renewalCost);
  settingsModel.setRenewalCost.mockImplementation(async (value) => {
    renewalCost = value;
    return value;
  });
}

async function createReseller(adminAgent, { username, password, email, initialCredit }) {
  const res = await adminAgent.post('/api/admins').send({ username, password, email, initialCredit });
  expect(res.status).toBe(201);
  return res.body;
}

describe('Wallet / billing (Phase 1)', () => {
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

  describe('reseller creation with initialCredit', () => {
    test('creating a reseller with initialCredit produces the correct wallet balance and a matching ledger entry', async () => {
      const reseller = await createReseller(adminAgent, {
        username: `wallet_credit_${Date.now()}`,
        password: resellerPassword,
        email: `wallet_credit_${Date.now()}@example.com`,
        initialCredit: 75,
      });

      const res = await adminAgent.get(`/api/resellers/${reseller.id}/wallet`);
      expect(res.status).toBe(200);
      expect(res.body.balanceUsd).toBe(75);
      expect(res.body.ledger).toHaveLength(1);
      expect(res.body.ledger[0]).toMatchObject({ type: 'initial_credit', amount_usd: 75 });
    });

    test('creating a reseller without initialCredit defaults balance to 0 with no ledger entry', async () => {
      const reseller = await createReseller(adminAgent, {
        username: `wallet_nocredit_${Date.now()}`,
        password: resellerPassword,
        email: `wallet_nocredit_${Date.now()}@example.com`,
      });

      const res = await adminAgent.get(`/api/resellers/${reseller.id}/wallet`);
      expect(res.status).toBe(200);
      expect(res.body.balanceUsd).toBe(0);
      expect(res.body.ledger).toHaveLength(0);
    });

    test('a negative initialCredit is rejected with a field-specific 400', async () => {
      const res = await adminAgent.post('/api/admins').send({
        username: `wallet_bad_${Date.now()}`,
        password: resellerPassword,
        email: `wallet_bad_${Date.now()}@example.com`,
        initialCredit: -5,
      });
      expect(res.status).toBe(400);
      expect(res.body.errors).toHaveProperty('initialCredit');
    });
  });

  describe('top-up', () => {
    let reseller;

    beforeAll(async () => {
      reseller = await createReseller(adminAgent, {
        username: `wallet_topup_${Date.now()}`,
        password: resellerPassword,
        email: `wallet_topup_${Date.now()}@example.com`,
        initialCredit: 10,
      });
    });

    test('top-up increases balance and logs an admin_topup entry with the correct created_by', async () => {
      const res = await adminAgent
        .post(`/api/resellers/${reseller.id}/wallet/topup`)
        .send({ amount: 40, note: 'manual top-up' });

      expect(res.status).toBe(200);
      expect(res.body.balanceUsd).toBe(50);

      const walletRes = await adminAgent.get(`/api/resellers/${reseller.id}/wallet`);
      const topupEntry = walletRes.body.ledger.find((e) => e.type === 'admin_topup');
      expect(topupEntry).toMatchObject({
        amount_usd: 40,
        created_by: TEST_ADMIN.id,
        note: 'manual top-up',
      });
    });

    test('a non-positive amount is rejected with 400', async () => {
      const res = await adminAgent.post(`/api/resellers/${reseller.id}/wallet/topup`).send({ amount: 0 });
      expect(res.status).toBe(400);
    });

    test('topping up a non-existent reseller returns 404', async () => {
      const res = await adminAgent.post('/api/resellers/999999/wallet/topup').send({ amount: 10 });
      expect(res.status).toBe(404);
    });

    test('as a reseller, top-up is forbidden', async () => {
      const resellerAgent = request.agent(app);
      await resellerAgent
        .post('/api/auth/login')
        .send({ username: reseller.username, password: resellerPassword });

      const res = await resellerAgent
        .post(`/api/resellers/${reseller.id}/wallet/topup`)
        .send({ amount: 10 });
      expect(res.status).toBe(403);
    });
  });

  describe('owed-accounts derivation', () => {
    let reseller;

    beforeAll(async () => {
      reseller = await createReseller(adminAgent, {
        username: `wallet_owed_${Date.now()}`,
        password: resellerPassword,
        email: `wallet_owed_${Date.now()}@example.com`,
      });

      await adminAgent.put('/api/settings/renewal-cost').send({ renewalCost: 10 });
    });

    test('zero balance owes nothing', async () => {
      walletsByResellerId[reseller.id].balance_usd = 0;
      const res = await adminAgent.get(`/api/resellers/${reseller.id}/wallet`);
      expect(res.body.owedAccounts).toBe(0);
    });

    test('positive balance owes nothing', async () => {
      walletsByResellerId[reseller.id].balance_usd = 35;
      const res = await adminAgent.get(`/api/resellers/${reseller.id}/wallet`);
      expect(res.body.owedAccounts).toBe(0);
    });

    test('negative balance that divides evenly by renewal cost', async () => {
      walletsByResellerId[reseller.id].balance_usd = -30;
      const res = await adminAgent.get(`/api/resellers/${reseller.id}/wallet`);
      expect(res.body.owedAccounts).toBe(3);
    });

    test('negative balance that does not divide evenly rounds up', async () => {
      walletsByResellerId[reseller.id].balance_usd = -25;
      const res = await adminAgent.get(`/api/resellers/${reseller.id}/wallet`);
      expect(res.body.owedAccounts).toBe(3);
    });

    test('a tiny negative balance still owes at least one account', async () => {
      walletsByResellerId[reseller.id].balance_usd = -1;
      const res = await adminAgent.get(`/api/resellers/${reseller.id}/wallet`);
      expect(res.body.owedAccounts).toBe(1);
    });
  });

  describe('wallet access scoping', () => {
    let resellerA;
    let resellerB;
    let resellerAAgent;

    beforeAll(async () => {
      resellerA = await createReseller(adminAgent, {
        username: `wallet_scope_a_${Date.now()}`,
        password: resellerPassword,
        email: `wallet_scope_a_${Date.now()}@example.com`,
        initialCredit: 15,
      });
      resellerB = await createReseller(adminAgent, {
        username: `wallet_scope_b_${Date.now()}`,
        password: resellerPassword,
        email: `wallet_scope_b_${Date.now()}@example.com`,
        initialCredit: 25,
      });

      resellerAAgent = request.agent(app);
      await resellerAAgent
        .post('/api/auth/login')
        .send({ username: resellerA.username, password: resellerPassword });
    });

    test('a reseller can access their own wallet', async () => {
      const res = await resellerAAgent.get(`/api/resellers/${resellerA.id}/wallet`);
      expect(res.status).toBe(200);
      expect(res.body.balanceUsd).toBe(15);
    });

    test("a reseller requesting another reseller's wallet is rejected", async () => {
      const res = await resellerAAgent.get(`/api/resellers/${resellerB.id}/wallet`);
      expect(res.status).toBe(404);
    });

    test('an admin can access any reseller wallet', async () => {
      const resA = await adminAgent.get(`/api/resellers/${resellerA.id}/wallet`);
      const resB = await adminAgent.get(`/api/resellers/${resellerB.id}/wallet`);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      expect(resB.body.balanceUsd).toBe(25);
    });
  });

  describe('renewal-cost setting', () => {
    test('admin can set the renewal cost', async () => {
      const res = await adminAgent.put('/api/settings/renewal-cost').send({ renewalCost: 12.5 });
      expect(res.status).toBe(200);
      expect(res.body.renewalCost).toBe(12.5);
    });

    test('both admin and reseller can read the renewal cost', async () => {
      const resellerAgent = request.agent(app);
      const reseller = await createReseller(adminAgent, {
        username: `wallet_reader_${Date.now()}`,
        password: resellerPassword,
        email: `wallet_reader_${Date.now()}@example.com`,
      });
      await resellerAgent
        .post('/api/auth/login')
        .send({ username: reseller.username, password: resellerPassword });

      const adminRes = await adminAgent.get('/api/settings/renewal-cost');
      const resellerRes = await resellerAgent.get('/api/settings/renewal-cost');

      expect(adminRes.status).toBe(200);
      expect(resellerRes.status).toBe(200);
      expect(adminRes.body.renewalCost).toBe(12.5);
      expect(resellerRes.body.renewalCost).toBe(12.5);
    });

    test('a reseller cannot set the renewal cost', async () => {
      const resellerAgent = request.agent(app);
      const reseller = await createReseller(adminAgent, {
        username: `wallet_writer_${Date.now()}`,
        password: resellerPassword,
        email: `wallet_writer_${Date.now()}@example.com`,
      });
      await resellerAgent
        .post('/api/auth/login')
        .send({ username: reseller.username, password: resellerPassword });

      const res = await resellerAgent.put('/api/settings/renewal-cost').send({ renewalCost: 99 });
      expect(res.status).toBe(403);
    });

    test('a negative renewal cost is rejected with 400', async () => {
      const res = await adminAgent.put('/api/settings/renewal-cost').send({ renewalCost: -1 });
      expect(res.status).toBe(400);
    });
  });
});
