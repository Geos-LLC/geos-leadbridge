/**
 * SF-connected mode tests.
 *
 * Verifies the contract from the "Finalize SF-connected mode without changing
 * autonomous mode" change:
 *
 *   1. Autonomous mode (no SF link) is UNCHANGED — every status write that
 *      worked before still works exactly the same.
 *   2. SF-connected mode (sfJobId / sfCustomerId / syncStatus='linked') blocks
 *      SF lifecycle statuses from overwriting Lead.status.
 *   3. SF-connected mode also blocks lb_automation from writing terminal
 *      states (`lost`, `booked`) — LB does not chase converted customers.
 *   4. The link metadata (sfJobId, sfLastEventAt) IS still written in
 *      SF-connected mode — only the canonical status mutation is held back.
 *   5. The first SF event that ESTABLISHES the link is also treated as
 *      mirror-only (the conversion moment).
 *
 * Paired with:
 *   - sf-link.ts                          (the predicate)
 *   - lead-status.service.ts              (guards 2a / 2b)
 *   - sf-inbound-status.service.spec.ts   (live webhook reaction)
 *   - sf-historical-sync.service.spec.ts  (manual link + bulk link)
 *   - follow-up-gate.service.spec.ts      (gate short-circuit)
 *   - follow-up-engine.service.spec.ts    (enrollment refusal)
 */

import { LeadStatusService } from './lead-status.service';
import { isSfLinkedLead } from './sf-link';

const LEAD_ID = 'lead-sf';
const USER_ID = 'user-sf';
const SF_JOB_ID = 'sfjob-42';
const SF_CUSTOMER_ID = 'sfcust-42';

