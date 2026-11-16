const crypto = require('crypto');

const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

// Published verbatim in this feature's spec as the fixed test vector key -
// anyone can read it, so it must never protect real data. If it ever ends up
// configured in a production environment (copy-pasted from docs, a stale
// .env committed by mistake, etc.) requests must fail loudly instead of
// silently encrypting QR payloads with a key the whole world already has.
const TEST_KEY = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');

class QrKeyError extends Error {}

function isValidBase64(value) {
  return typeof value === 'string' && value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

// Re-reads and re-validates QR_ENCRYPTION_KEY on every call rather than
// caching it at module load - this must fail at request time (not just at
// boot) so callers can turn a bad key into a clean rejection of the specific
// request that needed it, per the "no DB write on a bad key" requirement.
function resolveQrEncryptionKey() {
  const raw = process.env.QR_ENCRYPTION_KEY;
  if (!raw) {
    throw new QrKeyError('QR_ENCRYPTION_KEY is not set');
  }
  if (!isValidBase64(raw)) {
    throw new QrKeyError('QR_ENCRYPTION_KEY is not valid base64');
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new QrKeyError(`QR_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH} bytes`);
  }

  if (process.env.NODE_ENV === 'production' && key.length === TEST_KEY.length && crypto.timingSafeEqual(key, TEST_KEY)) {
    throw new QrKeyError('QR_ENCRYPTION_KEY must not be the published test key in production');
  }

  return key;
}

// The one place the plaintext QR structure is defined - exactly the two
// members Ahmed's Swift app expects (it turns the decrypted JSON into a
// String:String dictionary, so any extra field or non-string value breaks
// it). Every caller goes through this function rather than building the
// object inline.
function buildQrContent({ username, password }) {
  return { username, password };
}

// Low-level primitive: AES-256-GCM, no AAD, standard (padded) base64 of
// nonce || ciphertext || tag - matching Ahmed's Python encrypt_string and
// readable directly by Swift's AES.GCM.SealedBox(combined:). `nonce` is only
// ever overridden by tests reproducing a fixed vector; real callers always
// let this default to a fresh random value, never reused across calls.
function encryptString(plaintext, { nonce } = {}) {
  const key = resolveQrEncryptionKey();
  const iv = nonce || crypto.randomBytes(NONCE_LENGTH);
  if (iv.length !== NONCE_LENGTH) {
    throw new QrKeyError(`QR nonce must be ${NONCE_LENGTH} bytes`);
  }

  const plaintextBuf = Buffer.from(plaintext, 'utf8');

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, ciphertext, tag]).toString('base64');
}

function decryptString(text) {
  if (typeof text !== 'string') {
    throw new QrKeyError('QR payload must be a string');
  }

  const key = resolveQrEncryptionKey();
  const combined = Buffer.from(text, 'base64');
  if (combined.length < NONCE_LENGTH + TAG_LENGTH) {
    throw new QrKeyError('QR payload is malformed');
  }

  const iv = combined.subarray(0, NONCE_LENGTH);
  const tag = combined.subarray(combined.length - TAG_LENGTH);
  const ciphertext = combined.subarray(NONCE_LENGTH, combined.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

function encryptQrContent({ username, password }, options) {
  return encryptString(JSON.stringify(buildQrContent({ username, password })), options);
}

function decryptQrContent(text) {
  return JSON.parse(decryptString(text));
}

module.exports = {
  QrKeyError,
  resolveQrEncryptionKey,
  buildQrContent,
  encryptString,
  decryptString,
  encryptQrContent,
  decryptQrContent,
};
