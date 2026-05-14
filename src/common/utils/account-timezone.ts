/**
 * Single source of truth for resolving an account's wall-clock timezone.
 *
 * Resolution order (each is skipped if null / empty / whitespace):
 *   1. SavedAccount.followUpTimezone — set via the Services UI
 *   2. User.businessHoursTimezone    — user-level default
 *   3. 'America/New_York'            — last-resort literal
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
 * Per-feature TZ columns (NotificationSettings.quietHoursTimezone,
 * AutomationRule.activeHoursTimezone, CallConnectSettings.quietHoursTimezone,
 * FollowUpSequenceTemplate.activeHoursTimezone) are slated for removal — they
 * predate this consolidation and are kept as read-only fallbacks until every
 * call site here is migrated. New code MUST resolve TZ through this helper.
 */

export const DEFAULT_TIMEZONE = 'America/New_York';

interface AccountTimezoneFields {
  followUpTimezone?: string | null;
}

interface UserTimezoneFields {
  businessHoursTimezone?: string | null;
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
  const acctTz = account?.followUpTimezone?.trim();
  if (acctTz) return acctTz;
  const userTz = user?.businessHoursTimezone?.trim();
  if (userTz) return userTz;
  return DEFAULT_TIMEZONE;
}
