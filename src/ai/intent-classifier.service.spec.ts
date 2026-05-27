/**
 * Classifier vocabulary lock — no LLM call.
 *
 * The classifier's behavior is best validated by integration tests against
 * real OpenAI responses, which we don't run in unit tests. This spec
 * locks the *vocabulary* shape: the new wants_to_schedule intent is
 * (a) listed in the allowlist, (b) recognized by the coercer,
 * (c) documented in the SYSTEM_PROMPT, and (d) disjoint from existing
 * intents that have load-bearing downstream handlers.
 */

import { ConfigService } from '@nestjs/config';
import { IntentClassifierService, type CustomerIntent } from './intent-classifier.service';

function buildService(): IntentClassifierService {
  // We only exercise the coerceIntent helper here — no LLM call — so a
  // stub ConfigService is fine.
  const cfg = { get: () => undefined } as unknown as ConfigService;
  return new IntentClassifierService(cfg);
}

describe('IntentClassifierService — wants_to_schedule intent (Phase 2B)', () => {
  let svc: IntentClassifierService;
  beforeEach(() => { svc = buildService(); });

  describe('coerceIntent allowlist', () => {
    // Reach in via `as any` — coerceIntent is private but we want to lock
    // the allowlist without exposing it to production code.
    const coerce = (s: string): CustomerIntent | null => (svc as any).coerceIntent(s);

    it('accepts wants_to_schedule', () => {
      expect(coerce('wants_to_schedule')).toBe('wants_to_schedule');
    });

    it('still accepts every existing intent (no regression)', () => {
      const existing: CustomerIntent[] = [
        'opt_out',
        'hired_elsewhere',
        'completed',
        'agreed',
        'wants_live_contact',
        'deferring',
        'terminal_defer',
        'asking',
        'engaged',
      ];
      for (const i of existing) {
        expect(coerce(i)).toBe(i);
      }
    });

    it('rejects unknown strings', () => {
      expect(coerce('book_it')).toBeNull();
      expect(coerce('schedule_me')).toBeNull();
      expect(coerce('')).toBeNull();
    });

    it('rejects close-but-wrong variants', () => {
      // Surface common LLM hallucinations so the allowlist stays tight.
      expect(coerce('want_to_schedule')).toBeNull();
      expect(coerce('schedule')).toBeNull();
      expect(coerce('booking')).toBeNull();
    });
  });

  describe('SYSTEM_PROMPT documents the new intent', () => {
    // Lock that the prompt mentions wants_to_schedule with at least one
    // example and the distinction-from-wants_live_contact clause. If
    // someone removes the prompt section by accident, this fails.
    it('mentions wants_to_schedule by name', () => {
      const src = require('fs').readFileSync(require.resolve('./intent-classifier.service'), 'utf8');
      expect(src).toMatch(/wants_to_schedule/);
    });

    it('contains the distinction-from-wants_live_contact phrasing', () => {
      const src = require('fs').readFileSync(require.resolve('./intent-classifier.service'), 'utf8');
      // Wording from the SYSTEM_PROMPT — adjust both sides together.
      expect(src).toMatch(/Distinguish from 'wants_live_contact'/);
    });

    it('contains the "ALSO set handoff" backward-compat instruction', () => {
      // Critical safety property: even when flag is OFF and the booking
      // orchestrator does nothing, dispatchers must still get paged on
      // committal phrasing. Locked here so the prompt edit cannot drop
      // this clause silently.
      const src = require('fs').readFileSync(require.resolve('./intent-classifier.service'), 'utf8');
      expect(src).toMatch(/ALSO set handoff\.shouldHandoff=true/);
    });
  });
});
