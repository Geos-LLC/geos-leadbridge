import { ConversationRuntimeService } from './conversation-runtime.service';

function buildPrismaMock() {
  const calls: any[] = [];
  return {
    _calls: calls,
    threadContext: {
      updateMany: jest.fn().mockImplementation(async (args: any) => {
        calls.push({ op: 'threadContext.updateMany', ...args });
        return { count: 1 };
      }),
    },
  } as any;
}

describe('ConversationRuntimeService', () => {
  describe('setConversationState', () => {
    it('writes conversationState + conversationStateAt + reason', async () => {
      const prisma = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      await svc.setConversationState('conv-1', { state: 'awaiting_customer', reason: 'ai_replied' });
      expect(prisma.threadContext.updateMany).toHaveBeenCalledTimes(1);
      const call = prisma._calls[0];
      expect(call.where).toEqual({ conversationId: 'conv-1' });
      expect(call.data.conversationState).toBe('awaiting_customer');
      expect(call.data.conversationStateAt).toBeInstanceOf(Date);
      expect(call.data.conversationStateReason).toBe('ai_replied');
    });

    it('no-ops on null/undefined conversationId', async () => {
      const prisma = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      await svc.setConversationState(null, { state: 'awaiting_customer' });
      await svc.setConversationState(undefined, { state: 'awaiting_customer' });
      await svc.setConversationState('', { state: 'awaiting_customer' });
      expect(prisma.threadContext.updateMany).not.toHaveBeenCalled();
    });

    it('no-ops when input has no actionable fields', async () => {
      const prisma = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      await svc.setConversationState('conv-1', {});
      expect(prisma.threadContext.updateMany).not.toHaveBeenCalled();
    });

    it('swallows DB errors (best-effort)', async () => {
      const prisma = {
        threadContext: {
          updateMany: jest.fn().mockRejectedValue(new Error('boom')),
        },
      } as any;
      const svc = new ConversationRuntimeService(prisma);
      await expect(
        svc.setConversationState('conv-1', { state: 'awaiting_customer' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('setAiStatus', () => {
    it('writes aiStatus + aiStatusAt + reason', async () => {
      const prisma = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      await svc.setAiStatus('conv-1', { status: 'paused_human', reason: 'manual_reply_recency_window' });
      expect(prisma._calls[0].data).toEqual(
        expect.objectContaining({
          aiStatus: 'paused_human',
          aiStatusReason: 'manual_reply_recency_window',
        }),
      );
      expect(prisma._calls[0].data.aiStatusAt).toBeInstanceOf(Date);
    });
  });

  describe('setState (combined)', () => {
    it('writes both conversationState and aiStatus in one updateMany', async () => {
      const prisma = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      await svc.setState('conv-1', {
        conversationState: 'opted_out',
        conversationStateReason: 'classifier_opt_out',
        aiStatus: 'stopped_terminal',
        aiStatusReason: 'classifier_opt_out',
      });
      expect(prisma.threadContext.updateMany).toHaveBeenCalledTimes(1);
      const data = prisma._calls[0].data;
      expect(data.conversationState).toBe('opted_out');
      expect(data.aiStatus).toBe('stopped_terminal');
      expect(data.conversationStateAt).toBeInstanceOf(Date);
      expect(data.aiStatusAt).toBeInstanceOf(Date);
    });

    it('no-ops on null conversationId', async () => {
      const prisma = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      await svc.setState(null, { conversationState: 'opted_out' });
      expect(prisma.threadContext.updateMany).not.toHaveBeenCalled();
    });

    it('no-ops when no fields supplied', async () => {
      const prisma = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      await svc.setState('conv-1', {});
      expect(prisma.threadContext.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('recordClassifierIntent', () => {
    it('writes intent + confidence + timestamp', async () => {
      const prisma = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      await svc.recordClassifierIntent('conv-1', { intent: 'wants_live_contact', confidence: 0.92 });
      const data = prisma._calls[0].data;
      expect(data.lastClassifiedIntent).toBe('wants_live_contact');
      expect(data.lastClassifiedConfidence).toBe(0.92);
      expect(data.lastClassifiedAt).toBeInstanceOf(Date);
    });

    it('accepts missing confidence', async () => {
      const prisma = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      await svc.recordClassifierIntent('conv-1', { intent: 'agreed' });
      expect(prisma._calls[0].data.lastClassifiedConfidence).toBeNull();
    });

    it('no-ops on empty intent', async () => {
      const prisma = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      await svc.recordClassifierIntent('conv-1', { intent: '' });
      expect(prisma.threadContext.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('setHandoffRequested', () => {
    it('sets handoffRequestedAt + reason + clears prior resolution', async () => {
      const prisma = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      await svc.setHandoffRequested('conv-1', 'agreed');
      const data = prisma._calls[0].data;
      expect(data.handoffRequestedAt).toBeInstanceOf(Date);
      expect(data.handoffRequestedReason).toBe('agreed');
      expect(data.handoffResolvedAt).toBeNull();
    });
  });

  describe('resolveHandoff', () => {
    it('only updates rows with open handoff (handoffRequestedAt set + handoffResolvedAt null)', async () => {
      const prisma = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      await svc.resolveHandoff('conv-1');
      const where = prisma._calls[0].where;
      expect(where).toEqual({
        conversationId: 'conv-1',
        handoffRequestedAt: { not: null },
        handoffResolvedAt: null,
      });
      expect(prisma._calls[0].data.handoffResolvedAt).toBeInstanceOf(Date);
    });
  });
});
