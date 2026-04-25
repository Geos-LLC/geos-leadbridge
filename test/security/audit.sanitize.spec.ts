/**
 * Audit log sanitization unit tests — Phase 2.
 *
 * Covers the masking helpers and `sanitizeReason` that protect the audit log
 * from accidentally storing PII or secrets in free-text fields.
 */

import { maskPhone, maskEmail, sanitizeReason } from '../../src/common/audit/sanitize';

describe('maskPhone', () => {
  it('masks US-format numbers to last 4 digits', () => {
    expect(maskPhone('+1 (555) 123-4567')).toBe('***4567');
    expect(maskPhone('+15551234567')).toBe('***4567');
    expect(maskPhone('555-123-4567')).toBe('***4567');
  });

  it('returns *** for inputs with fewer than 4 digits', () => {
    expect(maskPhone('12')).toBe('***');
    expect(maskPhone('')).toBe('***');
  });
});

describe('maskEmail', () => {
  it('masks to first letter + domain', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@example.com');
    expect(maskEmail('x@y.z')).toBe('x***@y.z');
  });

  it('returns *** for inputs without an @', () => {
    expect(maskEmail('no-at-sign')).toBe('***');
    expect(maskEmail('@no-user.com')).toBe('***');
  });
});

describe('sanitizeReason', () => {
  it('returns null for nullish/empty inputs', () => {
    expect(sanitizeReason(null)).toBeNull();
    expect(sanitizeReason(undefined)).toBeNull();
    expect(sanitizeReason('')).toBeNull();
    expect(sanitizeReason('   ')).toBeNull();
  });

  it('returns null for non-string inputs', () => {
    expect(sanitizeReason(42 as any)).toBeNull();
    expect(sanitizeReason({} as any)).toBeNull();
  });

  it('masks an embedded email address', () => {
    const out = sanitizeReason('user complained about alice@example.com');
    expect(out).toContain('a***@example.com');
    expect(out).not.toContain('alice@example.com');
  });

  it('masks an embedded phone number', () => {
    const out = sanitizeReason('callback to +1 (555) 123-4567');
    expect(out).toContain('***4567');
    expect(out).not.toContain('555');
  });

  it('redacts a Bearer token entirely', () => {
    expect(sanitizeReason('Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig')).toBe('[redacted-bearer]');
  });

  it('redacts a long opaque token-like string entirely', () => {
    // Solid 40+ char alphanumeric/underscore/hyphen blob — token shape.
    expect(sanitizeReason('ya29A0ARrdaMLongRandomLookingTokenStringThatExceedsForty')).toBe('[redacted-token]');
  });

  it('truncates very long inputs that are not token-shaped', () => {
    // Long text with spaces does NOT match the token redaction regex,
    // so it should be truncated to MAX_REASON_LENGTH instead.
    const long = 'something happened '.repeat(50);
    const out = sanitizeReason(long)!;
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out.endsWith('…')).toBe(true);
  });
});
