/**
 * V2 goal completion stop gates — wiring contract.
 *
 * The new per-goal "Stop AI + Notify Team" choice on Qualify and Phone
 * goals adds two gates to automation.service.ts handleCustomerReply:
 *
 *   handoff.reason='qualification_complete' + goalQualifyStopOnComplete=true
 *     → AI stops, conversationRuntime records GOAL_QUALIFY_COMPLETE
 *
 *   handoff.reason='provided_phone_number' + goalPhoneStopOnComplete=true
 *     → AI stops, conversationRuntime records GOAL_PHONE_COMPLETE
 *
 * These tests pin three things:
 *   1. The new AI_STATUS_REASONS / CONVERSATION_STATE_REASONS constants
 *      exist with the expected snake_case wire values.
 *   2. The gates live in automation.service.ts (source-grep) and they
 *      reference the new aiRules.goalQualifyStopOnComplete /
 *      .goalPhoneStopOnComplete keys.
 *   3. The default (unset) behavior is preserved — gates require strict
 *      `=== true`, not truthy, so existing tenants without the keys are
 *      not affected.
 *
 * End-to-end integration coverage is out of scope: handleCustomerReply
 * needs prisma / classifier / trialService / conversationRuntime mocks
 * that would dwarf the gate logic itself. Source-level pinning plus
 * staging verification is the pragmatic split.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AI_STATUS_REASONS,
  CONVERSATION_STATE_REASONS,
} from '../conversation-context/conversation-runtime';

describe('V2 goal completion stop — AI_STATUS_REASONS / CONVERSATION_STATE_REASONS', () => {
  it('AI_STATUS_REASONS.GOAL_QUALIFY_COMPLETE exists with wire value', () => {
    expect(AI_STATUS_REASONS.GOAL_QUALIFY_COMPLETE).toBe('goal_qualify_complete');
  });

  it('AI_STATUS_REASONS.GOAL_PHONE_COMPLETE exists with wire value', () => {
    expect(AI_STATUS_REASONS.GOAL_PHONE_COMPLETE).toBe('goal_phone_complete');
  });

  it('CONVERSATION_STATE_REASONS.GOAL_QUALIFY_COMPLETE exists with wire value', () => {
    expect(CONVERSATION_STATE_REASONS.GOAL_QUALIFY_COMPLETE).toBe('goal_qualify_complete');
  });

  it('CONVERSATION_STATE_REASONS.GOAL_PHONE_COMPLETE exists with wire value', () => {
    expect(CONVERSATION_STATE_REASONS.GOAL_PHONE_COMPLETE).toBe('goal_phone_complete');
  });
});

/**
 * Helper: slice the source around a regex anchor so we can assert on what
 * appears WITHIN the matching gate block without relying on character-count
 * proximity (which breaks when comments grow).
 */
function gateBlock(source: string, anchor: RegExp, maxChars = 1200): string {
  const idx = source.search(anchor);
  if (idx < 0) return '';
  return source.slice(idx, idx + maxChars);
}

