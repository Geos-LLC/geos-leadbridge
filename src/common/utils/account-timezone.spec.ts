/**
 * Pins the resolution order of the canonical account-timezone helper.
 *
 * Guards against silent regression of the fallback chain:
 *   SavedAccount.followUpTimezone → User.businessHoursTimezone → DEFAULT.
 *
 * Why this is its own test file: the helper is the single source of truth
 * the follow-up engine, scheduler, and any future quiet-hours / active-hours
 * consumer reach for. A subtle precedence change here (e.g. flipping the
 * order, or no longer trimming whitespace) would silently land follow-ups
 * on the wrong wall clock for every account that has different values on
 * the two columns.
 */

import { DEFAULT_TIMEZONE, resolveTimezone } from './account-timezone';

describe('resolveTimezone — single source of truth', () => {
  it('returns SavedAccount.followUpTimezone when set', () => {
    expect(
      resolveTimezone({ followUpTimezone: 'America/Los_Angeles' }, { businessHoursTimezone: 'America/Chicago' }),
    ).toBe('America/Los_Angeles');
  });

  it('falls back to User.businessHoursTimezone when account TZ is null', () => {
    expect(
      resolveTimezone({ followUpTimezone: null }, { businessHoursTimezone: 'America/Chicago' }),
    ).toBe('America/Chicago');
  });

  it('falls back to User.businessHoursTimezone when account TZ is empty string', () => {
    expect(
      resolveTimezone({ followUpTimezone: '' }, { businessHoursTimezone: 'Europe/London' }),
    ).toBe('Europe/London');
  });

  it('falls back to User.businessHoursTimezone when account TZ is whitespace-only', () => {
    // A whitespace string would parse as a valid IANA zone by Intl and produce
    // garbage at format time. The trim guard catches this before propagation.
    expect(
      resolveTimezone({ followUpTimezone: '   ' }, { businessHoursTimezone: 'Europe/London' }),
    ).toBe('Europe/London');
  });

  it('falls back to DEFAULT when both account and user are null', () => {
    expect(resolveTimezone(null, null)).toBe(DEFAULT_TIMEZONE);
  });

  it('falls back to DEFAULT when both are absent (no args)', () => {
    expect(resolveTimezone()).toBe(DEFAULT_TIMEZONE);
  });

  it('falls back to DEFAULT when account is null and user has empty TZ', () => {
    expect(resolveTimezone(null, { businessHoursTimezone: '' })).toBe(DEFAULT_TIMEZONE);
  });

  it('DEFAULT_TIMEZONE is America/New_York (literal anchor, not derived)', () => {
    // Pinned literal — if this value ever changes the migration also needs to
    // backfill every account whose null fallback was relying on it.
    expect(DEFAULT_TIMEZONE).toBe('America/New_York');
  });

  it('prefers account TZ over user TZ even when both are valid', () => {
    // Reaffirms the precedence direction. Reversing the order here would
    // silently override any per-account overrides set via the Services UI.
    expect(
      resolveTimezone(
        { followUpTimezone: 'Pacific/Honolulu' },
        { businessHoursTimezone: 'America/New_York' },
      ),
    ).toBe('Pacific/Honolulu');
  });
});
