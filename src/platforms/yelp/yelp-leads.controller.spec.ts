/**
 * YelpController.getLeads — account-scope behavior.
 *
 * Pre-fix this returned every Yelp lead under the user across all Yelp
 * businesses. The hotfix routes through `parseAccountScope`. These tests
 * pin the contract using a minimal Prisma stub — we don't construct the
 * full controller's other deps because they're not on this path.
 *
 * Strict-mode (post-cleanup): missing both businessId and scope=all → 400.
 */

import { BadRequestException } from '@nestjs/common';
import { YelpController } from './yelp.controller';

const USER = { id: 'user-1' };

function buildController(opts: {
  leadsByWhere?: (where: any) => any[];
  savedAccount?: { id: string } | null;
} = {}) {
  const findManyCalls: Array<{ where: any }> = [];
  const prisma: any = {
    lead: {
      findMany: jest.fn(async ({ where }: any) => {
        findManyCalls.push({ where });
        return opts.leadsByWhere ? opts.leadsByWhere(where) : [];
      }),
    },
    savedAccount: {
      findFirst: jest.fn(async () => opts.savedAccount ?? null),
    },
  };
  const configService: any = {
    get: jest.fn((key: string) => (key === 'encryption.key' ? 'test-key' : 'http://localhost:5173')),
  };

  const controller = new YelpController(
    /* yelpAdapter */ {} as any,
    /* platformService */ {} as any,
    prisma,
    configService,
    /* trialService */ {} as any,
  );

  return { controller, prisma, findManyCalls };
}

describe('YelpController.getLeads — account-scope', () => {
  it('businessId → narrows where clause to (userId, platform, businessId)', async () => {
    const { controller, findManyCalls } = buildController({
      savedAccount: { id: 'acct-1' },
      leadsByWhere: () => [{ id: 'y1', businessId: 'yelp-A' }],
    });

    await controller.getLeads(USER, 'yelp-A', undefined);

    expect(findManyCalls).toHaveLength(1);
    expect(findManyCalls[0].where).toEqual({
      userId: 'user-1',
      platform: 'yelp',
      businessId: 'yelp-A',
    });
  });

  it('businessId not owned by user → 400, no DB query', async () => {
    const { controller, prisma } = buildController({ savedAccount: null });

    await expect(controller.getLeads(USER, 'unknown-biz', undefined)).rejects.toThrow(
      BadRequestException,
    );

    expect(prisma.lead.findMany).not.toHaveBeenCalled();
  });

  it('scope=all → returns all Yelp leads, no businessId filter', async () => {
    const { controller, findManyCalls } = buildController({
      leadsByWhere: () => [
        { id: 'y1', businessId: 'yelp-A' },
        { id: 'y2', businessId: 'yelp-B' },
      ],
    });

    const out = await controller.getLeads(USER, undefined, 'all');

    expect(findManyCalls[0].where).toEqual({ userId: 'user-1', platform: 'yelp' });
    expect(out.count).toBe(2);
  });

  it('businessId + scope=all → 400', async () => {
    const { controller } = buildController();

    await expect(controller.getLeads(USER, 'yelp-A', 'all')).rejects.toThrow(BadRequestException);
  });

  it('neither businessId nor scope → 400 (strict mode)', async () => {
    const { controller, prisma } = buildController({
      leadsByWhere: () => [{ id: 'y1', businessId: 'yelp-A' }],
    });

    await expect(controller.getLeads(USER, undefined, undefined)).rejects.toThrow(
      BadRequestException,
    );

    expect(prisma.lead.findMany).not.toHaveBeenCalled();
  });
});
