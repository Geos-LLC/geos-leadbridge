import { parseDuration } from './parse-duration';

describe('parseDuration', () => {
  // Long form — what the followUpSteps[].delay field stores.
  describe('long form', () => {
    it.each([
      ['1 min', 1],
      ['2 min', 2],
      ['30 min', 30],
      ['30 minutes', 30],
      ['1 hour', 60],
      ['3 hours', 180],
      ['1 day', 1440],
      ['3 days', 3 * 1440],
      ['1 week', 10080],
      ['2 weeks', 2 * 10080],
      ['1 month', 43200],
      ['1 year', 525600],
    ])('parses "%s" → %i min', (input, expected) => {
      expect(parseDuration(input)).toBe(expected);
    });
  });

  // Compact form — what fuReEnrollDelay / aiDeferralDelay / aiHiredCompetitorDelay store.
  // This is exactly the case the old parseDelayString got wrong: "24h" → 24
  // instead of 1440 because `"24h".includes("hr")` is false.
  describe('compact form', () => {
    it.each([
      ['24h', 1440],
      ['1h', 60],
      ['1d', 1440],
      ['3d', 3 * 1440],
      ['1w', 10080],
      ['2w', 2 * 10080],
      ['30m', 30],
      ['60d', 60 * 1440],
      ['1y', 525600],
    ])('parses "%s" → %i min', (input, expected) => {
      expect(parseDuration(input)).toBe(expected);
    });
  });

  // The m-prefix group needs care — "min" vs "month" vs bare "m".
  describe('m-prefix disambiguation', () => {
    it.each([
      ['1m', 1],
      ['30m', 30],
      ['1 min', 1],
      ['1 minute', 1],
      ['1 minutes', 1],
      ['1mo', 43200],
      ['1 mo', 43200],
      ['1 month', 43200],
      ['3 months', 3 * 43200],
    ])('parses "%s" → %i min', (input, expected) => {
      expect(parseDuration(input)).toBe(expected);
    });
  });

  describe('whitespace + casing', () => {
    it.each([
      ['  24h  ', 1440],
      ['24 H', 1440],
      ['24H', 1440],
      ['1 HOUR', 60],
      ['1Day', 1440],
    ])('parses "%s" → %i min', (input, expected) => {
      expect(parseDuration(input)).toBe(expected);
    });
  });

  describe('fallback handling', () => {
    it('returns the default fallback (60) when input is empty/null/undefined', () => {
      expect(parseDuration('')).toBe(60);
      expect(parseDuration(null)).toBe(60);
      expect(parseDuration(undefined)).toBe(60);
    });

    it('respects a custom fallback for unset/invalid inputs', () => {
      expect(parseDuration('', 1440)).toBe(1440);
      expect(parseDuration(null, 4320)).toBe(4320);
      expect(parseDuration('garbage', 999)).toBe(999);
    });

    it('returns fallback for zero / negative / non-finite numbers', () => {
      expect(parseDuration('0', 60)).toBe(60);
      expect(parseDuration('0h', 1440)).toBe(1440);
      expect(parseDuration('-5h', 60)).toBe(60);
    });

    it('returns fallback for unrecognised unit', () => {
      expect(parseDuration('5fortnights', 99)).toBe(99);
      expect(parseDuration('1s', 99)).toBe(99);
    });
  });

  // Bare number (no unit) → minutes. Documented behavior for legacy
  // step entries that just store a number.
  describe('bare number', () => {
    it('treats bare numbers as minutes', () => {
      expect(parseDuration('5')).toBe(5);
      expect(parseDuration('60')).toBe(60);
    });

    it('handles decimal minutes by rounding', () => {
      expect(parseDuration('2.4')).toBe(2);
      expect(parseDuration('2.6')).toBe(3);
    });
  });
});
