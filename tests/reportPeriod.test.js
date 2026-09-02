const { parsePeriod } = require('../utils/reportPeriod');

describe('parsePeriod', () => {
  test('rejects a missing period', () => {
    expect(parsePeriod({})).toEqual({ error: expect.any(String) });
  });

  test('rejects an unrecognized period value', () => {
    expect(parsePeriod({ period: 'weekly', month: '2026-08' })).toEqual({ error: expect.any(String) });
  });

  test('monthly: rejects a missing month', () => {
    expect(parsePeriod({ period: 'monthly' })).toEqual({ error: expect.any(String) });
  });

  test('monthly: rejects a malformed month', () => {
    expect(parsePeriod({ period: 'monthly', month: '2026-8' })).toEqual({ error: expect.any(String) });
    expect(parsePeriod({ period: 'monthly', month: '2026-13' })).toEqual({ error: expect.any(String) });
    expect(parsePeriod({ period: 'monthly', month: 'not-a-month' })).toEqual({ error: expect.any(String) });
  });

  test('monthly: computes a half-open [start, end) range and a human label', () => {
    const result = parsePeriod({ period: 'monthly', month: '2026-08' });

    expect(result.error).toBeUndefined();
    expect(result.start).toEqual(new Date(2026, 7, 1));
    expect(result.end).toEqual(new Date(2026, 8, 1));
    expect(result.label).toBe('August 2026');
    expect(result.slug).toBe('2026-08');
  });

  test('monthly: December rolls over into January of the next year', () => {
    const result = parsePeriod({ period: 'monthly', month: '2026-12' });

    expect(result.end).toEqual(new Date(2027, 0, 1));
  });

  test('annual: rejects a missing or malformed year', () => {
    expect(parsePeriod({ period: 'annual' })).toEqual({ error: expect.any(String) });
    expect(parsePeriod({ period: 'annual', year: '26' })).toEqual({ error: expect.any(String) });
    expect(parsePeriod({ period: 'annual', year: 'abcd' })).toEqual({ error: expect.any(String) });
  });

  test('annual: computes a half-open [start, end) range and a human label', () => {
    const result = parsePeriod({ period: 'annual', year: '2026' });

    expect(result.error).toBeUndefined();
    expect(result.start).toEqual(new Date(2026, 0, 1));
    expect(result.end).toEqual(new Date(2027, 0, 1));
    expect(result.label).toBe('Year 2026');
    expect(result.slug).toBe('2026');
  });
});