describe('V2 goal completion stop — gate wiring in automation.service.ts', () => {
  const source = readFileSync(
    join(__dirname, 'automation.service.ts'),
    'utf-8',
  );

  it('reads goalQualifyStopOnComplete from aiRules', () => {
    // The gate uses `as any` because we don't widen the aiRules type for
    // this single new key; the assertion is the wire contract.
    expect(source).toMatch(/aiRules\s*as\s*any\s*\)\.goalQualifyStopOnComplete\s*===\s*true/);
  });

  it('reads goalPhoneStopOnComplete from aiRules', () => {
    expect(source).toMatch(/aiRules\s*as\s*any\s*\)\.goalPhoneStopOnComplete\s*===\s*true/);
  });

  it('Qualify gate checks handoff.reason === "qualification_complete"', () => {
    expect(source).toMatch(/handoff\.reason\s*===\s*['"]qualification_complete['"]/);
  });

  it('Phone gate checks handoff.reason === "provided_phone_number"', () => {
    expect(source).toMatch(/handoff\.reason\s*===\s*['"]provided_phone_number['"]/);
  });

  it('Qualify gate references AI_STATUS_REASONS.GOAL_QUALIFY_COMPLETE', () => {
    expect(source).toMatch(/AI_STATUS_REASONS\.GOAL_QUALIFY_COMPLETE/);
  });

  it('Phone gate references AI_STATUS_REASONS.GOAL_PHONE_COMPLETE', () => {
    expect(source).toMatch(/AI_STATUS_REASONS\.GOAL_PHONE_COMPLETE/);
  });

  it('Qualify gate references CONVERSATION_STATE_REASONS.GOAL_QUALIFY_COMPLETE', () => {
    expect(source).toMatch(/CONVERSATION_STATE_REASONS\.GOAL_QUALIFY_COMPLETE/);
  });

  it('Phone gate references CONVERSATION_STATE_REASONS.GOAL_PHONE_COMPLETE', () => {
    expect(source).toMatch(/CONVERSATION_STATE_REASONS\.GOAL_PHONE_COMPLETE/);
  });

  it('uses strict === true (NOT truthy) so undefined defaults to Continue', () => {
    // Critical for back-compat: existing tenants without the JSON keys
    // see goalQualifyStopOnComplete=undefined, which must NOT fire the
    // stop. Strict === true is the safety net.
    const matches = source.match(/goal(Qualify|Phone)StopOnComplete\s*===\s*true/g);
    expect(matches).toBeTruthy();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it('both gates live inside the LLM-confidence guard block', () => {
    // The outer block at the top of the classifier-driven short-circuit
    // already guards on `classification.fromLlm && classification.confidence
    // >= CLASSIFIER_CONFIDENCE_THRESHOLD`. Both new gates inherit that
    // protection — no separate fromLlm check needed inside the gate
    // itself. This assertion pins the structural fact that the outer
    // guard precedes both gates in source order.
    const outerGuardIdx = source.search(/classification\.fromLlm[\s\S]{0,200}CLASSIFIER_CONFIDENCE_THRESHOLD/);
    const qualifyGateIdx = source.search(/const isQualifyComplete\b/);
    const phoneGateIdx = source.search(/const isPhoneComplete\b/);
    expect(outerGuardIdx).toBeGreaterThan(-1);
    expect(qualifyGateIdx).toBeGreaterThan(outerGuardIdx);
    expect(phoneGateIdx).toBeGreaterThan(outerGuardIdx);
  });

  it('both gates check handoff.shouldHandoff before reading reason', () => {
    // Defensive: handoff is optional on the classifier output. Reading
    // .reason without shouldHandoff would fire on partial / stale signals.
    const qualifyChunk = source.match(/const isQualifyComplete[\s\S]{0,400}/);
    const phoneChunk = source.match(/const isPhoneComplete[\s\S]{0,400}/);
    expect(qualifyChunk).toBeTruthy();
    expect(phoneChunk).toBeTruthy();
    expect(qualifyChunk![0]).toMatch(/handoff\?\.shouldHandoff/);
    expect(phoneChunk![0]).toMatch(/handoff\?\.shouldHandoff/);
  });
});

/**
 * V2 split of `wants_live_contact` (system event) from `agreed` (Price goal
 * completion). Previously both intents shared the `aiStopOnPriceAgreed`
 * gate, which meant picking Price="Continue AI + Notify Team" silently
 * disabled the wants_live_contact stop too. That coupling contradicted the
 * spec's "wants_live_contact is a non-configurable system event."
 */
describe('V2 wants_live_contact split — system event, not gated by aiStopOnPriceAgreed', () => {
  const source = readFileSync(
    join(__dirname, 'automation.service.ts'),
    'utf-8',
  );

  it('wants_live_contact has its own dedicated gate', () => {
    expect(source).toMatch(/if\s*\(\s*intent\s*===\s*['"]wants_live_contact['"]\s*\)\s*{/);
  });

  it('wants_live_contact gate does NOT depend on aiStopOnPriceAgreed', () => {
    // Slice tightly from the gate's opening `if` to its `return;` so the
    // assertion doesn't bleed into the *next* gate's comment (which legit
    // mentions aiStopOnPriceAgreed as part of the agreed-gate explanation).
    const start = source.search(/if\s*\(\s*intent\s*===\s*['"]wants_live_contact['"]\s*\)\s*{/);
    expect(start).toBeGreaterThan(-1);
    const tail = source.slice(start);
    const returnIdx = tail.search(/\breturn;/);
    expect(returnIdx).toBeGreaterThan(-1);
    const gateBody = tail.slice(0, returnIdx + 'return;'.length);
    expect(gateBody).not.toMatch(/aiStopOnPriceAgreed/);
  });

  it('wants_live_contact gate sets stopped_booked + CLASSIFIER_WANTS_LIVE_CONTACT reason', () => {
    const block = gateBlock(source, /if\s*\(\s*intent\s*===\s*['"]wants_live_contact['"]\s*\)\s*{/, 700);
    expect(block).toMatch(/aiStatus:\s*['"]stopped_booked['"]/);
    expect(block).toMatch(/AI_STATUS_REASONS\.CLASSIFIER_WANTS_LIVE_CONTACT/);
    expect(block).toMatch(/conversationState:\s*['"]human_handling['"]/);
    expect(block).toMatch(/CONVERSATION_STATE_REASONS\.CLASSIFIER_WANTS_LIVE_CONTACT/);
  });

  it('agreed gate is separate and IS gated by aiStopOnPriceAgreed', () => {
    // The `agreed` gate must be the Price goal completion — gated by
    // aiStopOnPriceAgreed !== false. Distinct from wants_live_contact.
    expect(source).toMatch(
      /if\s*\(\s*intent\s*===\s*['"]agreed['"]\s*&&\s*aiRules\.aiStopOnPriceAgreed\s*!==\s*false\s*\)\s*{/,
    );
  });

  it('agreed gate does NOT mention wants_live_contact in its condition', () => {
    // Source-grep that the OR-with-wants_live_contact coupling is gone.
    // The old form was `(intent === 'agreed' || intent === 'wants_live_contact') && aiStopOnPriceAgreed !== false`.
    // Match the condition line specifically and confirm it's clean.
    const m = source.match(/if\s*\(\s*intent\s*===\s*['"]agreed['"][^)]*\)/);
    expect(m).toBeTruthy();
    expect(m![0]).not.toMatch(/wants_live_contact/);
  });

  it('agreed gate sets booked_in_lb (not human_handling)', () => {
    // Conversation-state semantics differ: agreed → booked_in_lb (price
    // accepted, dispatcher confirms scheduling), wants_live_contact →
    // human_handling (customer wants a person, period). Pin both.
    const agreedBlock = gateBlock(source, /if\s*\(\s*intent\s*===\s*['"]agreed['"][^)]*\)\s*{/, 900);
    expect(agreedBlock).toMatch(/conversationState:\s*['"]booked_in_lb['"]/);
    expect(agreedBlock).toMatch(/AI_STATUS_REASONS\.CLASSIFIER_AGREED/);
    expect(agreedBlock).toMatch(/CONVERSATION_STATE_REASONS\.CLASSIFIER_AGREED/);
  });

  it('wants_live_contact gate appears BEFORE agreed gate in source order', () => {
    // wants_live_contact must short-circuit before reaching the
    // aiStopOnPriceAgreed-gated agreed path, otherwise a wants_live_contact
    // intent would never hit its own dedicated gate.
    const wantsLiveIdx = source.search(/if\s*\(\s*intent\s*===\s*['"]wants_live_contact['"]\s*\)\s*{/);
    const agreedIdx = source.search(/if\s*\(\s*intent\s*===\s*['"]agreed['"]\s*&&\s*aiRules\.aiStopOnPriceAgreed/);
    expect(wantsLiveIdx).toBeGreaterThan(-1);
    expect(agreedIdx).toBeGreaterThan(-1);
    expect(wantsLiveIdx).toBeLessThan(agreedIdx);
  });
});

/**
 * Per-goal mapping contract — pin which classifier signal each backend
 * field gates. Source-grep so the wiring stays explicit even as the gate
 * code changes shape.
 */
describe('V2 per-goal mapping contract', () => {
  const source = readFileSync(
    join(__dirname, 'automation.service.ts'),
    'utf-8',
  );

  it('Price goal: intent="agreed" → aiStopOnPriceAgreed', () => {
    expect(source).toMatch(
      /if\s*\(\s*intent\s*===\s*['"]agreed['"]\s*&&\s*aiRules\.aiStopOnPriceAgreed\s*!==\s*false\s*\)/,
    );
  });

  it('Qualify goal: handoff.reason="qualification_complete" → goalQualifyStopOnComplete', () => {
    const block = gateBlock(source, /const isQualifyComplete\s*=/, 600);
    expect(block).toMatch(/handoff\.reason\s*===\s*['"]qualification_complete['"]/);
    expect(block).toMatch(/goalQualifyStopOnComplete\s*===\s*true/);
  });

  it('Phone goal: handoff.reason="provided_phone_number" → goalPhoneStopOnComplete', () => {
    const block = gateBlock(source, /const isPhoneComplete\s*=/, 600);
    expect(block).toMatch(/handoff\.reason\s*===\s*['"]provided_phone_number['"]/);
    expect(block).toMatch(/goalPhoneStopOnComplete\s*===\s*true/);
  });

  it('System event opt_out → aiStopOnOptOut (always-on default)', () => {
    expect(source).toMatch(
      /if\s*\(\s*intent\s*===\s*['"]opt_out['"]\s*&&\s*aiRules\.aiStopOnOptOut\s*!==\s*false\s*\)/,
    );
  });

  it('System event wants_live_contact → unconditional stop (no toggle gate)', () => {
    expect(source).toMatch(
      /if\s*\(\s*intent\s*===\s*['"]wants_live_contact['"]\s*\)\s*{/,
    );
  });

  it('No phantom Qualify-goal coupling with aiStopOnPriceAgreed', () => {
    // The Qualify gate must NOT read aiStopOnPriceAgreed — that field is
    // the Price goal's domain. Cross-coupling here would replay the
    // pre-V2 wants_live_contact bug for a different intent.
    const block = gateBlock(source, /const isQualifyComplete\s*=/, 800);
    expect(block).not.toMatch(/aiStopOnPriceAgreed/);
  });

  it('No phantom Phone-goal coupling with aiStopOnPriceAgreed', () => {
    const block = gateBlock(source, /const isPhoneComplete\s*=/, 800);
    expect(block).not.toMatch(/aiStopOnPriceAgreed/);
  });
});
