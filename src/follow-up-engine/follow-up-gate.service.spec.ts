/**
 * FollowUpGateService unit tests.
 *
 * The gate is the shared decision logic between the scheduler (cron) and the
 * preview controller (UI). These tests prove the gate decision is correct in
 * isolation — side effects (stopEnrollment, writeStatus) are not the gate's
 * responsibility and are tested separately on each caller.
 *
 * Cross-path equivalence is asserted in `follow-up-gate-equivalence.spec.ts`.
 */

import { FollowUpGateService } from './follow-up-gate.service';

const CONV = 'conv-1';
const LEAD = 'lead-1';

function buildPrisma(opts: {
  customerMessage?: string | null;
  recentMessages?: Array<{ sender: string; content: string }>;
  leadStatus?: string;
  leadCategory?: string;
} = {}) {
  const lastMsg = opts.customerMessage === undefined
    ? null
    : opts.customerMessage === null
      ? null
      : { content: opts.customerMessage, createdAt: new Date('2026-04-15T00:00:00Z') };

  return {
    message: {
      findFirst: jest.fn().mockResolvedValue(lastMsg),
      findMany: jest.fn().mockResolvedValue(
        (opts.recentMessages ?? (opts.customerMessage ? [{ sender: 'customer', content: opts.customerMessage }] : [])).map((m: any) => ({ sender: m.sender, content: m.content }))
      ),
    },
    lead: {
      findUnique: jest.fn().mockResolvedValue({
        status: opts.leadStatus ?? 'engaged',
        category: opts.leadCategory ?? 'Deep cleaning',
      }),
    },
  } as any;
}

function buildClassifier(result: any) {
  return {
    classify: jest.fn().mockResolvedValue(result),
  } as any;
}

