const {
  QrKeyError,
  resolveQrEncryptionKey,
  buildQrContent,
  encryptString,
  decryptString,
  encryptQrContent,
  decryptQrContent,
} = require('../utils/qrPayload');

const TEST_KEY_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const TEST_KEY_BASE64 = Buffer.from(TEST_KEY_HEX, 'hex').toString('base64');
const TEST_NONCE_HEX = 'a0a1a2a3a4a5a6a7a8a9aaab';

// Generated with Ahmed's encrypt_string (Python), fixed key + nonce, confirmed
// with Node. The plaintext strings are reproduced byte-for-byte, including
// Python's json.dumps spacing (": ", ", ") and its ensure_ascii \uXXXX escapes
// for vector 2 - these are literal 6-character escape sequences in the
// plaintext bytes, not actual unicode characters, so they're built here with
// an escaped backslash rather than a real template-literal unicode escape.
const VECTOR_1 = {
  plaintext: '{"username": "testuser01", "password": "testpass123"}',
  base64:
    'oKGio6SlpqeoqaqrnToJXiC5bN4PAKXpJ1i0uwPYLGP3xXJdviIGpA/KBnKlGTWbjRhzHyv5d7x5G/CKdil1ah8huU3g9EiMZhhnWDsCrhEK',
};
const VECTOR_2 = {
  plaintext: '{"username": "testuser01", "password": "T\\u00ebst-P\\u00e4ss\\u2713"}',
  base64:
    'oKGio6SlpqeoqaqrnToJXiC5bN4PAKXpJ1i0uwPYLGP3xXJdviIGpA/KBnKlGTWbjRhzHwvAcfg5H+GKMzYWFBfgKht1LXgC0UKygYee+BWzNDSfqmBPyapPd5jie/o=',
};

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  process.env = { ...ORIGINAL_ENV };
}

describe('buildQrContent', () => {
  test('contains only username and password', () => {
    expect(buildQrContent({ username: 'bob', password: 'secret' })).toEqual({
      username: 'bob',
      password: 'secret',
    });
    expect(Object.keys(buildQrContent({ username: 'bob', password: 'secret' }))).toEqual(['username', 'password']);
  });
});

describe('encryptString / decryptString (test vectors)', () => {
  afterEach(restoreEnv);

  beforeEach(() => {
    process.env.QR_ENCRYPTION_KEY = TEST_KEY_BASE64;
  });

  test('vector 1 (ASCII): encrypting the exact plaintext with the fixed nonce reproduces the published base64 exactly', () => {
    const nonce = Buffer.from(TEST_NONCE_HEX, 'hex');
    const result = encryptString(VECTOR_1.plaintext, { nonce });
    expect(result).toBe(VECTOR_1.base64);
  });

  test('vector 1: decrypting the published base64 returns the exact plaintext', () => {
    expect(decryptString(VECTOR_1.base64)).toBe(VECTOR_1.plaintext);
  });

  test('vector 2 (non-ASCII, \\uXXXX-escaped): encrypting the exact plaintext with the fixed nonce reproduces the published base64 exactly', () => {
    const nonce = Buffer.from(TEST_NONCE_HEX, 'hex');
    const result = encryptString(VECTOR_2.plaintext, { nonce });
    expect(result).toBe(VECTOR_2.base64);
  });

  test('vector 2: decrypting the published base64 returns the exact plaintext', () => {
    expect(decryptString(VECTOR_2.base64)).toBe(VECTOR_2.plaintext);
  });

  test('output matches standard padded base64 (A-Za-z0-9+/, "=" padding) with no prefix and length a multiple of 4', () => {
    const result = encryptString('hello world');
    expect(result).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(result.length % 4).toBe(0);
    expect(result.startsWith('v1.')).toBe(false);
  });
});

describe('encryptQrContent / decryptQrContent (JSON round trip)', () => {
  afterEach(restoreEnv);

  beforeEach(() => {
    process.env.QR_ENCRYPTION_KEY = TEST_KEY_BASE64;
  });

  test('round trip gives back exactly { username, password } - two string keys, no v', () => {
    const payload = encryptQrContent({ username: 'alice', password: 'Correct-Horse-9!' });
    const decoded = decryptQrContent(payload);

    expect(decoded).toEqual({ username: 'alice', password: 'Correct-Horse-9!' });
    expect(Object.keys(decoded).sort()).toEqual(['password', 'username']);
    expect(typeof decoded.username).toBe('string');
    expect(typeof decoded.password).toBe('string');
    expect(decoded).not.toHaveProperty('v');
  });

  test('a non-ASCII password round-trips correctly', () => {
    const payload = encryptQrContent({ username: 'alice', password: 'Tëst-Päss✓' });
    expect(decryptQrContent(payload)).toEqual({ username: 'alice', password: 'Tëst-Päss✓' });
  });

  test('two encryptions of the same credentials produce different payloads (fresh random nonce)', () => {
    const a = encryptQrContent({ username: 'alice', password: 'Correct-Horse-9!' });
    const b = encryptQrContent({ username: 'alice', password: 'Correct-Horse-9!' });
    expect(a).not.toBe(b);
  });

  test('a tampered payload fails to decrypt', () => {
    const payload = encryptQrContent({ username: 'alice', password: 'Correct-Horse-9!' });
    const bytes = Buffer.from(payload, 'base64');
    bytes[bytes.length - 1] ^= 0xff;
    const tampered = bytes.toString('base64');

    expect(() => decryptQrContent(tampered)).toThrow();
  });

  test('decrypting with the wrong key fails', () => {
    const payload = encryptQrContent({ username: 'alice', password: 'Correct-Horse-9!' });

    process.env.QR_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

    expect(() => decryptQrContent(payload)).toThrow();
  });

  test('a 20-character username and a 128-character password still produce a single QR-sized payload', () => {
    const username = 'a'.repeat(20);
    const password = 'b'.repeat(128);
    const payload = encryptQrContent({ username, password });

    expect(decryptQrContent(payload)).toEqual({ username, password });
    // Reported to the user rather than silently capped - see the task report.
    // eslint-disable-next-line no-console
    console.info(`QR payload length at 20-char username / 128-char password: ${payload.length} chars`);
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
