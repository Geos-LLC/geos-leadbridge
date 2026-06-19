/**
 * Intent classifier — historical bug cases.
 *
 * These tests pin down behavior on the real customer messages that the old
 * phrase-list approach missed. Each case is a regression: a customer who got
 * harassed because the phrase list didn't catch their phrasing.
 *
 * The actual LLM call is mocked. We're testing the prompt-shape, parsing,
 * fallback behavior, and that the historical messages are at least not
 * miscategorized into 'engaged' (which is the bug — defaulting to engaged
 * means the AI keeps pestering them).
 *
 * Live LLM accuracy is validated via the staging-shadow log + the dry-run
 * audit script (scripts/audit-missed-optouts.js) before Phase 2 of rollout.
 */

import { ConfigService } from '@nestjs/config';
import { IntentClassifierService } from './intent-classifier.service';

type MockChatCreate = jest.Mock;

function makeService(mockCreate: MockChatCreate): IntentClassifierService {
  const cfg = { get: () => 'sk-test' } as unknown as ConfigService;
  const svc = new IntentClassifierService(cfg);
  // Inject mocked OpenAI client by overriding the private getter.
  Object.defineProperty(svc, 'client', {
    get: () => ({
      chat: { completions: { create: mockCreate } },
    }),
  });
  return svc;
}

function llmReply(intent: string, confidence: number, reason = 'mocked', suggestedReengageInDays?: number | null): MockChatCreate {
  const payload: any = { intent, confidence, reason };
  if (suggestedReengageInDays !== undefined) payload.suggestedReengageInDays = suggestedReengageInDays;
  return jest.fn().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify(payload) } }],
  });
}

