// Flexisip's SIP realm, confirmed with Ahmed - the production system hashes
// every password as SHA-256(`${authid}:${SIP_REALM}:${password}`) against
// this exact literal (note the "1" in "flexi1"), and this is the only realm
// in use. Deliberately NOT an env var: a misconfigured value here would
// silently produce hashes that can't sign in, and there is currently no
// legitimate reason for it to differ across environments.
const SIP_REALM = 'flexi1.kryptoline.com';

module.exports = { SIP_REALM };
