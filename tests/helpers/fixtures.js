const bcrypt = require('bcrypt');

// Real bcrypt hash, computed once at module load, so login/change-password
// tests exercise genuine bcrypt.compare() logic without ever touching a real DB.
const TEST_ADMIN_PASSWORD = 'TestPassword123!';
const TEST_ADMIN_PASSWORD_HASH = bcrypt.hashSync(TEST_ADMIN_PASSWORD, 10);

const TEST_ADMIN = {
  id: 1,
  username: 'testadmin',
  password_hash: TEST_ADMIN_PASSWORD_HASH,
  role: 'admin',
  status: 'active',
  created_at: new Date('2024-01-01T00:00:00Z'),
};

function hashOf(plaintextPassword) {
  return bcrypt.hashSync(plaintextPassword, 10);
}

module.exports = { TEST_ADMIN_PASSWORD, TEST_ADMIN_PASSWORD_HASH, TEST_ADMIN, hashOf };
