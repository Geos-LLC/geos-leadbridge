import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

const DEFAULT_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];

type ResolvedWindow = {
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
  timezone: string;
  days: string[]; // ["mon","tue",...]
};

@Injectable()
export class BusinessHoursService {
  private readonly logger = new Logger(BusinessHoursService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns true if right now falls inside the user's business-hours window,
   * after applying the per-account override if present.
   *
   * Returns true when:
   *  - businessHoursEnabled is false (master switch off → no gating)
   *  - resolved start/end are missing or malformed (defensive — don't accidentally block)
   *
   * Returns false only when the master is on AND we have a valid window AND
   * the current time/day is outside it.
   */
  async isInBusinessHours(userId: string, savedAccountId?: string | null): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        businessHoursEnabled: true,
        businessHoursStart: true,
        businessHoursEnd: true,
        businessHoursTimezone: true,
        businessHoursDays: true,
      },
    });

    if (!user || !user.businessHoursEnabled) return true;

    let override: any = null;
    if (savedAccountId) {
      const acct = await this.prisma.savedAccount.findUnique({
        where: { id: savedAccountId },
        select: { businessHoursOverride: true },
      });
      override = acct?.businessHoursOverride ?? null;
    }

    const window = this.resolveWindow(user, override);
    if (!window) return true; // Misconfigured — fail open.

    return BusinessHoursService.isInWindow(new Date(), window);
  }

  private resolveWindow(
    user: {
      businessHoursStart: string | null;
      businessHoursEnd: string | null;
      businessHoursTimezone: string | null;
      businessHoursDays: any;
    },
    override: any,
  ): ResolvedWindow | null {
    const start = override?.start ?? user.businessHoursStart;
    const end = override?.end ?? user.businessHoursEnd;
    const timezone = override?.timezone ?? user.businessHoursTimezone ?? 'America/New_York';
    const rawDays = override?.days ?? user.businessHoursDays;

    if (!start || !end || !/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) {
      return null;
    }
    const days = Array.isArray(rawDays) && rawDays.length > 0 ? rawDays : DEFAULT_DAYS;
    return { start, end, timezone, days: days.map((d: string) => d.toLowerCase()) };
  }

  /**
   * Returns true if right now falls inside the user's quiet-hours window.
   * Quiet hours is a daily window (no weekday filter) — broader than business
   * hours. Used by follow-ups (don't text leads at night).
   *
   * Returns false (NOT in quiet hours = OK to send) when:
   *  - quietHoursEnabled is false (master off)
   *  - resolved start/end are missing or malformed (defensive — never accidentally block)
   */
  async isInQuietHours(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        quietHoursEnabled: true,
        quietHoursStart: true,
        quietHoursEnd: true,
        quietHoursTimezone: true,
      },
    });
    if (!user?.quietHoursEnabled) return false;
    const start = user.quietHoursStart;
    const end = user.quietHoursEnd;
    const tz = user.quietHoursTimezone || 'America/New_York';
    if (!start || !end || !/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) return false;
    // Days = every day (quiet hours is a daily politeness window, not weekday-filtered).
    return BusinessHoursService.isInWindow(new Date(), {
      start, end, timezone: tz,
      days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
    });
  }

  /** Pure window check — exported for tests and direct callers. */
  static isInWindow(now: Date, window: ResolvedWindow): boolean {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: window.timezone,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const parts = fmt.formatToParts(now);
      const wd = parts.find(p => p.type === 'weekday')?.value?.toLowerCase().slice(0, 3) || '';
      const hh = Number(parts.find(p => p.type === 'hour')?.value || '0');
      const mm = Number(parts.find(p => p.type === 'minute')?.value || '0');
      if (!window.days.includes(wd)) return false;

      const cur = hh * 60 + mm;
      const [sh, sm] = window.start.split(':').map(Number);
      const [eh, em] = window.end.split(':').map(Number);
      const s = sh * 60 + sm;
      const e = eh * 60 + em;
      return s > e ? (cur >= s || cur < e) : (cur >= s && cur < e);
    } catch {
      return true; // Defensive: never accidentally block on a TZ/format error.
    }
  }
}
