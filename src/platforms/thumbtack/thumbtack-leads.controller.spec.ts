/**
 * ThumbtackController.getLeads — account-scope + cross-platform-merge
 * deprecation contract.
 *
 *   ?businessId=<id> → only that account's leads (stable; no deprecation
 *                       header). Resolves to one platform via SavedAccount.
 *   ?scope=all       → DEPRECATED cross-platform merge of Thumbtack + Yelp.
 *                       Behavior preserved for the LB frontend Messages page;
 *                       endpoint emits `X-LeadBridge-Deprecated: cross-platform-merge`
 *                       so SF + frontend can migrate to `/v1/leads?scope=all`.
 *                       Strict-platform cut happens in a follow-up commit
 *                       after callers migrate.
 *   neither          → 400 (strict mode)
 *   both             → 400
 *
 * These tests pin the contract using a minimal stub for LeadsService.getLeads,
 * a mock prisma.savedAccount.findFirst, and a fake Express Response that
 * captures setHeader calls.
 */

import { BadRequestException } from '@nestjs/common';
import { ThumbtackController } from './thumbtack.controller';

const USER = { id: 'user-1' };

function buildController(opts: {
  thumbtackLeads?: any[];
  yelpLeads?: any[];
  savedAccount?: { businessId: string; platform: 'thumbtack' | 'yelp' } | null;
} = {}) {
  const calls: Array<{ platform: string; options: any }> = [];

  const leadsService: any = {
    getLeads: jest.fn(async (_userId: string, platform: string, options: any) => {
      calls.push({ platform, options });
      if (platform === 'thumbtack') return opts.thumbtackLeads ?? [];
      if (platform === 'yelp') return opts.yelpLeads ?? [];
      return [];
    }),
    enrichLeadsWithAccountInfo: jest.fn(async (_userId: string, leads: any[]) => leads),
  };

  const prisma: any = {
    savedAccount: {
      findFirst: jest.fn(async () => opts.savedAccount ?? null),
    },
  };

  const configService: any = { get: jest.fn(() => 'http://localhost:5173') };
  const controller = new ThumbtackController(
    /* platformService */ {} as any,
    /* platformFactory */ {} as any,
    leadsService,
    configService,
    prisma,
  );

  return { controller, leadsService, prisma, calls };
}

function fakeRes() {
  const headers: Record<string, string> = {};
  return {
    res: { setHeader: jest.fn((k: string, v: string) => { headers[k] = v; }) } as any,
    headers,
  };
}