describe('IntentClassifierService', () => {
  describe('parsing + structure', () => {
    it('returns the parsed intent on a valid LLM response', async () => {
      const svc = makeService(llmReply('opt_out', 0.95, 'explicit removal request'));
      const result = await svc.classify({ message: 'please lose my information' });
      expect(result.intent).toBe('opt_out');
      expect(result.confidence).toBe(0.95);
      expect(result.reason).toBe('explicit removal request');
      expect(result.fromLlm).toBe(true);
    });

    it('clamps confidence to [0, 1]', async () => {
      const svc = makeService(llmReply('engaged', 1.5));
      const result = await svc.classify({ message: 'ok' });
      expect(result.confidence).toBe(1);
    });

    it('falls back to engaged + fromLlm=false when LLM throws', async () => {
      const svc = makeService(jest.fn().mockRejectedValue(new Error('boom')));
      const result = await svc.classify({ message: 'something' });
      expect(result.intent).toBe('engaged');
      expect(result.confidence).toBe(0);
      expect(result.fromLlm).toBe(false);
      expect(result.reason).toContain('classifier_failed');
    });

    it('falls back when LLM returns an unrecognized intent string', async () => {
      const svc = makeService(llmReply('nonsense_intent', 0.9));
      const result = await svc.classify({ message: 'ok' });
      expect(result.intent).toBe('engaged');
      expect(result.fromLlm).toBe(false);
    });

    it('falls back when LLM returns malformed JSON', async () => {
      const create = jest.fn().mockResolvedValue({
        choices: [{ message: { content: 'not json at all' } }],
      });
      const svc = makeService(create);
      const result = await svc.classify({ message: 'ok' });
      expect(result.fromLlm).toBe(false);
      expect(result.intent).toBe('engaged');
    });

    it('passes lead status + category + recent history into the user prompt', async () => {
      const create = llmReply('engaged', 0.7);
      const svc = makeService(create);
      await svc.classify({
        message: 'ok',
        leadStatus: 'engaged',
        leadCategory: 'Deep cleaning',
        recentHistory: [
          { role: 'pro', content: 'Hi! When would you like the cleaning?' },
          { role: 'customer', content: 'Tomorrow' },
        ],
      });
      const userMsg = create.mock.calls[0][0].messages[1].content as string;
      expect(userMsg).toContain('Current lead status: engaged');
      expect(userMsg).toContain('Service: Deep cleaning');
      expect(userMsg).toContain('Business: Hi! When would you like the cleaning?');
      expect(userMsg).toContain('Customer: Tomorrow');
      expect(userMsg).toContain('Message to classify');
    });

    it('truncates very long history messages to keep the prompt bounded', async () => {
      const create = llmReply('engaged', 0.7);
      const svc = makeService(create);
      const long = 'x'.repeat(500);
      await svc.classify({
        message: 'ok',
        recentHistory: [{ role: 'customer', content: long }],
      });
      const userMsg = create.mock.calls[0][0].messages[1].content as string;
      expect(userMsg).not.toContain('x'.repeat(500));
      expect(userMsg).toContain('…');
    });

    it('only includes the last 5 history turns', async () => {
      const create = llmReply('engaged', 0.7);
      const svc = makeService(create);
      const history = Array.from({ length: 10 }).map((_, i) => ({
        role: 'customer' as const,
        content: `msg-${i}`,
      }));
      await svc.classify({ message: 'ok', recentHistory: history });
      const userMsg = create.mock.calls[0][0].messages[1].content as string;
      expect(userMsg).not.toContain('msg-0');
      expect(userMsg).not.toContain('msg-4');
      expect(userMsg).toContain('msg-5');
      expect(userMsg).toContain('msg-9');
    });

    it('uses temperature=0 and json_object response format for determinism', async () => {
      const create = llmReply('engaged', 0.7);
      const svc = makeService(create);
      await svc.classify({ message: 'ok' });
      const args = create.mock.calls[0][0];
      expect(args.temperature).toBe(0);
      expect(args.response_format).toEqual({ type: 'json_object' });
      expect(args.model).toBe('gpt-4o-mini');
    });
  });

  /**
   * Historical bug cases. Each test simulates the LLM returning what we EXPECT
   * for that message. Real LLM accuracy is validated via shadow logs + the
   * audit script before Phase 2 rollout — these tests just pin the contract.
   */
  describe('historical bug cases (mocked LLM responses)', () => {
    it('Lynn case — "Please lose my information" → opt_out', async () => {
      const svc = makeService(llmReply('opt_out', 0.95, 'explicit info removal'));
      const result = await svc.classify({
        message: 'I sold my property at 795 Del Oro and moved into a condo. Please lose my information. Thanks',
        leadStatus: 'engaged',
      });
      expect(result.intent).toBe('opt_out');
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it('Donna case — "It\'s already done, thank you" → completed', async () => {
      const svc = makeService(llmReply('completed', 0.9, 'work no longer needed'));
      const result = await svc.classify({
        message: "It's already done, thank you.",
        leadStatus: 'engaged',
      });
      expect(result.intent).toBe('completed');
    });

    // Yvonne case 2026-06-19 — gpt-4o-mini live-classified this message as
    // opt_out @ 0.95 ("Customer explicitly states they no longer need the
    // service."), which routed the lead to lostReason='opt_out' (no re-engage)
    // instead of the intended hired_someone path (reengageAt=now+21d +
    // customer_hired_competitor sequence). The prompt was updated to make
    // "no longer need" explicitly route to completed/hired_elsewhere, not
    // opt_out. This pins the contract for the mocked response we expect.
    it('Yvonne case — "Sorry, I no longer need this service" → completed (NOT opt_out)', async () => {
      const svc = makeService(llmReply('completed', 0.9, 'no longer needs service'));
      const result = await svc.classify({
        message: 'Sorry, I no longer need this service',
        leadStatus: 'new',
      });
      expect(result.intent).toBe('completed');
      expect(result.intent).not.toBe('opt_out');
    });

    it('Lewam case — "It\'s ok we can cancel" → completed (job called off)', async () => {
      const svc = makeService(llmReply('completed', 0.85, 'customer canceling existing booking'));
      const result = await svc.classify({
        message: "It's ok we can cancel",
        leadStatus: 'booked',
      });
      expect(result.intent).toBe('completed');
    });

    it('Carol case — "let me check with my husband" → deferring', async () => {
      const svc = makeService(llmReply('deferring', 0.9, 'pausing for spouse consultation'));
      const result = await svc.classify({
        message: 'Sounds great, let me check with my husband and get back to you',
      });
      expect(result.intent).toBe('deferring');
    });

    it('Amy case — "Thank you. I will get back to you" → deferring', async () => {
      const svc = makeService(llmReply('deferring', 0.9, 'polite pause'));
      const result = await svc.classify({
        message: 'Thank you. I will get back to you',
      });
      expect(result.intent).toBe('deferring');
    });

    it('false-positive guard — "Can I cancel my morning slot to switch to afternoon?" → engaged', async () => {
      const svc = makeService(llmReply('engaged', 0.8, 'rescheduling, not canceling outright'));
      const result = await svc.classify({
        message: 'Can I cancel my morning slot to switch to afternoon?',
      });
      expect(result.intent).toBe('engaged');
    });

    it('agreed — "Sounds good, when can you come?" → agreed', async () => {
      const svc = makeService(llmReply('agreed', 0.9, 'price accepted, ready to schedule'));
      const result = await svc.classify({
        message: 'Sounds good, when can you come?',
      });
      expect(result.intent).toBe('agreed');
    });

    it('opt_out — "stop messaging me" → opt_out', async () => {
      const svc = makeService(llmReply('opt_out', 0.99, 'explicit unsubscribe'));
      const result = await svc.classify({ message: 'stop messaging me' });
      expect(result.intent).toBe('opt_out');
    });

    it('hired_elsewhere — "we already booked someone" → hired_elsewhere', async () => {
      const svc = makeService(llmReply('hired_elsewhere', 0.92, 'competitor hired'));
      const result = await svc.classify({ message: 'we already booked someone' });
      expect(result.intent).toBe('hired_elsewhere');
    });

    it('asking — "How much for a 3 bedroom?" → asking', async () => {
      const svc = makeService(llmReply('asking', 0.95, 'pricing question'));
      const result = await svc.classify({ message: 'How much for a 3 bedroom?' });
      expect(result.intent).toBe('asking');
    });
  });

  /**
   * suggestedReengageInDays — explicit time-bound deferrals/completions.
   * The Devi case ("back in 2 weeks") is the canonical example: classifier
   * extracts the duration so the customer_deferred enrollment can anchor the
   * re-engagement to the customer's stated timing instead of the default
   * cadence.
   */
  describe('suggestedReengageInDays extraction', () => {
    it('Devi case — "back in 2 weeks to reschedule" → deferring + 14 days', async () => {
      const svc = makeService(llmReply('deferring', 0.9, 'time-bound pause', 14));
      const result = await svc.classify({
        message: "Hi I have to reschedule I'm in the military and they are sending me on a detachment. I will be in touch when I'm home in 2 weeks to reschedule",
      });
      expect(result.intent).toBe('deferring');
      expect(result.suggestedReengageInDays).toBe(14);
    });

    it('passes through suggestedReengageInDays for hired_elsewhere intent', async () => {
      const svc = makeService(llmReply('hired_elsewhere', 0.9, 'temporary pick', 30));
      const result = await svc.classify({
        message: 'We went with someone else for now, ask us again in a month',
      });
      expect(result.intent).toBe('hired_elsewhere');
      expect(result.suggestedReengageInDays).toBe(30);
    });

    it('omits suggestedReengageInDays when intent is engaged (model returned a value but it should be ignored)', async () => {
      const svc = makeService(llmReply('engaged', 0.9, 'continuing', 7));
      const result = await svc.classify({ message: 'Yes 3 bedrooms' });
      expect(result.intent).toBe('engaged');
      expect(result.suggestedReengageInDays).toBeUndefined();
    });

    it('omits suggestedReengageInDays when null returned (no explicit timing)', async () => {
      const svc = makeService(llmReply('deferring', 0.9, 'vague pause', null));
      const result = await svc.classify({ message: "I'll get back to you" });
      expect(result.intent).toBe('deferring');
      expect(result.suggestedReengageInDays).toBeUndefined();
    });

    it('clamps suggestedReengageInDays to 180 when model returns absurdly high value', async () => {
      const svc = makeService(llmReply('deferring', 0.9, 'far future', 9999));
      const result = await svc.classify({ message: 'maybe in a few years' });
      expect(result.suggestedReengageInDays).toBe(180);
    });

    it('clamps suggestedReengageInDays to ≥1 when model returns 0 or negative', async () => {
      const svc = makeService(llmReply('deferring', 0.9, 'now-ish', 0));
      const result = await svc.classify({ message: 'tomorrow' });
      // 0 is treated as "unset" since we require > 0
      expect(result.suggestedReengageInDays).toBeUndefined();
    });

    it('rounds fractional days', async () => {
      const svc = makeService(llmReply('deferring', 0.9, 'half a week', 3.7));
      const result = await svc.classify({ message: 'in about half a week' });
      expect(result.suggestedReengageInDays).toBe(4);
    });

    it('omits when intent is opt_out (no re-engagement on explicit unsubscribe)', async () => {
      const svc = makeService(llmReply('opt_out', 0.99, 'explicit', 14));
      const result = await svc.classify({ message: 'stop messaging me, also in 2 weeks' });
      expect(result.intent).toBe('opt_out');
      expect(result.suggestedReengageInDays).toBeUndefined();
    });

    it('omits when intent is agreed (booked, not paused)', async () => {
      const svc = makeService(llmReply('agreed', 0.95, 'booked', 7));
      const result = await svc.classify({ message: 'Sounds good, see you next week' });
      expect(result.intent).toBe('agreed');
      expect(result.suggestedReengageInDays).toBeUndefined();
    });
  });
});
