import { normalizePhoneE164 } from './phone-normalize';

describe('normalizePhoneE164', () => {
  it('null/undefined/empty → null', () => {
    expect(normalizePhoneE164(null)).toBeNull();
    expect(normalizePhoneE164(undefined)).toBeNull();
    expect(normalizePhoneE164('')).toBeNull();
  });

  it('10 raw digits → +1 prefix', () => {
    expect(normalizePhoneE164('5551234567')).toBe('+15551234567');
  });

  it('11 digits starting with 1 → + prefix', () => {
    expect(normalizePhoneE164('15551234567')).toBe('+15551234567');
  });

  it('formatted US phone normalizes', () => {
    expect(normalizePhoneE164('(555) 123-4567')).toBe('+15551234567');
    expect(normalizePhoneE164('555.123.4567')).toBe('+15551234567');
    expect(normalizePhoneE164('555 123 4567')).toBe('+15551234567');
  });

  it('already-E164 normalizes idempotently', () => {
    expect(normalizePhoneE164('+15551234567')).toBe('+15551234567');
  });

  it('international (>11 digits) keeps original digit run', () => {
    expect(normalizePhoneE164('+447911123456')).toBe('+447911123456');
  });

  it('too-short input → null (treated as incomparable)', () => {
    expect(normalizePhoneE164('555')).toBeNull();
    expect(normalizePhoneE164('123456789')).toBeNull();
  });
});
