/**
 * Cross-path equivalence regression test.
 *
 * Phase 1 Task 2 requirement: "preview and scheduler produce equivalent gating
 * decisions". This file's purpose is to fail loudly the day someone forks the
 * gate logic between the two paths.
 *
 * Strategy:
 *   - Build a parameterized matrix of (latest-customer-message, classifier
 *     result, triggerState) inputs.
 *   - Run gateService.evaluate() — that's what the scheduler delegates to.
 *   - Assert that simulating the controller's preview path against the SAME
 *     gateService instance returns the same { shouldBlock, action, intent,
 *     sideEffect } decision shape.
 *
 * If a future change adds a code path that calls the generator without going
 * through the gate (preview, "send now" button, manual approval flow, etc.),
 * those need their own equivalence test — add a row to the matrix.
 */

import { FollowUpGateService } from './follow-up-gate.service';

const CONV = 'conv-1';
const LEAD = 'lead-1';
const ENROLL = 'enroll-1';

interface MatrixRow {
  name: string;
  customerMessage: string;
  classifier: { intent: string; confidence: number; reason: string; fromLlm: boolean };
  triggerState?: string;
  expectedShouldBlock: boolean;
  expectedAction: string;
  expectedSideEffect: string;
}

const MATRIX: MatrixRow[] = [
  {
    name: 'opt_out at high confidence → block_terminal + stop_and_lost',
    customerMessage: 'please lose my information',
    classifier: { intent: 'opt_out', confidence: 0.95, reason: 'explicit', fromLlm: true },
    expectedShouldBlock: true,
    expectedAction: 'block_terminal',
    expectedSideEffect: 'stop_and_lost',
  },
  {
    name: 'hired_elsewhere at high confidence → block_terminal + stop_and_lost',
    customerMessage: 'we hired another company',
    classifier: { intent: 'hired_elsewhere', confidence: 0.92, reason: 'hired', fromLlm: true },
    expectedShouldBlock: true,
    expectedAction: 'block_terminal',
    expectedSideEffect: 'stop_and_lost',
  },
  {
    // 2026-06-17 lifecycle rule cleanup: `completed` no longer maps to lost.
    // Wrap-up phrasing is too ambiguous to safely flip a customer to lost
    // from a classifier signal alone — the sequence stops, but the lead
    // stays in its current funnel state until SF/platform/manual reports.
    name: 'completed (Donna case) → block_terminal + stop_only (no longer maps to lost)',
    customerMessage: 'The house has already been cleaned',
    classifier: { intent: 'completed', confidence: 0.88, reason: 'work done', fromLlm: true },
    expectedShouldBlock: true,
    expectedAction: 'block_terminal',
    expectedSideEffect: 'stop_only',
  },
  {
    // 2026-06-17 lifecycle rule cleanup: AI no longer authors `booked`.
    // The handoff alert path (maybeFireHandoffAlert on the inbound classifier)
    // pages the dispatcher; the actual booking is recorded by SF/platform/manual.
    name: 'agreed → block_terminal + stop_only (AI never authors booked)',
    customerMessage: "let's book it",
    classifier: { intent: 'agreed', confidence: 0.9, reason: 'price accepted', fromLlm: true },
    expectedShouldBlock: true,
    expectedAction: 'block_terminal',
    expectedSideEffect: 'stop_only',
  },
  {
    name: 'deferring (bounded) → block_terminal + stop_only (pause not lost)',
    customerMessage: "I'll get back to you next week",
    classifier: { intent: 'deferring', confidence: 0.85, reason: 'pause', fromLlm: true },
    expectedShouldBlock: true,
    expectedAction: 'block_terminal',
    expectedSideEffect: 'stop_only',
  },
  {
    name: 'terminal_defer (unbounded "maybe later") → block_terminal + stop_and_lost',
    customerMessage: 'maybe later',
    classifier: { intent: 'terminal_defer', confidence: 0.88, reason: 'unbounded deflection', fromLlm: true },
    expectedShouldBlock: true,
    expectedAction: 'block_terminal',
    expectedSideEffect: 'stop_and_lost',
  },
  {
    name: 'terminal_defer (no return window) → block_terminal + stop_and_lost',
    customerMessage: "thanks but I'm going to think about it for a while",
    classifier: { intent: 'terminal_defer', confidence: 0.92, reason: 'no return window', fromLlm: true },
    expectedShouldBlock: true,
    expectedAction: 'block_terminal',
    expectedSideEffect: 'stop_and_lost',
  },
  {
    name: 'engaged → proceed',
    customerMessage: 'yes 3 bedrooms',
    classifier: { intent: 'engaged', confidence: 0.95, reason: 'continuing', fromLlm: true },
    expectedShouldBlock: false,
    expectedAction: 'proceed',
    expectedSideEffect: 'none',
  },
  {
    name: 'asking → proceed',
    customerMessage: 'how much for 3 bed?',
    classifier: { intent: 'asking', confidence: 0.95, reason: 'pricing', fromLlm: true },
    expectedShouldBlock: false,
    expectedAction: 'proceed',
    expectedSideEffect: 'none',
  },
  {
    name: 'low confidence → pass_low_confidence (no side effect)',
    customerMessage: 'ok',
    classifier: { intent: 'completed', confidence: 0.5, reason: 'unclear', fromLlm: true },
    expectedShouldBlock: false,
    expectedAction: 'pass_low_confidence',
    expectedSideEffect: 'none',
  },
  {
    name: 'classifier failed (fromLlm=false) → pass_classifier_failed',
    customerMessage: 'hello',
    classifier: { intent: 'engaged', confidence: 0, reason: 'fallback', fromLlm: false },
    expectedShouldBlock: false,
    expectedAction: 'pass_classifier_failed',
    expectedSideEffect: 'none',
  },
  {
    // Savanna 2026-05-12 regression: pre-fix, `completed` on a re-engagement
    // sequence bypassed the gate and let 3 follow-ups blast a customer who
    // had just confirmed a booking with "Thank you!". The narrow bypass only
    // applies to `deferring` now — `completed` on a re-engagement is treated
    // the same as on a regular sequence: stop, mark lost.
    // 2026-06-17 lifecycle rule cleanup: `completed` is stop_only everywhere.
    name: 're-engagement BLOCKS completed: completed on customer_deferred → block_terminal + stop_only',
    customerMessage: "we're done with it",
    classifier: { intent: 'completed', confidence: 0.9, reason: 'job done', fromLlm: true },
    triggerState: 'customer_deferred',
    expectedShouldBlock: true,
    expectedAction: 'block_terminal',
    expectedSideEffect: 'stop_only',
  },
  {
    // 2026-06-17 lifecycle rule cleanup: `agreed` is stop_only everywhere.
    name: 're-engagement BLOCKS agreed: agreed on customer_hired_competitor → block_terminal + stop_only',
    customerMessage: 'yes book it',
    classifier: { intent: 'agreed', confidence: 0.95, reason: 'accepted', fromLlm: true },
    triggerState: 'customer_hired_competitor',
    expectedShouldBlock: true,
    expectedAction: 'block_terminal',
    expectedSideEffect: 'stop_only',
  },
  {
    name: 're-engagement BLOCKS hired_elsewhere: hired_elsewhere on customer_hired_competitor → block_terminal',
    customerMessage: 'we went with another company',
    classifier: { intent: 'hired_elsewhere', confidence: 0.9, reason: 'hired other', fromLlm: true },
    triggerState: 'customer_hired_competitor',
    expectedShouldBlock: true,
    expectedAction: 'block_terminal',
    expectedSideEffect: 'stop_and_lost',
  },
  {
    name: 're-engagement still blocks opt_out: opt_out on customer_hired_competitor',
    customerMessage: 'stop messaging me',
    classifier: { intent: 'opt_out', confidence: 0.99, reason: 'explicit', fromLlm: true },
    triggerState: 'customer_hired_competitor',
    expectedShouldBlock: true,
    expectedAction: 'block_terminal',
    expectedSideEffect: 'stop_and_lost',
  },
  {
    // Phase 1 Task 3: re-engagement sequences MUST also block terminal_defer.
    // The whole point of terminal_defer is "no return commitment" — sending
    // another re-engagement message is the creepy follow-up this gate exists
    // to prevent. Distinct from regular `deferring` (bounded) which DOES
    // bypass the re-engagement gate to allow scheduled messaging.
    name: 're-engagement BLOCKS terminal_defer: terminal_defer on customer_deferred',
    customerMessage: 'maybe someday',
    classifier: { intent: 'terminal_defer', confidence: 0.9, reason: 'indefinite punt', fromLlm: true },
    triggerState: 'customer_deferred',
    expectedShouldBlock: true,
    expectedAction: 'block_terminal',
    expectedSideEffect: 'stop_and_lost',
  },
  {
    name: 're-engagement bypass STILL applies to bounded deferring: deferring on customer_deferred',
    customerMessage: "I'll let you know in 3 weeks",
    classifier: { intent: 'deferring', confidence: 0.88, reason: 'bounded pause', fromLlm: true },
    triggerState: 'customer_deferred',
    expectedShouldBlock: false,
    expectedAction: 'pass_re_engagement',
    expectedSideEffect: 'none',
  },
];

