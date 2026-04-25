/**
 * Cross-tenant access tests for ConversationContextController — Phase 0 hotfix.
 *
 * Before Phase 0 these endpoints looked up ThreadContext by conversationId
 * with no ownership filter. Regression check: every `:conversationId` route
 * must call TenancyService.requireConversationAccess before touching the
 * service layer, and must surface a NotFoundException (NOT Forbidden) when
 * the conversation belongs to a different user.
 */

import { NotFoundException } from '@nestjs/common';
import { ConversationContextController } from '../../src/conversation-context/conversation-context.controller';
import { TenancyService } from '../../src/common/tenancy/tenancy.service';

function buildPrisma(ownerUserId: string) {
  // `findFirst` returns a row ONLY when the where clause matches the real
  // owner — this mirrors the Prisma behavior used by requireConversationAccess.
  return {
    conversation: {
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        if (where?.userId === ownerUserId) return Promise.resolve({ id: where.id });
        return Promise.resolve(null);
      }),
    },
  } as any;
}

function buildContextService() {
  return {
    getContext: jest.fn().mockResolvedValue({ summary: 'x' }),
    getThreadState: jest.fn().mockResolvedValue({ stage: 'new' }),
    buildContext: jest.fn().mockResolvedValue({ systemContext: '', recentMessages: [], threadState: {} }),
    updateStage: jest.fn().mockResolvedValue(undefined),
    updateStrategy: jest.fn().mockResolvedValue(undefined),
    suggestStrategy: jest.fn().mockResolvedValue({ suggested: 'hybrid', reason: '', confidence: 0.5, scores: {}, threadState: {} }),
    forceSummaryUpdate: jest.fn().mockResolvedValue(undefined),
    getThreadContextsForUser: jest.fn().mockResolvedValue([]),
  } as any;
}

describe('ConversationContextController — cross-tenant access', () => {
  const OWNER = 'user-a';
  const INTRUDER = 'user-b';
  const CONV_ID = 'conv-owned-by-a';

  let controller: ConversationContextController;
  let contextService: any;

  beforeEach(() => {
    const prisma = buildPrisma(OWNER);
    contextService = buildContextService();
    const tenancy = new TenancyService(prisma);
    controller = new ConversationContextController(contextService, tenancy);
  });

  describe('when the caller owns the conversation', () => {
    const user = { id: OWNER } as any;

    it('getContext returns data', async () => {
      const res = await controller.getContext(user, CONV_ID);
      expect(res).toEqual({ success: true, context: { summary: 'x' } });
      expect(contextService.getContext).toHaveBeenCalledWith(CONV_ID, 10);
    });

    it('getState returns data', async () => {
      const res = await controller.getState(user, CONV_ID);
      expect(res).toEqual({ success: true, state: { stage: 'new' } });
    });

    it('getAiContext returns data', async () => {
      const res = await controller.getAiContext(user, CONV_ID);
      expect(res.success).toBe(true);
      expect(contextService.buildContext).toHaveBeenCalledWith(CONV_ID);
    });

    it('updateStage succeeds', async () => {
      const res = await controller.updateStage(user, CONV_ID, 'booked');
      expect(res).toEqual({ success: true });
      expect(contextService.updateStage).toHaveBeenCalledWith(CONV_ID, 'booked');
    });

    it('updateStrategy succeeds', async () => {
      const res = await controller.updateStrategy(user, CONV_ID, 'price');
      expect(res).toEqual({ success: true });
    });

    it('suggestStrategy returns data', async () => {
      const res = await controller.suggestStrategy(user, CONV_ID);
      expect(res.success).toBe(true);
    });

    it('regenerateSummary succeeds', async () => {
      const res = await controller.regenerateSummary(user, CONV_ID);
      expect(res.success).toBe(true);
      expect(contextService.forceSummaryUpdate).toHaveBeenCalledWith(CONV_ID);
    });
  });

  describe('when a different user tries to access a conversation they do not own', () => {
    const intruder = { id: INTRUDER } as any;

    it.each([
      ['getContext', (c: ConversationContextController) => c.getContext(intruder, CONV_ID)],
      ['getState', (c: ConversationContextController) => c.getState(intruder, CONV_ID)],
      ['getAiContext', (c: ConversationContextController) => c.getAiContext(intruder, CONV_ID)],
      ['updateStage', (c: ConversationContextController) => c.updateStage(intruder, CONV_ID, 'quoting')],
      ['updateStrategy', (c: ConversationContextController) => c.updateStrategy(intruder, CONV_ID, 'price')],
      ['suggestStrategy', (c: ConversationContextController) => c.suggestStrategy(intruder, CONV_ID)],
      ['regenerateSummary', (c: ConversationContextController) => c.regenerateSummary(intruder, CONV_ID)],
    ])('%s throws NotFoundException', async (_label, invoke) => {
      await expect(invoke(controller)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('does NOT leak data by calling the underlying service', async () => {
      await expect(controller.getContext(intruder, CONV_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(contextService.getContext).not.toHaveBeenCalled();
      expect(contextService.buildContext).not.toHaveBeenCalled();
    });

    it('does NOT mutate data on write endpoints', async () => {
      await expect(controller.updateStage(intruder, CONV_ID, 'booked')).rejects.toBeInstanceOf(NotFoundException);
      await expect(controller.updateStrategy(intruder, CONV_ID, 'price')).rejects.toBeInstanceOf(NotFoundException);
      await expect(controller.regenerateSummary(intruder, CONV_ID)).rejects.toBeInstanceOf(NotFoundException);
      expect(contextService.updateStage).not.toHaveBeenCalled();
      expect(contextService.updateStrategy).not.toHaveBeenCalled();
      expect(contextService.forceSummaryUpdate).not.toHaveBeenCalled();
    });
  });
});