describe('ThumbtackController.getLeads — account-scope', () => {
  it('businessId → resolves platform via SavedAccount and calls only that adapter', async () => {
    const { controller, leadsService, prisma, calls } = buildController({
      thumbtackLeads: [{ id: 't1', businessId: 'biz-A', createdAt: new Date('2026-04-29T10:00Z') }],
      savedAccount: { businessId: 'biz-A', platform: 'thumbtack' },
    });
    const { res, headers } = fakeRes();

    const out = await controller.getLeads(USER, res, undefined, undefined, 'biz-A', undefined);

    expect(prisma.savedAccount.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', businessId: 'biz-A' },
      select: { platform: true, businessId: true },
    });
    // Only ONE getLeads call — not the Thumbtack+Yelp merge.
    expect(leadsService.getLeads).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual({
      platform: 'thumbtack',
      options: expect.objectContaining({ businessId: 'biz-A' }),
    });
    expect(out.leads).toHaveLength(1);
    // No deprecation header on businessId branch — that branch is stable.
    expect(headers['X-LeadBridge-Deprecated']).toBeUndefined();
  });

  it('businessId for a Yelp account → calls only the Yelp adapter, no Thumbtack call', async () => {
    const { controller, leadsService, calls } = buildController({
      yelpLeads: [{ id: 'y1', businessId: 'yelp-biz', createdAt: new Date() }],
      savedAccount: { businessId: 'yelp-biz', platform: 'yelp' },
    });
    const { res } = fakeRes();

    await controller.getLeads(USER, res, undefined, undefined, 'yelp-biz', undefined);

    expect(leadsService.getLeads).toHaveBeenCalledTimes(1);
    expect(calls[0].platform).toBe('yelp');
    expect(calls[0].options).toEqual(expect.objectContaining({ businessId: 'yelp-biz' }));
  });

  it('businessId not owned by user → 400', async () => {
    const { controller } = buildController({ savedAccount: null });
    const { res } = fakeRes();

    await expect(
      controller.getLeads(USER, res, undefined, undefined, 'unknown-biz', undefined),
    ).rejects.toThrow(BadRequestException);
  });

  it('scope=all → STILL returns cross-platform merge during deprecation window', async () => {
    // Frontend Messages page depends on this — do not break it.
    const { controller, leadsService, calls } = buildController({
      thumbtackLeads: [{ id: 't1', platform: 'thumbtack', businessId: 'biz-A', createdAt: new Date('2026-04-29T11:00Z') }],
      yelpLeads: [{ id: 'y1', platform: 'yelp', businessId: 'yelp-biz', createdAt: new Date('2026-04-29T12:00Z') }],
    });
    const { res } = fakeRes();

    const out = await controller.getLeads(USER, res, undefined, undefined, undefined, 'all');

    expect(leadsService.getLeads).toHaveBeenCalledTimes(2);
    expect(calls.map((c) => c.platform).sort()).toEqual(['thumbtack', 'yelp']);
    for (const c of calls) {
      expect(c.options).toEqual(expect.objectContaining({ scope: 'all' }));
    }
    expect(out.count).toBe(2);
  });

  it('scope=all → emits X-LeadBridge-Deprecated header pointing to /v1/leads?scope=all', async () => {
    const { controller } = buildController({
      thumbtackLeads: [{ id: 't1', platform: 'thumbtack', businessId: 'biz-A', createdAt: new Date() }],
      yelpLeads: [{ id: 'y1', platform: 'yelp', businessId: 'yelp-biz', createdAt: new Date() }],
    });
    const { res, headers } = fakeRes();

    await controller.getLeads(USER, res, undefined, undefined, undefined, 'all');

    expect(res.setHeader).toHaveBeenCalledWith('X-LeadBridge-Deprecated', 'cross-platform-merge');
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-LeadBridge-Deprecation-Replacement',
      '/v1/leads?scope=all',
    );
    expect(headers['X-LeadBridge-Deprecated']).toBe('cross-platform-merge');
    expect(headers['X-LeadBridge-Deprecation-Replacement']).toBe('/v1/leads?scope=all');
  });

  it('businessId + scope=all → 400', async () => {
    const { controller } = buildController();
    const { res } = fakeRes();

    await expect(
      controller.getLeads(USER, res, undefined, undefined, 'biz-A', 'all'),
    ).rejects.toThrow(BadRequestException);
  });

  it('neither businessId nor scope → 400 (strict mode)', async () => {
    const { controller, leadsService } = buildController({
      thumbtackLeads: [{ id: 't1', businessId: 'biz-A', createdAt: new Date() }],
      yelpLeads: [{ id: 'y1', businessId: 'yelp-biz', createdAt: new Date() }],
    });
    const { res } = fakeRes();

    await expect(
      controller.getLeads(USER, res, undefined, undefined, undefined, undefined),
    ).rejects.toThrow(BadRequestException);

    // The adapter must not be called when scope parsing fails.
    expect(leadsService.getLeads).not.toHaveBeenCalled();
  });

  it('two accounts on same platform — businessId filter narrows result to one', async () => {
    const { controller, calls } = buildController({
      thumbtackLeads: [{ id: 't1', businessId: 'biz-A', createdAt: new Date() }],
      savedAccount: { businessId: 'biz-A', platform: 'thumbtack' },
    });
    const { res } = fakeRes();

    await controller.getLeads(USER, res, undefined, undefined, 'biz-A', undefined);

    expect(calls[0].options.businessId).toBe('biz-A');
  });
});
