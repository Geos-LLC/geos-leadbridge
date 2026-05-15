/**
 * Single source of truth for resolving an account's wall-clock timezone.
 *
 * Resolution order (each is skipped if null / empty / whitespace):
 *   1. SavedAccount.timezoneOverride    — canonical per-account override
 *   2. SavedAccount.followUpTimezone    — DEPRECATED legacy column (read-only fallback)
 *   3. User.timezone                    — canonical user-level master
 *   4. User.businessHoursTimezone       — DEPRECATED legacy fallback
 *   5. User.quietHoursTimezone          — DEPRECATED legacy fallback
 *   6. 'America/New_York'               — last-resort literal
 *
 * Use this helper EVERY time you need to interpret wall-clock times for an
 * account — active-hours snap, quiet-hours snap, AI prompt clock, notification
 * gating, daily-summary boundaries, etc.
 *
 * Do NOT hardcode 'America/New_York' in new code. Even when it matches today's
 * customer cohort it's a silent correctness trap the first time a non-NY
 * account ships — the scheduler will read a different TZ than the AI prompt
 * which will read a different TZ than the SMS gating, and only one of them
 * will be right.
 *
 * Writes MUST target the canonical columns (`SavedAccount.timezoneOverride` and
 * `User.timezone`). Steps 2/4/5 above only exist to keep pre-migration rows
 * working until those legacy columns are dropped in a follow-up PR. Per-feature
 * TZ columns (NotificationSettings.quietHoursTimezone, AutomationRule.activeHoursTimezone,
 * CallConnectSettings.quietHoursTimezone, FollowUpSequenceTemplate.activeHoursTimezone)
 * are also slated for removal.
 */

export const DEFAULT_TIMEZONE = 'America/New_York';

interface AccountTimezoneFields {
  /** Canonical per-account override. Prefer this on new writes. */
  timezoneOverride?: string | null;
  /** Legacy — read fallback only. */
  followUpTimezone?: string | null;
}

interface UserTimezoneFields {
  /** Canonical user-level master. Prefer this on new writes. */
  timezone?: string | null;
  /** Legacy — read fallback only. */
  businessHoursTimezone?: string | null;
  /** Legacy — read fallback only. */
  quietHoursTimezone?: string | null;
}

/**
 * Pure resolver — pass the SavedAccount row (or null) and optionally the User
 * row, get back the canonical IANA timezone for that account.
 *
 * The pure shape matters: every caller already has at least one of these
 * rows in hand from its surrounding query. Asking it to pass them in keeps
 * this helper synchronous and trivially testable, and avoids duplicate DB
 * round-trips.
 */
export function resolveTimezone(
  account?: AccountTimezoneFields | null,
  user?: UserTimezoneFields | null,
): string {
  const acctOverride = account?.timezoneOverride?.trim();
  if (acctOverride) return acctOverride;
  const acctLegacy = account?.followUpTimezone?.trim();
  if (acctLegacy) return acctLegacy;
  const userMaster = user?.timezone?.trim();
  if (userMaster) return userMaster;
  const userBh = user?.businessHoursTimezone?.trim();
  if (userBh) return userBh;
  const userQh = user?.quietHoursTimezone?.trim();
  if (userQh) return userQh;
  return DEFAULT_TIMEZONE;
}
