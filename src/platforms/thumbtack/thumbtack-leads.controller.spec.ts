/**
 * ThumbtackController.getLeads — account-scope behavior.
 *
 * Pre-fix this endpoint returned every Thumbtack + Yelp lead the user owned,
 * across every saved account. The hotfix routes through `parseAccountScope`:
 *
 *   ?businessId=A → only A's leads (resolves to one platform)
 *   ?scope=all    → unified merge (legacy behavior, now opt-in)
 *   neither       → legacy behavior + warning header (transition window)
 *   both          → 400
 *
 * These tests pin the contract using a minimal stub for LeadsService.getLeads
 * and a mock prisma.savedAccount.findFirst for businessId resolution. We don't
 * exercise the full controller constructor because most deps (PlatformService,
 * PlatformFactory, ConfigService) aren't on this path.
 */

import { BadRequestException } from '@nestjs/common';
import { ThumbtackController } from './thumbtack.controller';
import { ACCOUNT_BOUNDARY_WARNING_HEADER } from '../../common/account-scope/account-scope.util';

const USER = { id: 'user-1' };

function makeRes() {
  const headers: Record<string, string> = {};
  return {
    setHeader: (k: string, v: string) => { headers[k] = v; },
    getHeader: (k: string) => headers[k],
    headers,
  } as any;
}

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

describe('ThumbtackController.getLeads — account-scope', () => {
  it('businessId → resolves platform via SavedAccount and calls only that adapter', async () => {
    const { controller, leadsService, prisma, calls } = buildController({
      thumbtackLeads: [{ id: 't1', businessId: 'biz-A', createdAt: new Date('2026-04-29T10:00Z') }],
      savedAccount: { businessId: 'biz-A', platform: 'thumbtack' },
    });
    const res = makeRes();

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
    expect(res.getHeader(ACCOUNT_BOUNDARY_WARNING_HEADER)).toBeUndefined();
  });

  it('businessId for a Yelp account → calls only the Yelp adapter, no Thumbtack call', async () => {
    const { controller, leadsService, calls } = buildController({
      yelpLeads: [{ id: 'y1', businessId: 'yelp-biz', createdAt: new Date() }],
      savedAccount: { businessId: 'yelp-biz', platform: 'yelp' },
    });

    await controller.getLeads(USER, makeRes(), undefined, undefined, 'yelp-biz', undefined);

    expect(leadsService.getLeads).toHaveBeenCalledTimes(1);
    expect(calls[0].platform).toBe('yelp');
    expect(calls[0].options).toEqual(expect.objectContaining({ businessId: 'yelp-biz' }));
  });

  it('businessId not owned by user → 400', async () => {
    const { controller } = buildController({ savedAccount: null });

    await expect(
      controller.getLeads(USER, makeRes(), undefined, undefined, 'unknown-biz', undefined),
    ).rejects.toThrow(BadRequestException);
  });

  it('scope=all → unified merge of Thumbtack + Yelp, no warning', async () => {
    const { controller, leadsService, calls } = buildController({
      thumbtackLeads: [{ id: 't1', businessId: 'biz-A', createdAt: new Date('2026-04-29T11:00Z') }],
      yelpLeads: [{ id: 'y1', businessId: 'yelp-biz', createdAt: new Date('2026-04-29T12:00Z') }],
    });
    const res = makeRes();

    const out = await controller.getLeads(USER, res, undefined, undefined, undefined, 'all');

    expect(leadsService.getLeads).toHaveBeenCalledTimes(2);
    expect(calls.map((c) => c.platform).sort()).toEqual(['thumbtack', 'yelp']);
    // Both calls receive scope: 'all' so the service skips businessId filtering.
    for (const c of calls) {
      expect(c.options).toEqual(expect.objectContaining({ scope: 'all' }));
    }
    expect(out.count).toBe(2);
    expect(res.getHeader(ACCOUNT_BOUNDARY_WARNING_HEADER)).toBeUndefined();
  });

  it('businessId + scope=all → 400', async () => {
    const { controller } = buildController();

    await expect(
      controller.getLeads(USER, makeRes(), undefined, undefined, 'biz-A', 'all'),
    ).rejects.toThrow(BadRequestException);
  });

  it('neither businessId nor scope → unified merge + warning header (transition mode)', async () => {
    const { controller, leadsService } = buildController({
      thumbtackLeads: [{ id: 't1', businessId: 'biz-A', createdAt: new Date() }],
      yelpLeads: [{ id: 'y1', businessId: 'yelp-biz', createdAt: new Date() }],
    });
    const res = makeRes();

    const out = await controller.getLeads(USER, res, undefined, undefined, undefined, undefined);

    expect(leadsService.getLeads).toHaveBeenCalledTimes(2);
    expect(out.count).toBe(2);
    expect(res.getHeader(ACCOUNT_BOUNDARY_WARNING_HEADER)).toBe('missing-business-id');
  });

  it('two accounts on same platform — businessId filter narrows result to one', async () => {
    // The leads stub returns whatever the controller asks for; we assert the
    // controller pushes businessId='biz-A' into the call so the *service*
    // filters. This test pins the contract end of the chain — the matching
    // service-level test in leads.service.spec covers the DB filter.
    const { controller, calls } = buildController({
      thumbtackLeads: [{ id: 't1', businessId: 'biz-A', createdAt: new Date() }],
      savedAccount: { businessId: 'biz-A', platform: 'thumbtack' },
    });

    await controller.getLeads(USER, makeRes(), undefined, undefined, 'biz-A', undefined);

    expect(calls[0].options.businessId).toBe('biz-A');
  });
});
