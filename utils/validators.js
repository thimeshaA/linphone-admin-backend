const { isCommonPassword } = require('./commonPasswords');

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 128;

function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function isValidUsername(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value);
}

// Length over forced complexity - long passwords resist brute-force better
// than mixed-case/special-character rules, which mostly just push people
// toward predictable substitutions (e.g. "Password1!"). Returns null when
// valid, or a user-facing error string when not.
function isValidPassword(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return 'password is required';
  }
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    return `password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  if (isCommonPassword(value)) {
    return 'password is too common - please choose a less predictable one';
  }
  return null;
}

module.exports = { isValidEmail, isValidUsername, isValidPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH };
