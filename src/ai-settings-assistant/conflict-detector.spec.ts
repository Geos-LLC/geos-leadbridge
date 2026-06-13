/**
 * Conflict detector — fallback + parsing tests.
 *
 * The service-level conflict.spec.ts exercises the detector through
 * `runConflictDetection` (a stubbed protected method). These tests hit
 * `detectConflict` directly to lock the safe-fallback paths: timeout,
 * malformed JSON, hallucinated excerpt, empty inputs.
 */

import { detectConflict, type LlmCaller } from './conflict-detector';

function stubCaller(responseOrThrow: string | Error): LlmCaller {
  return async () => {
    if (responseOrThrow instanceof Error) throw responseOrThrow;
    return responseOrThrow;
  };
}

describe('detectConflict — safe fallbacks', () => {
  it('returns compatible (no LLM) when currentValue is empty', async () => {
    let called = 0;
    const llm: LlmCaller = async () => { called++; return ''; };
    const r = await detectConflict(llm, { currentValue: '', newValue: 'something', area: 'business_information' });
    expect(r.verdict).toBe('compatible');
    expect(r.fromLlm).toBe(false);
    expect(called).toBe(0);
  });

  it('returns compatible when LLM throws', async () => {
    const r = await detectConflict(
      stubCaller(new Error('boom')),
      { currentValue: 'Existing.', newValue: 'New.', area: 'pricing_guidance' },
    );
    expect(r.verdict).toBe('compatible');
    expect(r.fromLlm).toBe(false);
    expect(r.explanation).toMatch(/detector unavailable|errored|append/i);
  });

  it('returns compatible when LLM returns malformed JSON', async () => {
    const r = await detectConflict(
      stubCaller('not json at all'),
      { currentValue: 'Existing.', newValue: 'New.', area: 'pricing_guidance' },
    );
    expect(r.verdict).toBe('compatible');
    expect(r.fromLlm).toBe(false);
  });

  it('downgrades to compatible when LLM hallucinates an excerpt not present in current', async () => {
    const r = await detectConflict(
      stubCaller(JSON.stringify({ verdict: 'conflict', conflictingExcerpt: 'sentence that does NOT appear', explanation: '...' })),
      { currentValue: 'Real existing rule.', newValue: 'New.', area: 'pricing_guidance' },
    );
    expect(r.verdict).toBe('compatible');
    expect(r.conflictingExcerpt).toBe('');
  });

  it('keeps conflict verdict when excerpt is a true substring', async () => {
    const r = await detectConflict(
      stubCaller(JSON.stringify({ verdict: 'conflict', conflictingExcerpt: 'no trainee cleaners', explanation: 'forbids' })),
      { currentValue: 'Policy: no trainee cleaners on jobs.', newValue: 'Offer trainee cleaners.', area: 'pricing_guidance' },
    );
    expect(r.verdict).toBe('conflict');
    expect(r.conflictingExcerpt).toBe('no trainee cleaners');
    expect(r.fromLlm).toBe(true);
  });

  it('coerces unknown verdict strings to compatible', async () => {
    const r = await detectConflict(
      stubCaller(JSON.stringify({ verdict: 'maybe?', conflictingExcerpt: '', explanation: 'unsure' })),
      { currentValue: 'A.', newValue: 'B.', area: 'business_information' },
    );
    expect(r.verdict).toBe('compatible');
  });
});
