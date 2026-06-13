/**
 * Cross-tenant access tests for AutomationService — Phase 1A.
 *
 * The automation controller already passes `user.id` to the service, and the
 * service uses `findFirst({ id, userId })` for every CRUD operation. These
 * tests pin that behavior so future refactors can't quietly drop the userId
 * filter and reintroduce a cross-tenant read/write hole.
 */

import { NotFoundException } from '@nestjs/common';
import { AutomationService } from '../../src/automation/automation.service';

function buildPrisma(ownerUserId: string) {
  // findFirst returns a row only when the where clause matches the real owner.
  return {
    automationRule: {
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        if (where?.userId === ownerUserId) {
          return Promise.resolve({
            id: where.id,
            userId: ownerUserId,
            name: 'rule',
            triggerType: 'new_lead',
            replyTriggerMode: null,
            templateId: null,
            promptTemplateId: null,
            delayMinutes: 0,
            enabled: true,
            useAi: false,
            replyMode: 'custom',
            isFollowUp: false,
            activeHoursStart: null,
            activeHoursEnd: null,
            activeHoursTimezone: null,
            stopOnCustomerReply: true,
            triggerCount: 0,
            lastTriggeredAt: null,
            createdAt: new Date(),
            savedAccount: null,
            template: null,
          });
        }
        return Promise.resolve(null);
      }),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    pendingAutomatedMessage: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
  } as any;
}

function makeService(prisma: any): AutomationService {
  // Cast to any — only the methods exercised here need to be functional.
  // The AutomationService constructor takes 15 injected deps; this test
  // only exercises the prisma path so the remaining 14 are stubbed.
  // If the constructor adds a new dep, append another `{} as any` here.
  return new AutomationService(
    prisma,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any,
  );
}

describe('AutomationService — cross-tenant access', () => {
  const OWNER = 'user-a';
  const INTRUDER = 'user-b';
  const RULE_ID = 'rule-owned-by-a';

  describe('owner can act on their own rule', () => {
    const owner = OWNER;

    it('getRule returns the rule', async () => {
      const prisma = buildPrisma(OWNER);
      const svc = makeService(prisma);
      const rule = await svc.getRule(owner, RULE_ID);
      expect(rule.id).toBe(RULE_ID);
    });
  });

  describe('intruder cannot act on a rule they do not own', () => {
    it.each([
      ['getRule', (s: AutomationService) => s.getRule(INTRUDER, RULE_ID)],
      ['updateRule', (s: AutomationService) => s.updateRule(INTRUDER, RULE_ID, { name: 'evil' })],
      ['deleteRule', (s: AutomationService) => s.deleteRule(INTRUDER, RULE_ID)],
      ['getPendingMessages', (s: AutomationService) => s.getPendingMessages(INTRUDER, RULE_ID)],
    ])('%s throws NotFoundException', async (_label, invoke) => {
      const prisma = buildPrisma(OWNER);
      const svc = makeService(prisma);
      await expect(invoke(svc)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('updateRule does NOT mutate when caller is wrong tenant', async () => {
      const prisma = buildPrisma(OWNER);
      const svc = makeService(prisma);
      await expect(svc.updateRule(INTRUDER, RULE_ID, { name: 'evil' })).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.automationRule.update).not.toHaveBeenCalled();
    });

    it('deleteRule does NOT delete when caller is wrong tenant', async () => {
      const prisma = buildPrisma(OWNER);
      const svc = makeService(prisma);
      await expect(svc.deleteRule(INTRUDER, RULE_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.automationRule.delete).not.toHaveBeenCalled();
    });
  });

  describe('cancelPendingMessage rejects cross-tenant cancellation', () => {
    it('throws NotFoundException when the pending message belongs to another tenant', async () => {
      const prisma = buildPrisma(OWNER);
      prisma.pendingAutomatedMessage.findFirst.mockResolvedValue({
        id: 'p1',
        status: 'pending',
        automationRule: { userId: OWNER },
      });
      const svc = makeService(prisma);
      await expect(svc.cancelPendingMessage(INTRUDER, 'p1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.pendingAutomatedMessage.update).not.toHaveBeenCalled();
    });
  });
});
