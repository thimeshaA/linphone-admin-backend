const {
  QrKeyError,
  resolveQrEncryptionKey,
  buildQrContent,
  encryptQrContent,
  decryptQrContent,
} = require('../utils/qrPayload');

const TEST_KEY_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const TEST_KEY_BASE64 = Buffer.from(TEST_KEY_HEX, 'hex').toString('base64');
const TEST_NONCE_HEX = 'a0a1a2a3a4a5a6a7a8a9aaab';
const EXPECTED_TEST_VECTOR =
  'v1.oKGio6SlpqeoqaqrnToKD3_6Lp0XFuKhaRutu1KWe2T3xDYZ72tUtk6JWSOiFzSM2E0hWX2mJpzK0fCNakuF7BGj-OLSfHa5Eqs-rAAYDtjxfvY9lcT7';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  process.env = { ...ORIGINAL_ENV };
}

describe('buildQrContent', () => {
  afterEach(restoreEnv);

  test('contains only v, username and password', () => {
    expect(buildQrContent({ username: 'bob', password: 'secret' })).toEqual({
      v: 1,
      username: 'bob',
      password: 'secret',
    });
  });
});

describe('encryptQrContent (test vector)', () => {
  afterEach(restoreEnv);

  test('reproduces the published test vector byte for byte with the fixed key and nonce', () => {
    process.env.QR_ENCRYPTION_KEY = TEST_KEY_BASE64;
    const nonce = Buffer.from(TEST_NONCE_HEX, 'hex');

    const result = encryptQrContent({ username: 'testuser01', password: 'Tëst-Päss✓' }, { nonce });

    expect(result).toBe(EXPECTED_TEST_VECTOR);
  });
});

describe('encrypt/decrypt round trip', () => {
  afterEach(restoreEnv);

  beforeEach(() => {
    process.env.QR_ENCRYPTION_KEY = TEST_KEY_BASE64;
  });

  test('decrypting an encrypted payload returns the original username and password', () => {
    const payload = encryptQrContent({ username: 'alice', password: 'Correct-Horse-9!' });
    const decoded = decryptQrContent(payload);

    expect(decoded).toEqual({ v: 1, username: 'alice', password: 'Correct-Horse-9!' });
  });

  test('two encryptions of the same credentials produce different payloads (fresh random nonce)', () => {
    const a = encryptQrContent({ username: 'alice', password: 'Correct-Horse-9!' });
    const b = encryptQrContent({ username: 'alice', password: 'Correct-Horse-9!' });

    expect(a).not.toBe(b);
  });

  test('a tampered payload fails to decrypt', () => {
    const payload = encryptQrContent({ username: 'alice', password: 'Correct-Horse-9!' });
    // Flip a character inside the base64url body (not the "v1." prefix) so
    // the GCM tag no longer authenticates - this must throw, not silently
    // return corrupted data.
    const tampered = payload.slice(0, -1) + (payload.slice(-1) === 'A' ? 'B' : 'A');

    expect(() => decryptQrContent(tampered)).toThrow();
  });

  test('decrypting with the wrong key fails', () => {
    const payload = encryptQrContent({ username: 'alice', password: 'Correct-Horse-9!' });

    process.env.QR_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

    expect(() => decryptQrContent(payload)).toThrow();
  });
});

describe('resolveQrEncryptionKey validation', () => {
  afterEach(restoreEnv);

  test('rejects a missing key', () => {
    delete process.env.QR_ENCRYPTION_KEY;
    expect(() => resolveQrEncryptionKey()).toThrow(QrKeyError);
  });

  test('rejects a non-base64 key', () => {
    process.env.QR_ENCRYPTION_KEY = 'not base64 at all!!';
    expect(() => resolveQrEncryptionKey()).toThrow(QrKeyError);
  });

  test('rejects a key that decodes to the wrong length', () => {
    process.env.QR_ENCRYPTION_KEY = Buffer.alloc(16).toString('base64');
    expect(() => resolveQrEncryptionKey()).toThrow(QrKeyError);
  });

  test('accepts a well-formed 32-byte base64 key outside production', () => {
    process.env.QR_ENCRYPTION_KEY = TEST_KEY_BASE64;
    expect(() => resolveQrEncryptionKey()).not.toThrow();
  });

  test('refuses the published test key when NODE_ENV is production', () => {
    process.env.QR_ENCRYPTION_KEY = TEST_KEY_BASE64;
    process.env.NODE_ENV = 'production';
    expect(() => resolveQrEncryptionKey()).toThrow(QrKeyError);
  });

  test('allows a real key in production', () => {
    process.env.QR_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    process.env.NODE_ENV = 'production';
    expect(() => resolveQrEncryptionKey()).not.toThrow();
  });
});
