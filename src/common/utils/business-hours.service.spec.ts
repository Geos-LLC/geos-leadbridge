/**
 * Pins the TZ fallback chain of BusinessHoursService.isInQuietHours.
 *
 * Resolution is now delegated to resolveTimezone() in account-timezone.ts.
 * The order it produces for User-only inputs:
 *
 *   1. User.timezone               — canonical master (new)
 *   2. User.businessHoursTimezone  — legacy column
 *   3. User.quietHoursTimezone     — legacy column
 *   4. 'America/New_York'          — last-resort literal
 *
 * Behavior change from the prior Adjustment-A chain: when both
 * `businessHoursTimezone` and `quietHoursTimezone` are set on legacy rows
 * (no `timezone` column set yet), `businessHoursTimezone` now wins. This
 * mirrors what the migration's backfill SQL writes into `User.timezone`,
 * so once the migration runs every row resolves to the same value the
 * fallback chain returns. The single-source-of-truth direction.
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

  it('uses the canonical User.timezone when set (wins over every legacy column)', async () => {
    const { svc } = buildService({
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
      timezone: 'America/Los_Angeles',
      businessHoursTimezone: 'America/Chicago',
      quietHoursTimezone: 'America/Denver',
    });
    await svc.isInQuietHours('u-1');
    expect(rangeSpy).toHaveBeenCalledWith(expect.any(Date), '22:00', '08:00', 'America/Los_Angeles');
  });

  it('falls back to User.businessHoursTimezone when canonical timezone is null', async () => {
    const { svc } = buildService({
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
      timezone: null,
      businessHoursTimezone: 'America/Chicago',
      quietHoursTimezone: 'America/Denver',
    });
    await svc.isInQuietHours('u-1');
    // businessHoursTimezone wins over quietHoursTimezone (legacy ordering
    // chosen to match the migration backfill — see resolveTimezone()).
    expect(rangeSpy).toHaveBeenCalledWith(expect.any(Date), '22:00', '08:00', 'America/Chicago');
  });

  it('falls back to User.quietHoursTimezone when canonical and businessHours legacy are null', async () => {
    const { svc } = buildService({
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
      timezone: null,
      businessHoursTimezone: null,
      quietHoursTimezone: 'America/Denver',
    });
    await svc.isInQuietHours('u-1');
    expect(rangeSpy).toHaveBeenCalledWith(expect.any(Date), '22:00', '08:00', 'America/Denver');
  });

  it('falls back to canonical timezone over legacy when both set (whitespace-trim safe)', async () => {
    const { svc } = buildService({
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
      timezone: '  America/Phoenix  ',
      businessHoursTimezone: 'America/Chicago',
    });
    await svc.isInQuietHours('u-1');
    expect(rangeSpy).toHaveBeenCalledWith(expect.any(Date), '22:00', '08:00', 'America/Phoenix');
  });

  it('skips empty / whitespace canonical and falls back to legacy business-hours TZ', async () => {
    const { svc } = buildService({
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
      timezone: '   ',
      businessHoursTimezone: 'America/Chicago',
    });
    await svc.isInQuietHours('u-1');
    expect(rangeSpy).toHaveBeenCalledWith(expect.any(Date), '22:00', '08:00', 'America/Chicago');
  });

  it('falls back to America/New_York when every TZ source is null', async () => {
    const { svc } = buildService({
      quietHoursStart: '22:00',
      quietHoursEnd: '08:00',
      timezone: null,
      businessHoursTimezone: null,
      quietHoursTimezone: null,
    });
    await svc.isInQuietHours('u-1');
    expect(rangeSpy).toHaveBeenCalledWith(expect.any(Date), '22:00', '08:00', 'America/New_York');
  });

  it('falls back to America/New_York when the User row is missing entirely', async () => {
    const { svc } = buildService(null);
    await svc.isInQuietHours('u-missing');
    expect(rangeSpy).toHaveBeenCalledWith(expect.any(Date), '22:00', '08:00', 'America/New_York');
  });

  it('uses default quiet-hours range (22:00–08:00) when both fields are null', async () => {
    const { svc } = buildService({
      quietHoursStart: null,
      quietHoursEnd: null,
      timezone: null,
    });
    await svc.isInQuietHours('u-1');
    expect(rangeSpy).toHaveBeenCalledWith(expect.any(Date), '22:00', '08:00', 'America/New_York');
  });

  it('keeps user-set start / end when they match HH:MM regex', async () => {
    const { svc } = buildService({
      quietHoursStart: '21:30',
      quietHoursEnd: '07:15',
      timezone: 'America/Denver',
    });
    await svc.isInQuietHours('u-1');
    expect(rangeSpy).toHaveBeenCalledWith(expect.any(Date), '21:30', '07:15', 'America/Denver');
  });

  it('rejects malformed start time and substitutes the default 22:00', async () => {
    const { svc } = buildService({
      quietHoursStart: 'not-a-time',
      quietHoursEnd: '08:00',
      timezone: 'America/Denver',
    });
    await svc.isInQuietHours('u-1');
    expect(rangeSpy).toHaveBeenCalledWith(expect.any(Date), '22:00', '08:00', 'America/Denver');
  });
});