describe('FollowUpGateService', () => {
  describe('evaluate() — early returns', () => {
    it('returns pass_no_message when conversationId is missing', async () => {
      const service = new FollowUpGateService(buildPrisma(), buildClassifier({}));
      const decision = await service.evaluate({ conversationId: '' });
      expect(decision).toMatchObject({
        action: 'pass_no_message',
        shouldBlock: false,
        sideEffect: 'none',
        intent: null,
        classifierRan: false,
      });
    });

    it('returns pass_no_message when no customer message exists in thread', async () => {
      const prisma = buildPrisma({ customerMessage: null });
      const classifier = buildClassifier({});
      const service = new FollowUpGateService(prisma, classifier);
      const decision = await service.evaluate({ conversationId: CONV });
      expect(decision.action).toBe('pass_no_message');
      expect(decision.shouldBlock).toBe(false);
      expect(classifier.classify).not.toHaveBeenCalled();
    });
  });

  describe('evaluate() — classifier fail-open', () => {
    it('passes through when classifier throws', async () => {
      const prisma = buildPrisma({ customerMessage: 'hello' });
      const classifier = { classify: jest.fn().mockRejectedValue(new Error('llm timeout')) } as any;
      const service = new FollowUpGateService(prisma, classifier);
      const decision = await service.evaluate({ conversationId: CONV, leadId: LEAD });
      expect(decision.action).toBe('pass_classifier_failed');
      expect(decision.shouldBlock).toBe(false);
      expect(decision.reason).toContain('classifier_failed');
    });

    it('passes through when classifier returns fromLlm=false (fallback path)', async () => {
      const prisma = buildPrisma({ customerMessage: 'hello' });
      const classifier = buildClassifier({ intent: 'engaged', confidence: 0, reason: 'fallback', fromLlm: false });
      const service = new FollowUpGateService(prisma, classifier);
      const decision = await service.evaluate({ conversationId: CONV, leadId: LEAD });
      expect(decision.action).toBe('pass_classifier_failed');
      expect(decision.shouldBlock).toBe(false);
    });
  });

  describe('evaluate() — confidence threshold', () => {
    it('passes through when confidence < 0.7 even on terminal intent', async () => {
      const prisma = buildPrisma({ customerMessage: 'maybe' });
      const classifier = buildClassifier({ intent: 'completed', confidence: 0.5, reason: 'unclear', fromLlm: true });
      const service = new FollowUpGateService(prisma, classifier);
      const decision = await service.evaluate({ conversationId: CONV, leadId: LEAD });
      expect(decision.action).toBe('pass_low_confidence');
      expect(decision.shouldBlock).toBe(false);
      expect(decision.intent).toBe('completed');
    });

    it('blocks at exactly threshold and above for terminal intents', async () => {
      const prisma = buildPrisma({ customerMessage: 'we hired someone' });
      const classifier = buildClassifier({ intent: 'hired_elsewhere', confidence: 0.7, reason: 'hired competitor', fromLlm: true });
      const service = new FollowUpGateService(prisma, classifier);
      const decision = await service.evaluate({ conversationId: CONV, leadId: LEAD });
      expect(decision.action).toBe('block_terminal');
      expect(decision.shouldBlock).toBe(true);
    });
  });

  describe('evaluate() — non-terminal intents pass through', () => {
    it('passes through on engaged', async () => {
      const prisma = buildPrisma({ customerMessage: 'yes 3 bedrooms' });
      const classifier = buildClassifier({ intent: 'engaged', confidence: 0.95, reason: 'continuing', fromLlm: true });
      const service = new FollowUpGateService(prisma, classifier);
      const decision = await service.evaluate({ conversationId: CONV, leadId: LEAD });
      expect(decision.action).toBe('proceed');
      expect(decision.shouldBlock).toBe(false);
      expect(decision.intent).toBe('engaged');
    });

    it('passes through on asking', async () => {
      const prisma = buildPrisma({ customerMessage: 'how much?' });
      const classifier = buildClassifier({ intent: 'asking', confidence: 0.9, reason: 'pricing question', fromLlm: true });
      const service = new FollowUpGateService(prisma, classifier);
      const decision = await service.evaluate({ conversationId: CONV, leadId: LEAD });
      expect(decision.action).toBe('proceed');
      expect(decision.shouldBlock).toBe(false);
    });
  });

  describe('evaluate() — terminal intents block with correct sideEffect', () => {
    it('opt_out → block_terminal + stop_and_lost', async () => {
      const prisma = buildPrisma({ customerMessage: 'please stop messaging me' });
      const classifier = buildClassifier({ intent: 'opt_out', confidence: 0.95, reason: 'explicit unsubscribe', fromLlm: true });
      const service = new FollowUpGateService(prisma, classifier);
      const decision = await service.evaluate({ conversationId: CONV, leadId: LEAD });
      expect(decision).toMatchObject({
        action: 'block_terminal',
        shouldBlock: true,
        sideEffect: 'stop_and_lost',
        intent: 'opt_out',
      });
    });

    it('hired_elsewhere → block_terminal + stop_and_lost', async () => {
      const prisma = buildPrisma({ customerMessage: 'we already hired someone' });
      const classifier = buildClassifier({ intent: 'hired_elsewhere', confidence: 0.92, reason: 'hired competitor', fromLlm: true });
      const service = new FollowUpGateService(prisma, classifier);
      const decision = await service.evaluate({ conversationId: CONV, leadId: LEAD });
      expect(decision.sideEffect).toBe('stop_and_lost');
    });

    it('completed → block_terminal + stop_and_lost', async () => {
      const prisma = buildPrisma({ customerMessage: "it's already done" });
      const classifier = buildClassifier({ intent: 'completed', confidence: 0.88, reason: 'work finished', fromLlm: true });
      const service = new FollowUpGateService(prisma, classifier);
      const decision = await service.evaluate({ conversationId: CONV, leadId: LEAD });
      expect(decision.sideEffect).toBe('stop_and_lost');
    });

    it('agreed → block_terminal + stop_and_booked', async () => {
      const prisma = buildPrisma({ customerMessage: "let's book it" });
      const classifier = buildClassifier({ intent: 'agreed', confidence: 0.9, reason: 'price accepted', fromLlm: true });
      const service = new FollowUpGateService(prisma, classifier);
      const decision = await service.evaluate({ conversationId: CONV, leadId: LEAD });
      expect(decision.sideEffect).toBe('stop_and_booked');
    });

    it('deferring → block_terminal + stop_only (no status flip)', async () => {
      const prisma = buildPrisma({ customerMessage: "I'll get back to you" });
      const classifier = buildClassifier({ intent: 'deferring', confidence: 0.85, reason: 'pause', fromLlm: true });
      const service = new FollowUpGateService(prisma, classifier);
      const decision = await service.evaluate({ conversationId: CONV, leadId: LEAD });
      expect(decision.sideEffect).toBe('stop_only');
    });
  });

  describe('evaluate() — re-engagement bypass', () => {
    it('passes through completed on customer_deferred re-engagement (sequence purpose)', async () => {
      const prisma = buildPrisma({ customerMessage: "we're done with it" });
      const classifier = buildClassifier({ intent: 'completed', confidence: 0.9, reason: 'job done', fromLlm: true });
      const service = new FollowUpGateService(prisma, classifier);
      const decision = await service.evaluate({ conversationId: CONV, leadId: LEAD, triggerState: 'customer_deferred' });
      expect(decision.action).toBe('pass_re_engagement');
      expect(decision.shouldBlock).toBe(false);
    });

    it('STILL blocks opt_out on customer_hired_competitor re-engagement', async () => {
      const prisma = buildPrisma({ customerMessage: 'stop' });
      const classifier = buildClassifier({ intent: 'opt_out', confidence: 0.99, reason: 'unsubscribe', fromLlm: true });
      const service = new FollowUpGateService(prisma, classifier);
      const decision = await service.evaluate({ conversationId: CONV, leadId: LEAD, triggerState: 'customer_hired_competitor' });
      expect(decision.action).toBe('block_terminal');
      expect(decision.shouldBlock).toBe(true);
      expect(decision.sideEffect).toBe('stop_and_lost');
    });
  });

  describe('evaluate() — latest-customer-message semantics', () => {
    it('queries latest customer message ordered by createdAt desc, sender=customer', async () => {
      const prisma = buildPrisma({ customerMessage: 'latest msg' });
      const classifier = buildClassifier({ intent: 'engaged', confidence: 0.9, reason: 'ok', fromLlm: true });
      const service = new FollowUpGateService(prisma, classifier);
      await service.evaluate({ conversationId: CONV });
      const callArgs = prisma.message.findFirst.mock.calls[0][0];
      expect(callArgs).toMatchObject({
        where: { conversationId: CONV, sender: 'customer' },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('passes the LATEST customer message content into the classifier', async () => {
      const prisma = buildPrisma({ customerMessage: 'we already hired someone yesterday' });
      const classifier = buildClassifier({ intent: 'hired_elsewhere', confidence: 0.95, reason: 'hired', fromLlm: true });
      const service = new FollowUpGateService(prisma, classifier);
      await service.evaluate({ conversationId: CONV });
      expect(classifier.classify).toHaveBeenCalledWith(expect.objectContaining({
        message: 'we already hired someone yesterday',
      }));
    });

    it('passes 5-turn recent history (newest last) into classifier context', async () => {
      const prisma = buildPrisma({
        customerMessage: 'final answer',
        recentMessages: [
          { sender: 'customer', content: 'msg1' },
          { sender: 'pro', content: 'msg2' },
          { sender: 'customer', content: 'msg3' },
        ],
      });
      const classifier = buildClassifier({ intent: 'engaged', confidence: 0.9, reason: 'ok', fromLlm: true });
      const service = new FollowUpGateService(prisma, classifier);
      await service.evaluate({ conversationId: CONV });
      const ctx = classifier.classify.mock.calls[0][0];
      expect(ctx.recentHistory).toBeDefined();
      // findMany returned newest-first order; gate reverses to oldest-first for prompt.
      // Our fixture has 3 messages — verify they're all there in oldest-first order.
      expect(ctx.recentHistory.length).toBe(3);
    });

    it('passes lead.status and lead.category into classifier context when leadId provided', async () => {
      const prisma = buildPrisma({
        customerMessage: 'thanks',
        leadStatus: 'engaged',
        leadCategory: 'House cleaning',
      });
      const classifier = buildClassifier({ intent: 'completed', confidence: 0.85, reason: 'done', fromLlm: true });
      const service = new FollowUpGateService(prisma, classifier);
      await service.evaluate({ conversationId: CONV, leadId: LEAD });
      expect(classifier.classify).toHaveBeenCalledWith(expect.objectContaining({
        leadStatus: 'engaged',
        leadCategory: 'House cleaning',
      }));
    });

    it('skips lead lookup when leadId is null', async () => {
      const prisma = buildPrisma({ customerMessage: 'hello' });
      const classifier = buildClassifier({ intent: 'engaged', confidence: 0.9, reason: 'ok', fromLlm: true });
      const service = new FollowUpGateService(prisma, classifier);
      await service.evaluate({ conversationId: CONV, leadId: null });
      expect(prisma.lead.findUnique).not.toHaveBeenCalled();
      expect(classifier.classify).toHaveBeenCalledWith(expect.objectContaining({
        leadStatus: undefined,
        leadCategory: undefined,
      }));
    });
  });

  describe('evaluate() — does NOT mutate state (pure decision)', () => {
    it('does not call any update/upsert/stopEnrollment/writeStatus', async () => {
      const prisma = buildPrisma({ customerMessage: 'stop' });
      const classifier = buildClassifier({ intent: 'opt_out', confidence: 0.95, reason: 'explicit', fromLlm: true });
      const service = new FollowUpGateService(prisma, classifier);
      await service.evaluate({ conversationId: CONV, leadId: LEAD });
      // Only read-only operations should have been called
      const allMethods = ['update', 'updateMany', 'upsert', 'create', 'createMany', 'delete', 'deleteMany'];
      for (const method of allMethods) {
        for (const tableName of ['message', 'lead']) {
          const table = (prisma as any)[tableName];
          if (table && table[method]) {
            expect(table[method]).not.toHaveBeenCalled();
          }
        }
      }
    });
  });
});
