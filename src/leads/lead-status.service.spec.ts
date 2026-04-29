/**
 * LeadStatusService tests.
 *
 * Covers the original conflict matrix:
 *
 *   | Who wrote               | Other side           | Conflict? |
 *   | service_flow            | LB older             | No        |
 *   | manual (SF integrated)  | SF older             | YES       |
 *   | manual (SF not integ.)  | —                    | No        |
 *   | platform_sync           | LB older             | No        |
 *   | manual                  | platform differs     | YES       |
 *
 * Plus the 8 transition guards added in PR 2:
 *   1. same-status no-op
 *   2. canonical validation
 *   3. hard-terminal (blocks all)
 *   4. SF_STATUS_WINS protection (lb_automation only)
 *   5. automation-terminal (lb_automation only)
 *   6. pipeline-downgrade
 *   7. dedup by sourceEventId
 *   8. stale-event
 *
 * Plus lostReason / reengageAt projection rules.
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
      lostReason: null,
      reengageAt: null,
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
      findFirst: jest.fn().mockResolvedValue(null),
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

function buildConfig(overrides: Record<string, string> = {}) {
  return {
    get: jest.fn((key: string, def?: any) => overrides[key] ?? def),
  } as any;
}

describe('LeadStatusService', () => {
  describe('conflict matrix', () => {
    it('service_flow write → no conflict, writes Lead.status silently', async () => {
      const prisma = buildPrismaMock();
      const events = buildEvents();
      const svc = new LeadStatusService(prisma, events, buildConfig());

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

    it('manual write + SF integrated → CONFLICT sf_push_needed (still applies)', async () => {
      const prisma = buildPrismaMock({ sfJobId: 'sf_job_42', status: 'new' });
      const events = buildEvents();
      const svc = new LeadStatusService(prisma, events, buildConfig());

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

    it('manual override is allowed even when SF_STATUS_WINS=true (audited)', async () => {
      const prisma = buildPrismaMock({ sfJobId: 'sf_job_42', status: 'new' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig({ SF_STATUS_WINS: 'true' }));

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'manual',
        newStatus: 'scheduled',
      });

      expect(res.applied).toBe(true);
      expect(res.conflict?.kind).toBe('sf_push_needed');
      expect(prisma._state.audits[0].conflict).toBe(true);
    });

    it('manual write + SF NOT integrated → no conflict when platform status absent', async () => {
      const prisma = buildPrismaMock({ sfJobId: null, platformStatus: null });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'manual',
        newStatus: 'contacted',
      });

      expect(res.applied).toBe(true);
      expect(res.conflict).toBeNull();
    });

    it('manual write + platform status differs → CONFLICT platform_nudge_needed', async () => {
      const prisma = buildPrismaMock({
        sfJobId: null,
        platformStatus: 'Hired',
        platform: 'thumbtack',
      });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'manual',
        newStatus: 'lost',
      });

      expect(res.applied).toBe(true);
      expect(res.conflict?.kind).toBe('platform_nudge_needed');
      expect(res.conflict?.platformStatus).toBe('Hired');
    });

    it('manual write + platform status agrees (consistent pair) → no conflict', async () => {
      const prisma = buildPrismaMock({
        sfJobId: null,
        platformStatus: 'Hired',
        platform: 'thumbtack',
        status: 'in_progress',
      });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      // "completed" ↔ "hired" is a consistent pair
      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'manual',
        newStatus: 'completed',
      });

      expect(res.applied).toBe(true);
      expect(res.conflict).toBeNull();
    });
  });

  describe('guard 1: same-status no-op', () => {
    it('returns applied=false with skipReason=no_change', async () => {
      const prisma = buildPrismaMock({ status: 'engaged' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'engaged',
      });

      expect(res.applied).toBe(false);
      expect(res.skipReason).toBe('no_change');
      expect(prisma._state.audits.length).toBe(0);
      expect(prisma._state.updates.length).toBe(0);
    });
  });

  describe('guard 2: canonical validation', () => {
    it('throws on non-canonical newStatus', async () => {
      const prisma = buildPrismaMock();
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      await expect(
        svc.writeStatus({ leadId: LEAD_ID, source: 'manual', newStatus: 'snoozed' }),
      ).rejects.toThrow(/Invalid status/);
    });
  });

  describe('guard 3: hard-terminal blocks all sources', () => {
    it.each([['service_flow'], ['manual'], ['lb_automation']] as const)(
      'blocks %s when oldStatus=archived',
      async (source) => {
        const prisma = buildPrismaMock({ status: 'archived' });
        const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

        const res = await svc.writeStatus({
          leadId: LEAD_ID,
          source,
          newStatus: 'engaged',
        });

        expect(res.applied).toBe(false);
        expect(res.skipReason).toBe('hard_terminal');
      },
    );
  });

  describe('guard 4: SF_STATUS_WINS protection', () => {
    it('blocks lb_automation on SF-linked lead when SF_STATUS_WINS=true', async () => {
      const prisma = buildPrismaMock({ sfJobId: 'sf_42', status: 'new' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig({ SF_STATUS_WINS: 'true' }));

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'engaged',
      });

      expect(res.applied).toBe(false);
      expect(res.skipReason).toBe('sf_protected');
    });

    it('does not block lb_automation when SF_STATUS_WINS=false', async () => {
      const prisma = buildPrismaMock({ sfJobId: 'sf_42', status: 'new' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig({ SF_STATUS_WINS: 'false' }));

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'engaged',
      });

      expect(res.applied).toBe(true);
    });

    it('does not block service_flow even when SF_STATUS_WINS=true', async () => {
      const prisma = buildPrismaMock({ sfJobId: 'sf_42', status: 'new' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig({ SF_STATUS_WINS: 'true' }));

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'service_flow',
        newStatus: 'in_progress',
      });

      expect(res.applied).toBe(true);
    });
  });

  describe('guard 4: SF_STATUS_WINS_USER_IDS scoped rollout', () => {
    // When the csv allowlist is non-empty, it overrides the global flag —
    // an explicit allowlist must not be widened by SF_STATUS_WINS=true.
    it('scoped allowlist blocks lb_automation for listed user', async () => {
      const prisma = buildPrismaMock({ sfJobId: 'sf_42', status: 'new', userId: USER_ID });
      const svc = new LeadStatusService(
        prisma,
        buildEvents(),
        buildConfig({ SF_STATUS_WINS: 'false', SF_STATUS_WINS_USER_IDS: USER_ID }),
      );

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'engaged',
      });

      expect(res.applied).toBe(false);
      expect(res.skipReason).toBe('sf_protected');
    });

    it('scoped allowlist blocks platform_sync canonical write for listed user (platformStatus still flows)', async () => {
      const prisma = buildPrismaMock({
        sfJobId: 'sf_42',
        status: 'in_progress',
        platform: 'thumbtack',
        platformStatus: null,
        userId: USER_ID,
      });
      const svc = new LeadStatusService(
        prisma,
        buildEvents(),
        buildConfig({ SF_STATUS_WINS: 'false', SF_STATUS_WINS_USER_IDS: USER_ID }),
      );

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        newStatus: 'completed',
        platformStatus: 'Done',
      });

      // platformStatus row was written; canonical Lead.status update was held back.
      expect(res.applied).toBe(true);
      expect(res.skipReason).toBe('sf_protected');
      expect(res.platformStatus).toBe('Done');
      expect(res.status).toBe('in_progress'); // unchanged
      expect(prisma._state.lead.status).toBe('in_progress');
      expect(prisma._state.lead.platformStatus).toBe('Done');
    });

    it('non-scoped user behaves unchanged (lb_automation proceeds, even global=false)', async () => {
      const prisma = buildPrismaMock({ sfJobId: 'sf_42', status: 'new', userId: 'other-user' });
      const svc = new LeadStatusService(
        prisma,
        buildEvents(),
        buildConfig({ SF_STATUS_WINS: 'false', SF_STATUS_WINS_USER_IDS: USER_ID }),
      );

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'engaged',
      });

      expect(res.applied).toBe(true);
      expect(res.status).toBe('engaged');
    });

    it('non-scoped user is NOT widened by global SF_STATUS_WINS=true (allowlist is authoritative)', async () => {
      const prisma = buildPrismaMock({ sfJobId: 'sf_42', status: 'new', userId: 'other-user' });
      const svc = new LeadStatusService(
        prisma,
        buildEvents(),
        buildConfig({ SF_STATUS_WINS: 'true', SF_STATUS_WINS_USER_IDS: USER_ID }),
      );

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'engaged',
      });

      expect(res.applied).toBe(true);
    });

    it('service_flow still writes when scoped user is the lead owner', async () => {
      const prisma = buildPrismaMock({ sfJobId: 'sf_42', status: 'new', userId: USER_ID });
      const svc = new LeadStatusService(
        prisma,
        buildEvents(),
        buildConfig({ SF_STATUS_WINS_USER_IDS: USER_ID }),
      );

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'service_flow',
        newStatus: 'in_progress',
      });

      expect(res.applied).toBe(true);
      expect(res.status).toBe('in_progress');
    });

    it('manual still writes for scoped SF-linked lead but flags sf_push_needed conflict', async () => {
      const prisma = buildPrismaMock({ sfJobId: 'sf_42', status: 'new', userId: USER_ID });
      const events = buildEvents();
      const svc = new LeadStatusService(
        prisma,
        events,
        buildConfig({ SF_STATUS_WINS_USER_IDS: USER_ID }),
      );

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'manual',
        newStatus: 'scheduled',
      });

      expect(res.applied).toBe(true);
      expect(res.conflict?.kind).toBe('sf_push_needed');
      expect(events.emit).toHaveBeenCalled();
    });

    it('does not block lb_automation on non-SF-linked leads even when user is scoped', async () => {
      const prisma = buildPrismaMock({ sfJobId: null, status: 'new', userId: USER_ID });
      const svc = new LeadStatusService(
        prisma,
        buildEvents(),
        buildConfig({ SF_STATUS_WINS_USER_IDS: USER_ID }),
      );

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'engaged',
      });

      expect(res.applied).toBe(true);
    });

    it('csv parsing tolerates whitespace and trailing commas', async () => {
      const prisma = buildPrismaMock({ sfJobId: 'sf_42', status: 'new', userId: USER_ID });
      const svc = new LeadStatusService(
        prisma,
        buildEvents(),
        buildConfig({ SF_STATUS_WINS_USER_IDS: ` ${USER_ID} , other-user ,` }),
      );

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'engaged',
      });

      expect(res.applied).toBe(false);
      expect(res.skipReason).toBe('sf_protected');
    });
  });

  describe('guard 5: automation-terminal', () => {
    it('blocks lb_automation when oldStatus=lost', async () => {
      const prisma = buildPrismaMock({ status: 'lost' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'engaged',
      });

      expect(res.applied).toBe(false);
      expect(res.skipReason).toBe('automation_terminal');
    });

    it('allows manual override of lost → engaged', async () => {
      const prisma = buildPrismaMock({ status: 'lost', lostReason: 'opt_out' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'manual',
        newStatus: 'engaged',
      });

      expect(res.applied).toBe(true);
      expect(prisma._state.lead.lostReason).toBeNull();
      expect(prisma._state.lead.reengageAt).toBeNull();
    });

    it('allows service_flow override of lost → in_progress', async () => {
      const prisma = buildPrismaMock({ status: 'lost' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'service_flow',
        newStatus: 'in_progress',
      });

      expect(res.applied).toBe(true);
    });
  });

  describe('guard 6: pipeline-downgrade', () => {
    it('blocks quoted → contacted', async () => {
      const prisma = buildPrismaMock({ status: 'quoted' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'contacted',
      });

      expect(res.applied).toBe(false);
      expect(res.skipReason).toBe('pipeline_downgrade');
    });

    it('allows quoted → lost (terminal exit, off-pipeline)', async () => {
      const prisma = buildPrismaMock({ status: 'quoted' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'lost',
        lostReason: 'opt_out',
      });

      expect(res.applied).toBe(true);
      expect(prisma._state.lead.lostReason).toBe('opt_out');
    });

    it('allows contacted → booked (skipping quoted is fine)', async () => {
      const prisma = buildPrismaMock({ status: 'contacted' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'booked',
      });

      expect(res.applied).toBe(true);
    });
  });

  describe('guard 7: sourceEventId dedup', () => {
    it('skips duplicate (leadId, source, sourceEventId)', async () => {
      const prisma = buildPrismaMock({ status: 'new' });
      prisma.leadStatusAuditLog.findFirst.mockResolvedValueOnce({ id: 'prior' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'engaged',
        sourceEventId: 'msg_123',
      });

      expect(res.applied).toBe(false);
      expect(res.skipReason).toBe('duplicate');
    });

    it('does not call findFirst when sourceEventId is null', async () => {
      const prisma = buildPrismaMock({ status: 'new' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'manual',
        newStatus: 'engaged',
      });

      expect(prisma.leadStatusAuditLog.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('guard 8: stale-event', () => {
    it('blocks when occurredAt < lead.statusUpdatedAt', async () => {
      const prisma = buildPrismaMock({
        status: 'engaged',
        statusUpdatedAt: new Date('2026-04-28T20:00:00Z'),
      });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'quoted',
        occurredAt: new Date('2026-04-28T19:00:00Z'),
      });

      expect(res.applied).toBe(false);
      expect(res.skipReason).toBe('stale_event');
    });

    it('allows when occurredAt > lead.statusUpdatedAt', async () => {
      const prisma = buildPrismaMock({
        status: 'engaged',
        statusUpdatedAt: new Date('2026-04-28T20:00:00Z'),
      });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'quoted',
        occurredAt: new Date('2026-04-28T21:00:00Z'),
      });

      expect(res.applied).toBe(true);
    });
  });

  describe('lostReason / reengageAt projection', () => {
    it('sets lostReason and reengageAt when transitioning to lost', async () => {
      const prisma = buildPrismaMock({ status: 'engaged' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());
      const reengageAt = new Date('2026-07-12T00:00:00Z');

      await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'lost',
        lostReason: 'hired_someone',
        reengageAt,
      });

      expect(prisma._state.lead.lostReason).toBe('hired_someone');
      expect(prisma._state.lead.reengageAt).toEqual(reengageAt);
    });

    it('clears lostReason + reengageAt when transitioning out of lost', async () => {
      const prisma = buildPrismaMock({
        status: 'lost',
        lostReason: 'opt_out',
        reengageAt: new Date('2026-07-12T00:00:00Z'),
      });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'manual',
        newStatus: 'engaged',
      });

      expect(prisma._state.lead.lostReason).toBeNull();
      expect(prisma._state.lead.reengageAt).toBeNull();
    });

    it('defaults lostReason to "manual" for manual-source writes when not provided', async () => {
      const prisma = buildPrismaMock({ status: 'engaged' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'manual',
        newStatus: 'lost',
      });

      expect(prisma._state.lead.lostReason).toBe('manual');
    });

    it('does not touch lostReason/reengageAt for non-lost transitions', async () => {
      const prisma = buildPrismaMock({ status: 'new', lostReason: null, reengageAt: null });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'engaged',
      });

      // Updates payload should not include lostReason/reengageAt keys
      expect('lostReason' in prisma._state.updates[0]).toBe(false);
      expect('reengageAt' in prisma._state.updates[0]).toBe(false);
    });
  });

  describe('audit log', () => {
    it('every applied write produces a status_changed row with reason + metadata', async () => {
      const prisma = buildPrismaMock({ status: 'engaged' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'lost',
        lostReason: 'opt_out',
        reason: 'opt_out',
        metadata: { trigger: 'msg_123' },
      });

      expect(prisma._state.audits.length).toBe(1);
      const row = prisma._state.audits[0];
      expect(row.activityType).toBe('status_changed');
      expect(row.oldStatus).toBe('engaged');
      expect(row.newStatus).toBe('lost');
      expect(row.source).toBe('lb_automation');
      expect(row.reason).toBe('opt_out');
      expect(row.metadata).toEqual({ trigger: 'msg_123' });
    });

    it('falls back to lostReason as reason when reason is not provided', async () => {
      const prisma = buildPrismaMock({ status: 'engaged' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'lost',
        lostReason: 'hired_someone',
      });

      expect(prisma._state.audits[0].reason).toBe('hired_someone');
    });
  });

  describe('platform_sync', () => {
    it('updates both Lead.status AND Lead.platformStatus when both provided', async () => {
      const prisma = buildPrismaMock({ platform: 'thumbtack', status: 'new' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

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

    it('writes platformStatus only when newStatus is non-canonical (invalid_status)', async () => {
      const prisma = buildPrismaMock({ platform: 'thumbtack', status: 'new' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        platformStatus: 'Some Custom Status',
        newStatus: 'snoozed', // not in CANONICAL_STATUSES
      });

      expect(prisma._state.lead.platformStatus).toBe('Some Custom Status');
      expect(prisma._state.lead.status).toBe('new'); // unchanged
    });

    it('blocks Lead.status write when SF_STATUS_WINS=true and lead is SF-mapped', async () => {
      const prisma = buildPrismaMock({
        platform: 'thumbtack',
        status: 'in_progress',
        sfJobId: 'sf_99',
      });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig({ SF_STATUS_WINS: 'true' }));

      await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        platformStatus: 'Done',
        newStatus: 'completed',
      });

      // platformStatus still flows
      expect(prisma._state.lead.platformStatus).toBe('Done');
      // canonical status is SF-protected
      expect(prisma._state.lead.status).toBe('in_progress');
    });

    it('skips on stale platform_sync event', async () => {
      const prisma = buildPrismaMock({
        status: 'engaged',
        statusUpdatedAt: new Date('2026-04-28T20:00:00Z'),
      });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        platformStatus: 'Hired',
        occurredAt: new Date('2026-04-28T18:00:00Z'),
      });

      expect(res.applied).toBe(false);
      expect(res.skipReason).toBe('stale_event');
    });

    it('no-op when both values unchanged', async () => {
      const prisma = buildPrismaMock({ status: 'in_progress', platformStatus: 'Hired' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        platformStatus: 'Hired',
        newStatus: 'in_progress',
      });

      expect(res.applied).toBe(false);
    });
  });

  describe('platform_sync downgrade guard', () => {
    it('completed + Yelp Active(contacted) → canonical NOT overwritten, platformStatus still updates, skipReason=pipeline_downgrade', async () => {
      const prisma = buildPrismaMock({
        platform: 'yelp',
        status: 'completed',
        platformStatus: 'Done',
      });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        platformStatus: 'Active',
        newStatus: 'contacted',
      });

      expect(res.applied).toBe(true);
      expect(res.skipReason).toBe('pipeline_downgrade');
      expect(prisma._state.lead.status).toBe('completed'); // canonical preserved
      expect(prisma._state.lead.platformStatus).toBe('Active'); // raw updated
    });

    it('booked + Yelp Active(contacted) → canonical NOT overwritten, platformStatus updates, skipReason=pipeline_downgrade', async () => {
      const prisma = buildPrismaMock({
        platform: 'yelp',
        status: 'booked',
        platformStatus: 'Hired',
      });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        platformStatus: 'Active',
        newStatus: 'contacted',
      });

      expect(res.applied).toBe(true);
      expect(res.skipReason).toBe('pipeline_downgrade');
      expect(prisma._state.lead.status).toBe('booked');
      expect(prisma._state.lead.platformStatus).toBe('Active');
    });

    it('quoted + Active(contacted) → canonical NOT overwritten', async () => {
      const prisma = buildPrismaMock({ status: 'quoted', platformStatus: null });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        platformStatus: 'Active',
        newStatus: 'contacted',
      });

      expect(res.applied).toBe(true);
      expect(res.skipReason).toBe('pipeline_downgrade');
      expect(prisma._state.lead.status).toBe('quoted');
    });

    it('scheduled + Active(contacted) → canonical NOT overwritten', async () => {
      const prisma = buildPrismaMock({ status: 'scheduled', platformStatus: null });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        platformStatus: 'Active',
        newStatus: 'contacted',
      });

      expect(res.skipReason).toBe('pipeline_downgrade');
      expect(prisma._state.lead.status).toBe('scheduled');
    });

    it('completed-lock: completed + Yelp Closed(lost) → canonical NOT overwritten (completed locks against terminals too)', async () => {
      const prisma = buildPrismaMock({
        platform: 'yelp',
        status: 'completed',
        platformStatus: 'Done',
      });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        platformStatus: 'Closed',
        newStatus: 'lost',
      });

      expect(res.applied).toBe(true);
      expect(res.skipReason).toBe('pipeline_downgrade');
      expect(prisma._state.lead.status).toBe('completed');
      expect(prisma._state.lead.platformStatus).toBe('Closed');
    });

    it('forward progression: contacted + Yelp Hired(booked) → canonical updated, no skipReason', async () => {
      const prisma = buildPrismaMock({ status: 'contacted', platformStatus: 'Active' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        platformStatus: 'Hired',
        newStatus: 'booked',
      });

      expect(res.applied).toBe(true);
      expect(res.skipReason).toBeUndefined();
      expect(prisma._state.lead.status).toBe('booked');
      expect(prisma._state.lead.platformStatus).toBe('Hired');
    });

    it('terminal exit from active pipeline: contacted + Yelp Not hired(lost) → canonical=lost (terminals exempt from downgrade)', async () => {
      const prisma = buildPrismaMock({ status: 'contacted', platformStatus: 'Active' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        platformStatus: 'Not hired',
        newStatus: 'lost',
      });

      expect(res.applied).toBe(true);
      expect(res.skipReason).toBeUndefined();
      expect(prisma._state.lead.status).toBe('lost');
    });
  });

  describe('resolveConflict', () => {
    it('flips conflict=false on the audit row', async () => {
      const prisma = buildPrismaMock();
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      await svc.resolveConflict('audit-1', 'pushed_to_sf');

      expect(prisma.leadStatusAuditLog.updateMany).toHaveBeenCalledWith({
        where: { id: 'audit-1', conflict: true },
        data: { conflict: false, conflictNote: 'pushed_to_sf' },
      });
    });
  });
});
