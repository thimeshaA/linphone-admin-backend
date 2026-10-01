const { ensureAdditiveColumns, ADDITIVE_COLUMNS } = require('../scripts/ensure-additive-columns');

function fakePool(existingColumnNames) {
  return {
    query: jest.fn().mockImplementation(async (sql) => {
      if (sql.includes('information_schema.columns')) {
        return [existingColumnNames.map((name) => ({ name }))];
      }
      // An ALTER TABLE statement.
      return [{}];
    }),
  };
}

describe('ensureAdditiveColumns', () => {
  test('adds only the genuinely missing columns', async () => {
    const pool = fakePool(['creator_id', 'email']); // disabled_at/renewed_at missing

    const added = await ensureAdditiveColumns(pool, 'flexisip_users_test');

    expect(added.sort()).toEqual(['disabled_at', 'renewed_at']);

    const alterCalls = pool.query.mock.calls.filter((call) => call[0].includes('ALTER TABLE'));
    expect(alterCalls).toHaveLength(2);
    expect(alterCalls.map((call) => call[0])).toEqual(
      expect.arrayContaining([ADDITIVE_COLUMNS.disabled_at, ADDITIVE_COLUMNS.renewed_at])
    );
  });

  test('is a no-op when all 4 columns already exist', async () => {
    const pool = fakePool(['creator_id', 'email', 'disabled_at', 'renewed_at']);

    const added = await ensureAdditiveColumns(pool, 'flexisip_users_test');

    expect(added).toEqual([]);
    expect(pool.query.mock.calls.filter((call) => call[0].includes('ALTER TABLE'))).toHaveLength(0);
  });

  test('ignores unrelated existing columns (e.g. the original schema columns)', async () => {
    const pool = fakePool(['registerID', 'authid', 'domain', 'login', 'password', 'algorithm', 'phone']);

    const added = await ensureAdditiveColumns(pool, 'flexisip_users_test');

    expect(added.sort()).toEqual(['creator_id', 'disabled_at', 'email', 'renewed_at']);
  });
});
