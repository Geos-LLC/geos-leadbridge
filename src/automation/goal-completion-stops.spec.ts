/**
 * Goal completion stops — simplified contract (2026-06-18).
 *
 * Per the wizard / Settings simplification, the per-goal
 * "Continue AI + Notify Team" vs "Stop AI + Notify Team" choice was
 * removed. AI ALWAYS stops on goal completion across all three goals
 * (Price / Qualify / Phone) regardless of the legacy aiRules JSON
 * keys. The keys (aiStopOnPriceAgreed / goalQualifyStopOnComplete /
 * goalPhoneStopOnComplete) remain in followUpSettingsJson for
 * back-compat with old saves but are no longer read at runtime.
 *
 * These tests pin three things:
 *   1. The AI_STATUS_REASONS / CONVERSATION_STATE_REASONS constants
 *      still exist with the expected snake_case wire values.
 *   2. Each goal-completion gate in automation.service.ts is now
 *      unconditional (no aiStopOnPriceAgreed / goalQualifyStopOnComplete
 *      / goalPhoneStopOnComplete checks).
 *   3. The wants_live_contact split (a non-configurable system event)
 *      is unchanged.
 *
 * End-to-end integration coverage stays out of scope: handleCustomerReply
 * needs prisma / classifier / trialService / conversationRuntime mocks
 * that would dwarf the gate logic itself.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AI_STATUS_REASONS,
  CONVERSATION_STATE_REASONS,
} from '../conversation-context/conversation-runtime';

describe('Goal completion stop — AI_STATUS_REASONS / CONVERSATION_STATE_REASONS', () => {
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

function gateBlock(source: string, anchor: RegExp, maxChars = 1200): string {
  const idx = source.search(anchor);
  if (idx < 0) return '';
  return source.slice(idx, idx + maxChars);
}

describe('Goal completion stop — unconditional gate wiring', () => {
  const source = readFileSync(
    join(__dirname, 'automation.service.ts'),
    'utf-8',
  );

  it('Price gate is unconditional — checks ONLY intent === "agreed"', () => {
    // Old form was `intent === 'agreed' && aiRules.aiStopOnPriceAgreed !== false`.
    // New form is just `intent === 'agreed'`. The runtime no longer reads
    // the JSON key.
    expect(source).toMatch(/if\s*\(\s*intent\s*===\s*['"]agreed['"]\s*\)\s*{/);
  });

  it('Qualify gate is unconditional — no goalQualifyStopOnComplete check', () => {
    const block = gateBlock(source, /const isQualifyComplete\s*=/, 600);
    expect(block).toMatch(/handoff\.reason\s*===\s*['"]qualification_complete['"]/);
    expect(block).not.toMatch(/goalQualifyStopOnComplete/);
  });

  it('Phone gate is unconditional — no goalPhoneStopOnComplete check', () => {
    const block = gateBlock(source, /const isPhoneComplete\s*=/, 600);
    expect(block).toMatch(/handoff\.reason\s*===\s*['"]provided_phone_number['"]/);
    expect(block).not.toMatch(/goalPhoneStopOnComplete/);
  });

  it('automation.service.ts no longer reads aiStopOnPriceAgreed at runtime', () => {
    // The Price-goal gate was the last reader; the regex matches property
    // access patterns (`.aiStopOnPriceAgreed !==`/`===`) so explanatory
    // comments that mention the bare key name don't trip the assertion.
    expect(source).not.toMatch(/\.aiStopOnPriceAgreed\s*(!==|===)/);
  });

  it('automation.service.ts no longer reads goalQualifyStopOnComplete at runtime', () => {
    expect(source).not.toMatch(/goalQualifyStopOnComplete\s*(!==|===)/);
  });

  it('automation.service.ts no longer reads goalPhoneStopOnComplete at runtime', () => {
    expect(source).not.toMatch(/goalPhoneStopOnComplete\s*(!==|===)/);
  });

  it('Qualify gate sets AI_STATUS_REASONS.GOAL_QUALIFY_COMPLETE', () => {
    // Window widened from 1200 to 1800 chars after the qualifyMissing
    // suppression branch was added (Lawrence Parker fix 2026-06-22).
    // The setState call now lives inside the else branch instead of at
    // the top of the gate block.
    const block = gateBlock(source, /const isQualifyComplete\s*=/, 1800);
    expect(block).toMatch(/AI_STATUS_REASONS\.GOAL_QUALIFY_COMPLETE/);
    expect(block).toMatch(/CONVERSATION_STATE_REASONS\.GOAL_QUALIFY_COMPLETE/);
  });

  it('Phone gate sets AI_STATUS_REASONS.GOAL_PHONE_COMPLETE', () => {
    const block = gateBlock(source, /const isPhoneComplete\s*=/, 1200);
    expect(block).toMatch(/AI_STATUS_REASONS\.GOAL_PHONE_COMPLETE/);
    expect(block).toMatch(/CONVERSATION_STATE_REASONS\.GOAL_PHONE_COMPLETE/);
  });

  it('Qualify gate sets conversationState=human_handling', () => {
    const block = gateBlock(source, /const isQualifyComplete\s*=/, 1800);
    expect(block).toMatch(/conversationState:\s*['"]human_handling['"]/);
  });

  it('Qualify gate suppresses the stop when qualifyMissing has entries', () => {
    // Lawrence Parker (Spotless JAX Yelp 2026-06-20) — classifier flagged
    // qualification_complete even though sqft / bathrooms / phone were
    // never collected. The gate now consults qualifyMissing (computed
    // once per reply against the tenant's qualificationV2.requiredFields)
    // and falls through to AI reply generation instead of silencing
    // itself.
    const block = gateBlock(source, /const isQualifyComplete\s*=/, 1800);
    expect(block).toMatch(/qualifyMissing\.length\s*>\s*0/);
    expect(block).toMatch(/qualification_complete suppressed/);
  });

  it('Phone gate sets conversationState=human_handling', () => {
    const block = gateBlock(source, /const isPhoneComplete\s*=/, 1200);
    expect(block).toMatch(/conversationState:\s*['"]human_handling['"]/);
  });

  it('Price (agreed) gate sets conversationState=booked_in_lb', () => {
    const block = gateBlock(source, /if\s*\(\s*intent\s*===\s*['"]agreed['"]\s*\)\s*{/, 900);
    expect(block).toMatch(/conversationState:\s*['"]booked_in_lb['"]/);
    expect(block).toMatch(/AI_STATUS_REASONS\.CLASSIFIER_AGREED/);
    expect(block).toMatch(/CONVERSATION_STATE_REASONS\.CLASSIFIER_AGREED/);
  });

  it('both Qualify and Phone gates still check handoff.shouldHandoff', () => {
    // Defensive: handoff is optional on the classifier output. Reading
    // .reason without shouldHandoff would fire on partial / stale signals.
    const qualifyChunk = source.match(/const isQualifyComplete[\s\S]{0,400}/);
    const phoneChunk = source.match(/const isPhoneComplete[\s\S]{0,400}/);
    expect(qualifyChunk).toBeTruthy();
    expect(phoneChunk).toBeTruthy();
    expect(qualifyChunk![0]).toMatch(/handoff\?\.shouldHandoff/);
    expect(phoneChunk![0]).toMatch(/handoff\?\.shouldHandoff/);
  });

  it('both gates live inside the LLM-confidence guard block', () => {
    // Outer guard `classification.fromLlm && classification.confidence
    // >= CLASSIFIER_CONFIDENCE_THRESHOLD` still precedes both gates in
    // source order — no false positives from rule-based classifications.
    const outerGuardIdx = source.search(/classification\.fromLlm[\s\S]{0,200}CLASSIFIER_CONFIDENCE_THRESHOLD/);
    const qualifyGateIdx = source.search(/const isQualifyComplete\b/);
    const phoneGateIdx = source.search(/const isPhoneComplete\b/);
    expect(outerGuardIdx).toBeGreaterThan(-1);
    expect(qualifyGateIdx).toBeGreaterThan(outerGuardIdx);
    expect(phoneGateIdx).toBeGreaterThan(outerGuardIdx);
  });
});

/**
 * wants_live_contact split — unchanged. A non-configurable system event
 * that stops AI immediately, separate from the Price goal completion.
 */
