/**
 * `convertToNormalizedLead` SF-fields exposure.
 *
 * Locks in the "SF Connected Mode UI" API contract: every NormalizedLead
 * the LB API returns carries the SF link fields + the `isSfLinked` derived
 * flag computed via the same `isSfLinkedLead` predicate the status-write
 * guards use in LeadStatusService. The frontend (Messages.tsx header,
 * sidebar SF tag) reads `isSfLinked` directly — if this contract drifts,
 * the SF Customer badge silently stops appearing.
 *
 * Exercised via the public `getLead` path with a stubbed prisma + cache,
 * because `convertToNormalizedLead` is private.
 */

import { LeadsService } from './leads.service';

function buildPrisma(lead: any) {
  return {
    lead: {
      findFirst: jest.fn().mockResolvedValue(lead),
    },
  } as any;
}

// Cache pass-through: every getOrSet runs the loader and returns the raw value.
function buildCache() {
  return {
    getOrSet: jest.fn((_key: string, _ttl: number, loader: () => Promise<any>) => loader()),
  } as any;
}

function makeSvc(prisma: any) {
  return new LeadsService(
    prisma,
    {} as any, // platformService
    {} as any, // platformFactory
    {} as any, // configService
    {} as any, // templatesService
    {} as any, // analyticsService
    {} as any, // conversationContext
    null,      // followUpEngine (optional)
    null,      // crmWebhookService (optional)
    {} as any, // trialService
    {} as any, // leadCache
    buildCache(),
    {} as any, // leadStatusService
  );
}

const BASE_LEAD = {
  id: 'lead-1',
  userId: 'user-1',
  platform: 'yelp',
  businessId: 'biz-1',
  externalRequestId: 'ext-1',
  customerName: 'Test Customer',
  customerPhone: null,
  customerEmail: null,
  message: 'hi',
  budget: null,
  postcode: null,
  city: null,
  state: null,
  category: null,
  status: 'engaged',
  thumbtackStatus: null,
  threadId: null,
  createdAt: new Date('2026-06-01T00:00:00Z'),
  updatedAt: new Date('2026-06-01T00:00:00Z'),
  rawJson: null,
  sfJobId: null,
  sfCustomerId: null,
  syncStatus: null,
  sfJobOutcome: null,
  sfJobOutcomeAt: null,
  sfLeadId: null,
  sfLeadStageName: null,
  sfLeadMatchedAt: null,
};

