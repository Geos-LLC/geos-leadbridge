/**
 * LeadsController.getAllLeads — account-scope behavior.
 *
 * Pre-fix the platform branch (`if (platform) return getLeads(user.id, platform)`)
 * silently dropped the `businessId` query param. The hotfix routes everything
 * through `getCachedLeads` with the full filter shape so businessId is always
 * honored when present.
 *
 * Strict-mode (post-cleanup): missing both businessId and scope=all → 400.
 */

import { BadRequestException } from '@nestjs/common';
import { LeadsController } from './leads.controller';

const USER = { id: 'user-1' };

function buildController(opts: {
  cachedLeadsByFilter?: (filter: any) => any[];
} = {}) {
  const calls: Array<{ filter: any }> = [];
  const leadsService: any = {
    getCachedLeads: jest.fn(async (_userId: string, filter: any) => {
      calls.push({ filter });
      return opts.cachedLeadsByFilter ? opts.cachedLeadsByFilter(filter) : [];
    }),
    // Not exercised by these tests; included to satisfy the controller's typed
    // dependency in case an unused branch evaluates it.
    getLeads: jest.fn(),
  };

  const controller = new LeadsController(
    leadsService,
    /* leadStatusService */ {} as any,
    /* eventEmitter */ {} as any,
    /* prisma */ {} as any,
    /* crmWebhookService */ {} as any,
  );

  return { controller, leadsService, calls };
}

describe('LeadsController.getAllLeads — account-scope', () => {
  it('platform + businessId → both passed through to getCachedLeads (regression: pre-fix dropped businessId)', async () => {
    const { controller, calls } = buildController({
      cachedLeadsByFilter: () => [{ id: 't1', businessId: 'biz-A', platform: 'thumbtack' }],
    });

    await controller.getAllLeads(USER, 'thumbtack', undefined, undefined, 'biz-A', undefined);

    expect(calls).toHaveLength(1);
    expect(calls[0].filter).toEqual({
      platform: 'thumbtack',
      status: undefined,
      businessId: 'biz-A',
      limit: undefined,
    });
  });

  it('businessId only → narrows by account regardless of platform', async () => {
    const { controller, calls } = buildController();

    await controller.getAllLeads(USER, undefined, undefined, undefined, 'biz-A', undefined);

    expect(calls[0].filter.businessId).toBe('biz-A');
    expect(calls[0].filter.platform).toBeUndefined();
  });

  it('scope=all → no businessId filter', async () => {
    const { controller, calls } = buildController();

    await controller.getAllLeads(USER, undefined, undefined, undefined, undefined, 'all');

    expect(calls[0].filter.businessId).toBeUndefined();
  });

  it('businessId + scope=all → 400', async () => {
    const { controller } = buildController();

    await expect(
      controller.getAllLeads(USER, undefined, undefined, undefined, 'biz-A', 'all'),
    ).rejects.toThrow(BadRequestException);
  });

  it('neither businessId nor scope → 400 (strict mode)', async () => {
    const { controller, calls } = buildController();

    await expect(
      controller.getAllLeads(USER, undefined, undefined, undefined, undefined, undefined),
    ).rejects.toThrow(BadRequestException);

    // The DB layer must not be touched when scope parsing fails.
    expect(calls).toHaveLength(0);
  });

  it('limit param is forwarded as a number', async () => {
    const { controller, calls } = buildController();

    await controller.getAllLeads(USER, undefined, undefined, '50' as any, 'biz-A', undefined);

    expect(calls[0].filter.limit).toBe(50);
  });
});
