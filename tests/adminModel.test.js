jest.mock('../config/db', () => ({
  adminPool: { query: jest.fn() },
}));

const { adminPool } = require('../config/db');
const { createReseller } = require('../models/adminModel');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// admins.id is a UUID column, not AUTO_INCREMENT - the app generates the id
// itself and must pass it into the INSERT rather than trusting mysql2's
// result.insertId (which comes back as 0 for a non-AUTO_INCREMENT PK).
describe('adminModel.createReseller', () => {
  let adminsById;

  beforeEach(() => {
    adminsById = {};

    adminPool.query.mockImplementation(async (sql, params) => {
      if (sql.startsWith('INSERT INTO admins')) {
        const [id, username, passwordHash, expiresAt, email] = params;
        adminsById[id] = {
          id,
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
        const [id] = params;
        const row = adminsById[id];
        return [row ? [row] : []];
      }

      throw new Error(`Unhandled query in mock: ${sql}`);
    });
  });

  test('generates a UUID id and returns it, not the fabricated insertId', async () => {
    const reseller = await createReseller({
      username: 'acme_reseller',
      passwordHash: 'hashed',
      expiresAt: new Date('2027-01-01'),
      email: 'acme@example.com',
    });

    expect(reseller.id).toMatch(UUID_RE);
    expect(reseller.id).not.toBe(0);
    expect(reseller.username).toBe('acme_reseller');
  });
});
