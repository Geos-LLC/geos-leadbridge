import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

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
        businessHoursTimezone: true,
        businessHoursDays: true, // now holds the per-day schedule JSON
      },
    });
    if (!user) return true;

    let override: any = null;
    if (savedAccountId) {
      const acct = await this.prisma.savedAccount.findUnique({
        where: { id: savedAccountId },
        select: { businessHoursOverride: true },
      });
      override = acct?.businessHoursOverride ?? null;
    }

    const schedule = BusinessHoursService.normalizeSchedule(override?.schedule ?? user.businessHoursDays);
    const tz = override?.timezone ?? user.businessHoursTimezone ?? DEFAULT_TZ;

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
   */
  async isInQuietHours(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        quietHoursStart: true,
        quietHoursEnd: true,
        quietHoursTimezone: true,
      },
    });
    const rawStart = user?.quietHoursStart;
    const rawEnd = user?.quietHoursEnd;
    const start = rawStart && /^\d{1,2}:\d{2}$/.test(rawStart) ? rawStart : DEFAULT_QH_START;
    const end = rawEnd && /^\d{1,2}:\d{2}$/.test(rawEnd) ? rawEnd : DEFAULT_QH_END;
    const tz = user?.quietHoursTimezone || DEFAULT_TZ;
    return BusinessHoursService.isInTimeRange(new Date(), start, end, tz);
  }
}