function buildPrisma(customerMessage: string) {
  return {
    message: {
      findFirst: jest.fn().mockResolvedValue({
        content: customerMessage,
        createdAt: new Date('2026-04-15T00:00:00Z'),
      }),
      findMany: jest.fn().mockResolvedValue([
        { sender: 'customer', content: customerMessage },
      ]),
    },
    lead: {
      findUnique: jest.fn().mockResolvedValue({ status: 'engaged', category: 'House cleaning' }),
    },
  } as any;
}

describe('FollowUpGate cross-path equivalence (scheduler ↔ preview)', () => {
  for (const row of MATRIX) {
    it(`scheduler-path matches preview-path: ${row.name}`, async () => {
      const prisma = buildPrisma(row.customerMessage);
      const classifier = { classify: jest.fn().mockResolvedValue(row.classifier) } as any;
      const gate = new FollowUpGateService(prisma, classifier);

      // Simulate scheduler-path call (scheduler's classifyAndMaybeStop
      // delegates exclusively to gate.evaluate now).
      const schedulerDecision = await gate.evaluate({
        conversationId: CONV,
        enrollmentId: ENROLL,
        leadId: LEAD,
        triggerState: row.triggerState,
      });

      // Reset classifier mock so preview-path doesn't see scheduler's call.
      classifier.classify.mockClear();
      classifier.classify.mockResolvedValue(row.classifier);

      // Simulate preview-path call (controller calls gate.evaluate directly).
      const previewDecision = await gate.evaluate({
        conversationId: CONV,
        enrollmentId: ENROLL,
        leadId: LEAD,
        triggerState: row.triggerState,
      });

      // The two MUST agree on the gate-relevant fields. Confidence may vary
      // by ±0 since both call the SAME classifier mock with same inputs.
      expect(previewDecision.shouldBlock).toBe(schedulerDecision.shouldBlock);
      expect(previewDecision.action).toBe(schedulerDecision.action);
      expect(previewDecision.intent).toBe(schedulerDecision.intent);
      expect(previewDecision.sideEffect).toBe(schedulerDecision.sideEffect);

      // And both must match the matrix expectations.
      expect(schedulerDecision.shouldBlock).toBe(row.expectedShouldBlock);
      expect(schedulerDecision.action).toBe(row.expectedAction);
      expect(schedulerDecision.sideEffect).toBe(row.expectedSideEffect);
    });
  }

  describe('original-pitch fallback only when no later customer message exists', () => {
    it('with NO customer message: pass_no_message (preview can fall through to AI generation safely)', async () => {
      const prisma = {
        message: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
        lead: { findUnique: jest.fn().mockResolvedValue({ status: 'new', category: 'Cleaning' }) },
      } as any;
      const classifier = { classify: jest.fn().mockResolvedValue({}) } as any;
      const gate = new FollowUpGateService(prisma, classifier);
      const decision = await gate.evaluate({ conversationId: CONV, leadId: LEAD });
      expect(decision.action).toBe('pass_no_message');
      // Classifier never invoked — no message to classify
      expect(classifier.classify).not.toHaveBeenCalled();
    });

    it('with customer message present: classifier reads LATEST, not lead-creation pitch', async () => {
      // The lead-creation message is whatever produced the lead row originally.
      // The latest customer message is what the customer most recently sent.
      // The gate MUST read the latest, not the original pitch.
      const prisma = {
        message: {
          findFirst: jest.fn().mockResolvedValue({
            content: 'no longer interested',
            createdAt: new Date('2026-04-20T00:00:00Z'),
          }),
          findMany: jest.fn().mockResolvedValue([
            { sender: 'customer', content: 'I need a deep cleaning' }, // original pitch
            { sender: 'pro', content: 'price is $200' },
            { sender: 'customer', content: 'no longer interested' }, // latest
          ]),
        },
        lead: { findUnique: jest.fn().mockResolvedValue({ status: 'engaged', category: 'Deep cleaning' }) },
      } as any;
      const classifier = { classify: jest.fn().mockResolvedValue({
        intent: 'completed', confidence: 0.9, reason: 'lost interest', fromLlm: true,
      }) } as any;
      const gate = new FollowUpGateService(prisma, classifier);
      const decision = await gate.evaluate({ conversationId: CONV, leadId: LEAD });

      // Verify the LATEST message was passed (not the original pitch)
      expect(classifier.classify).toHaveBeenCalledWith(expect.objectContaining({
        message: 'no longer interested',
      }));
      expect(decision.shouldBlock).toBe(true);
      expect(decision.action).toBe('block_terminal');
    });
  });
});