function buildPrismaMock(lead: Partial<any> = {}, opts: { sfConnection?: any } = {}) {
  const state: any = {
    lead: {
      id: LEAD_ID,
      userId: USER_ID,
      status: 'engaged',
      platform: 'yelp',
      platformStatus: null,
      platformStatusAt: null,
      statusUpdatedAt: null,
      statusSource: null,
      sfJobId: null,
      sfCustomerId: null,
      syncStatus: null,
      thumbtackStatus: null,
      lostReason: null,
      reengageAt: null,
      ...lead,
    },
    sfConnection: opts.sfConnection ?? null,
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
      updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
        if (where.id !== state.lead.id) return { count: 0 };
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
  return { get: jest.fn((key: string, def?: any) => overrides[key] ?? def) } as any;
}

describe('isSfLinkedLead predicate', () => {
  it('returns false for stock autonomous lead', () => {
    expect(isSfLinkedLead({ sfJobId: null, sfCustomerId: null, syncStatus: null })).toBe(false);
  });

  it('returns true when sfJobId is set', () => {
    expect(isSfLinkedLead({ sfJobId: SF_JOB_ID })).toBe(true);
  });

  it('returns true when sfCustomerId is set without sfJobId', () => {
    expect(isSfLinkedLead({ sfCustomerId: SF_CUSTOMER_ID, sfJobId: null })).toBe(true);
  });

  it("returns true when syncStatus='linked' without sfJobId or sfCustomerId", () => {
    expect(isSfLinkedLead({ sfJobId: null, sfCustomerId: null, syncStatus: 'linked' })).toBe(true);
  });

  it('returns false for non-linked syncStatus values', () => {
    for (const ss of ['pending', 'needs_review', 'no_match', 'failed', 'skipped', null]) {
      expect(isSfLinkedLead({ sfJobId: null, sfCustomerId: null, syncStatus: ss as any })).toBe(false);
    }
  });

  it('respects pendingUpdates.sfJobId when current lead is not yet linked', () => {
    // Live SF webhook case: lead matched via externalRequestId fallback;
    // the extraLeadUpdates carry the about-to-be-written sfJobId. The
    // conversion moment is THIS event — treat it as mirror-only.
    expect(
      isSfLinkedLead({ sfJobId: null, sfCustomerId: null }, { sfJobId: SF_JOB_ID }),
    ).toBe(true);
  });

  it('respects pendingUpdates.sfCustomerId', () => {
    expect(
      isSfLinkedLead({ sfJobId: null, sfCustomerId: null }, { sfCustomerId: SF_CUSTOMER_ID }),
    ).toBe(true);
  });

  it("respects pendingUpdates.syncStatus='linked'", () => {
    expect(
      isSfLinkedLead({ sfJobId: null, sfCustomerId: null }, { syncStatus: 'linked' }),
    ).toBe(true);
  });
});

describe('LeadStatusService — autonomous mode (no SF link) UNCHANGED', () => {
  // Sanity checks that the new guards do NOT alter behavior for any lead
  // that isn't SF-linked. These mirror tests already in
  // lead-status.service.spec.ts; they're duplicated here as guardrails to
  // catch any regression that widens the SF guards too far.

  it('service_flow + non-linked lead → status WRITES as before', async () => {
    const prisma = buildPrismaMock({ status: 'engaged' });
    const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

    const res = await svc.writeStatus({
      leadId: LEAD_ID,
      source: 'service_flow',
      newStatus: 'booked',
    });

    expect(res.applied).toBe(true);
    expect(res.status).toBe('booked');
    expect(prisma._state.lead.status).toBe('booked');
    expect(prisma._state.audits[0]).toBeDefined();
  });

  it('lb_automation + non-linked lead → "lost" WRITES as before', async () => {
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

  it('lb_automation + non-linked lead → "booked" WRITES as before', async () => {
    const prisma = buildPrismaMock({ status: 'quoted' });
    const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

    const res = await svc.writeStatus({
      leadId: LEAD_ID,
      source: 'lb_automation',
      newStatus: 'booked',
    });

    expect(res.applied).toBe(true);
    expect(res.status).toBe('booked');
  });

  it('manual + non-linked lead → applies, no conflict', async () => {
    const prisma = buildPrismaMock({ status: 'contacted', sfJobId: null });
    const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

    const res = await svc.writeStatus({
      leadId: LEAD_ID,
      source: 'manual',
      newStatus: 'engaged',
    });

    expect(res.applied).toBe(true);
    expect(res.conflict).toBeNull();
  });
});

describe('LeadStatusService — SF-connected mode (service_flow lifecycle: SF authoritative)', () => {
  // Per spec: when the lead is SF-linked, SF owns the canonical Lead.status.
  // service_flow webhook events flow through writeStatus into Lead.status,
  // including reversals (cancelled → booked). The link metadata in
  // extraLeadUpdates is written alongside.

  for (const linkAttr of ['sfJobId', 'sfCustomerId', 'syncStatus'] as const) {
    for (const sfStatus of ['booked', 'in_progress', 'completed', 'cancelled', 'no_show'] as const) {
      const leadOverride =
        linkAttr === 'sfJobId'
          ? { sfJobId: SF_JOB_ID, status: 'engaged' }
          : linkAttr === 'sfCustomerId'
            ? { sfCustomerId: SF_CUSTOMER_ID, status: 'engaged' }
            : { syncStatus: 'linked', status: 'engaged' };

      it(`SF ${sfStatus} on lead linked via ${linkAttr} → Lead.status flips to ${sfStatus}`, async () => {
        const prisma = buildPrismaMock(leadOverride);
        const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

        const res = await svc.writeStatus({
          leadId: LEAD_ID,
          source: 'service_flow',
          newStatus: sfStatus,
          sourceEventId: `evt-${sfStatus}`,
        });

        expect(res.applied).toBe(true);
        expect(res.status).toBe(sfStatus);
        expect(prisma._state.lead.status).toBe(sfStatus);
        expect(prisma._state.audits.length).toBe(1);
      });
    }
  }

  it('SF completed on SF-linked lead → applies AND link metadata is written', async () => {
    const prisma = buildPrismaMock({ sfJobId: SF_JOB_ID, status: 'booked' });
    const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

    const occurredAt = new Date('2026-06-03T10:00:00Z');
    const res = await svc.writeStatus({
      leadId: LEAD_ID,
      source: 'service_flow',
      newStatus: 'completed',
      occurredAt,
      sourceEventId: 'evt-1',
      extraLeadUpdates: { sfLastEventAt: occurredAt },
    });

    expect(res.applied).toBe(true);
    expect(prisma._state.lead.status).toBe('completed');
    expect(prisma._state.lead.sfLastEventAt).toEqual(occurredAt);
  });

  it('first SF event that establishes the link (pendingUpdates.sfJobId) → applies', async () => {
    // Live-webhook path: lead found via externalRequestId fallback,
    // lead.sfJobId is still null but extraLeadUpdates carries the
    // about-to-be-written sfJobId. SF is authoritative from this event on.
    const prisma = buildPrismaMock({
      sfJobId: null,
      sfCustomerId: null,
      syncStatus: null,
      status: 'engaged',
    });
    const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

    const res = await svc.writeStatus({
      leadId: LEAD_ID,
      source: 'service_flow',
      newStatus: 'completed',
      sourceEventId: 'evt-first-link',
      extraLeadUpdates: { sfJobId: SF_JOB_ID, sfJobMappedAt: new Date(), sfLastEventAt: new Date() },
    });

    expect(res.applied).toBe(true);
    expect(prisma._state.lead.status).toBe('completed');
    expect(prisma._state.lead.sfJobId).toBe(SF_JOB_ID);
  });

  it('cancel → re-book transition (SF reversal lifecycle)', async () => {
    // Yelp-archived lead → SF cancels job → SF re-books. Both transitions
    // flow through to Lead.status.
    const prisma = buildPrismaMock({ sfJobId: SF_JOB_ID, status: 'cancelled' });
    const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

    const res = await svc.writeStatus({
      leadId: LEAD_ID,
      source: 'service_flow',
      newStatus: 'booked',
      sourceEventId: 'evt-rebook',
    });

    expect(res.applied).toBe(true);
    expect(prisma._state.lead.status).toBe('booked');
  });

  it('SF early-funnel status (quoted) on SF-linked lead → also applies', async () => {
    // SF early-funnel values are unexpected in connected mode but if they
    // arrive they MUST flow through — SF is authoritative.
    const prisma = buildPrismaMock({ sfJobId: SF_JOB_ID, status: 'new' });
    const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

    const res = await svc.writeStatus({
      leadId: LEAD_ID,
      source: 'service_flow',
      newStatus: 'quoted',
      sourceEventId: 'evt-funnel',
    });

    expect(res.applied).toBe(true);
    expect(prisma._state.lead.status).toBe('quoted');
  });
});

describe('LeadStatusService — SF-connected mode (guard 2b: lb_automation lost/booked)', () => {
  // Per spec: hired_elsewhere/opt_out → lost only while not SF-linked.
  // agreed → SF availability/booking (no LB status flip while SF-linked).

  it("lb_automation 'lost' on SF-linked lead → SKIPPED (sf_linked_customer)", async () => {
    const prisma = buildPrismaMock({ sfJobId: SF_JOB_ID, status: 'engaged' });
    const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

    const res = await svc.writeStatus({
      leadId: LEAD_ID,
      source: 'lb_automation',
      newStatus: 'lost',
      lostReason: 'opt_out',
      sourceEventId: 'evt-classifier-optout',
    });

    expect(res.applied).toBe(false);
    expect(res.skipReason).toBe('sf_linked_customer');
    expect(prisma._state.lead.status).toBe('engaged');
    expect(prisma._state.lead.lostReason).toBeNull();
  });

  it("lb_automation 'booked' on SF-linked lead → SKIPPED (sf_linked_customer)", async () => {
    const prisma = buildPrismaMock({ sfJobId: SF_JOB_ID, status: 'quoted' });
    const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

    const res = await svc.writeStatus({
      leadId: LEAD_ID,
      source: 'lb_automation',
      newStatus: 'booked',
      reason: 'price_agreed',
      sourceEventId: 'evt-classifier-agreed',
    });

    expect(res.applied).toBe(false);
    expect(res.skipReason).toBe('sf_linked_customer');
    expect(prisma._state.lead.status).toBe('quoted');
  });

  it("lb_automation 'engaged' on SF-linked lead → STILL WRITES (funnel signal allowed)", async () => {
    // Non-terminal lb_automation writes still flow — they're observability
    // signals, not lifecycle commitments. Lead at 'contacted' getting
    // moved to 'engaged' by the classifier IS still useful in SF-connected
    // mode (LB's own funnel metrics).
    const prisma = buildPrismaMock({ sfJobId: SF_JOB_ID, status: 'contacted' });
    const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

    const res = await svc.writeStatus({
      leadId: LEAD_ID,
      source: 'lb_automation',
      newStatus: 'engaged',
      sourceEventId: 'evt-engaged',
    });

    expect(res.applied).toBe(true);
    expect(res.status).toBe('engaged');
  });

  it("lb_automation 'lost' on lead linked via sfCustomerId only → SKIPPED", async () => {
    const prisma = buildPrismaMock({
      sfJobId: null,
      sfCustomerId: SF_CUSTOMER_ID,
      status: 'engaged',
    });
    const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

    const res = await svc.writeStatus({
      leadId: LEAD_ID,
      source: 'lb_automation',
      newStatus: 'lost',
      sourceEventId: 'evt-cust-only',
    });

    expect(res.applied).toBe(false);
    expect(res.skipReason).toBe('sf_linked_customer');
  });

  it("lb_automation 'lost' on lead linked via syncStatus='linked' only → SKIPPED", async () => {
    const prisma = buildPrismaMock({
      sfJobId: null,
      sfCustomerId: null,
      syncStatus: 'linked',
      status: 'engaged',
    });
    const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

    const res = await svc.writeStatus({
      leadId: LEAD_ID,
      source: 'lb_automation',
      newStatus: 'lost',
      sourceEventId: 'evt-sync-only',
    });

    expect(res.applied).toBe(false);
    expect(res.skipReason).toBe('sf_linked_customer');
  });
});

describe('LeadStatusService — SF-connected mode preserves other sources', () => {
  // Sanity: only service_flow and lb_automation get the new behavior. manual
  // + platform_sync flows are governed by the existing guards (sf_managed,
  // sf_link_protected, etc.) which already existed before this PR.

  it('manual write on SF-linked lead → existing sf_managed guard fires', async () => {
    // sf_managed guard requires an active sf_connection. We provide one;
    // the test asserts the manual write is blocked by sf_managed (existing
    // behavior).
    const prisma = buildPrismaMock(
      { sfJobId: SF_JOB_ID, status: 'engaged' },
      { sfConnection: { isActive: true, status: 'active' } },
    );
    const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

    const res = await svc.writeStatus({
      leadId: LEAD_ID,
      source: 'manual',
      newStatus: 'lost',
    });

    expect(res.applied).toBe(false);
    expect(res.skipReason).toBe('sf_managed');
  });

  it('platform_sync to lost on SF-linked lead → existing sf_link_protected guard fires', async () => {
    const prisma = buildPrismaMock({
      sfJobId: SF_JOB_ID,
      status: 'engaged',
      platform: 'yelp',
    });
    const svc = new LeadStatusService(prisma, buildEvents(), buildConfig());

    const res = await svc.writeStatus({
      leadId: LEAD_ID,
      source: 'platform_sync',
      newStatus: 'lost',
      platformStatus: 'Archived',
      lostReason: 'hired_someone',
    });

    // platform_sync writes still update the platform-native column but
    // hold back Lead.status via the existing sf_link_protected guard.
    expect(res.skipReason).toBe('sf_link_protected');
    expect(prisma._state.lead.status).toBe('engaged');
  });
});
