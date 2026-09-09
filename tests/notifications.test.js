const request = require('supertest');
const { TEST_ADMIN_PASSWORD, TEST_ADMIN } = require('./helpers/fixtures');

jest.mock('../models/adminModel');
jest.mock('../models/notificationModel');
jest.mock('../models/auditLogModel');
jest.mock('../models/walletModel');
jest.mock('../models/walletLedgerModel');
jest.mock('../utils/mailer');

const adminModel = require('../models/adminModel');
const notificationModel = require('../models/notificationModel');
const walletModel = require('../models/walletModel');
const walletLedgerModel = require('../models/walletLedgerModel');
const mailer = require('../utils/mailer');
const app = require('../index');

// In-memory fake table backing every mocked model function, so the tests
// below observe consistent state without a real DB. Mirrors the wiring style
// used in wallet.test.js/accounts.test.js.
let adminsByUsername;
let resellersById;
let notificationsById;
let nextAdminId;
let nextNotificationId;

function seedStore() {
  adminsByUsername = { [TEST_ADMIN.username]: TEST_ADMIN };
  resellersById = {};
  notificationsById = {};
  nextAdminId = 100;
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

  notificationModel.listNotificationsForRecipient.mockImplementation(async (recipientId, { page, limit, unreadOnly }) => {
    const rows = Object.values(notificationsById)
      .filter((n) => n.recipient_id === Number(recipientId))
      .filter((n) => !unreadOnly || !n.read_at)
      .sort((a, b) => b.id - a.id);
    const start = (page - 1) * limit;
    return { rows: rows.slice(start, start + limit).map((r) => ({ ...r })), total: rows.length };
  });

  notificationModel.getNotificationForRecipient.mockImplementation(async (id, recipientId) => {
    const notification = notificationsById[id];
    if (!notification || notification.recipient_id !== Number(recipientId)) {
      return null;
    }
    return { ...notification };
  });

  notificationModel.markNotificationRead.mockImplementation(async (id, recipientId) => {
    const notification = notificationsById[id];
    if (!notification || notification.recipient_id !== Number(recipientId) || notification.read_at) {
      return;
    }
    notification.read_at = new Date();
  });

  notificationModel.markAllNotificationsRead.mockImplementation(async (recipientId) => {
    Object.values(notificationsById)
      .filter((n) => n.recipient_id === Number(recipientId) && !n.read_at)
      .forEach((n) => {
        n.read_at = new Date();
      });
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

describe('In-app notifications (Phase 3)', () => {
  const adminAgent = request.agent(app);
  const resellerPassword = 'ResellerPass123!';

  beforeAll(() => {
    seedStore();
    wireMocks();
  });

  test('login as admin', async () => {
    const res = await adminAgent
      .post('/api/auth/login')
      .send({ username: TEST_ADMIN.username, password: TEST_ADMIN_PASSWORD });
    expect(res.status).toBe(200);
  });

  describe('recipient scoping', () => {
    let resellerA;
    let resellerB;
    let resellerAAgent;
    let resellerBAgent;
    let notificationForA;

    beforeAll(async () => {
      resellerA = await createReseller(adminAgent, {
        username: `notif_scope_a_${Date.now()}`,
        password: resellerPassword,
        email: `notif_scope_a_${Date.now()}@example.com`,
      });
      resellerB = await createReseller(adminAgent, {
        username: `notif_scope_b_${Date.now()}`,
        password: resellerPassword,
        email: `notif_scope_b_${Date.now()}@example.com`,
      });

      resellerAAgent = await loginAs(resellerA.username, resellerPassword);
      resellerBAgent = await loginAs(resellerB.username, resellerPassword);

      notificationForA = await notificationModel.createNotification(
        resellerA.id,
        'renewal_deduction',
        'Wallet charged for renewal of test@example.com',
        'Account test@example.com was renewed.',
        { accountId: 1, authid: 'test', domain: 'example.com', amountUsd: 15, balanceUsd: -5 }
      );
    });

    test('a notification is only visible to its own recipient', async () => {
      const resA = await resellerAAgent.get('/api/notifications');
      expect(resA.status).toBe(200);
      expect(resA.body.notifications.map((n) => n.id)).toEqual([notificationForA.id]);

      const resB = await resellerBAgent.get('/api/notifications');
      expect(resB.status).toBe(200);
      expect(resB.body.notifications).toHaveLength(0);
    });

    test("another reseller cannot mark someone else's notification as read", async () => {
      const res = await resellerBAgent.patch(`/api/notifications/${notificationForA.id}/read`);
      expect(res.status).toBe(404);

      const stillUnread = await resellerAAgent.get('/api/notifications');
      expect(stillUnread.body.notifications[0].read_at).toBeNull();
    });
  });

  describe('marking as read', () => {
    let reseller;
    let agent;
    let notifOne;
    let notifTwo;

    beforeAll(async () => {
      reseller = await createReseller(adminAgent, {
        username: `notif_read_${Date.now()}`,
        password: resellerPassword,
        email: `notif_read_${Date.now()}@example.com`,
      });
      agent = await loginAs(reseller.username, resellerPassword);

      notifOne = await notificationModel.createNotification(
        reseller.id,
        'renewal_deduction',
        'First',
        'First message',
        null
      );
      notifTwo = await notificationModel.createNotification(
        reseller.id,
        'renewal_deduction',
        'Second',
        'Second message',
        null
      );
    });

    test('marking one as read does not affect others', async () => {
      const res = await agent.patch(`/api/notifications/${notifOne.id}/read`);
      expect(res.status).toBe(200);
      expect(res.body.read_at).not.toBeNull();

      const listRes = await agent.get('/api/notifications');
      const one = listRes.body.notifications.find((n) => n.id === notifOne.id);
      const two = listRes.body.notifications.find((n) => n.id === notifTwo.id);
      expect(one.read_at).not.toBeNull();
      expect(two.read_at).toBeNull();
    });

    test('the unread=true filter excludes read notifications', async () => {
      const res = await agent.get('/api/notifications').query({ unread: 'true' });
      expect(res.status).toBe(200);
      expect(res.body.notifications.map((n) => n.id)).toEqual([notifTwo.id]);
    });

    test('marking an unknown notification id returns 404', async () => {
      const res = await agent.patch('/api/notifications/999999/read');
      expect(res.status).toBe(404);
    });
  });

  describe('read-all', () => {
    let resellerA;
    let resellerB;
    let agentA;
    let agentB;

    beforeAll(async () => {
      resellerA = await createReseller(adminAgent, {
        username: `notif_readall_a_${Date.now()}`,
        password: resellerPassword,
        email: `notif_readall_a_${Date.now()}@example.com`,
      });
      resellerB = await createReseller(adminAgent, {
        username: `notif_readall_b_${Date.now()}`,
        password: resellerPassword,
        email: `notif_readall_b_${Date.now()}@example.com`,
      });
      agentA = await loginAs(resellerA.username, resellerPassword);
      agentB = await loginAs(resellerB.username, resellerPassword);

      await notificationModel.createNotification(resellerA.id, 'renewal_deduction', 'A1', 'A1 message', null);
      await notificationModel.createNotification(resellerA.id, 'renewal_deduction', 'A2', 'A2 message', null);
      await notificationModel.createNotification(resellerB.id, 'renewal_deduction', 'B1', 'B1 message', null);
    });

    test("read-all only marks the caller's own notifications", async () => {
      const res = await agentA.patch('/api/notifications/read-all');
      expect(res.status).toBe(200);

      const listA = await agentA.get('/api/notifications');
      expect(listA.body.notifications.every((n) => n.read_at !== null)).toBe(true);

      const listB = await agentB.get('/api/notifications');
      expect(listB.body.notifications.every((n) => n.read_at === null)).toBe(true);
    });
  });
});
