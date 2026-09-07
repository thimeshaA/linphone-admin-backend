const { isValidPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } = require('../utils/validators');

describe('isValidPassword', () => {
  test('rejects a missing/empty password', () => {
    expect(isValidPassword(undefined)).toBeTruthy();
    expect(isValidPassword('')).toBeTruthy();
  });

  test(`rejects a password shorter than ${MIN_PASSWORD_LENGTH} characters`, () => {
    expect(isValidPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBeTruthy();
  });

  test(`accepts a password exactly ${MIN_PASSWORD_LENGTH} characters long (and not blocklisted)`, () => {
    expect(isValidPassword('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });

  test(`rejects a password longer than ${MAX_PASSWORD_LENGTH} characters`, () => {
    expect(isValidPassword('a'.repeat(MAX_PASSWORD_LENGTH + 1))).toBeTruthy();
  });

  test(`accepts a password exactly ${MAX_PASSWORD_LENGTH} characters long`, () => {
    expect(isValidPassword('a'.repeat(MAX_PASSWORD_LENGTH))).toBeNull();
  });

  test('rejects a common/blocklisted password regardless of length threshold', () => {
    expect(isValidPassword('password123')).toBeTruthy();
    expect(isValidPassword('qwertyuiop')).toBeTruthy();
  });

  test('the blocklist check is case-insensitive', () => {
    expect(isValidPassword('Password123')).toBeTruthy();
    expect(isValidPassword('PASSWORD123')).toBeTruthy();
  });

  test('accepts a long, non-blocklisted password', () => {
    expect(isValidPassword('correct horse battery staple 9!')).toBeNull();
  });

  test('does not enforce forced complexity - a long all-lowercase passphrase is accepted', () => {
    expect(isValidPassword('thisisalongpassphrasewithnospecialchars')).toBeNull();
  });
});
