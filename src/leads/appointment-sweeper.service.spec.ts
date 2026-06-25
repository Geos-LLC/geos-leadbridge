/**
 * AppointmentSweeperService — unit tests.
 *
 * Covers:
 *   - Dry-run logs would_complete but doesn't call writeStatus
 *   - Live mode calls writeStatus when slot+grace has passed
 *   - Skips leads whose slot+grace hasn't passed yet
 *   - Skips SF-linked leads (sfJobId / sfCustomerId / syncStatus='linked')
 *   - Skips leads without a dispatcher_confirmed audit row
 *   - Honors the latest dispatcher_confirmed metadata when multiple rows exist
 *   - writeStatus skip-result is reflected in stats and not surfaced as throws
 */

import { Logger } from '@nestjs/common';
import { AppointmentSweeperService } from './appointment-sweeper.service';
import type { LeadStatusService } from './lead-status.service';

const NOW = new Date('2026-06-25T22:00:00Z');

interface FakeAuditRow {
  leadId: string;
  metadata: any;
  occurredAt: Date;
}

interface FakeLeadRow {
  id: string;
  userId: string;
  sfJobId: string | null;
  sfCustomerId: string | null;
  syncStatus: string | null;
}

function buildPrismaMock(leads: FakeLeadRow[], audits: FakeAuditRow[]) {
  return {
    lead: {
      findMany: jest.fn().mockImplementation(async () => leads),
    },
    leadStatusAuditLog: {
      findMany: jest.fn().mockImplementation(async () => audits),
    },
  } as any;
}

function buildLeadStatusMock(behavior?: jest.Mock): jest.Mocked<LeadStatusService> {
  const writeStatus = behavior ?? jest.fn().mockResolvedValue({ applied: true, status: 'completed' });
  return { writeStatus } as any;
}

