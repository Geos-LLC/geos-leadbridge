/**
 * LeadStatusService tests — covers the 5-row conflict matrix:
 *
 *   | Who wrote               | Other side           | Conflict? |
 *   | service_flow            | LB older             | No        |
 *   | manual (SF integrated)  | SF older             | YES       |
 *   | manual (SF not integ.)  | —                    | No        |
 *   | platform_sync           | LB older             | No        |
 *   | manual                  | platform differs     | YES       |
 */

import { LeadStatusService } from './lead-status.service';

const LEAD_ID = 'lead-1';
const USER_ID = 'user-1';

function buildPrismaMock(lead: Partial<any> = {}) {
  const state: any = {
    lead: {
      id: LEAD_ID,
      userId: USER_ID,
      status: 'new',
      platform: 'yelp',
      platformStatus: null,
      platformStatusAt: null,
      statusUpdatedAt: null,
      statusSource: null,
      sfJobId: null,
      thumbtackStatus: null,
      ...lead,
    },
    updates: [] as any[],
    audits: [] as any[],
  };
  const mock: any = {
    _state: state,
    lead: {
      findUnique: jest.fn().mockImplementation(async () => state.lead),
      update: jest.fn().mockImplementation(async ({ data }: any) => {
        Object.assign(state.lead, data);
        state.updates.push(data);
        return state.lead;
      }),
    },
    leadStatusAuditLog: {
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const row = { id: `audit-${state.audits.length + 1}`, ...data };
        state.audits.push(row);
        return row;
      }),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  mock.$transaction = jest.fn().mockImplementation(async (cb: any) => cb(mock));
  return mock;
}

function buildEvents() {
  return { emit: jest.fn() } as any;
}

describe('LeadStatusService', () => {
  describe('conflict matrix', () => {
    it('service_flow write → no conflict, writes Lead.status silently', async () => {
      const prisma = buildPrismaMock();
      const events = buildEvents();
      const svc = new LeadStatusService(prisma, events);

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'service_flow',
        newStatus: 'scheduled',
      });

      expect(res.applied).toBe(true);
      expect(res.status).toBe('scheduled');
      expect(res.conflict).toBeNull();
      expect(prisma._state.audits[0].conflict).toBe(false);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('manual write + SF integrated → CONFLICT sf_push_needed', async () => {
      const prisma = buildPrismaMock({ sfJobId: 'sf_job_42', status: 'new' });
      const events = buildEvents();
      const svc = new LeadStatusService(prisma, events);

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'manual',
        newStatus: 'scheduled',
        actorId: USER_ID,
      });

      expect(res.applied).toBe(true);
      expect(res.status).toBe('scheduled');
      expect(res.conflict).not.toBeNull();
      expect(res.conflict?.kind).toBe('sf_push_needed');
      expect(res.conflict?.sfJobId).toBe('sf_job_42');
      expect(prisma._state.audits[0].conflict).toBe(true);
      expect(events.emit).toHaveBeenCalledWith(
        `lead.status.conflict.${USER_ID}`,
        expect.objectContaining({ leadId: LEAD_ID }),
      );
    });

    it('manual write + SF NOT integrated → no conflict when platform status absent', async () => {
      const prisma = buildPrismaMock({ sfJobId: null, platformStatus: null });
      const events = buildEvents();
      const svc = new LeadStatusService(prisma, events);

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'manual',
        newStatus: 'contacted',
      });

      expect(res.applied).toBe(true);
      expect(res.conflict).toBeNull();
      expect(prisma._state.audits[0].conflict).toBe(false);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('platform_sync write → no conflict, writes silently', async () => {
      const prisma = buildPrismaMock({ status: 'new' });
      const events = buildEvents();
      const svc = new LeadStatusService(prisma, events);

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        platformStatus: 'Hired',
        newStatus: 'in_progress',
      });

      expect(res.applied).toBe(true);
      expect(res.status).toBe('in_progress');
      expect(res.platformStatus).toBe('Hired');
      expect(res.conflict).toBeNull();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('manual write + platform status differs → CONFLICT platform_nudge_needed', async () => {
      const prisma = buildPrismaMock({
        sfJobId: null,
        platformStatus: 'Hired',
        platform: 'thumbtack',
      });
      const events = buildEvents();
      const svc = new LeadStatusService(prisma, events);

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'manual',
        newStatus: 'lost',
      });

      expect(res.applied).toBe(true);
      expect(res.conflict).not.toBeNull();
      expect(res.conflict?.kind).toBe('platform_nudge_needed');
      expect(res.conflict?.platformStatus).toBe('Hired');
      expect(res.conflict?.platform).toBe('thumbtack');
      expect(prisma._state.audits[0].conflict).toBe(true);
    });

    it('manual write + platform status agrees (consistent pair) → no conflict', async () => {
      const prisma = buildPrismaMock({
        sfJobId: null,
        platformStatus: 'Hired',
        platform: 'thumbtack',
      });
      const svc = new LeadStatusService(prisma, buildEvents());

      // "completed" ↔ "hired" is a consistent pair
      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'manual',
        newStatus: 'completed',
      });

      expect(res.applied).toBe(true);
      expect(res.conflict).toBeNull();
      expect(prisma._state.audits[0].conflict).toBe(false);
    });

    it('lb_automation write → no conflict even when SF integrated', async () => {
      const prisma = buildPrismaMock({ sfJobId: 'sf_job_42' });
      const events = buildEvents();
      const svc = new LeadStatusService(prisma, events);

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'contacted',
      });

      expect(res.applied).toBe(true);
      expect(res.conflict).toBeNull();
      expect(prisma._state.audits[0].conflict).toBe(false);
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('platform_sync edge cases', () => {
    it('updates both Lead.status AND Lead.platformStatus when both provided', async () => {
      const prisma = buildPrismaMock({ platform: 'thumbtack', status: 'new' });
      const svc = new LeadStatusService(prisma, buildEvents());

      await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        platformStatus: 'Not hired',
        newStatus: 'lost',
      });

      expect(prisma._state.lead.status).toBe('lost');
      expect(prisma._state.lead.platformStatus).toBe('Not hired');
      expect(prisma._state.lead.thumbtackStatus).toBe('Not hired');
    });

    it('no-op when both values unchanged', async () => {
      const prisma = buildPrismaMock({ status: 'in_progress', platformStatus: 'Hired' });
      const svc = new LeadStatusService(prisma, buildEvents());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        platformStatus: 'Hired',
        newStatus: 'in_progress',
      });

      expect(res.applied).toBe(false);
    });
  });

  describe('resolveConflict', () => {
    it('flips conflict=false on the audit row', async () => {
      const prisma = buildPrismaMock();
      const svc = new LeadStatusService(prisma, buildEvents());

      await svc.resolveConflict('audit-1', 'pushed_to_sf');

      expect(prisma.leadStatusAuditLog.updateMany).toHaveBeenCalledWith({
        where: { id: 'audit-1', conflict: true },
        data: { conflict: false, conflictNote: 'pushed_to_sf' },
      });
    });
  });
});