describe('convertToNormalizedLead — SF fields exposure', () => {
  it('autonomous lead (no SF link) → isSfLinked=false, SF fields null', async () => {
    const prisma = buildPrisma({ ...BASE_LEAD });
    const svc = makeSvc(prisma);

    const out = await svc.getLead('user-1', 'lead-1');

    expect(out.isSfLinked).toBe(false);
    expect(out.sfJobId).toBeNull();
    expect(out.sfCustomerId).toBeNull();
    expect(out.syncStatus).toBeNull();
    expect(out.sfJobOutcome).toBeNull();
    expect(out.sfJobOutcomeAt).toBeNull();
  });

  it('lead with sfJobId → isSfLinked=true, sfJobId surfaced', async () => {
    const prisma = buildPrisma({ ...BASE_LEAD, sfJobId: 'sfjob-42' });
    const svc = makeSvc(prisma);

    const out = await svc.getLead('user-1', 'lead-1');

    expect(out.isSfLinked).toBe(true);
    expect(out.sfJobId).toBe('sfjob-42');
  });

  it('lead with sfCustomerId only → isSfLinked=true', async () => {
    const prisma = buildPrisma({ ...BASE_LEAD, sfCustomerId: 'sfcust-9' });
    const svc = makeSvc(prisma);

    const out = await svc.getLead('user-1', 'lead-1');

    expect(out.isSfLinked).toBe(true);
    expect(out.sfCustomerId).toBe('sfcust-9');
    expect(out.sfJobId).toBeNull();
  });

  it("lead with syncStatus='linked' only → isSfLinked=true", async () => {
    const prisma = buildPrisma({ ...BASE_LEAD, syncStatus: 'linked' });
    const svc = makeSvc(prisma);

    const out = await svc.getLead('user-1', 'lead-1');

    expect(out.isSfLinked).toBe(true);
    expect(out.syncStatus).toBe('linked');
  });

  it("syncStatus values other than 'linked' → isSfLinked=false (pending/no_match/needs_review)", async () => {
    for (const ss of ['pending', 'no_match', 'needs_review', 'failed']) {
      const prisma = buildPrisma({ ...BASE_LEAD, syncStatus: ss });
      const svc = makeSvc(prisma);

      const out = await svc.getLead('user-1', 'lead-1');

      expect(out.isSfLinked).toBe(false);
      expect(out.syncStatus).toBe(ss);
    }
  });

  it('sfJobOutcome + sfJobOutcomeAt are passed through verbatim', async () => {
    const outcomeAt = new Date('2026-06-03T12:00:00Z');
    const prisma = buildPrisma({
      ...BASE_LEAD,
      sfJobId: 'sfjob-42',
      sfJobOutcome: 'completed',
      sfJobOutcomeAt: outcomeAt,
    });
    const svc = makeSvc(prisma);

    const out = await svc.getLead('user-1', 'lead-1');

    expect(out.sfJobOutcome).toBe('completed');
    expect(out.sfJobOutcomeAt).toEqual(outcomeAt);
  });

  // PR D (2026-06-05): SF Lead identity fields exposed to UI for badge
  // rendering. CRITICALLY: a lead with sfLeadId ONLY must NOT flip
  // isSfLinked to true — lead-only matches are operationally LB-managed
  // (status pill stays editable, follow-ups continue, AI/classifier
  // unchanged). The badge in Messages.tsx uses sfLeadId as a separate
  // signal, never as a substitute for isSfLinked.
  describe('SF Lead identity (PR D) — fields exposed; does NOT promote isSfLinked', () => {
    it('lead with sfLeadId only → isSfLinked=false, sfLeadId/stage/matchedAt surfaced', async () => {
      const matchedAt = new Date('2026-06-05T01:23:45Z');
      const prisma = buildPrisma({
        ...BASE_LEAD,
        syncStatus: 'lead_linked',
        syncReason: 'sf_lead_only:phone_name',
        sfLeadId: '107',
        sfLeadStageName: 'Contacted',
        sfLeadMatchedAt: matchedAt,
      });
      const svc = makeSvc(prisma);

      const out = await svc.getLead('user-1', 'lead-1');

      // isSfLinked stays FALSE — this is the whole architectural point.
      // Lead-only matches behave like LB-only: status editor stays enabled,
      // follow-ups continue, AI/classifier unchanged. The badge is a
      // separate render condition driven by sfLeadId, not by isSfLinked.
      expect(out.isSfLinked).toBe(false);

      // SF Lead fields are surfaced for the badge + tooltip.
      expect(out.sfLeadId).toBe('107');
      expect(out.sfLeadStageName).toBe('Contacted');
      expect(out.sfLeadMatchedAt).toEqual(matchedAt);

      // Customer/job fields remain null — lead-only never populates these.
      expect(out.sfJobId).toBeNull();
      expect(out.sfCustomerId).toBeNull();
      expect(out.sfJobOutcome).toBeNull();
    });

    it('lead with sfLeadId AND sfJobId (post-conversion) → isSfLinked=true (Customer wins precedence in UI)', async () => {
      // Post-promotion: SF later sent customer_job for the same lb_lead_id.
      // sfLeadId stays additive (PR B); sfJobId promotion flips isSfLinked.
      // The Messages.tsx badge if/else renders SF Customer (isSfLinked
      // branch) — SF Lead badge is suppressed via structural priority.
      const prisma = buildPrisma({
        ...BASE_LEAD,
        sfLeadId: '107',
        sfLeadStageName: 'Converted',
        sfJobId: 'sfjob-42',
        syncStatus: 'linked',
      });
      const svc = makeSvc(prisma);

      const out = await svc.getLead('user-1', 'lead-1');

      expect(out.isSfLinked).toBe(true);
      // Both fields exposed; the UI priority order in Messages.tsx
      // ensures SF Customer wins. The API doesn't enforce mutual
      // exclusion — it leaves the render decision to the client.
      expect(out.sfLeadId).toBe('107');
      expect(out.sfJobId).toBe('sfjob-42');
    });

    it('autonomous lead → sfLead fields null (no badge rendered)', async () => {
      const prisma = buildPrisma({ ...BASE_LEAD });
      const svc = makeSvc(prisma);

      const out = await svc.getLead('user-1', 'lead-1');

      expect(out.isSfLinked).toBe(false);
      expect(out.sfLeadId).toBeNull();
      expect(out.sfLeadStageName).toBeNull();
      expect(out.sfLeadMatchedAt).toBeNull();
    });
  });
});