describe('AppointmentSweeperService.sweepOnce', () => {
  // Quiet logger spam from the would_complete log line in tests.
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterAll(() => jest.restoreAllMocks());

  function makeSvc(prisma: any, ls: jest.Mocked<LeadStatusService>) {
    return new AppointmentSweeperService(prisma, ls);
  }

  it('marks lead completed when slot+grace has passed (live mode)', async () => {
    const lead: FakeLeadRow = { id: 'lead-1', userId: 'u1', sfJobId: null, sfCustomerId: null, syncStatus: null };
    const audit: FakeAuditRow = {
      leadId: 'lead-1',
      metadata: { appointmentAt: '2026-06-25T14:00:00Z', slotMinutes: 30 },
      occurredAt: new Date('2026-06-24T16:00:00Z'),
    };
    const prisma = buildPrismaMock([lead], [audit]);
    const ls = buildLeadStatusMock();
    const svc = makeSvc(prisma, ls);

    const stats = await svc.sweepOnce(prisma, { dryRun: false, now: NOW });

    expect(stats).toEqual({ examined: 1, completed: 1, skipped: 0 });
    expect(ls.writeStatus).toHaveBeenCalledTimes(1);
    expect(ls.writeStatus.mock.calls[0][0]).toMatchObject({
      leadId: 'lead-1',
      newStatus: 'completed',
      source: 'lb_automation',
      reason: 'appointment_date_passed',
    });
  });

  it('dry-run never calls writeStatus but reports the same completed count', async () => {
    const lead: FakeLeadRow = { id: 'lead-1', userId: 'u1', sfJobId: null, sfCustomerId: null, syncStatus: null };
    const audit: FakeAuditRow = {
      leadId: 'lead-1',
      metadata: { appointmentAt: '2026-06-25T14:00:00Z', slotMinutes: 30 },
      occurredAt: new Date('2026-06-24T16:00:00Z'),
    };
    const prisma = buildPrismaMock([lead], [audit]);
    const ls = buildLeadStatusMock();
    const svc = makeSvc(prisma, ls);

    const stats = await svc.sweepOnce(prisma, { dryRun: true, now: NOW });

    expect(stats).toEqual({ examined: 1, completed: 1, skipped: 0 });
    expect(ls.writeStatus).not.toHaveBeenCalled();
  });

  it('skips leads whose slot+grace has not yet passed', async () => {
    const lead: FakeLeadRow = { id: 'lead-1', userId: 'u1', sfJobId: null, sfCustomerId: null, syncStatus: null };
    // Slot at NOW − 1h with default 30min slot → grace ends at NOW + 5h30m.
    const audit: FakeAuditRow = {
      leadId: 'lead-1',
      metadata: { appointmentAt: '2026-06-25T21:00:00Z', slotMinutes: 30 },
      occurredAt: new Date('2026-06-24T16:00:00Z'),
    };
    const prisma = buildPrismaMock([lead], [audit]);
    const ls = buildLeadStatusMock();
    const svc = makeSvc(prisma, ls);

    const stats = await svc.sweepOnce(prisma, { dryRun: false, now: NOW });

    expect(stats).toEqual({ examined: 1, completed: 0, skipped: 0 });
    expect(ls.writeStatus).not.toHaveBeenCalled();
  });

  it('skips SF-linked leads even when otherwise eligible', async () => {
    const lead: FakeLeadRow = { id: 'lead-1', userId: 'u1', sfJobId: 'sf-job-1', sfCustomerId: null, syncStatus: null };
    const audit: FakeAuditRow = {
      leadId: 'lead-1',
      metadata: { appointmentAt: '2026-06-25T14:00:00Z', slotMinutes: 30 },
      occurredAt: new Date('2026-06-24T16:00:00Z'),
    };
    const prisma = buildPrismaMock([lead], [audit]);
    const ls = buildLeadStatusMock();
    const svc = makeSvc(prisma, ls);

    const stats = await svc.sweepOnce(prisma, { dryRun: false, now: NOW });

    expect(stats).toEqual({ examined: 1, completed: 0, skipped: 1 });
    expect(ls.writeStatus).not.toHaveBeenCalled();
  });

  it('skips leads with no dispatcher_confirmed audit row', async () => {
    const lead: FakeLeadRow = { id: 'lead-1', userId: 'u1', sfJobId: null, sfCustomerId: null, syncStatus: null };
    const prisma = buildPrismaMock([lead], []);
    const ls = buildLeadStatusMock();
    const svc = makeSvc(prisma, ls);

    const stats = await svc.sweepOnce(prisma, { dryRun: false, now: NOW });

    expect(stats.examined).toBe(0);
    expect(stats.completed).toBe(0);
    expect(ls.writeStatus).not.toHaveBeenCalled();
  });

  it('uses the LATEST dispatcher_confirmed audit row when multiple exist', async () => {
    // Audit rows arrive in occurredAt-desc order from Prisma; first row wins
    // when the JS map is populated.
    const lead: FakeLeadRow = { id: 'lead-1', userId: 'u1', sfJobId: null, sfCustomerId: null, syncStatus: null };
    const newer: FakeAuditRow = {
      leadId: 'lead-1',
      metadata: { appointmentAt: '2026-06-27T18:00:00Z', slotMinutes: 30 },
      occurredAt: new Date('2026-06-26T12:00:00Z'),
    };
    const older: FakeAuditRow = {
      leadId: 'lead-1',
      metadata: { appointmentAt: '2026-06-25T14:00:00Z', slotMinutes: 30 },
      occurredAt: new Date('2026-06-24T16:00:00Z'),
    };
    const prisma = buildPrismaMock([lead], [newer, older]);
    const ls = buildLeadStatusMock();
    const svc = makeSvc(prisma, ls);

    // NOW is Jun 25 22:00 — newer slot (Jun 27) hasn't passed grace yet → skip.
    const stats = await svc.sweepOnce(prisma, { dryRun: false, now: NOW });

    expect(stats).toEqual({ examined: 1, completed: 0, skipped: 0 });
    expect(ls.writeStatus).not.toHaveBeenCalled();
  });

  it('reports skipped when writeStatus returns applied=false', async () => {
    const lead: FakeLeadRow = { id: 'lead-1', userId: 'u1', sfJobId: null, sfCustomerId: null, syncStatus: null };
    const audit: FakeAuditRow = {
      leadId: 'lead-1',
      metadata: { appointmentAt: '2026-06-25T14:00:00Z', slotMinutes: 30 },
      occurredAt: new Date('2026-06-24T16:00:00Z'),
    };
    const prisma = buildPrismaMock([lead], [audit]);
    const writeStatus = jest.fn().mockResolvedValue({ applied: false, status: 'booked', skipReason: 'sf_connected_autonomous_blocked' });
    const ls = buildLeadStatusMock(writeStatus);
    const svc = makeSvc(prisma, ls);

    const stats = await svc.sweepOnce(prisma, { dryRun: false, now: NOW });

    expect(stats).toEqual({ examined: 1, completed: 0, skipped: 1 });
  });

  it('reports skipped when writeStatus throws (does not propagate)', async () => {
    const lead: FakeLeadRow = { id: 'lead-1', userId: 'u1', sfJobId: null, sfCustomerId: null, syncStatus: null };
    const audit: FakeAuditRow = {
      leadId: 'lead-1',
      metadata: { appointmentAt: '2026-06-25T14:00:00Z', slotMinutes: 30 },
      occurredAt: new Date('2026-06-24T16:00:00Z'),
    };
    const prisma = buildPrismaMock([lead], [audit]);
    const writeStatus = jest.fn().mockRejectedValue(new Error('db down'));
    const ls = buildLeadStatusMock(writeStatus);
    const svc = makeSvc(prisma, ls);

    const stats = await svc.sweepOnce(prisma, { dryRun: false, now: NOW });
    expect(stats).toEqual({ examined: 1, completed: 0, skipped: 1 });
  });
});
