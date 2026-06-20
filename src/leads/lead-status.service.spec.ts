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

function buildPrismaMock(lead: Partial<any> = {}, opts: { sfConnection?: any } = {}) {
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
      // SF-link guard inputs — default to null so a stock fixture is
      // treated as "no SF link"; tests opt in by setting them explicitly.
      sfCustomerId: null,
      syncStatus: null,
      thumbtackStatus: null,
      lostReason: null,
      reengageAt: null,
      ...lead,
    },
    sfConnection: opts.sfConnection ?? null, // null = no SF connection
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
      // updateMany powers writeSfJobOutcomeMirror's stale-protected write.
      // Default impl mimics Postgres semantics: returns count=1 when the
      // OR-conditioned where clause matches (sfJobOutcomeAt null or older
      // than the incoming occurredAt), else 0.
      updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
        if (where.id !== state.lead.id) return { count: 0 };
        const cur = state.lead.sfJobOutcomeAt;
        const incoming = (data.sfJobOutcomeAt as Date) ?? null;
        const matchesOr = !cur || (incoming && cur instanceof Date && cur.getTime() < incoming.getTime());
        if (!matchesOr) return { count: 0 };
        Object.assign(state.lead, data);
        state.updates.push(data);
        return { count: 1 };
      }),
    },
    sfConnection: {
      findUnique: jest.fn().mockImplementation(async () => state.sfConnection),
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
        newStatus: 'booked',
      });

      expect(res.applied).toBe(true);
      expect(res.status).toBe('booked');
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
        newStatus: 'booked',
        actorId: USER_ID,
      });

      expect(res.applied).toBe(true);
      expect(res.status).toBe('booked');
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
        newStatus: 'booked',
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
        newStatus: 'engaged',
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

  describe('guard 3: SF archived-reactivation carve-out', () => {
    // SF (and only SF) may reactivate archived → fulfillment lifecycle states.
    // Every other source stays blocked. This carve-out is the narrowest possible
    // exception to HARD_TERMINAL; all other guards (stale, dedup, downgrade)
    // continue to apply on top.

    function buildMetricsMock() {
      return {
        recordSkip: jest.fn(),
        recordSfReactivation: jest.fn(),
        countSkipLastHour: jest.fn().mockReturnValue(0),
        countSfReactivationsLastHour: jest.fn().mockReturnValue(0),
      } as any;
    }

    it.each([
      ['booked'],
      ['booked'],
      ['in_progress'],
      ['completed'],
      ['cancelled'],
      ['no_show'],
    ] as const)('allows service_flow archived → %s', async (target) => {
      const prisma = buildPrismaMock({ status: 'archived', statusUpdatedAt: new Date('2026-01-01') });
      const metrics = buildMetricsMock();
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig(), metrics);

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'service_flow',
        newStatus: target,
        sourceEventId: `sf_evt_${target}`,
        occurredAt: new Date('2026-05-25T17:30:19Z'),
      });

      expect(res.applied).toBe(true);
      expect(res.status).toBe(target);
      expect(prisma._state.lead.status).toBe(target);
      expect(prisma._state.lead.statusSource).toBe('service_flow');
      expect(prisma._state.audits[0].reason).toBe('sf_reactivated_archived');
      expect(prisma._state.audits[0].source).toBe('service_flow');
      expect(prisma._state.audits[0].oldStatus).toBe('archived');
      expect(prisma._state.audits[0].newStatus).toBe(target);
      expect(metrics.recordSfReactivation).toHaveBeenCalledTimes(1);
    });

    it('preserves caller-supplied reason over default sf_reactivated_archived', async () => {
      const prisma = buildPrismaMock({ status: 'archived', statusUpdatedAt: new Date('2026-01-01') });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'service_flow',
        newStatus: 'booked',
        sourceEventId: 'sf_evt_keep_reason',
        reason: 'job_142288_created',
      });

      expect(res.applied).toBe(true);
      expect(prisma._state.audits[0].reason).toBe('job_142288_created');
    });

    it.each([
      ['new'],
      ['engaged'],
      ['engaged'],
      ['quoted'],
      ['lost'],
    ] as const)('blocks service_flow archived → %s (not in reactivation allowlist)', async (target) => {
      const prisma = buildPrismaMock({ status: 'archived' });
      const metrics = buildMetricsMock();
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig(), metrics);

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'service_flow',
        newStatus: target,
        sourceEventId: `sf_evt_block_${target}`,
      });

      expect(res.applied).toBe(false);
      expect(res.skipReason).toBe('hard_terminal');
      expect(prisma._state.audits.length).toBe(0);
      expect(metrics.recordSfReactivation).not.toHaveBeenCalled();
    });

    it.each([['lb_automation'], ['manual'], ['backfill']] as const)(
      'blocks %s archived → scheduled outright (carve-out is SF-only)',
      async (source) => {
        const prisma = buildPrismaMock({ status: 'archived' });
        const metrics = buildMetricsMock();
        const svc = new LeadStatusService(prisma, buildEvents(), buildConfig(), metrics);

        const res = await svc.writeStatus({
          leadId: LEAD_ID,
          source,
          newStatus: 'booked',
          sourceEventId: `${source}_evt_block`,
        });

        expect(res.applied).toBe(false);
        // For lb_automation, Guard 2c (AUTOMATION_FORBIDDEN_DESTINATIONS)
        // fires first and short-circuits before Guard 3 (hard_terminal) can
        // reach the archived check. manual + backfill still hit Guard 3
        // because Guard 2c only applies to lb_automation. Either rejection
        // is correct — the write is blocked.
        if (source === 'lb_automation') {
          expect(res.skipReason).toBe('automation_forbidden_destination');
        } else {
          expect(res.skipReason).toBe('hard_terminal');
        }
        expect(prisma._state.lead.status).toBe('archived');
        expect(prisma._state.audits.length).toBe(0);
        expect(metrics.recordSfReactivation).not.toHaveBeenCalled();
      },
    );

    it('platform_sync cannot reactivate canonical (Lead.status stays archived) even though platformStatus still flows', async () => {
      // applyPlatformSync intentionally writes platformStatus separately from
      // canonical status — that is existing partial-write behavior, not a
      // reactivation. What the carve-out guarantees: Lead.status MUST remain
      // archived for platform_sync, no audit row for canonical reactivation,
      // no metric bump.
      const prisma = buildPrismaMock({ status: 'archived', platformStatus: null, platform: 'yelp' });
      const metrics = buildMetricsMock();
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig(), metrics);

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        newStatus: 'booked',
        platformStatus: 'Active',
        sourceEventId: 'yelp_scrape_evt_block',
      });

      // partial_skip: platformStatus row was written, canonical blocked.
      expect(res.skipReason).toBe('hard_terminal');
      expect(res.status).toBe('archived');
      expect(prisma._state.lead.status).toBe('archived');
      expect(prisma._state.lead.platformStatus).toBe('Active');
      expect(metrics.recordSfReactivation).not.toHaveBeenCalled();
    });

    it('stale_event guard wins over reactivation (older SF event cannot reactivate)', async () => {
      const prisma = buildPrismaMock({
        status: 'archived',
        statusUpdatedAt: new Date('2026-05-25T18:00:00Z'),
      });
      const metrics = buildMetricsMock();
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig(), metrics);

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'service_flow',
        newStatus: 'booked',
        sourceEventId: 'sf_evt_stale',
        occurredAt: new Date('2026-05-25T17:30:19Z'),
      });

      expect(res.applied).toBe(false);
      expect(res.skipReason).toBe('stale_event');
      expect(metrics.recordSfReactivation).not.toHaveBeenCalled();
    });

    it('duplicate guard wins over reactivation (replay of same eventId is idempotent)', async () => {
      const prisma = buildPrismaMock({ status: 'archived', statusUpdatedAt: new Date('2026-01-01') });
      // Mock dedup lookup to find a prior audit row.
      prisma.leadStatusAuditLog.findFirst = jest
        .fn()
        .mockResolvedValueOnce({ id: 'audit-prior' });
      const metrics = buildMetricsMock();
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig(), metrics);

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'service_flow',
        newStatus: 'booked',
        sourceEventId: 'sf_evt_duplicate',
      });

      expect(res.applied).toBe(false);
      expect(res.skipReason).toBe('duplicate');
      expect(metrics.recordSfReactivation).not.toHaveBeenCalled();
    });

    it('rejects non-canonical target even from SF', async () => {
      const prisma = buildPrismaMock({ status: 'archived' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      await expect(
        svc.writeStatus({
          leadId: LEAD_ID,
          source: 'service_flow',
          newStatus: 'snoozed',
          sourceEventId: 'sf_evt_invalid',
        }),
      ).rejects.toThrow(/Invalid status/);
    });

    it('after SF reactivates archived→scheduled, platform downgrade to contacted is held back (canonical stays scheduled)', async () => {
      const prisma = buildPrismaMock({
        status: 'archived',
        statusUpdatedAt: new Date('2026-01-01'),
        platform: 'yelp',
      });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      // Step 1: SF reactivates.
      const r1 = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'service_flow',
        newStatus: 'booked',
        sourceEventId: 'sf_evt_reactivate',
        occurredAt: new Date('2026-05-25T17:30:19Z'),
      });
      expect(r1.applied).toBe(true);
      expect(prisma._state.lead.status).toBe('booked');

      // Step 2: a later platform_sync says Active (→contacted) — must NOT
      // downgrade the canonical status, but platformStatus is allowed to move.
      const r2 = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        newStatus: 'engaged',
        platformStatus: 'Active',
        sourceEventId: 'yelp_scrape_active',
        occurredAt: new Date('2026-05-25T18:00:00Z'),
      });

      // partial_skip: platformStatus flowed, Lead.status held by pipeline_downgrade.
      expect(r2.applied).toBe(true);
      expect(r2.skipReason).toBe('pipeline_downgrade');
      expect(prisma._state.lead.status).toBe('booked');
      expect(prisma._state.lead.platformStatus).toBe('Active');
    });

    it('reactivation log line includes reason=sf_reactivated_archived', async () => {
      const prisma = buildPrismaMock({ status: 'archived', statusUpdatedAt: new Date('2026-01-01') });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const logSpy = jest.spyOn((svc as any).logger, 'log');

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'service_flow',
        newStatus: 'booked',
        sourceEventId: 'sf_evt_log_check',
      });

      expect(res.applied).toBe(true);
      const reactivationLog = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.includes('reason=sf_reactivated_archived'));
      expect(reactivationLog).toBeDefined();
      expect(reactivationLog).toMatch(/result=applied/);
      expect(reactivationLog).toMatch(/source=service_flow/);
      expect(reactivationLog).toMatch(/old_status=archived/);
      expect(reactivationLog).toMatch(/status=booked/);
    });
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

    it('SF_STATUS_WINS=true does not produce sf_protected for service_flow on SF-linked leads', async () => {
      // SF-connected mode: SF is authoritative for canonical Lead.status.
      // Guard 4 (SF_STATUS_WINS) only gates lb_automation writes; service_flow
      // writes flow through and apply.
      const prisma = buildPrismaMock({ sfJobId: 'sf_42', status: 'new' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig({ SF_STATUS_WINS: 'true' }));

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'service_flow',
        newStatus: 'in_progress',
      });

      expect(res.skipReason).not.toBe('sf_protected');
      expect(res.applied).toBe(true);
      expect(res.status).toBe('in_progress');
    });
  });

  // ─── Guard 4b: SF-managed (manual writes blocked on linked + connected) ──
  // The user-facing UX rule: in SF-connected mode, a normal LB user must
  // not "mark done / lost" on an SF-linked lead — SF owns lifecycle. Only
  // admin paths that pass adminOverride=true bypass.
  describe('guard 4b: SF-managed (manual writes blocked when sf_connection active)', () => {
    const ACTIVE_CONN = { isActive: true, status: 'active' };

    it('blocks source=manual on SF-linked lead when sf_connection is active', async () => {
      const prisma = buildPrismaMock(
        { sfJobId: 'sf_42', status: 'booked' },
        { sfConnection: ACTIVE_CONN },
      );
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'manual',
        newStatus: 'completed',
        actorType: 'user',
        actorId: USER_ID,
      });

      expect(res.applied).toBe(false);
      expect(res.skipReason).toBe('sf_managed');
      // Lead.status untouched.
      expect(prisma._state.lead.status).toBe('booked');
    });

    it('does NOT block source=manual when there is no sf_connection (autonomous LB mode)', async () => {
      const prisma = buildPrismaMock(
        { sfJobId: 'sf_42', status: 'booked' },  // sfJobId set, but no connection
        { sfConnection: null },
      );
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'manual',
        newStatus: 'completed',
      });

      expect(res.applied).toBe(true);
    });

    it('does NOT block source=manual when the lead has no sfJobId (unlinked)', async () => {
      const prisma = buildPrismaMock(
        { sfJobId: null, status: 'booked' },
        { sfConnection: ACTIVE_CONN },
      );
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'manual',
        newStatus: 'completed',
      });

      expect(res.applied).toBe(true);
    });

    it('does NOT block source=manual when sf_connection is inactive', async () => {
      const prisma = buildPrismaMock(
        { sfJobId: 'sf_42', status: 'booked' },
        { sfConnection: { isActive: false, status: 'disconnected' } },
      );
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'manual',
        newStatus: 'completed',
      });

      expect(res.applied).toBe(true);
    });

    it('adminOverride=true bypasses the guard (support/admin path)', async () => {
      const prisma = buildPrismaMock(
        { sfJobId: 'sf_42', status: 'booked' },
        { sfConnection: ACTIVE_CONN },
      );
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'manual',
        newStatus: 'completed',
        adminOverride: true,
      });

      expect(res.applied).toBe(true);
      expect(prisma._state.lead.status).toBe('completed');
    });

    it('does NOT produce sf_managed for service_flow on SF-linked + connected leads (SF is authoritative)', async () => {
      // SF-connected mode: SF is authoritative for canonical Lead.status.
      // Guard 4b (sf_managed) only gates manual writes; service_flow writes
      // flow through and apply.
      const prisma = buildPrismaMock(
        { sfJobId: 'sf_42', status: 'booked' },
        { sfConnection: ACTIVE_CONN },
      );
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'service_flow',
        newStatus: 'completed',
        sourceEventId: 'evt-sf-1',
      });

      expect(res.skipReason).not.toBe('sf_managed');
      expect(res.applied).toBe(true);
      expect(res.status).toBe('completed');
    });

    it('does NOT produce sf_managed for lb_automation (but new SF-link guard 2b blocks lost/booked instead)', async () => {
      // Pre-PR contract: lb_automation 'booked' on SF-linked → applied=true
      // (Guard 4b targets manual only).
      // Post-PR contract: lb_automation lost/booked on SF-linked → blocked
      // with skipReason='sf_linked_customer' (Guard 2b). 'sf_managed' is
      // still NOT the reason — the invariant the original test cared about
      // is preserved.
      const prisma = buildPrismaMock(
        { sfJobId: 'sf_42', status: 'engaged' },
        { sfConnection: ACTIVE_CONN },
      );
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig({ SF_STATUS_WINS: 'false' }));

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'booked',
      });

      expect(res.skipReason).not.toBe('sf_managed');
      expect(res.skipReason).toBe('sf_linked_customer');
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

    it('service_flow on scoped SF-linked lead → applies (SF is authoritative)', async () => {
      // SF-connected mode: SF owns the lifecycle. service_flow writes flow
      // through the normal guard chain regardless of SF_STATUS_WINS_USER_IDS
      // scope (that scope gates lb_automation only).
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
      expect(prisma._state.lead.status).toBe('in_progress');
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
        newStatus: 'booked',
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
        newStatus: 'engaged',
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
      // 2026-06-17 lifecycle rule cleanup: lb_automation is no longer the
      // authority for `booked` writes; manual is. The pipeline-downgrade
      // guard's "skipping forward through the pipeline" property is
      // source-agnostic and exercised here via manual.
      const prisma = buildPrismaMock({ status: 'engaged' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'manual',
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
        newStatus: 'engaged',
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
        newStatus: 'engaged',
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
        newStatus: 'engaged',
      });

      expect(res.applied).toBe(true);
      expect(res.skipReason).toBe('pipeline_downgrade');
      expect(prisma._state.lead.status).toBe('quoted');
    });

    it('scheduled + Active(contacted) → canonical NOT overwritten', async () => {
      const prisma = buildPrismaMock({ status: 'booked', platformStatus: null });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        platformStatus: 'Active',
        newStatus: 'engaged',
      });

      expect(res.skipReason).toBe('pipeline_downgrade');
      expect(prisma._state.lead.status).toBe('booked');
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
      const prisma = buildPrismaMock({ status: 'engaged', platformStatus: 'Active' });
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
      const prisma = buildPrismaMock({ status: 'engaged', platformStatus: 'Active' });
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

  // ─── Guard: SF-link protection (archive/lost on linked lead) ────────────
  // Spec: When Yelp archives a lead (raw "Archived" / "Closed" / "Not hired"
  // → canonical `lost`), LB must NOT downgrade to "No hire" if SF has
  // already linked the lead — either via the live webhook path (sfJobId),
  // the historical reconciliation (sfCustomerId), or an explicit
  // syncStatus='linked'. Independent of SF_STATUS_WINS. platformStatus
  // still flows so analytics keeps the marketplace breadcrumb; only the
  // canonical Lead.status is held back. A later service_flow write (SF
  // scheduling/completing the job) overrides freely because `lost` is not
  // a hard terminal.
  describe('guard: SF-link protection (archive/lost on linked lead)', () => {
    const ARCHIVED_EVENT_ID = 'yelp_scrape_archive_evt_1';

    it('1. Yelp archived + no SF link → lost (lostReason=archived; Yelp closed the thread, cause unknown)', async () => {
      const prisma = buildPrismaMock({
        platform: 'yelp',
        status: 'engaged',
        platformStatus: 'Active',
        sfJobId: null,
        sfCustomerId: null,
        syncStatus: null,
      });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        newStatus: 'lost',
        platformStatus: 'Archived',
        lostReason: 'archived',
        sourceEventId: ARCHIVED_EVENT_ID,
      });

      expect(res.applied).toBe(true);
      expect(res.skipReason).toBeUndefined();
      expect(prisma._state.lead.status).toBe('lost');
      expect(prisma._state.lead.platformStatus).toBe('Archived');
      // Distinct from 'hired_someone' — Yelp closing the thread does NOT
      // tell us the customer hired anyone. Re-engage path keys on
      // 'hired_someone' so 'archived' won't trigger speculative follow-ups.
      expect(prisma._state.lead.lostReason).toBe('archived');
      expect(prisma._state.lead.statusSource).toBe('platform_sync');
      expect(prisma._state.audits[0].reason).toBe('archived');
      expect(prisma._state.audits[0].source).toBe('platform_sync');
      expect(prisma._state.audits[0].newStatus).toBe('lost');
    });

    it('2. Yelp archived + sfJobId set → SF-link guard blocks canonical, platformStatus still flows', async () => {
      const prisma = buildPrismaMock({
        platform: 'yelp',
        status: 'booked',
        platformStatus: 'Hired',
        sfJobId: 'sfjob-99',
        sfCustomerId: null,
        syncStatus: null,
      });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        newStatus: 'lost',
        platformStatus: 'Archived',
        lostReason: 'hired_someone',
        sourceEventId: ARCHIVED_EVENT_ID,
      });

      expect(res.applied).toBe(true);
      expect(res.skipReason).toBe('sf_link_protected');
      // Canonical preserved — SF still owns lifecycle.
      expect(prisma._state.lead.status).toBe('booked');
      expect(prisma._state.lead.lostReason).toBeNull();
      // platformStatus still updated so the breadcrumb survives.
      expect(prisma._state.lead.platformStatus).toBe('Archived');
    });

    it('3. Yelp archived + sfCustomerId set → SF-link guard blocks canonical', async () => {
      const prisma = buildPrismaMock({
        platform: 'yelp',
        status: 'in_progress',
        platformStatus: 'Active',
        sfJobId: null,
        sfCustomerId: 'sfcust-77',
        syncStatus: null,
      });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        newStatus: 'lost',
        platformStatus: 'Archived',
        lostReason: 'hired_someone',
        sourceEventId: ARCHIVED_EVENT_ID,
      });

      expect(res.applied).toBe(true);
      expect(res.skipReason).toBe('sf_link_protected');
      expect(prisma._state.lead.status).toBe('in_progress');
      expect(prisma._state.lead.platformStatus).toBe('Archived');
    });

    it('4. Yelp archived + syncStatus=linked → SF-link guard blocks canonical', async () => {
      const prisma = buildPrismaMock({
        platform: 'yelp',
        status: 'booked',
        platformStatus: 'Hired',
        sfJobId: null,
        sfCustomerId: null,
        syncStatus: 'linked',
      });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        newStatus: 'lost',
        platformStatus: 'Archived',
        lostReason: 'hired_someone',
        sourceEventId: ARCHIVED_EVENT_ID,
      });

      expect(res.applied).toBe(true);
      expect(res.skipReason).toBe('sf_link_protected');
      expect(prisma._state.lead.status).toBe('booked');
      expect(prisma._state.lead.platformStatus).toBe('Archived');
    });

    it('5. Yelp archived then SF completed later → SF wins (lost is not a hard terminal)', async () => {
      // Sequence: a non-SF-linked Yelp archive lands LB on `lost`. Later
      // SF sends a job.status_changed with newStatus='completed'. SF
      // bypasses automation_terminal (manual+service_flow exempt), lost
      // is off-pipeline so no downgrade block, and hard_terminal only
      // covers `archived`. SF should win.
      const prisma = buildPrismaMock({
        platform: 'yelp',
        status: 'engaged',
        sfJobId: null,
        sfCustomerId: null,
        syncStatus: null,
      });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      // Step 1: Yelp archives.
      const r1 = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        newStatus: 'lost',
        platformStatus: 'Archived',
        lostReason: 'hired_someone',
        sourceEventId: 'yelp_archived_step1',
        occurredAt: new Date('2026-06-01T10:00:00Z'),
      });
      expect(r1.applied).toBe(true);
      expect(prisma._state.lead.status).toBe('lost');

      // Step 2: SF later marks the lead completed (job finished).
      const r2 = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'service_flow',
        newStatus: 'completed',
        sourceEventId: 'sf_evt_completed_step2',
        reason: 'job_142288_completed',
        occurredAt: new Date('2026-06-02T15:00:00Z'),
      });

      expect(r2.applied).toBe(true);
      expect(prisma._state.lead.status).toBe('completed');
      expect(prisma._state.lead.statusSource).toBe('service_flow');
      // lostReason cleared on exit from `lost`.
      expect(prisma._state.lead.lostReason).toBeNull();
    });

    it('6. Yelp archived then SF scheduled later → SF wins (sideways out of lost)', async () => {
      const prisma = buildPrismaMock({
        platform: 'yelp',
        status: 'engaged',
        sfJobId: null,
        sfCustomerId: null,
        syncStatus: null,
      });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const r1 = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        newStatus: 'lost',
        platformStatus: 'Archived',
        lostReason: 'hired_someone',
        sourceEventId: 'yelp_archived_step1_b',
        occurredAt: new Date('2026-06-01T10:00:00Z'),
      });
      expect(r1.applied).toBe(true);

      const r2 = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'service_flow',
        newStatus: 'booked',
        sourceEventId: 'sf_evt_scheduled_step2_b',
        occurredAt: new Date('2026-06-02T15:00:00Z'),
      });

      expect(r2.applied).toBe(true);
      expect(prisma._state.lead.status).toBe('booked');
      expect(prisma._state.lead.statusSource).toBe('service_flow');
      expect(prisma._state.lead.lostReason).toBeNull();
    });

    it('7. duplicate Yelp archived event → idempotent, no duplicate audit spam', async () => {
      const prisma = buildPrismaMock({
        platform: 'yelp',
        status: 'engaged',
        sfJobId: null,
        sfCustomerId: null,
        syncStatus: null,
      });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const DUP_EVENT_ID = 'yelp_scrape_archived_duplicate';

      // First delivery applies.
      const r1 = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        newStatus: 'lost',
        platformStatus: 'Archived',
        lostReason: 'hired_someone',
        sourceEventId: DUP_EVENT_ID,
        occurredAt: new Date('2026-06-01T10:00:00Z'),
      });
      expect(r1.applied).toBe(true);
      expect(prisma._state.audits.length).toBe(1);

      // Second delivery (same sourceEventId) hits the dedup guard.
      prisma.leadStatusAuditLog.findFirst = jest
        .fn()
        .mockResolvedValueOnce({ id: prisma._state.audits[0].id });

      const r2 = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        newStatus: 'lost',
        platformStatus: 'Archived',
        lostReason: 'hired_someone',
        sourceEventId: DUP_EVENT_ID,
        occurredAt: new Date('2026-06-01T10:01:00Z'),
      });

      expect(r2.applied).toBe(false);
      expect(r2.skipReason).toBe('duplicate');
      // No additional audit row created — count stays at 1.
      expect(prisma._state.audits.length).toBe(1);
    });

    // Additional coverage: archive/lost is the only newStatus the SF-link
    // guard targets. Forward progressions still flow when SF is linked
    // (subject to existing SF_STATUS_WINS gate elsewhere).
    it('forward progression to booked on SF-linked lead is NOT blocked by sf_link_protected', async () => {
      const prisma = buildPrismaMock({
        platform: 'yelp',
        status: 'engaged',
        sfJobId: 'sfjob-99',
        sfCustomerId: null,
        syncStatus: null,
      });
      // SF_STATUS_WINS=false so the env-based sf_protected guard doesn't fire.
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig({ SF_STATUS_WINS: 'false' }));

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        newStatus: 'booked',
        platformStatus: 'Hired',
        sourceEventId: 'yelp_hired_progress',
      });

      expect(res.applied).toBe(true);
      expect(res.skipReason).toBeUndefined();
      expect(prisma._state.lead.status).toBe('booked');
    });

    it('lifecycle protection: platform_sync `lost` from booked/scheduled/in_progress is blocked even without SF link', async () => {
      // Yelp sometimes archives a lead the operator has already booked
      // off-platform. The marketplace view is stale; LB must hold the
      // fulfillment state. Independent of SF — pure marketplace-vs-LB
      // semantics. Cancellation/lost from `engaged` still flows freely.
      const states: Array<'booked' | 'booked' | 'in_progress'> = [
        'booked',
        'booked',
        'in_progress',
      ];
      for (const fromState of states) {
        const prisma = buildPrismaMock({
          platform: 'yelp',
          status: fromState,
          platformStatus: 'Hired',
          sfJobId: null,
          sfCustomerId: null,
          syncStatus: null,
        });
        const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

        const res = await svc.writeStatus({
          leadId: LEAD_ID,
          source: 'platform_sync',
          newStatus: 'lost',
          platformStatus: 'Archived',
          lostReason: 'hired_someone',
          sourceEventId: `yelp_archived_from_${fromState}`,
        });

        expect(res.applied).toBe(true);
        expect(res.skipReason).toBe('pipeline_downgrade');
        expect(prisma._state.lead.status).toBe(fromState);
        // platformStatus still flowed.
        expect(prisma._state.lead.platformStatus).toBe('Archived');
      }
    });

    it('emits a greppable "skipped_archived_due_to_sf_link" log marker when blocked', async () => {
      const prisma = buildPrismaMock({
        platform: 'yelp',
        status: 'booked',
        sfJobId: 'sfjob-99',
        sfCustomerId: null,
        syncStatus: null,
      });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());
      const logSpy = jest.spyOn((svc as any).logger, 'log');

      await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'platform_sync',
        newStatus: 'lost',
        platformStatus: 'Archived',
        lostReason: 'hired_someone',
        sourceEventId: 'yelp_arc_log_check',
      });

      const markerLine = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.includes('skipped_archived_due_to_sf_link'));
      expect(markerLine).toBeDefined();
      expect(markerLine).toMatch(/sf_job_id=sfjob-99/);
      expect(markerLine).toMatch(/attempted=lost/);
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

  // ── writeSfJobOutcomeMirror — Phase 1 SF operational lifecycle ─────
  // Shared helper called by sf-inbound AND sf-historical-sync. Stale-
  // protected at the SQL level by the OR(sfJobOutcomeAt < occurredAt)
  // clause. Always returns; never throws.
  describe('writeSfJobOutcomeMirror', () => {
    it('writes outcome + occurredAt when sfJobOutcomeAt is null', async () => {
      const prisma = buildPrismaMock({ sfJobOutcomeAt: null, sfJobOutcome: null });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());
      const occurredAt = new Date('2026-06-03T17:30:00Z');
      const r = await svc.writeSfJobOutcomeMirror(LEAD_ID, 'booked', occurredAt, {
        sfJobId: 'SF-A', sourceEventId: 'evt-1', userId: USER_ID,
      });
      expect(r.written).toBe(true);
      expect(prisma._state.lead.sfJobOutcome).toBe('booked');
      expect(prisma._state.lead.sfJobOutcomeAt).toEqual(occurredAt);
    });

    it('overwrites when incoming occurredAt is newer', async () => {
      const earlier = new Date('2026-06-01T00:00:00Z');
      const later = new Date('2026-06-03T17:30:00Z');
      const prisma = buildPrismaMock({ sfJobOutcomeAt: earlier, sfJobOutcome: 'in_progress' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());
      const r = await svc.writeSfJobOutcomeMirror(LEAD_ID, 'completed', later);
      expect(r.written).toBe(true);
      expect(prisma._state.lead.sfJobOutcome).toBe('completed');
    });

    it('does NOT overwrite when incoming occurredAt is stale (older than stored)', async () => {
      const newer = new Date('2026-06-03T17:30:00Z');
      const older = new Date('2026-06-01T00:00:00Z');
      const prisma = buildPrismaMock({ sfJobOutcomeAt: newer, sfJobOutcome: 'completed' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());
      const r = await svc.writeSfJobOutcomeMirror(LEAD_ID, 'booked', older);
      expect(r.written).toBe(false);
      expect(prisma._state.lead.sfJobOutcome).toBe('completed');
      expect(prisma._state.lead.sfJobOutcomeAt).toEqual(newer);
    });

    it('returns written=false silently when prisma.updateMany throws (never propagates)', async () => {
      const prisma = buildPrismaMock();
      prisma.lead.updateMany.mockRejectedValueOnce(new Error('connection lost'));
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());
      const r = await svc.writeSfJobOutcomeMirror(LEAD_ID, 'booked', new Date());
      expect(r.written).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 2026-06-17 lifecycle rule cleanup — Guard 2c spec tests
  //
  // Mirrors Scope D of the spec PR. Each `it` cites the spec test it covers.
  // ────────────────────────────────────────────────────────────────────────
  describe('Guard 2c — AI lifecycle terminal rule (spec D 2026-06-17)', () => {
    // Spec D.3: opt_out intent → lost opt_out (allowed).
    it('lb_automation lost+opt_out on engaged lead → APPLIES', async () => {
      const prisma = buildPrismaMock({ status: 'engaged' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'lost',
        lostReason: 'opt_out',
      });

      expect(res.applied).toBe(true);
      expect(res.status).toBe('lost');
      expect(prisma._state.lead.lostReason).toBe('opt_out');
    });

    // Spec D.4: hired_elsewhere intent on active lead → lost hired_someone.
    it('lb_automation lost+hired_someone on engaged lead → APPLIES + sets reengageAt', async () => {
      const prisma = buildPrismaMock({ status: 'engaged' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());
      const reengageAt = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'lost',
        lostReason: 'hired_someone',
        reengageAt,
      });

      expect(res.applied).toBe(true);
      expect(prisma._state.lead.lostReason).toBe('hired_someone');
      expect(prisma._state.lead.reengageAt).toEqual(reengageAt);
    });

    // Spec D.5: hired_elsewhere intent on booked lead → ignored / stays booked.
    it('lb_automation lost+hired_someone on BOOKED lead → SKIPPED, stays booked', async () => {
      const prisma = buildPrismaMock({ status: 'booked' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'lost',
        lostReason: 'hired_someone',
      });

      expect(res.applied).toBe(false);
      expect(res.skipReason).toBe('automation_forbidden_destination');
      expect(prisma._state.lead.status).toBe('booked');
    });

    // Spec D.5 (parallel): same protection for in_progress and completed —
    // any post-acquisition state must be safe from AI downgrade.
    it.each([['in_progress'], ['completed']] as const)(
      'lb_automation lost+hired_someone on %s lead → SKIPPED, status preserved',
      async (oldStatus) => {
        const prisma = buildPrismaMock({ status: oldStatus });
        const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

        const res = await svc.writeStatus({
          leadId: LEAD_ID,
          source: 'lb_automation',
          newStatus: 'lost',
          lostReason: 'hired_someone',
        });

        expect(res.applied).toBe(false);
        expect(res.skipReason).toBe('automation_forbidden_destination');
        expect(prisma._state.lead.status).toBe(oldStatus);
      },
    );

    // Spec D.6: classifier wrap-up ("completed" intent / "thanks") does not
    // map to lost. Verified at the gate-mapping level (intentToTransitionKind
    // returns 'engaged' now); this is the belt-and-suspenders at the
    // service layer — any attempted lb_automation lost write without an
    // allowed lostReason is blocked.
    it.each([['no_response'], ['manual'], [null]] as const)(
      'lb_automation lost with lostReason=%p → SKIPPED (only opt_out / hired_someone allowed)',
      async (reason) => {
        const prisma = buildPrismaMock({ status: 'engaged' });
        const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

        const res = await svc.writeStatus({
          leadId: LEAD_ID,
          source: 'lb_automation',
          newStatus: 'lost',
          lostReason: reason as any,
        });

        expect(res.applied).toBe(false);
        expect(res.skipReason).toBe('automation_forbidden_destination');
      },
    );

    // Spec D.1: booked lead + customer "thanks again" must NOT flip lost.
    // The transition into `lost` from `booked` would route via
    // automation.service.applyCustomerReplyStatusTransition; if the
    // classifier somehow tries to write `lost` here, Guard 2c blocks it.
    // This test pins the LeadStatusService-side behavior (the gate level
    // is covered separately in automation.service.spec).
    it('lb_automation lost on booked lead → SKIPPED, booked preserved', async () => {
      const prisma = buildPrismaMock({ status: 'booked' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'lost',
        lostReason: 'hired_someone',
        reason: 'classifier_completed',
      });

      expect(res.applied).toBe(false);
      expect(prisma._state.lead.status).toBe('booked');
    });

    // Spec D.2 (companion): new lead + customer reply → engaged still flows.
    // Engaged is not in AUTOMATION_FORBIDDEN_DESTINATIONS, so Guard 2c
    // passes through and the funnel promotion happens normally.
    it('lb_automation engaged on new lead → APPLIES (funnel promotion unaffected)', async () => {
      const prisma = buildPrismaMock({ status: 'new' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'engaged',
        reason: 'customer_replied',
      });

      expect(res.applied).toBe(true);
      expect(res.status).toBe('engaged');
    });

    // Spec A.3 carve-out: lost+hired_someone → engaged is allowed for
    // lb_automation (re-engagement loop). Verifies the Guard 5 carve-out.
    it('lb_automation engaged on lost+hired_someone → APPLIES (re-engagement carve-out)', async () => {
      const prisma = buildPrismaMock({ status: 'lost', lostReason: 'hired_someone' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'engaged',
        reason: 'reengagement_customer_replied',
      });

      expect(res.applied).toBe(true);
      expect(res.status).toBe('engaged');
      // lostReason clears on lost-exit (existing projection logic).
      expect(prisma._state.lead.lostReason).toBeNull();
    });

    // Companion to A.3: lost+opt_out is NEVER recoverable by lb_automation.
    // Only manual / service_flow may transition out.
    it('lb_automation engaged on lost+opt_out → SKIPPED (opt_out is final for AI)', async () => {
      const prisma = buildPrismaMock({ status: 'lost', lostReason: 'opt_out' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'engaged',
        reason: 'customer_replied',
      });

      expect(res.applied).toBe(false);
      expect(res.skipReason).toBe('automation_terminal');
      expect(prisma._state.lead.status).toBe('lost');
    });

    // 2026-06-20 extension: lostReason='archived' (Yelp closed the thread —
    // see yelp-status-map.ts) is treated identically to 'hired_someone' by
    // the recovery carve-out. If a Yelp customer un-archives and replies,
    // lb_automation must be able to promote them back into the active funnel.
    it('lb_automation engaged on lost+archived → APPLIES (Yelp un-archive recovery)', async () => {
      const prisma = buildPrismaMock({ status: 'lost', lostReason: 'archived' });
      const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

      const res = await svc.writeStatus({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'engaged',
        reason: 'reengagement_customer_replied',
      });

      expect(res.applied).toBe(true);
      expect(res.status).toBe('engaged');
      expect(prisma._state.lead.lostReason).toBeNull();
    });
  });
});
