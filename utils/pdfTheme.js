// Mirrors the frontend's design tokens (linphone-admin-frontend/styles/globals.css).
// That palette is deliberately five colours with no dedicated red/amber, so
// "expiring" borrows the SIP-identity orange and "disabled" stays grayscale.
const PRODUCT_NAME = 'SIP Admin Control';

const INK = '#090909';
const PAPER = '#FFFFFF';
const BORDER = '#e5e5e5';
const ROW_STRIPE = '#f7f7f7';
const ACCENT = '#ABF43F';
// Second brand accent, exposed separately from TONES.warning: used decoratively
// (cover art, alternating card/bar accents) where "orange" doesn't imply "warning".
const ORANGE = '#F0793F';

const TONES = {
  success: { fill: '#ABF43F', text: '#4a7c15', tint: '#f3fce3' },
  warning: { fill: '#F0793F', text: '#a34410', tint: '#fdede4' },
  neutral: { fill: '#c9c9c9', text: INK, tint: '#f2f2f2' },
};

module.exports = { PRODUCT_NAME, INK, PAPER, BORDER, ROW_STRIPE, ACCENT, ORANGE, TONES };
