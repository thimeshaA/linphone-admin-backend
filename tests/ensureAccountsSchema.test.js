const { ensureAccountsSchema } = require('../db/ensureAccountsSchema');

function fakePool(existsCount) {
  return {
    query: jest.fn().mockImplementation(async (sql) => {
      if (sql.includes('information_schema.tables')) {
        return [[{ count: existsCount }]];
      }
      // Anything else (the bundled CREATE TABLE) just succeeds.
      return [{}];
    }),
  };
}

describe('ensureAccountsSchema', () => {
  test('table already exists: no error, no CREATE TABLE issued, regardless of the flag', async () => {
    const pool = fakePool(1);

    await expect(ensureAccountsSchema(pool, 'flexisip_users_test', { autoCreate: false })).resolves.toBeUndefined();
    await expect(ensureAccountsSchema(pool, 'flexisip_users_test', { autoCreate: true })).resolves.toBeUndefined();

    // Only the existence check ran each time - never a schema-creation query.
    expect(pool.query).toHaveBeenCalledTimes(2);
    for (const call of pool.query.mock.calls) {
      expect(call[0]).toContain('information_schema.tables');
    }
  });

  test('table missing, AUTO_CREATE_SCHEMA not set: fails loudly, creates nothing', async () => {
    const pool = fakePool(0);

    await expect(ensureAccountsSchema(pool, 'flexisip_users_test', { autoCreate: false })).rejects.toThrow(
      /accounts.*does not exist.*flexisip_users_test.*AUTO_CREATE_SCHEMA/s
    );

    // Only the existence check ran - the table was never created.
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toContain('information_schema.tables');
  });

  test('table missing, AUTO_CREATE_SCHEMA=true: creates it from the bundled schema and logs loudly', async () => {
    const pool = fakePool(0);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await expect(ensureAccountsSchema(pool, 'flexisip_users_test', { autoCreate: true })).resolves.toBeUndefined();

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[1][0]).toContain('CREATE TABLE accounts');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('AUTO_CREATE_SCHEMA is enabled'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('db/schema/accounts.sql'));

    logSpy.mockRestore();
  });
});
