import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

const DEFAULT_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const DEFAULT_BH_START = '09:00';
const DEFAULT_BH_END = '18:00';
const DEFAULT_QH_START = '22:00';
const DEFAULT_QH_END = '08:00';
const DEFAULT_TZ = 'America/New_York';

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
   * after applying the per-account override if present. The window is treated
   * as always-defined — defaults (9:00–18:00 Mon–Fri NY) apply when fields
   * are null. The user-level `businessHoursEnabled` flag is no longer consulted;
   * per-feature toggles on SavedAccount are the sole gating mechanism.
   */
  async isInBusinessHours(userId: string, savedAccountId?: string | null): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        businessHoursStart: true,
        businessHoursEnd: true,
        businessHoursTimezone: true,
        businessHoursDays: true,
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

    const window = this.resolveWindow(user, override);
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
  ): ResolvedWindow {
    const rawStart = override?.start ?? user.businessHoursStart;
    const rawEnd = override?.end ?? user.businessHoursEnd;
    const start = rawStart && /^\d{1,2}:\d{2}$/.test(rawStart) ? rawStart : DEFAULT_BH_START;
    const end = rawEnd && /^\d{1,2}:\d{2}$/.test(rawEnd) ? rawEnd : DEFAULT_BH_END;
    const timezone = override?.timezone ?? user.businessHoursTimezone ?? DEFAULT_TZ;
    const rawDays = override?.days ?? user.businessHoursDays;
    const days = Array.isArray(rawDays) && rawDays.length > 0 ? rawDays : DEFAULT_DAYS;
    return { start, end, timezone, days: days.map((d: string) => d.toLowerCase()) };
  }

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
