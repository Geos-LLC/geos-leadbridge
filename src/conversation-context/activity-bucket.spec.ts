import {
  ACTIVITY_BUCKETS,
  activityBucketFromThreadContext,
  activityBucketLabel,
  isActivityBucket,
  type ActivityBucket,
} from './activity-bucket';
import { CONVERSATION_STATES } from './conversation-runtime';

describe('activity-bucket — Lead activity badge derivation', () => {
  describe('ACTIVITY_BUCKETS', () => {
    it('exposes exactly the 4 spec values in stable order', () => {
      expect([...ACTIVITY_BUCKETS]).toEqual([
        'engagement',
        'ai_conversation',
        'follow_up',
        'human_handoff',
      ]);
    });
  });

  describe('isActivityBucket', () => {
    it.each(ACTIVITY_BUCKETS)('accepts %s', (b) => {
      expect(isActivityBucket(b)).toBe(true);
    });
    it.each(['', null, undefined, 'engagment', 'AiConversation', 'Follow-up'])(
      'rejects %p', (v: any) => {
        expect(isActivityBucket(v)).toBe(false);
      },
    );
  });

  describe('activityBucketLabel', () => {
    it.each<[ActivityBucket | null | undefined, string | null]>([
      ['engagement',      'Engagement'],
      ['ai_conversation', 'AI Conversation'],
      ['follow_up',       'Follow-up'],
      ['human_handoff',   'Human Handoff'],
      [null,              null],
      [undefined,         null],
    ])('labels %s → %s', (input, expected) => {
      expect(activityBucketLabel(input)).toBe(expected);
    });
  });

  describe('activityBucketFromThreadContext — TC value mapping (Lead.status = "engaged")', () => {
    const LEAD = 'engaged';
    it.each<[string, ActivityBucket | null]>([
      ['new',                'engagement'],
      ['ai_engaging',        'ai_conversation'],
      ['awaiting_customer',  'follow_up'],
      ['deferred',           'follow_up'],
      ['long_silent',        'follow_up'],
      ['customer_replied',   'human_handoff'],
      ['human_handling',     'human_handoff'],
      ['closed',             null],
      ['opted_out',          null],
      ['hired_elsewhere',    null],
      ['booked_in_lb',       null],
    ])('TC=%s on engaged lead → %s', (tc, expected) => {
      expect(activityBucketFromThreadContext(tc, LEAD)).toBe(expected);
    });
  });

  describe('terminal Lead.status suppresses the badge regardless of TC', () => {
    const TERMINALS = ['booked', 'completed', 'lost', 'cancelled', 'no_show', 'archived'];
    it.each(TERMINALS)('Lead.status=%s → null (no badge)', (s) => {
      // Even if TC says ai_engaging or human_handling, terminal status wins
      for (const tc of CONVERSATION_STATES) {
        expect(activityBucketFromThreadContext(tc, s)).toBeNull();
      }
      expect(activityBucketFromThreadContext(null, s)).toBeNull();
    });
  });

  describe('null / missing TC fallbacks', () => {
    it('null TC + Lead.status=new → engagement (cold lead, no conversation yet)', () => {
      expect(activityBucketFromThreadContext(null, 'new')).toBe('engagement');
      expect(activityBucketFromThreadContext(undefined, 'new')).toBe('engagement');
    });
    it('null TC + Lead.status=engaged → engagement (fallback; PR may refine)', () => {
      expect(activityBucketFromThreadContext(null, 'engaged')).toBe('engagement');
    });
    it('empty-string TC treated as null', () => {
      expect(activityBucketFromThreadContext('', 'engaged')).toBe('engagement');
    });
  });

  describe('case + whitespace robustness', () => {
    it.each([
      ['  ENGAGED  '],
      ['Engaged'],
      ['engaged'],
    ])('Lead.status %p is matched terminal-check case-insensitively', (s) => {
      // 'engaged' is NOT terminal — should still produce a bucket
      expect(activityBucketFromThreadContext('ai_engaging', s)).toBe('ai_conversation');
    });
    it.each([
      ['  BOOKED  '],
      ['Booked'],
      ['booked'],
    ])('Lead.status %p is detected as terminal case-insensitively', (s) => {
      expect(activityBucketFromThreadContext('ai_engaging', s)).toBeNull();
    });
  });

  describe('unknown TC vocabulary defaults to engagement (safest fallback)', () => {
    it('unknown TC value on active lead → engagement', () => {
      expect(activityBucketFromThreadContext('some_future_value', 'engaged')).toBe('engagement');
    });
  });

  // 2026-06-11 — Handoff badge audit (Mario Evans incident). Without signals
  // the legacy state-only mapping projects 'human_handling' → 'human_handoff'
  // forever. With signals, the badge must represent CURRENT pending operator
  // action, not historical classifier output.
  describe('human_handoff freshness + resolution guards (signals provided)', () => {
    const T = (iso: string) => new Date(iso);

    it('human_handling + no outbound after customer → human_handoff (Mario)', () => {
      // Customer's TT-relay "Hello" landed at 20:15. Last AI reply was 19:56.
      // Customer is ahead → badge stays.
      const b = activityBucketFromThreadContext('human_handling', 'engaged', {
        lastCustomerMessageAt: T('2026-06-10T20:15:06Z'),
        lastBusinessMessageAt: null,
        lastAiMessageAt:       T('2026-06-10T19:56:00Z'),
        handoffRequestedAt:    null,
        handoffResolvedAt:     null,
      });
      expect(b).toBe('human_handoff');
    });

    it('human_handling + business outbound after customer → follow_up (operator already replied)', () => {
      const b = activityBucketFromThreadContext('human_handling', 'engaged', {
        lastCustomerMessageAt: T('2026-06-10T20:15:06Z'),
        lastBusinessMessageAt: T('2026-06-10T20:30:00Z'),
        lastAiMessageAt:       null,
        handoffRequestedAt:    null,
        handoffResolvedAt:     null,
      });
      expect(b).toBe('follow_up');
    });

    it('customer_replied + AI outbound after customer → follow_up (AI already replied)', () => {
      const b = activityBucketFromThreadContext('customer_replied', 'engaged', {
        lastCustomerMessageAt: T('2026-06-10T20:15:06Z'),
        lastBusinessMessageAt: null,
        lastAiMessageAt:       T('2026-06-10T20:16:30Z'),
        handoffRequestedAt:    null,
        handoffResolvedAt:     null,
      });
      expect(b).toBe('follow_up');
    });

    it('handoffResolvedAt > handoffRequestedAt → follow_up (handoff resolved)', () => {
      // Customer is ahead of outbound, BUT handoff was explicitly resolved.
      const b = activityBucketFromThreadContext('human_handling', 'engaged', {
        lastCustomerMessageAt: T('2026-06-10T20:15:06Z'),
        lastBusinessMessageAt: null,
        lastAiMessageAt:       T('2026-06-10T19:56:00Z'),
        handoffRequestedAt:    T('2026-06-10T19:58:00Z'),
        handoffResolvedAt:     T('2026-06-10T20:00:00Z'),
      });
      expect(b).toBe('follow_up');
    });

    it('handoffResolvedAt == handoffRequestedAt → follow_up (resolved-at-request edge)', () => {
      const sameTs = T('2026-06-10T20:00:00Z');
      const b = activityBucketFromThreadContext('human_handling', 'engaged', {
        lastCustomerMessageAt: T('2026-06-10T20:15:06Z'),
        lastAiMessageAt:       T('2026-06-10T19:56:00Z'),
        handoffRequestedAt:    sameTs,
        handoffResolvedAt:     sameTs,
      });
      expect(b).toBe('follow_up');
    });

    it('handoff re-requested AFTER prior resolution → human_handoff', () => {
      // requestedAt > resolvedAt → unresolved again.
      const b = activityBucketFromThreadContext('human_handling', 'engaged', {
        lastCustomerMessageAt: T('2026-06-10T21:30:00Z'),
        lastAiMessageAt:       T('2026-06-10T19:56:00Z'),
        handoffRequestedAt:    T('2026-06-10T21:00:00Z'),
        handoffResolvedAt:     T('2026-06-10T20:00:00Z'),
      });
      expect(b).toBe('human_handoff');
    });

    it.each(['booked', 'completed', 'lost', 'cancelled', 'no_show', 'archived'])(
      'terminal Lead.status=%s suppresses badge even with fresh customer message',
      (s) => {
        const b = activityBucketFromThreadContext('human_handling', s, {
          lastCustomerMessageAt: T('2026-06-10T20:15:06Z'),
          lastAiMessageAt:       T('2026-06-10T19:56:00Z'),
        });
        expect(b).toBeNull();
      },
    );

    it('null lastCustomerMessageAt with any outbound → follow_up (no fresh customer signal)', () => {
      // Degenerate: TC says human_handling but no message timestamps. Without
      // a customer-side signal we can't claim pending operator action.
      const b = activityBucketFromThreadContext('human_handling', 'engaged', {
        lastCustomerMessageAt: null,
        lastAiMessageAt:       T('2026-06-10T19:56:00Z'),
      });
      expect(b).toBe('follow_up');
    });

    it('non-handoff buckets unaffected by signals (ai_engaging stays ai_conversation)', () => {
      // Guards should ONLY apply to human_handoff candidates.
      const b = activityBucketFromThreadContext('ai_engaging', 'engaged', {
        lastCustomerMessageAt: T('2026-06-10T20:15:06Z'),
        lastAiMessageAt:       T('2026-06-10T19:56:00Z'),
        handoffResolvedAt:     T('2026-06-10T20:00:00Z'),
      });
      expect(b).toBe('ai_conversation');
    });

    it('signals omitted → legacy state-only mapping (Mario before this fix)', () => {
      // Backward-compat: callers without signal data get the old behavior.
      // Analytics aggregates exercise this path.
      const b = activityBucketFromThreadContext('human_handling', 'engaged');
      expect(b).toBe('human_handoff');
    });
  });

  describe('production sample — Active pool (930 leads) sub-bucket projection', () => {
    // Mirrors §7 of the audit: distribution of active leads by TC.
    // Demonstrates that the derivation produces the expected counts.
    const samples = [
      { tc: 'ai_engaging',       status: 'engaged', count: 151, expect: 'ai_conversation' as const },
      { tc: 'awaiting_customer', status: 'new',     count: 219, expect: 'follow_up'        as const },
      { tc: 'customer_replied',  status: 'new',     count: 211, expect: 'human_handoff'    as const },
      { tc: 'human_handling',    status: 'engaged', count: 21,  expect: 'human_handoff'    as const },
      { tc: 'deferred',          status: 'engaged', count: 1,   expect: 'follow_up'        as const },
      { tc: null,                status: 'new',     count: 143, expect: 'engagement'       as const },
      { tc: null,                status: 'engaged', count: 184, expect: 'engagement'       as const },
    ];
    let totals = { engagement: 0, ai_conversation: 0, follow_up: 0, human_handoff: 0 };
    for (const s of samples) {
      const b = activityBucketFromThreadContext(s.tc, s.status);
      if (b) totals[b] += s.count;
      it(`tc=${s.tc} status=${s.status} → ${s.expect}`, () => {
        expect(b).toBe(s.expect);
      });
    }
    it('aggregate totals match the audit projection', () => {
      // Recompute (it.each above already evaluated)
      const recompute = { engagement: 0, ai_conversation: 0, follow_up: 0, human_handoff: 0 };
      for (const s of samples) {
        const b = activityBucketFromThreadContext(s.tc, s.status);
        if (b) recompute[b] += s.count;
      }
      expect(recompute).toEqual({
        ai_conversation: 151,
        follow_up:       220,  // awaiting_customer 219 + deferred 1
        human_handoff:   232,  // customer_replied 211 + human_handling 21
        engagement:      327,  // null-TC fallback: 143 + 184
      });
    });
  });
});
