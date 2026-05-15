import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { resolveTimezone } from './account-timezone';

const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type Day = typeof ALL_DAYS[number];

const DEFAULT_BH_START = '09:00';
const DEFAULT_BH_END = '18:00';
const DEFAULT_QH_START = '22:00';
const DEFAULT_QH_END = '08:00';
const DEFAULT_TZ = 'America/New_York';

/** Per-day window. `null` = closed that day. */
export type DaySchedule = { start: string; end: string } | null;

/** Full schedule keyed by day-of-week (lowercase 3-letter). */
export type BusinessSchedule = Partial<Record<Day, DaySchedule>>;

/** Default: Mon-Fri 9-18, weekends closed. */
export const DEFAULT_BUSINESS_SCHEDULE: BusinessSchedule = {
  mon: { start: DEFAULT_BH_START, end: DEFAULT_BH_END },
  tue: { start: DEFAULT_BH_START, end: DEFAULT_BH_END },
  wed: { start: DEFAULT_BH_START, end: DEFAULT_BH_END },
  thu: { start: DEFAULT_BH_START, end: DEFAULT_BH_END },
  fri: { start: DEFAULT_BH_START, end: DEFAULT_BH_END },
  sat: null,
  sun: null,
};

@Injectable()
export class BusinessHoursService {
  private readonly logger = new Logger(BusinessHoursService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns true if right now falls inside the user's business-hours window
   * for the current day. Schedule is per-day (each weekday can have its own
   * start/end, or be closed). Defaults (Mon-Fri 9-18 NY, weekends closed)
   * apply when fields are null. Per-feature toggles on SavedAccount are the
   * sole gating mechanism — the user-level enabled flag is not consulted.
   */
  async isInBusinessHours(userId: string, savedAccountId?: string | null): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        timezone: true,                // canonical user-level TZ
        businessHoursTimezone: true,   // legacy fallback (deprecated)
        quietHoursTimezone: true,      // legacy fallback (deprecated)
        businessHoursDays: true,       // per-day schedule JSON
      },
    });
    if (!user) return true;

    let override: any = null;
    let accountForTz: { timezoneOverride?: string | null; followUpTimezone?: string | null } | null = null;
    if (savedAccountId) {
      const acct = await this.prisma.savedAccount.findUnique({
        where: { id: savedAccountId },
        select: {
          businessHoursOverride: true,
          timezoneOverride: true,      // canonical per-account override
          followUpTimezone: true,      // legacy fallback (deprecated)
        },
      });
      override = acct?.businessHoursOverride ?? null;
      accountForTz = acct ?? null;
    }

    const schedule = BusinessHoursService.normalizeSchedule(override?.schedule ?? user.businessHoursDays);
    // Canonical TZ resolution. Precedence (top wins):
    //   1. SavedAccount.timezoneOverride                       (new canonical)
    //   2. SavedAccount.followUpTimezone                       (legacy column)
    //   3. SavedAccount.businessHoursOverride.timezone (JSON)  (legacy JSON field)
    //   4. User.timezone                                       (new canonical)
    //   5. User.businessHoursTimezone / quietHoursTimezone     (legacy columns)
    //   6. 'America/New_York'                                  (literal default)
    //
    // The JSON-nested timezone in businessHoursOverride is folded in as a
    // legacy fallback (step 3) — it was introduced before `timezoneOverride`
    // existed as a top-level column, and rows written through the pre-canonical
    // UI still carry it. New writes target `timezoneOverride` directly.
    const overrideJsonTz = typeof override?.timezone === 'string' && override.timezone.trim()
      ? override.timezone
      : null;
    const tz = resolveTimezone(
      {
        timezoneOverride: accountForTz?.timezoneOverride,
        followUpTimezone: accountForTz?.followUpTimezone ?? overrideJsonTz,
      },
      user,
    );

    const today = BusinessHoursService.currentWeekday(new Date(), tz);
    const day = schedule[today];
    if (!day) return false; // closed today
    return BusinessHoursService.isInTimeRange(new Date(), day.start, day.end, tz);
  }

  /** Coerce stored value into a clean BusinessSchedule. Tolerates legacy shape. */
  static normalizeSchedule(raw: any): BusinessSchedule {
    if (!raw) return DEFAULT_BUSINESS_SCHEDULE;
    // Legacy: ["mon","tue","wed","thu","fri"] — uniform 9-18 across enabled days.
    if (Array.isArray(raw)) {
      const out: BusinessSchedule = {};
      for (const k of ALL_DAYS) {
        out[k] = raw.includes(k) ? { start: DEFAULT_BH_START, end: DEFAULT_BH_END } : null;
      }
      return out;
    }
    if (typeof raw === 'object') {
      const out: BusinessSchedule = {};
      for (const k of ALL_DAYS) {
        const v = (raw as any)[k];
        if (!v) { out[k] = null; continue; }
        const start = typeof v.start === 'string' && /^\d{1,2}:\d{2}$/.test(v.start) ? v.start : DEFAULT_BH_START;
        const end = typeof v.end === 'string' && /^\d{1,2}:\d{2}$/.test(v.end) ? v.end : DEFAULT_BH_END;
        out[k] = { start, end };
      }
      return out;
    }
    return DEFAULT_BUSINESS_SCHEDULE;
  }

  /** Three-letter lowercase weekday key (`mon`..`sun`) for the given instant in tz. */
  static currentWeekday(now: Date, timezone: string): Day {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' });
      const wd = fmt.format(now).toLowerCase().slice(0, 3);
      if ((ALL_DAYS as readonly string[]).includes(wd)) return wd as Day;
    } catch { /* fall through */ }
    return 'mon';
  }

  /** Pure HH:MM range check, overnight-wrap aware. */
  static isInTimeRange(now: Date, start: string, end: string, timezone: string): boolean {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
      const parts = fmt.formatToParts(now);
      const hh = Number(parts.find(p => p.type === 'hour')?.value || '0');
      const mm = Number(parts.find(p => p.type === 'minute')?.value || '0');
      const cur = hh * 60 + mm;
      const [sh, sm] = start.split(':').map(Number);
      const [eh, em] = end.split(':').map(Number);
      const s = sh * 60 + sm;
      const e = eh * 60 + em;
      return s > e ? (cur >= s || cur < e) : (cur >= s && cur < e);
    } catch {
      return true;
    }
  }

  // resolveWindow removed — replaced by the per-day path in isInBusinessHours
  // + normalizeSchedule / currentWeekday / isInTimeRange.

  /**
   * Returns true if right now falls inside the user's quiet-hours window.
   * Quiet hours is a daily window (no weekday filter) and is treated as
   * always-defined — defaults (22:00–08:00 NY) apply when fields are null.
   * The user-level `quietHoursEnabled` flag is no longer consulted;
   * `SavedAccount.followUpsApplyQuietHours` is the sole gating mechanism.
   *
   * TZ resolution falls back through `businessHoursTimezone` before the
   * literal default so a user who set ONE master TZ via Settings doesn't see
   * quiet-hours interpreted in a different wall clock than business-hours.
   * Matches the convergence direction of `resolveTimezone` in account-timezone.ts.
   */
  async isInQuietHours(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        quietHoursStart: true,
        quietHoursEnd: true,
        // Pull every TZ column the resolver knows about. Resolution priority
        // is enforced by resolveTimezone() — not by the order of the select.
        timezone: true,
        businessHoursTimezone: true,
        quietHoursTimezone: true,
      },
    });
    const rawStart = user?.quietHoursStart;
    const rawEnd = user?.quietHoursEnd;
    const start = rawStart && /^\d{1,2}:\d{2}$/.test(rawStart) ? rawStart : DEFAULT_QH_START;
    const end = rawEnd && /^\d{1,2}:\d{2}$/.test(rawEnd) ? rawEnd : DEFAULT_QH_END;
    // Canonical TZ resolution chain — same one resolveTimezone() applies for
    // the follow-up engine and isInBusinessHours. New: User.timezone wins,
    // legacy quietHoursTimezone / businessHoursTimezone are read fallbacks.
    const tz = resolveTimezone(null, user);
    return BusinessHoursService.isInTimeRange(new Date(), start, end, tz);
  }
}
