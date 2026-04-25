/**
 * Cross-tenant access tests for ServiceFlowInboundController — Phase 1B.
 *
 * Before this PR, `replay/:id` did `findUnique({where: {id}})` then checked
 * `event.userId !== user.id` and returned `{success: false}` (200). That
 * leaks "this event exists in our system" via timing/shape difference vs
 * a truly missing id. The patch uses `findFirst({id, userId})` and throws
 * NotFoundException (404) so both cases collapse to one response.
 */

import { NotFoundException } from '@nestjs/common';
import { ServiceFlowInboundController } from '../../src/integrations/service-flow/service-flow-inbound.controller';

function buildPrisma(ownerUserId: string) {
  return {
    sfInboundEvent: {
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        if (where?.userId === ownerUserId) {
          return Promise.resolve({
            id: where.id,
            userId: ownerUserId,
            status: 'deferred',
            sfSubscriptionId: 'sub-1',
            payloadJson: {},
          });
        }
        return Promise.resolve(null);
      }),
    },
    crmWebhookSubscription: {
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        if (where?.userId === ownerUserId) return Promise.resolve({ id: where.id, secret: 's' });
        return Promise.resolve(null);
      }),
    },
  } as any;
}

describe('ServiceFlowInboundController.replay — cross-tenant access', () => {
  const OWNER = 'user-a';
  const INTRUDER = 'user-b';
  const EVENT_ID = 'evt-owned-by-a';

  it('throws NotFoundException for an intruder', async () => {
    const prisma = buildPrisma(OWNER);
    const sfInbound = { process: jest.fn().mockResolvedValue({ httpStatus: 200 }) } as any;
    const controller = new ServiceFlowInboundController(prisma, sfInbound);
    await expect(controller.replay({ id: INTRUDER }, EVENT_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does NOT process when caller is wrong tenant', async () => {
    const prisma = buildPrisma(OWNER);
    const process = jest.fn().mockResolvedValue({ httpStatus: 200 });
    const sfInbound = { process } as any;
    const controller = new ServiceFlowInboundController(prisma, sfInbound);
    await expect(controller.replay({ id: INTRUDER }, EVENT_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(process).not.toHaveBeenCalled();
  });

  it('owner can replay their own deferred event', async () => {
    const prisma = buildPrisma(OWNER);
    const process = jest.fn().mockResolvedValue({ httpStatus: 200, result: 'applied' });
    const sfInbound = { process } as any;
    const controller = new ServiceFlowInboundController(prisma, sfInbound);
    const res = await controller.replay({ id: OWNER }, EVENT_ID);
    expect(res.success).toBe(true);
    expect(process).toHaveBeenCalled();
  });
});

describe('ServiceFlowInboundController.listEvents — cross-tenant filtering', () => {
  const OWNER = 'user-a';

  it('always passes userId in the query', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { sfInboundEvent: { findMany } } as any;
    const controller = new ServiceFlowInboundController(prisma, {} as any);
    await controller.listEvents({ id: OWNER });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: OWNER }) }),
    );
  });
});
