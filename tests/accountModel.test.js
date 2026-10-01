jest.mock('../config/db', () => ({
  flexisipPool: { query: jest.fn() },
}));

const { flexisipPool } = require('../config/db');
const {
  listAccounts,
  getAccountById,
  findAccountByAuthid,
  findAccountLabelsByIds,
  createAccount,
  reassignAccountCreator,
  renewAccount,
  disableAccount,
  updateAccountPassword,
  deleteAccount,
} = require('../models/accountModel');

function dateOnly(value) {
  return value.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

// Mirrors the CASE expression in accountModel.js's PUBLIC_COLUMNS, so the
// fake query executor below returns the same status a real MySQL server
// would for a given disabled_at/scadenza combination.
function computeStatus(row, today) {
  if (row.disabled_at !== null) return 'disabled';
  return row.scadenza < today ? 'expired' : 'active';
}

// registerID is a plain AUTO_INCREMENT integer in the real accounts table -
// this fake executor never generates an id itself, it only ever returns
// whatever the (auto-incrementing) mock insertId produced, mirroring what a
// real INSERT would hand back via result.insertId.
describe('accountModel (against a fake accounts table)', () => {
  let rowsById;
  let nextId;

  beforeEach(() => {
    rowsById = {};
    nextId = 1;

    flexisipPool.query.mockImplementation(async (sql, params = []) => {
      const today = dateOnly(new Date());

      if (sql.includes('INSERT INTO accounts')) {
        const [authid, login, domain, password, algorithm, phone, creazione, scadenza, creatorId, email] = params;
        const id = nextId++;
        rowsById[id] = {
          registerID: id,
          authid,
          login,
          domain,
          password,
          algorithm,
          phone,
          creazione,
          scadenza,
          creator_id: creatorId,
          email,
          disabled_at: null,
          renewed_at: null,
        };
        return [{ insertId: id }];
      }

      if (sql.startsWith('DELETE FROM accounts')) {
        const [id] = params;
        const existed = Boolean(rowsById[id]);
        delete rowsById[id];
        return [{ affectedRows: existed ? 1 : 0 }];
      }

      if (sql.startsWith('UPDATE accounts SET scadenza')) {
        const [scadenza, id] = params;
        const row = rowsById[id];
        if (!row) return [{ affectedRows: 0 }];
        row.scadenza = scadenza;
        row.renewed_at = new Date();
        return [{ affectedRows: 1 }];
      }

      if (sql.startsWith('UPDATE accounts SET creator_id')) {
        const [creatorId, id] = params;
        const row = rowsById[id];
        if (!row) return [{ affectedRows: 0 }];
        row.creator_id = creatorId;
        return [{ affectedRows: 1 }];
      }

      if (sql.startsWith('UPDATE accounts SET disabled_at')) {
        const [id] = params;
        const row = rowsById[id];
        if (!row) return [{ affectedRows: 0 }];
        row.disabled_at = new Date();
        return [{ affectedRows: 1 }];
      }

      if (sql.startsWith('UPDATE accounts SET password')) {
        const [password, id] = params;
        const row = rowsById[id];
        if (!row) return [{ affectedRows: 0 }];
        row.password = password;
        return [{ affectedRows: 1 }];
      }

      if (sql.startsWith('SELECT registerID AS id FROM accounts WHERE authid')) {
        const [authid] = params;
        const row = Object.values(rowsById).find((r) => r.authid === authid);
        return [row ? [{ id: row.registerID }] : []];
      }

      if (sql.startsWith('SELECT registerID AS id, authid, domain FROM accounts WHERE registerID IN')) {
        const matched = params
          .map((id) => rowsById[id])
          .filter(Boolean)
          .map((r) => ({ id: r.registerID, authid: r.authid, domain: r.domain }));
        return [matched];
      }

      if (sql.includes('FROM accounts')) {
        // listAccounts / getAccountById / createAccount's re-fetch all share
        // PUBLIC_COLUMNS - simulate the same projection and filters.
        let candidates = Object.values(rowsById);
        let paramIdx = 0;

        if (sql.includes('WHERE registerID = ?')) {
          const id = params[paramIdx++];
          candidates = candidates.filter((r) => String(r.registerID) === String(id));
        }
        if (sql.includes('creator_id = ?')) {
          const creatorId = params[paramIdx++];
          candidates = candidates.filter((r) => String(r.creator_id) === String(creatorId));
        }
        if (sql.includes('authid LIKE ?')) {
          const authidTerm = String(params[paramIdx++]).replace(/%/g, '');
          const domainTerm = String(params[paramIdx++]).replace(/%/g, '');
          candidates = candidates.filter((r) => r.authid.includes(authidTerm) || r.domain.includes(domainTerm));
        }

        let projected = candidates.map((r) => ({
          id: r.registerID,
          authid: r.authid,
          domain: r.domain,
          created_at: r.creazione,
          expires_at: r.scadenza,
          disabled_at: r.disabled_at,
          renewed_at: r.renewed_at,
          creator_id: r.creator_id,
          email: r.email,
          status: computeStatus(r, today),
        }));

        if (sql.includes('HAVING status = ?')) {
          const status = params[paramIdx++];
          projected = projected.filter((r) => r.status === status);
        }

        if (sql.includes('ORDER BY created_at DESC')) {
          projected = [...projected].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        }

        return [projected];
      }

      throw new Error(`Unhandled query in mock: ${sql}`);
    });
  });

  describe('createAccount', () => {
    test('returns the plain auto-increment id from the INSERT, not a generated UUID', async () => {
      const account = await createAccount({
        authid: 'acme_account',
        domain: 'sip.example.com',
        passwordHash: 'hashed',
        phone: '+15551234567',
        expiresAt: addDays(new Date(), 180),
        creatorId: 7,
        email: 'acme@example.com',
      });

      expect(account.id).toBe(1);
      expect(typeof account.id).toBe('number');
    });

    test('sets login equal to authid and algorithm to MD5, regardless of input', async () => {
      const account = await createAccount({
        authid: 'acme_account',
        domain: 'sip.example.com',
        passwordHash: 'hashed',
        phone: '+15551234567',
        expiresAt: addDays(new Date(), 180),
        creatorId: 7,
        email: 'acme@example.com',
      });

      expect(rowsById[account.id].login).toBe('acme_account');
      expect(rowsById[account.id].algorithm).toBe('MD5');
    });

    test('writes phone through to the row', async () => {
      const account = await createAccount({
        authid: 'acme_account',
        domain: 'sip.example.com',
        passwordHash: 'hashed',
        phone: '+15551234567',
        expiresAt: addDays(new Date(), 180),
        creatorId: 7,
        email: 'acme@example.com',
      });

      expect(rowsById[account.id].phone).toBe('+15551234567');
    });

    test('formats creazione/scadenza as YYYY-MM-DD strings, not Date objects', async () => {
      const expiresAt = addDays(new Date(), 180);
      const account = await createAccount({
        authid: 'acme_account',
        domain: 'sip.example.com',
        passwordHash: 'hashed',
        phone: '+15551234567',
        expiresAt,
        creatorId: 7,
        email: 'acme@example.com',
      });

      expect(rowsById[account.id].creazione).toBe(dateOnly(new Date()));
      expect(rowsById[account.id].scadenza).toBe(dateOnly(expiresAt));
      expect(account.created_at).toBe(dateOnly(new Date()));
      expect(account.expires_at).toBe(dateOnly(expiresAt));
    });
  });

  describe('computed status', () => {
    async function seed({ scadenzaOffsetDays, disabled }) {
      const account = await createAccount({
        authid: 'user1',
        domain: 'sip.example.com',
        passwordHash: 'hashed',
        phone: '+15551234567',
        expiresAt: addDays(new Date(), scadenzaOffsetDays),
        creatorId: 7,
        email: 'user1@example.com',
      });
      if (disabled) {
        await disableAccount(account.id, {});
      }
      return getAccountById(account.id, {});
    }

    test('active: scadenza in the future, not disabled', async () => {
      const account = await seed({ scadenzaOffsetDays: 30 });
      expect(account.status).toBe('active');
    });

    test('active: scadenza is exactly today (boundary - not strictly less than CURDATE())', async () => {
      const account = await seed({ scadenzaOffsetDays: 0 });
      expect(account.status).toBe('active');
    });

    test('expired: scadenza in the past, not disabled', async () => {
      const account = await seed({ scadenzaOffsetDays: -1 });
      expect(account.status).toBe('expired');
    });

    test('disabled: disabled_at set, even with a future scadenza', async () => {
      const account = await seed({ scadenzaOffsetDays: 30, disabled: true });
      expect(account.status).toBe('disabled');
    });

    test('disabled overrides expired: disabled_at set and scadenza in the past', async () => {
      const account = await seed({ scadenzaOffsetDays: -1, disabled: true });
      expect(account.status).toBe('disabled');
    });
  });

  describe('listAccounts', () => {
    beforeEach(async () => {
      await createAccount({
        authid: 'active_one',
        domain: 'sip.example.com',
        passwordHash: 'hashed',
        phone: '+15551111111',
        expiresAt: addDays(new Date(), 30),
        creatorId: 7,
        email: 'a@example.com',
      });
      const expiredAccount = await createAccount({
        authid: 'expired_one',
        domain: 'sip.example.com',
        passwordHash: 'hashed',
        phone: '+15552222222',
        expiresAt: addDays(new Date(), -30),
        creatorId: 8,
        email: 'b@example.com',
      });
      await disableAccount(
        (
          await createAccount({
            authid: 'disabled_one',
            domain: 'other.example.com',
            passwordHash: 'hashed',
            phone: '+15553333333',
            expiresAt: addDays(new Date(), 30),
            creatorId: 7,
            email: 'c@example.com',
          })
        ).id,
        {}
      );
      void expiredAccount;
    });

    test('filters by computed status via HAVING, not a stored column', async () => {
      const expired = await listAccounts({}, { status: 'expired' });
      expect(expired).toHaveLength(1);
      expect(expired[0].authid).toBe('expired_one');

      const disabled = await listAccounts({}, { status: 'disabled' });
      expect(disabled).toHaveLength(1);
      expect(disabled[0].authid).toBe('disabled_one');

      const active = await listAccounts({}, { status: 'active' });
      expect(active).toHaveLength(1);
      expect(active[0].authid).toBe('active_one');
    });

    test('filters by search term across authid/domain', async () => {
      const results = await listAccounts({}, { search: 'other.example' });
      expect(results).toHaveLength(1);
      expect(results[0].authid).toBe('disabled_one');
    });

    test('scopes to a single reseller via creator_id', async () => {
      const results = await listAccounts({ creator_id: 8 }, {});
      expect(results).toHaveLength(1);
      expect(results[0].authid).toBe('expired_one');
    });
  });

  test('findAccountByAuthid finds an existing account and returns null otherwise', async () => {
    const created = await createAccount({
      authid: 'findme',
      domain: 'sip.example.com',
      passwordHash: 'hashed',
      phone: '+15551234567',
      expiresAt: addDays(new Date(), 30),
      creatorId: 7,
      email: 'findme@example.com',
    });

    expect((await findAccountByAuthid('findme')).id).toBe(created.id);
    expect(await findAccountByAuthid('nobody')).toBeNull();
  });

  test('findAccountLabelsByIds resolves authid@domain labels in bulk', async () => {
    const a = await createAccount({
      authid: 'alice',
      domain: 'sip.example.com',
      passwordHash: 'hashed',
      phone: '+15551234567',
      expiresAt: addDays(new Date(), 30),
      creatorId: 7,
      email: 'alice@example.com',
    });
    const b = await createAccount({
      authid: 'bob',
      domain: 'sip.example.com',
      passwordHash: 'hashed',
      phone: '+15559876543',
      expiresAt: addDays(new Date(), 30),
      creatorId: 7,
      email: 'bob@example.com',
    });

    const labels = await findAccountLabelsByIds([a.id, b.id]);
    expect(labels[a.id]).toBe('alice@sip.example.com');
    expect(labels[b.id]).toBe('bob@sip.example.com');
  });

  test('findAccountLabelsByIds returns {} for an empty id list without querying', async () => {
    flexisipPool.query.mockClear();
    expect(await findAccountLabelsByIds([])).toEqual({});
    expect(flexisipPool.query).not.toHaveBeenCalled();
  });

  test('renewAccount updates scadenza/renewed_at and the computed status reflects it', async () => {
    const created = await createAccount({
      authid: 'renewme',
      domain: 'sip.example.com',
      passwordHash: 'hashed',
      phone: '+15551234567',
      expiresAt: addDays(new Date(), -10),
      creatorId: 7,
      email: 'renewme@example.com',
    });
    expect((await getAccountById(created.id, {})).status).toBe('expired');

    const newExpiry = addDays(new Date(), 180);
    const renewed = await renewAccount(created.id, {}, newExpiry);

    expect(renewed.expires_at).toBe(dateOnly(newExpiry));
    expect(renewed.status).toBe('active');
    expect(renewed.renewed_at).not.toBeNull();
  });

  test('renewAccount returns null when the account is out of scope', async () => {
    const created = await createAccount({
      authid: 'scoped',
      domain: 'sip.example.com',
      passwordHash: 'hashed',
      phone: '+15551234567',
      expiresAt: addDays(new Date(), 30),
      creatorId: 7,
      email: 'scoped@example.com',
    });

    expect(await renewAccount(created.id, { creator_id: 999 }, addDays(new Date(), 30))).toBeNull();
  });

  test('disableAccount sets disabled_at and computed status becomes disabled', async () => {
    const created = await createAccount({
      authid: 'disableme',
      domain: 'sip.example.com',
      passwordHash: 'hashed',
      phone: '+15551234567',
      expiresAt: addDays(new Date(), 30),
      creatorId: 7,
      email: 'disableme@example.com',
    });

    const disabled = await disableAccount(created.id, {});
    expect(disabled.status).toBe('disabled');
    expect(disabled.disabled_at).not.toBeNull();
  });

  test('reassignAccountCreator updates creator_id', async () => {
    const created = await createAccount({
      authid: 'reassignme',
      domain: 'sip.example.com',
      passwordHash: 'hashed',
      phone: '+15551234567',
      expiresAt: addDays(new Date(), 30),
      creatorId: 7,
      email: 'reassignme@example.com',
    });

    const reassigned = await reassignAccountCreator(created.id, 42);
    expect(reassigned.creator_id).toBe(42);
  });

  test('updateAccountPassword updates the stored password hash', async () => {
    const created = await createAccount({
      authid: 'passme',
      domain: 'sip.example.com',
      passwordHash: 'old-hash',
      phone: '+15551234567',
      expiresAt: addDays(new Date(), 30),
      creatorId: 7,
      email: 'passme@example.com',
    });

    expect(await updateAccountPassword(created.id, {}, 'new-hash')).toBe(true);
    expect(rowsById[created.id].password).toBe('new-hash');
  });

  test('deleteAccount removes the row and returns false on a second delete', async () => {
    const created = await createAccount({
      authid: 'deleteme',
      domain: 'sip.example.com',
      passwordHash: 'hashed',
      phone: '+15551234567',
      expiresAt: addDays(new Date(), 30),
      creatorId: 7,
      email: 'deleteme@example.com',
    });

    expect(await deleteAccount(created.id)).toBe(true);
    expect(await deleteAccount(created.id)).toBe(false);
  });
});
