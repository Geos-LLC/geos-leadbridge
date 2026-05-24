/**
 * YelpController.getLeads — platform-scoped (Yelp only) + no 100-cap.
 *
 * Pre-fix this endpoint:
 *   - hard-coded `take: 100` (Spotless Yelp ~323 leads showed as 100)
 *   - returned raw Prisma rows instead of the NormalizedLead shape that
 *     `/v1/thumbtack/leads` and `/v1/leads` return
 *
 * Post-fix it routes through `LeadsService.getLeads(userId, 'yelp', ...)`
 * and enriches with `businessName` so SF can dedupe by businessId and render
 * a human-readable source. No cap unless `?limit=N` is passed.
 */

import { BadRequestException } from '@nestjs/common';
import { YelpController } from './yelp.controller';

const USER = { id: 'user-1' };

function buildController(opts: {
  leadsByOptions?: (platform: string, options: any) => any[];
  savedAccount?: { id: string } | null;
  enrichedNames?: Record<string, string>; // businessId → businessName
} = {}) {
  const getLeadsCalls: Array<{ userId: string; platform: string; options: any }> = [];

  const leadsService: any = {
    getLeads: jest.fn(async (userId: string, platform: string, options: any) => {
      getLeadsCalls.push({ userId, platform, options });
      return opts.leadsByOptions ? opts.leadsByOptions(platform, options) : [];
    }),
    enrichLeadsWithAccountInfo: jest.fn(async (_userId: string, leads: any[]) => {
      if (!opts.enrichedNames) return leads;
      return leads.map((l) => ({
        ...l,
        businessName: l.businessId ? opts.enrichedNames![l.businessId] : undefined,
      }));
    }),
  };

  const prisma: any = {
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
    leadsService,
  );

  return { controller, leadsService, prisma, getLeadsCalls };
}

describe('YelpController.getLeads — platform-scoped, no 100-cap', () => {
  it('scope=all → calls LeadsService.getLeads with scope:all and NO limit (regression: was capped at 100)', async () => {
    const fullDataset = Array.from({ length: 323 }, (_, i) => ({
      id: `y${i}`,
      platform: 'yelp',
      businessId: i < 192 ? 'yelp-tampa' : 'yelp-jax',
      customerName: `Customer ${i}`,
      customerPhone: '+15555550000',
      customerEmail: `c${i}@x.com`,
      status: 'new',
      createdAt: new Date(`2026-05-${(i % 28) + 1}`),
      updatedAt: new Date(`2026-05-${(i % 28) + 1}`),
      lastMessageAt: new Date(`2026-05-${(i % 28) + 1}`),
    }));
    const { controller, getLeadsCalls } = buildController({
      leadsByOptions: () => fullDataset,
    });

    const out = await controller.getLeads(USER, undefined, 'all', undefined);

    expect(getLeadsCalls).toHaveLength(1);
    expect(getLeadsCalls[0].platform).toBe('yelp');
    expect(getLeadsCalls[0].options).toEqual({ scope: 'all' });
    expect(getLeadsCalls[0].options.limit).toBeUndefined();
    expect(out.count).toBe(323);
    expect(out.leads).toHaveLength(323);
  });

  it('scope=all returns the NormalizedLead-shape fields SF needs for sync', async () => {
    const { controller } = buildController({
      leadsByOptions: () => [
        {
          id: 'y1',
          externalRequestId: 'yelp-lead-abc',
          platform: 'yelp',
          businessId: 'yelp-tampa',
          customerName: 'Jane Doe',
          customerPhone: '+18135551212',
          customerEmail: 'jane@example.com',
          status: 'contacted',
          createdAt: new Date('2026-05-15T12:00:00Z'),
          updatedAt: new Date('2026-05-16T09:00:00Z'),
          lastMessageAt: new Date('2026-05-16T09:00:00Z'),
        },
      ],
      enrichedNames: { 'yelp-tampa': 'Spotless Tampa (Yelp)' },
    });

    const out = await controller.getLeads(USER, undefined, 'all', undefined);

    expect(out.leads[0]).toEqual(
      expect.objectContaining({
        id: 'y1',
        externalRequestId: 'yelp-lead-abc',
        platform: 'yelp',
        businessId: 'yelp-tampa',
        businessName: 'Spotless Tampa (Yelp)',
        customerName: 'Jane Doe',
        customerPhone: '+18135551212',
        customerEmail: 'jane@example.com',
        status: 'contacted',
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
        lastMessageAt: expect.any(Date),
      }),
    );
  });

  it('businessId → narrows scope to that account and verifies it belongs to user', async () => {
    const { controller, prisma, getLeadsCalls } = buildController({
      savedAccount: { id: 'acct-1' },
      leadsByOptions: (_p, opts) => [{ id: 'y1', platform: 'yelp', businessId: opts.businessId, createdAt: new Date() }],
    });

    await controller.getLeads(USER, 'yelp-tampa', undefined, undefined);

    expect(prisma.savedAccount.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', platform: 'yelp', businessId: 'yelp-tampa' },
      select: { id: true },
    });
    expect(getLeadsCalls[0].options).toEqual({ businessId: 'yelp-tampa' });
  });

  it('businessId not owned by user → 400, no leads query', async () => {
    const { controller, leadsService } = buildController({ savedAccount: null });

    await expect(controller.getLeads(USER, 'unknown-biz', undefined, undefined)).rejects.toThrow(
      BadRequestException,
    );

    expect(leadsService.getLeads).not.toHaveBeenCalled();
  });

  it('businessId + scope=all → 400', async () => {
    const { controller } = buildController();

    await expect(controller.getLeads(USER, 'yelp-tampa', 'all', undefined)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('neither businessId nor scope → 400 (strict mode)', async () => {
    const { controller, leadsService } = buildController();

    await expect(controller.getLeads(USER, undefined, undefined, undefined)).rejects.toThrow(
      BadRequestException,
    );

    expect(leadsService.getLeads).not.toHaveBeenCalled();
  });

  it('?limit=N is forwarded to LeadsService.getLeads', async () => {
    const { controller, getLeadsCalls } = buildController({
      leadsByOptions: () => [],
    });

    await controller.getLeads(USER, undefined, 'all', '50');

    expect(getLeadsCalls[0].options.limit).toBe(50);
  });
});
