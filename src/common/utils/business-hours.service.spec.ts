/**
 * Pins the TZ fallback chain of BusinessHoursService.isInQuietHours.
 *
 * The chain is:
 *   1. User.quietHoursTimezone           — explicit quiet-hours override
 *   2. User.businessHoursTimezone        — user's master TZ (single source)
 *   3. 'America/New_York'                — last-resort literal
 *
 * Why this matters: the master-quiet-hours scheduler gate (introduced in
 * the business-hours PR) interprets "is now in 22:00-08:00" against
 * whichever TZ this function returns. A user who set ONE master TZ
 * (businessHoursTimezone) but never touched quietHoursTimezone expects
 * both gates to interpret in the SAME wall clock — without the fallback
 * through businessHoursTimezone, quiet hours silently defaulted to NY
 * while the business-hours gate honored the user's setting. Drift would
 * be invisible until the wrong follow-up fires.
 *
 * We assert precedence by spying on the static `isInTimeRange` (which
 * receives the resolved TZ as its 4th argument) instead of relying on
 * the actual time-of-day math. That keeps the spec immune to DST shifts
 * and to whoever runs the test.
 */

import { BusinessHoursService } from './business-hours.service';

function buildService(userOverride: any) {
  const prisma: any = {
    user: { findUnique: jest.fn().mockResolvedValue(userOverride) },
  };
  const svc = new (BusinessHoursService as any)(prisma) as BusinessHoursService;
  return { svc, prisma };
}

describe('BusinessHoursService.isInQuietHours — TZ fallback precedence', () => {
  let rangeSpy: jest.SpyInstance;

  beforeEach(() => {
    // Stub isInTimeRange to return false so the surrounding boolean is
    // deterministic — the assertion we care about is *which TZ string*
    // gets passed in, not the wall-clock answer.
    rangeSpy = jest.spyOn(BusinessHoursService as any, 'isInTimeRange').mockReturnValue(false);
  });

  afterEach(() => {
    rangeSpy.mockRestore();
  });

  it('uses User.quietHoursTimezone when set (highest precedence)', async () => {
    const { svc } = buildService({
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
      quietHoursTimezone: 'America/Los_Angeles',
      businessHoursTimezone: 'America/New_York',
    });
    await svc.isInQuietHours('u-1');
    expect(rangeSpy).toHaveBeenCalledWith(expect.any(Date), '22:00', '08:00', 'America/Los_Angeles');
  });

  it('falls back to User.businessHoursTimezone when quietHoursTimezone is null', async () => {
    const { svc } = buildService({
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
      quietHoursTimezone: null,
      businessHoursTimezone: 'America/Chicago',
    });
    await svc.isInQuietHours('u-1');
    expect(rangeSpy).toHaveBeenCalledWith(expect.any(Date), '22:00', '08:00', 'America/Chicago');
  });

  it('falls back to User.businessHoursTimezone when quietHoursTimezone is empty string', async () => {
    const { svc } = buildService({
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
      quietHoursTimezone: '',
      businessHoursTimezone: 'America/Chicago',
    });
    await svc.isInQuietHours('u-1');
    expect(rangeSpy).toHaveBeenCalledWith(expect.any(Date), '22:00', '08:00', 'America/Chicago');
  });

  it('falls back to User.businessHoursTimezone when quietHoursTimezone is whitespace-only', async () => {
    // Whitespace would format as a non-IANA zone and produce garbage. The
    // trim+truthy check pushes through to the next fallback.
    const { svc } = buildService({
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
      quietHoursTimezone: '   ',
      businessHoursTimezone: 'America/Chicago',
    });
    await svc.isInQuietHours('u-1');
    expect(rangeSpy).toHaveBeenCalledWith(expect.any(Date), '22:00', '08:00', 'America/Chicago');
  });

  it('falls back to America/New_York when both are null', async () => {
    const { svc } = buildService({
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
      quietHoursTimezone: null,
      businessHoursTimezone: null,
    });
    await svc.isInQuietHours('u-1');
    expect(rangeSpy).toHaveBeenCalledWith(expect.any(Date), '22:00', '08:00', 'America/New_York');
  });

  it('falls back to America/New_York when the User row is missing entirely', async () => {
    const { svc } = buildService(null);
    await svc.isInQuietHours('u-missing');
    expect(rangeSpy).toHaveBeenCalledWith(expect.any(Date), '22:00', '08:00', 'America/New_York');
  });

  it('uses default start/end (22:00–08:00) when both fields are null', async () => {
    const { svc } = buildService({
      quietHoursStart: null,
      quietHoursEnd: null,
      quietHoursTimezone: null,
      businessHoursTimezone: null,
    });
    await svc.isInQuietHours('u-1');
    expect(rangeSpy).toHaveBeenCalledWith(expect.any(Date), '22:00', '08:00', 'America/New_York');
  });

  it('keeps user-set start/end when they match the HH:MM regex', async () => {
    const { svc } = buildService({
      quietHoursStart: '21:30',
      quietHoursEnd: '07:15',
      quietHoursTimezone: 'America/Denver',
      businessHoursTimezone: null,
    });
    await svc.isInQuietHours('u-1');
    expect(rangeSpy).toHaveBeenCalledWith(expect.any(Date), '21:30', '07:15', 'America/Denver');
  });

  it('rejects malformed start time and substitutes the default', async () => {
    const { svc } = buildService({
      quietHoursStart: 'not-a-time',
      quietHoursEnd: '08:00',
      quietHoursTimezone: 'America/Denver',
      businessHoursTimezone: null,
    });
    await svc.isInQuietHours('u-1');
    expect(rangeSpy).toHaveBeenCalledWith(expect.any(Date), '22:00', '08:00', 'America/Denver');
  });
});
