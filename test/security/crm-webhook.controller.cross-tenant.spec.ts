/**
 * Cross-tenant access tests for CrmWebhookController + Service — Phase 1B.
 *
 * Before this PR:
 *   - DELETE /v1/integrations/webhooks/:id returned `{success: false}` (200)
 *     when the subscription belonged to another tenant.
 *   - POST /v1/integrations/webhooks/:id/test (via service) likewise returned
 *     `{success: false, error: 'Outbound subscription not found'}` (200).
 *
 * The patch makes both throw NotFoundException (404) so cross-tenant access
 * is indistinguishable from "doesn't exist".
 */

import { NotFoundException } from '@nestjs/common';
import { CrmWebhookController } from '../../src/crm-webhooks/crm-webhook.controller';
import { CrmWebhookService } from '../../src/crm-webhooks/crm-webhook.service';

function buildPrisma(ownerUserId: string) {
  return {
    crmWebhookSubscription: {
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        if (where?.userId === ownerUserId) return Promise.resolve({ id: where.id, name: 'sub', secret: 's', webhookUrl: 'https://x' });
        return Promise.resolve(null);
      }),
      delete: jest.fn().mockResolvedValue({}),
    },
  } as any;
}

describe('CrmWebhookController — cross-tenant access', () => {
  const OWNER = 'user-a';
  const INTRUDER = 'user-b';
  const SUB_ID = 'sub-owned-by-a';

  describe('DELETE /:id remove', () => {
    it('returns success for the owner', async () => {
      const prisma = buildPrisma(OWNER);
      const controller = new CrmWebhookController(prisma, {} as any);
      const res = await controller.remove({ id: OWNER }, SUB_ID);
      expect(res).toEqual({ success: true });
      expect(prisma.crmWebhookSubscription.delete).toHaveBeenCalledWith({ where: { id: SUB_ID } });
    });

    it('throws NotFoundException for an intruder', async () => {
      const prisma = buildPrisma(OWNER);
      const controller = new CrmWebhookController(prisma, {} as any);
      await expect(controller.remove({ id: INTRUDER }, SUB_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('does NOT delete when caller is wrong tenant', async () => {
      const prisma = buildPrisma(OWNER);
      const controller = new CrmWebhookController(prisma, {} as any);
      await expect(controller.remove({ id: INTRUDER }, SUB_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.crmWebhookSubscription.delete).not.toHaveBeenCalled();
    });
  });
});

describe('CrmWebhookService.sendTestEvent — cross-tenant access', () => {
  const OWNER = 'user-a';
  const INTRUDER = 'user-b';
  const SUB_ID = 'sub-owned-by-a';

  function makeService(prismaOwnerId: string) {
    const prisma = buildPrisma(prismaOwnerId);
    const svc = new CrmWebhookService(prisma);
    return { svc, prisma };
  }

  it('throws NotFoundException for an intruder', async () => {
    const { svc } = makeService(OWNER);
    await expect(svc.sendTestEvent(SUB_ID, INTRUDER)).rejects.toBeInstanceOf(NotFoundException);
  });
});
