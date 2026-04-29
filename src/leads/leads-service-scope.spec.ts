/**
 * LeadsService.getLeads / getAllLeads — account-scope plumbing.
 *
 * The pre-fix bug was at the service: `getLeads` for thumbtack/yelp called
 * `getCachedLeads` with no `businessId`, even when the caller was clearly
 * scoped to one account. The hotfix wires `businessId` and `scope` through.
 *
 * The DB-layer behavior (Prisma where clause) is exercised through a stubbed
 * `getCachedLeads` that records its filter argument. End-to-end DB filtering
 * is covered separately by the controller specs that go through the real
 * service against a Prisma mock.
 */

import { LeadsService } from './leads.service';

function buildService(opts: {
  recordedFilters?: any[];
  cachedLeadsByFilter?: (filter: any) => any[];
  connectedPlatforms?: Array<{ platformName: string; connected: boolean }>;
}) {
  const recordedFilters = opts.recordedFilters ?? [];
  const platformService: any = {
    getUserPlatforms: jest.fn(async () => opts.connectedPlatforms ?? []),
    getCredentials: jest.fn(),
  };

  // Build a real LeadsService and override only the methods we want to observe.
  const svc = new LeadsService(
    /* prisma */ {} as any,
    platformService,
    /* platformFactory */ { getAdapter: jest.fn() } as any,
    /* configService */ {} as any,
    /* templatesService */ {} as any,
    /* analyticsService */ {} as any,
    /* conversationContext */ {} as any,
    /* followUpEngine */ null,
    /* crmWebhookService */ null,
    /* trialService */ {} as any,
    /* leadCache */ {} as any,
    /* cache */ {} as any,
    /* leadStatusService */ {} as any,
  );

  // Replace getCachedLeads with a recorder. This is the seam between
  // getLeads (which we're testing) and the cache/DB layer (already covered
  // by isCacheableLeadFilter and CacheKeys specs).
  (svc as any).getCachedLeads = jest.fn(async (_userId: string, filter: any) => {
    recordedFilters.push(filter);
    return opts.cachedLeadsByFilter ? opts.cachedLeadsByFilter(filter) : [];
  });

  return { svc, recordedFilters };
}

describe('LeadsService.getLeads — account-scope plumbing', () => {
  it('thumbtack + businessId → forwards businessId to getCachedLeads', async () => {
    const { svc, recordedFilters } = buildService({
      cachedLeadsByFilter: (f) =>
        f.businessId === 'biz-A' ? [{ id: 't1', businessId: 'biz-A' } as any] : [],
    });

    const result = await svc.getLeads('user-1', 'thumbtack', { businessId: 'biz-A' });

    expect(recordedFilters[0]).toEqual({
      platform: 'thumbtack',
      businessId: 'biz-A',
      limit: undefined,
    });
    expect(result).toHaveLength(1);
  });

  it('thumbtack + scope=all → does NOT forward businessId (unified)', async () => {
    const { svc, recordedFilters } = buildService({
      cachedLeadsByFilter: () => [
        { id: 't1', businessId: 'biz-A' } as any,
        { id: 't2', businessId: 'biz-B' } as any,
      ],
    });

    const result = await svc.getLeads('user-1', 'thumbtack', { scope: 'all', businessId: 'biz-A' });

    // scope=all wins — businessId is dropped on purpose so the unified
    // view is genuinely unified.
    expect(recordedFilters[0]).toEqual({
      platform: 'thumbtack',
      businessId: undefined,
      limit: undefined,
    });
    expect(result).toHaveLength(2);
  });

  it('yelp + businessId → forwards businessId to getCachedLeads', async () => {
    const { svc, recordedFilters } = buildService({});

    await svc.getLeads('user-1', 'yelp', { businessId: 'yelp-A' });

    expect(recordedFilters[0]).toEqual({
      platform: 'yelp',
      businessId: 'yelp-A',
      limit: undefined,
    });
  });

  it('two thumbtack accounts under same user — each businessId returns only its own leads', async () => {
    // The cache stub partitions by businessId, simulating a per-account DB result.
    const dataset: Record<string, any[]> = {
      'biz-A': [{ id: 'a1', businessId: 'biz-A' } as any, { id: 'a2', businessId: 'biz-A' } as any],
      'biz-B': [{ id: 'b1', businessId: 'biz-B' } as any],
    };
    const { svc } = buildService({
      cachedLeadsByFilter: (f) => (f.businessId ? dataset[f.businessId] ?? [] : Object.values(dataset).flat()),
    });

    const aLeads = await svc.getLeads('user-1', 'thumbtack', { businessId: 'biz-A' });
    const bLeads = await svc.getLeads('user-1', 'thumbtack', { businessId: 'biz-B' });

    expect(aLeads.map((l) => l.id)).toEqual(['a1', 'a2']);
    expect(bLeads.map((l) => l.id)).toEqual(['b1']);
  });

  it('legacy call (no businessId, no scope) → unified, no businessId in filter', async () => {
    const { svc, recordedFilters } = buildService({});

    await svc.getLeads('user-1', 'thumbtack');

    expect(recordedFilters[0].businessId).toBeUndefined();
  });
});

describe('LeadsService.getAllLeads — account-scope plumbing', () => {
  it('forwards businessId to each per-platform getLeads call', async () => {
    const { svc, recordedFilters } = buildService({
      connectedPlatforms: [
        { platformName: 'thumbtack', connected: true },
        { platformName: 'yelp', connected: true },
      ],
    });

    await svc.getAllLeads('user-1', { businessId: 'biz-A' });

    // One filter per platform, each with businessId.
    expect(recordedFilters).toHaveLength(2);
    for (const f of recordedFilters) {
      expect(f.businessId).toBe('biz-A');
    }
  });

  it('Yelp + Thumbtack — Yelp businessId returns no Thumbtack leads (cross-platform isolation)', async () => {
    // The dataset partitions by (platform, businessId), mirroring how the
    // real Lead table behaves: Thumbtack rows have a Thumbtack businessId,
    // Yelp rows have a Yelp businessId, and the columns never collide.
    // When the caller asks for businessId='yelp-Y', the Thumbtack adapter's
    // call returns [] (no Thumbtack row has businessId='yelp-Y') and only
    // the Yelp adapter returns hits.
    const dataset: Array<{ platform: string; businessId: string; lead: any }> = [
      { platform: 'thumbtack', businessId: 'biz-T', lead: { id: 't1', businessId: 'biz-T', platform: 'thumbtack', createdAt: new Date('2026-04-29T10:00:00Z') } },
      { platform: 'yelp', businessId: 'yelp-Y', lead: { id: 'y1', businessId: 'yelp-Y', platform: 'yelp', createdAt: new Date('2026-04-29T11:00:00Z') } },
    ];
    const { svc } = buildService({
      connectedPlatforms: [
        { platformName: 'thumbtack', connected: true },
        { platformName: 'yelp', connected: true },
      ],
      cachedLeadsByFilter: (f) =>
        dataset
          .filter((row) => row.platform === f.platform && (!f.businessId || row.businessId === f.businessId))
          .map((row) => row.lead),
    });

    const result = await svc.getAllLeads('user-1', { businessId: 'yelp-Y' });

    // Only the Yelp lead — no Thumbtack lead leaked through.
    expect(result.map((l) => l.id)).toEqual(['y1']);
  });
});
