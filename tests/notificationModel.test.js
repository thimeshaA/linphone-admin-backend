jest.mock('../config/db', () => ({
  adminPool: { query: jest.fn() },
}));

const { adminPool } = require('../config/db');
const { createNotification } = require('../models/notificationModel');

// Fakes just enough of a JSON-typed MariaDB column to catch the real bug:
// passing a plain object straight into a parameterized query instead of
// JSON.stringify-ing it first produces `[object Object]`, which a JSON
// column rejects as invalid JSON. mysql2 also auto-parses JSON columns back
// into JS values on SELECT, which the round-trip assertions below rely on.
describe('notificationModel.createNotification', () => {
  let notificationsById;
  let nextId;

  beforeEach(() => {
    notificationsById = {};
    nextId = 1;

    adminPool.query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('INSERT INTO notifications')) {
        const [recipientId, type, title, message, payload] = params;

        if (payload !== null && typeof payload !== 'string') {
          throw new TypeError(
            `payload must be a string for a JSON column, got ${Object.prototype.toString.call(payload)}`
          );
        }
        if (payload !== null) {
          JSON.parse(payload);
        }

        const id = nextId++;
        notificationsById[id] = { id, recipient_id: recipientId, type, title, message, payload };
        return [{ insertId: id }];
      }

      if (sql.startsWith('SELECT')) {
        const [id] = params;
        const row = notificationsById[id];
        if (!row) return [[]];
        return [[{ ...row, payload: row.payload === null ? null : JSON.parse(row.payload) }]];
      }

      throw new Error(`Unhandled query in mock: ${sql}`);
    });
  });

  test('an object payload is serialized and round-trips back to the original object', async () => {
    const payload = { accountId: 42, authid: 'alice', domain: 'example.com', amountUsd: 12.5, balanceUsd: -3.25 };

    const row = await createNotification(7, 'renewal_deduction', 'Subject', 'Body', payload);

    expect(row.payload).toEqual(payload);
  });

  test('a null payload succeeds without crashing and stays null', async () => {
    const row = await createNotification(7, 'invoice_issued', 'Subject', 'Body', null);

    expect(row.payload).toBeNull();
  });

  test('an omitted payload succeeds without crashing and stays null', async () => {
    const row = await createNotification(7, 'invoice_issued', 'Subject', 'Body', undefined);

    expect(row.payload).toBeNull();
  });
});
