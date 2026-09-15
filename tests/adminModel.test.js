jest.mock('../config/db', () => ({
  adminPool: { query: jest.fn() },
}));

const { adminPool } = require('../config/db');
const { createReseller } = require('../models/adminModel');

// admins.id is a UUID column, not AUTO_INCREMENT, so a real INSERT never
// populates mysql2's result.insertId (it comes back as 0) - this fakes that
// exact behavior to catch a regression where createReseller trusts insertId
// instead of re-fetching the row it just created.
describe('adminModel.createReseller', () => {
  let adminsByUsername;

  beforeEach(() => {
    adminsByUsername = {};

    adminPool.query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('INSERT INTO admins')) {
        const [username, passwordHash, expiresAt, email] = params;
        adminsByUsername[username] = {
          id: 'a1b2c3d4-0000-4000-8000-000000000001',
          username,
          password_hash: passwordHash,
          role: 'reseller',
          status: 'active',
          expires_at: expiresAt,
          expired_at: null,
          email,
          created_at: new Date(),
        };
        return [{ insertId: 0 }];
      }

      if (sql.startsWith('SELECT')) {
        const [username] = params;
        const row = adminsByUsername[username];
        return [row ? [row] : []];
      }

      throw new Error(`Unhandled query in mock: ${sql}`);
    });
  });

  test('returns the real UUID id, not the fabricated insertId', async () => {
    const reseller = await createReseller({
      username: 'acme_reseller',
      passwordHash: 'hashed',
      expiresAt: new Date('2027-01-01'),
      email: 'acme@example.com',
    });

    expect(reseller.id).toBe('a1b2c3d4-0000-4000-8000-000000000001');
    expect(reseller.id).not.toBe(0);
  });
});
