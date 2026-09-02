const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const YEAR_RE = /^\d{4}$/;

function parsePeriod({ period, month, year }) {
  if (period !== 'monthly' && period !== 'annual') {
    return { error: 'period is required and must be "monthly" or "annual"' };
  }

  if (period === 'monthly') {
    const match = MONTH_RE.exec(month || '');
    if (!match) {
      return { error: 'month is required and must be in YYYY-MM format for a monthly report' };
    }

    const y = Number(match[1]);
    const m = Number(match[2]);
    if (m < 1 || m > 12) {
      return { error: 'month must be in YYYY-MM format with a month between 01 and 12' };
    }

    return {
      start: new Date(y, m - 1, 1),
      end: new Date(y, m, 1),
      label: `${MONTH_NAMES[m - 1]} ${y}`,
      slug: month,
    };
  }

  if (!YEAR_RE.test(year || '')) {
    return { error: 'year is required and must be in YYYY format for an annual report' };
  }

  const y = Number(year);
  return {
    start: new Date(y, 0, 1),
    end: new Date(y + 1, 0, 1),
    label: `Year ${y}`,
    slug: year,
  };
}

module.exports = { parsePeriod };
