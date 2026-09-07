// A small, local, bundled list of extremely common/leaked passwords - checked
// in-process, never against a third-party breached-password API (that would
// be a third-party runtime dependency, against this project's no-outsource
// policy). Not exhaustive; it exists to reject the most obviously predictable
// passwords, not to replace the length requirement as the primary defense.
const COMMON_PASSWORDS = [
  '123456', '123456789', '12345678', '12345', '1234567', '1234567890', '1234567891',
  '1234', '12345678910', '111111', '000000', '222222', '333333', '444444', '555555',
  '666666', '777777', '888888', '999999', '121212', '112233', '123123', '123123123',
  '654321', '696969', '789456', '987654321', '159753', '147258369', '110110',

  'password', 'password1', 'password12', 'password123', 'passw0rd', 'passw0rd1',
  'password1!', 'p@ssword', 'p@ssw0rd', 'pa55word', 'pass1234', 'pass123',
  'iloveyou', 'iloveyou1', 'iloveyou2', 'letmein', 'letmein1', 'letmein123',
  'welcome', 'welcome1', 'welcome123', 'admin', 'admin123', 'admin1234',
  'administrator', 'root', 'toor', 'changeme', 'changeme123', 'default',
  'guest', 'guest123', 'temp123', 'temppass', 'test123', 'test1234', 'testing123',
  'secret', 'secret123', 'access', 'access123', 'login', 'login123',

  'qwerty', 'qwerty1', 'qwerty12', 'qwerty123', 'qwertyuiop', 'qwertyui',
  'asdfghjkl', 'asdfgh', 'asdf1234', 'zxcvbnm', 'zxcvbn', '1qaz2wsx',
  '1qaz2wsx3edc', 'qazwsx', 'qazwsx123', '1q2w3e4r', '1q2w3e4r5t', '1q2w3e',
  'zaq12wsx', 'q1w2e3r4', 'poiuytrewq',

  'dragon', 'dragon123', 'monkey', 'monkey1', 'monkey123', 'football', 'football1',
  'baseball', 'baseball1', 'basketball', 'soccer', 'master', 'master123',
  'shadow', 'shadow1', 'superman', 'batman', 'trustno1', 'ninja', 'ninja123',
  'mustang', 'michael', 'jennifer', 'jordan', 'jordan23', 'hunter', 'hunter2',
  'freedom', 'whatever', 'summer', 'summer123', 'winter', 'winter123', 'spring',
  'autumn', 'sunshine', 'sunshine1', 'princess', 'princess1', 'flower', 'flower1',
  'starwars', 'pokemon', 'minecraft', 'yankees', 'cheese', 'chocolate',

  'abc123', 'abc12345', 'a1b2c3', 'aa123456', '654321a', '123qwe', '123abc',
  'q1w2e3r4t5', 'qwe123', 'qweasd', 'qweasdzxc', 'zxc123',

  'welcome1!', 'welcome123!', 'admin123!', 'password123!', 'password1!', 'p@ssw0rd!',
  'passw0rd!', 'welcome@123', 'admin@123', 'test@123', 'india123', 'lanka123',

  'nicole', 'daniel', 'babygirl', 'monica', 'jessica', 'ashley', 'amanda',
  'joshua', 'andrew', 'tigger', 'buster', 'charlie', 'thomas', 'robert',
  'jasmine', 'michelle', 'lauren', 'hannah', 'chelsea', 'internet',
  'samsung', 'gemini', 'aaaaaa', 'bbbbbb', 'passme', 'nopassword',

  'lovely', 'sweety', 'baby123', 'iloveu', 'iloveu1', 'iloveyou123', 'ihateyou',

  '00000000', '11111111', '99999999', '87654321', '13131313', '10203040',
  '19921992', '19931993', '20002000', '20222022', '20232023', '20242024',
  '20252025', '20262026',
];

const COMMON_PASSWORD_SET = new Set(COMMON_PASSWORDS.map((p) => p.toLowerCase()));

function isCommonPassword(password) {
  return typeof password === 'string' && COMMON_PASSWORD_SET.has(password.toLowerCase());
}

module.exports = { isCommonPassword };
