jest.mock('../config/db', () => ({
  flexisipPool: { query: jest.fn() },
}));

const { flexisipPool } = require('../config/db');
const { createAccount } = require('../models/accountModel');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// auth_users.id is a UUID column, not AUTO_INCREMENT - the app generates the
// id itself and must pass it into the INSERT rather than trusting mysql2's
// result.insertId (which comes back as 0 for a non-AUTO_INCREMENT PK).
describe('accountModel.createAccount', () => {
  let accountsById;

  beforeEach(() => {
    accountsById = {};

    flexisipPool.query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('INSERT INTO auth_users')) {
        const [id, authid, domain, password, status, expiresAt, creatorId, email] = params;
        accountsById[id] = {
          id,
          authid,
          domain,
          created_at: new Date(),
          status,
          expires_at: expiresAt,
          disabled_at: null,
          expired_at: null,
          renewed_at: null,
          creator_id: creatorId,
          email,
        };
        return [{ insertId: 0 }];
      }

      if (sql.startsWith('SELECT')) {
        const [id] = params;
        const row = accountsById[id];
        return [row ? [row] : []];
      }

      throw new Error(`Unhandled query in mock: ${sql}`);
    });
  });

  test('generates a UUID id and returns it, not the fabricated insertId', async () => {
    const account = await createAccount({
      authid: 'acme_account',
      domain: 'sip.example.com',
      passwordHash: 'hashed',
      status: 'active',
      expiresAt: new Date('2027-01-01'),
      creatorId: 'a1b2c3d4-0000-4000-8000-000000000001',
      email: 'acme@example.com',
    });

    expect(account.id).toMatch(UUID_RE);
    expect(account.id).not.toBe(0);
    expect(account.authid).toBe('acme_account');
  });
});