describe('wants_live_contact split — system event, unchanged by simplification', () => {
  const source = readFileSync(
    join(__dirname, 'automation.service.ts'),
    'utf-8',
  );

  it('wants_live_contact has its own dedicated gate', () => {
    expect(source).toMatch(/if\s*\(\s*intent\s*===\s*['"]wants_live_contact['"]\s*\)\s*{/);
  });

  it('wants_live_contact gate is unconditional (no JSON key gate)', () => {
    const start = source.search(/if\s*\(\s*intent\s*===\s*['"]wants_live_contact['"]\s*\)\s*{/);
    expect(start).toBeGreaterThan(-1);
    const tail = source.slice(start);
    const returnIdx = tail.search(/\breturn;/);
    expect(returnIdx).toBeGreaterThan(-1);
    const gateBody = tail.slice(0, returnIdx + 'return;'.length);
    expect(gateBody).not.toMatch(/aiStopOn/);
    expect(gateBody).not.toMatch(/StopOnComplete/);
  });

  it('wants_live_contact gate sets stopped_booked + CLASSIFIER_WANTS_LIVE_CONTACT reason', () => {
    const block = gateBlock(source, /if\s*\(\s*intent\s*===\s*['"]wants_live_contact['"]\s*\)\s*{/, 700);
    expect(block).toMatch(/aiStatus:\s*['"]stopped_booked['"]/);
    expect(block).toMatch(/AI_STATUS_REASONS\.CLASSIFIER_WANTS_LIVE_CONTACT/);
    expect(block).toMatch(/conversationState:\s*['"]human_handling['"]/);
    expect(block).toMatch(/CONVERSATION_STATE_REASONS\.CLASSIFIER_WANTS_LIVE_CONTACT/);
  });

  it('wants_live_contact gate appears BEFORE agreed gate in source order', () => {
    // wants_live_contact must short-circuit before reaching the agreed
    // path so it always sets human_handling (not booked_in_lb).
    const wantsLiveIdx = source.search(/if\s*\(\s*intent\s*===\s*['"]wants_live_contact['"]\s*\)\s*{/);
    const agreedIdx = source.search(/if\s*\(\s*intent\s*===\s*['"]agreed['"]\s*\)/);
    expect(wantsLiveIdx).toBeGreaterThan(-1);
    expect(agreedIdx).toBeGreaterThan(-1);
    expect(wantsLiveIdx).toBeLessThan(agreedIdx);
  });

  it('opt_out remains a separate gate (still has its own JSON key)', () => {
    // opt_out is a customer-protection signal (unsubscribe wording) that
    // remains independently togglable via aiStopOnOptOut. Untouched by
    // the goal-completion simplification.
    // 2c flipped the runtime check from `!== false` to `=== true` —
    // semantically identical post-backfill (every SavedAccount now has
    // the key explicitly set), but the assertion needs to track the
    // current literal form.
    expect(source).toMatch(
      /if\s*\(\s*intent\s*===\s*['"]opt_out['"]\s*&&\s*aiRules\.aiStopOnOptOut\s*===\s*true\s*\)/,
    );
  });
});
