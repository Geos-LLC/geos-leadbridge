/**
 * Cross-tenant access tests for TemplatesService — Phase 1A.
 *
 * Templates already filter by userId at the service layer. These tests pin
 * that behavior so a future refactor can't drop the userId filter and let
 * tenant A read/update/delete tenant B's templates.
 */

import { NotFoundException } from '@nestjs/common';
import { TemplatesService } from '../../src/templates/templates.service';

function buildPrisma(ownerUserId: string) {
  return {
    messageTemplate: {
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        if (where?.userId === ownerUserId) {
          return Promise.resolve({
            id: where.id,
            userId: ownerUserId,
            name: 't',
            content: 'c',
            type: 'message',
            isDefault: false,
            usageCount: 0,
            lastUsedAt: null,
            createdAt: new Date(),
          });
        }
        return Promise.resolve(null);
      }),
      update: jest.fn().mockResolvedValue({
        id: 't1', userId: ownerUserId, name: 't', content: 'c', type: 'message',
        isDefault: false, usageCount: 0, lastUsedAt: null, createdAt: new Date(),
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      delete: jest.fn().mockResolvedValue({}),
    },
  } as any;
}

describe('TemplatesService — cross-tenant access', () => {
  const OWNER = 'user-a';
  const INTRUDER = 'user-b';
  const TEMPLATE_ID = 'tpl-owned-by-a';

  it('getTemplate returns data for the owner', async () => {
    const prisma = buildPrisma(OWNER);
    const svc = new TemplatesService(prisma);
    const tpl = await svc.getTemplate(OWNER, TEMPLATE_ID);
    expect(tpl.id).toBe(TEMPLATE_ID);
  });

  it.each([
    ['getTemplate', (s: TemplatesService) => s.getTemplate(INTRUDER, TEMPLATE_ID)],
    ['updateTemplate', (s: TemplatesService) => s.updateTemplate(INTRUDER, TEMPLATE_ID, { name: 'evil' })],
    ['deleteTemplate', (s: TemplatesService) => s.deleteTemplate(INTRUDER, TEMPLATE_ID)],
  ])('%s throws NotFoundException for an intruder', async (_label, invoke) => {
    const prisma = buildPrisma(OWNER);
    const svc = new TemplatesService(prisma);
    await expect(invoke(svc)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updateTemplate does NOT mutate when caller is wrong tenant', async () => {
    const prisma = buildPrisma(OWNER);
    const svc = new TemplatesService(prisma);
    await expect(svc.updateTemplate(INTRUDER, TEMPLATE_ID, { name: 'evil' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.messageTemplate.update).not.toHaveBeenCalled();
  });

  it('deleteTemplate does NOT delete when caller is wrong tenant', async () => {
    const prisma = buildPrisma(OWNER);
    const svc = new TemplatesService(prisma);
    await expect(svc.deleteTemplate(INTRUDER, TEMPLATE_ID)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.messageTemplate.delete).not.toHaveBeenCalled();
  });
});
