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

    it('documents the holding-vs-farewell distinction for bare acks (Elda Wells regression)', () => {
      // Locks the prompt section that addresses the Elda case so a future
      // simplification can't silently re-introduce "bare ok after holding
      // == completed".
      const src = require('fs').readFileSync(require.resolve('./intent-classifier.service'), 'utf8');
      expect(src).toMatch(/HOLDING message where WE owe the customer follow-up/);
      expect(src).toMatch(/NEVER 'completed' \/ 'hired_elsewhere' in this case/);
    });
  });
});

// ─── Bare-acknowledgement safety override (Elda Wells regression) ───────────
//
// Reproduces the production incident on lead 23e6827b-…:
//   AI: "I'll check timing and confirm shortly."
//   Customer: "Ok."
//   Previous classifier behavior: completed → hired_someone → lost.
//   Correct behavior: engaged (customer is waiting on us).
//
// The fix is two layers — prompt change (validated above) + a deterministic
// post-LLM override (validated here, no LLM call needed because the override
// is pure logic).

describe('IntentClassifierService — bare-ack-after-holding safety override', () => {
  // Direct unit tests on the static helpers — they're the load-bearing
  // pieces of the override, so we lock their input space tightly.

  describe('isBareAcknowledgement', () => {
    const isBare = (s: string) => IntentClassifierService.isBareAcknowledgement(s);

    it('matches the canonical bare tokens (case + punctuation insensitive)', () => {
      const yes = [
        'Ok.', 'OK', 'ok', 'okay', 'Okay!',
        'Thanks', 'thanks.', 'Thank you', 'Thank you.', 'thx', 'ty',
        'Got it', 'got it.', 'gotit',
        'Sounds good', 'cool', 'great', 'awesome',
        'k', 'kk',
      ];
      for (const m of yes) expect(isBare(m)).toBe(true);
    });

    it('rejects messages that add semantic content', () => {
      const no = [
        'Ok thanks I will wait',
        'Thanks but I went with someone else',
        'Ok but how much is it',
        'Got it — what time?',
        'Thanks for checking, I already hired another company',
        'Cool, send me a quote',
        // empty / whitespace / nonsense
        '', '   ', '?',
      ];
      for (const m of no) expect(isBare(m)).toBe(false);
    });
  });

  describe('isHoldingMessage', () => {
    const isHold = (s: string) => IntentClassifierService.isHoldingMessage(s);

    it('matches AI holding/follow-up-owed phrasings', () => {
      const yes = [
        "I'll check timing and confirm shortly.",
        "Let me confirm with my team and get back to you.",
        "I'll get back to you in a few hours.",
        "Checking the calendar — one sec.",
        "I'll confirm timing shortly.",
        "Waiting for confirmation from the office, will let you know.",
        "I'll be in touch once I hear back.",
        "Let me check availability and reply.",
      ];
      for (const m of yes) expect(isHold(m)).toBe(true);
    });

    it('does not match farewell / closure messages', () => {
      const no = [
        "Thanks for considering us, have a great day!",
        "Best of luck on your project.",
        "Feel free to reach out if you change your mind.",
        "What day works best for you?",
        "Our rate is $250 for a deep clean.",
        "",
      ];
      for (const m of no) expect(isHold(m)).toBe(false);
    });
  });

  describe('lastAiMessage + isLeadTerminal', () => {
    it('returns most-recent pro message regardless of history order', () => {
      const h = [
        { role: 'customer' as const, content: 'hi' },
        { role: 'pro' as const, content: 'first ai' },
        { role: 'customer' as const, content: 'ok' },
        { role: 'pro' as const, content: 'second ai' },
      ];
      expect(IntentClassifierService.lastAiMessage(h)).toBe('second ai');
    });

    it('returns null on empty history', () => {
      expect(IntentClassifierService.lastAiMessage([])).toBeNull();
      expect(IntentClassifierService.lastAiMessage(undefined)).toBeNull();
    });

    it('flags only the documented terminal statuses', () => {
      expect(IntentClassifierService.isLeadTerminal('lost')).toBe(true);
      expect(IntentClassifierService.isLeadTerminal('cancelled')).toBe(true);
      expect(IntentClassifierService.isLeadTerminal('archived')).toBe(true);
      expect(IntentClassifierService.isLeadTerminal('no_show')).toBe(true);
      expect(IntentClassifierService.isLeadTerminal('engaged')).toBe(false);
      expect(IntentClassifierService.isLeadTerminal('contacted')).toBe(false);
      expect(IntentClassifierService.isLeadTerminal('booked')).toBe(false);
      expect(IntentClassifierService.isLeadTerminal('completed')).toBe(false); // completed != terminal-for-rescue
      expect(IntentClassifierService.isLeadTerminal(undefined)).toBe(false);
    });
  });

  // The 5 user-spec scenarios, each composed from the helpers above. These
  // test the combined predicate that the override uses:
  //   override applies iff
  //     intent ∈ {completed, hired_elsewhere}
  //     AND isBareAcknowledgement(customer message)
  //     AND isHoldingMessage(last ai message)
  //     AND !isLeadTerminal(lead.status)
  //
  // We don't make the LLM call (private + paid + flaky); we exercise the
  // composed gate the override implements.

  function overrideTriggers(opts: {
    aiSaid: string;
    customerSaid: string;
    leadStatus?: string;
    initialIntent?: CustomerIntent;
  }): boolean {
    const intent = opts.initialIntent ?? 'completed';
    if (!(intent === 'completed' || intent === 'hired_elsewhere')) return false;
    if (!IntentClassifierService.isBareAcknowledgement(opts.customerSaid)) return false;
    if (!IntentClassifierService.isHoldingMessage(opts.aiSaid)) return false;
    if (IntentClassifierService.isLeadTerminal(opts.leadStatus)) return false;
    return true;
  }

  it("Scenario 1 — AI 'I'll check and confirm shortly', customer 'Ok.' → no transition (override fires)", () => {
    expect(overrideTriggers({
      aiSaid: "I'll check and confirm shortly",
      customerSaid: 'Ok.',
      leadStatus: 'engaged',
    })).toBe(true);
  });

  it("Scenario 2 — AI 'I'll confirm timing', customer 'Thanks' → no transition (override fires)", () => {
    expect(overrideTriggers({
      aiSaid: "I'll confirm timing with the team and get back to you.",
      customerSaid: 'Thanks',
      leadStatus: 'engaged',
    })).toBe(true);
  });

  it("Scenario 3 — explicit 'I hired someone else' → still maps to lost / hired_someone (override does NOT fire)", () => {
    // The override only catches BARE acks. "I hired someone else" is not a
    // bare ack — it adds explicit semantic content. So the classifier's
    // intent stands.
    expect(overrideTriggers({
      aiSaid: "I'll check and confirm shortly",
      customerSaid: 'Thanks but I hired someone else',
      leadStatus: 'engaged',
      initialIntent: 'hired_elsewhere',
    })).toBe(false);
  });

  it("Scenario 4 — 'No thanks, I found another cleaner' → still maps to lost (override does NOT fire)", () => {
    expect(overrideTriggers({
      aiSaid: "I'll confirm timing and get back to you.",
      customerSaid: 'No thanks, I found another cleaner',
      leadStatus: 'engaged',
      initialIntent: 'hired_elsewhere',
    })).toBe(false);
  });

  it("Scenario 5 — bare 'ok' on already-terminal lead → override does NOT fire (rescue would be wrong)", () => {
    expect(overrideTriggers({
      aiSaid: "I'll check and confirm shortly",
      customerSaid: 'Ok.',
      leadStatus: 'lost',
    })).toBe(false);
    expect(overrideTriggers({
      aiSaid: "I'll check and confirm shortly",
      customerSaid: 'Ok.',
      leadStatus: 'archived',
    })).toBe(false);
  });

  it('Scenario 5b — bare ok after a farewell-shape AI message → override does NOT fire (LLM completed is correct)', () => {
    expect(overrideTriggers({
      aiSaid: 'Thanks for considering us, have a great day!',
      customerSaid: 'Ok thanks',
      leadStatus: 'engaged',
    })).toBe(false);
  });

  it('Scenario 5c — Elda Wells exact reproduction (lead 23e6827b)', () => {
    expect(overrideTriggers({
      aiSaid: "I'll check timing and confirm shortly.",
      customerSaid: 'Ok.',
      leadStatus: 'engaged',
    })).toBe(true);
  });
});
