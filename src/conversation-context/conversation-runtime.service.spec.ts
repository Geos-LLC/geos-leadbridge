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

  describe('structured log emission (Phase 1.5)', () => {
    function captureLogs(svc: ConversationRuntimeService): string[] {
      const lines: string[] = [];
      jest.spyOn((svc as any).logger, 'log').mockImplementation((msg: any) => {
        lines.push(String(msg));
      });
      return lines;
    }

    it('setConversationState emits event=conversation_state_write with meta', async () => {
      const prisma = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      const logs = captureLogs(svc);
      await svc.setConversationState(
        'conv-1',
        { state: 'opted_out', reason: 'classifier_opt_out' },
        { leadId: 'lead-9', userId: 'user-7', sourceEventId: 'evt_x' },
      );
      const line = logs.find((l) => l.includes('event=conversation_state_write'));
      expect(line).toBeDefined();
      expect(line).toContain('conversation_id=conv-1');
      expect(line).toContain('new_state=opted_out');
      expect(line).toContain('reason=classifier_opt_out');
      expect(line).toContain('lead_id=lead-9');
      expect(line).toContain('user_id=user-7');
      expect(line).toContain('source_event_id=evt_x');
    });

    it('setAiStatus emits event=ai_status_write', async () => {
      const prisma = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      const logs = captureLogs(svc);
      await svc.setAiStatus('conv-2', { status: 'paused_human', reason: 'manual_reply_recency_window' });
      const line = logs.find((l) => l.includes('event=ai_status_write'));
      expect(line).toBeDefined();
      expect(line).toContain('new_status=paused_human');
      expect(line).toContain('reason=manual_reply_recency_window');
    });

    it('setState emits event=state_write with both new_conversation_state and new_ai_status', async () => {
      const prisma = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      const logs = captureLogs(svc);
      await svc.setState(
        'conv-3',
        {
          conversationState: 'deferred',
          conversationStateReason: 'classifier_deferring',
          aiStatus: 'paused_deferral',
          aiStatusReason: 'classifier_deferring',
        },
        { leadId: 'lead-3' },
      );
      const line = logs.find((l) => l.includes('event=state_write'));
      expect(line).toBeDefined();
      expect(line).toContain('new_conversation_state=deferred');
      expect(line).toContain('new_ai_status=paused_deferral');
      expect(line).toContain('lead_id=lead-3');
    });

    it('recordClassifierIntent emits event=classifier_intent_write with confidence', async () => {
      const prisma = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      const logs = captureLogs(svc);
      await svc.recordClassifierIntent('conv-4', { intent: 'wants_live_contact', confidence: 0.91 });
      const line = logs.find((l) => l.includes('event=classifier_intent_write'));
      expect(line).toBeDefined();
      expect(line).toContain('intent=wants_live_contact');
      expect(line).toContain('confidence=0.91');
    });

    it('setHandoffRequested emits event=handoff_write action=requested', async () => {
      const prisma = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      const logs = captureLogs(svc);
      await svc.setHandoffRequested('conv-5', 'agreed', { leadId: 'lead-5' });
      const line = logs.find((l) => l.includes('event=handoff_write'));
      expect(line).toBeDefined();
      expect(line).toContain('action=requested');
      expect(line).toContain('reason=agreed');
    });

    it('resolveHandoff emits event=handoff_write action=resolved when a row flipped', async () => {
      const prisma = buildPrismaMock();
      // Default updateMany mock returns { count: 1 } — simulates a row flip
      const svc = new ConversationRuntimeService(prisma);
      const logs = captureLogs(svc);
      await svc.resolveHandoff('conv-6');
      const line = logs.find((l) => l.includes('event=handoff_write'));
      expect(line).toBeDefined();
      expect(line).toContain('action=resolved');
    });

    it('resolveHandoff is silent when no row flipped (count=0)', async () => {
      const prisma = buildPrismaMock();
      prisma.threadContext.updateMany = jest.fn().mockResolvedValue({ count: 0 });
      const svc = new ConversationRuntimeService(prisma);
      const logs = captureLogs(svc);
      await svc.resolveHandoff('conv-7');
      const line = logs.find((l) => l.includes('event=handoff_write'));
      expect(line).toBeUndefined();
    });

    it('failed writes do NOT emit success log (only warn)', async () => {
      const prisma: any = {
        threadContext: { updateMany: jest.fn().mockRejectedValue(new Error('boom')) },
      };
      const svc = new ConversationRuntimeService(prisma);
      const logs = captureLogs(svc);
      const warns: string[] = [];
      jest.spyOn((svc as any).logger, 'warn').mockImplementation((m: any) => warns.push(String(m)));
      await svc.setAiStatus('conv-8', { status: 'disabled', reason: 'user_ai_conversation_disabled' });
      expect(logs.find((l) => l.includes('event=ai_status_write'))).toBeUndefined();
      expect(warns.find((l) => l.includes('setAiStatus failed'))).toBeDefined();
    });

    it('does not leak PII — log fields are only state values + ids', async () => {
      const prisma = buildPrismaMock();
      const svc = new ConversationRuntimeService(prisma);
      const logs = captureLogs(svc);
      await svc.setConversationState('conv-pii', { state: 'opted_out', reason: 'classifier_opt_out' });
      const line = logs.find((l) => l.includes('event=conversation_state_write'))!;
      // No customer message body, phone, email, or name leaks
      expect(line).not.toMatch(/customer/i);
      expect(line).not.toMatch(/@/); // no email
      expect(line).not.toMatch(/\+\d{10,}/); // no phone
    });
  });
});
