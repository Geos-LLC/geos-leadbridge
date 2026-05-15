/**
 * Pins the resolution order of the canonical account-timezone helper.
 *
 * Resolution order (precedence, top wins):
 *   1. SavedAccount.timezoneOverride    — canonical per-account override
 *   2. SavedAccount.followUpTimezone    — legacy read fallback (deprecated)
 *   3. User.timezone                    — canonical user-level master
 *   4. User.businessHoursTimezone       — legacy read fallback (deprecated)
 *   5. User.quietHoursTimezone          — legacy read fallback (deprecated)
 *   6. 'America/New_York'               — last-resort literal
 *
 * This file guards both the canonical-column-wins direction (rows that
 * exist on the new columns must beat any legacy value on the same row)
 * and the legacy-fallback direction (pre-migration rows that still only
 * have legacy values must keep resolving to those values until the
 * follow-up "drop legacy columns" PR lands).
 *
 * Why the second direction matters: the migration that introduces the new
 * columns backfills from legacy values, but a row that was created
 * BEFORE the migration ran but RE-READ AFTER it ran would have NULL on
 * the new columns and non-null on the legacy ones. The fallback chain
 * lets those rows continue to resolve correctly during the transition.
 */

import { DEFAULT_TIMEZONE, resolveTimezone } from './account-timezone';

describe('resolveTimezone — canonical-column precedence', () => {
  it('returns SavedAccount.timezoneOverride when set, regardless of legacy', () => {
    expect(
      resolveTimezone(
        { timezoneOverride: 'America/Los_Angeles', followUpTimezone: 'America/Chicago' },
        { timezone: 'Europe/London', businessHoursTimezone: 'Europe/Paris', quietHoursTimezone: 'Europe/Berlin' },
      ),
    ).toBe('America/Los_Angeles');
  });

  it('returns User.timezone when no account-level value is set', () => {
    expect(
      resolveTimezone(
        { timezoneOverride: null, followUpTimezone: null },
        { timezone: 'Europe/London', businessHoursTimezone: 'Europe/Paris' },
      ),
    ).toBe('Europe/London');
  });

  it('prefers canonical User.timezone over legacy User.businessHoursTimezone when both set', () => {
    expect(
      resolveTimezone(
        null,
        { timezone: 'America/Phoenix', businessHoursTimezone: 'America/Chicago' },
      ),
    ).toBe('America/Phoenix');
  });

  it('prefers User.timezone over User.quietHoursTimezone when both set', () => {
    expect(
      resolveTimezone(
        null,
        { timezone: 'America/Phoenix', quietHoursTimezone: 'America/Chicago' },
      ),
    ).toBe('America/Phoenix');
  });
});

describe('resolveTimezone — legacy column fallback (transition window)', () => {
  it('falls back to SavedAccount.followUpTimezone when timezoneOverride is null', () => {
    // Pre-migration row: only the legacy column has a value. Resolver still works.
    expect(
      resolveTimezone(
        { timezoneOverride: null, followUpTimezone: 'America/Los_Angeles' },
        { timezone: 'Europe/London' },
      ),
    ).toBe('America/Los_Angeles');
  });

  it('falls back to User.businessHoursTimezone when both canonical columns are null', () => {
    expect(
      resolveTimezone(
        { timezoneOverride: null, followUpTimezone: null },
        { timezone: null, businessHoursTimezone: 'America/Chicago' },
      ),
    ).toBe('America/Chicago');
  });

  it('falls back to User.quietHoursTimezone when business-hours legacy is also null', () => {
    expect(
      resolveTimezone(
        null,
        { timezone: null, businessHoursTimezone: null, quietHoursTimezone: 'America/Denver' },
      ),
    ).toBe('America/Denver');
  });

  it('account-level legacy beats user-level master (per-account intent dominates)', () => {
    // A row written before the migration that explicitly set followUpTimezone
    // overrode the user master. Preserve that intent until the column is dropped.
    expect(
      resolveTimezone(
        { followUpTimezone: 'America/Los_Angeles' },
        { timezone: 'Europe/London' },
      ),
    ).toBe('America/Los_Angeles');
  });
});

describe('resolveTimezone — null / empty / whitespace guards', () => {
  it('returns DEFAULT when every input is null', () => {
    expect(resolveTimezone(null, null)).toBe(DEFAULT_TIMEZONE);
  });

  it('returns DEFAULT when called with no args', () => {
    expect(resolveTimezone()).toBe(DEFAULT_TIMEZONE);
  });

  it('returns DEFAULT when every input is empty string', () => {
    expect(
      resolveTimezone(
        { timezoneOverride: '', followUpTimezone: '' },
        { timezone: '', businessHoursTimezone: '', quietHoursTimezone: '' },
      ),
    ).toBe(DEFAULT_TIMEZONE);
  });

  it('skips whitespace-only values (they would crash Intl.DateTimeFormat)', () => {
    expect(
      resolveTimezone(
        { timezoneOverride: '   ', followUpTimezone: '\t' },
        { timezone: ' ', businessHoursTimezone: 'America/Chicago' },
      ),
    ).toBe('America/Chicago');
  });

  it('DEFAULT_TIMEZONE is America/New_York (literal anchor, not derived)', () => {
    // Pinned literal — if this value ever changes the migration also needs to
    // backfill every account whose null fallback was relying on it.
    expect(DEFAULT_TIMEZONE).toBe('America/New_York');
  });
});
