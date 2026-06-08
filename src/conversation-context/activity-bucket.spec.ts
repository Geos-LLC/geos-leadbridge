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

  describe('stale-state override (timestamp-aware refinement)', () => {
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

    it('customer_replied + business message NEWER than customer → follow_up (stale)', () => {
      expect(activityBucketFromThreadContext('customer_replied', 'engaged', {
        lastCustomerMessageAt: minutesAgo(60),
        lastBusinessMessageAt: minutesAgo(10),
        lastAiMessageAt:       null,
      })).toBe('follow_up');
    });

    it('customer_replied + AI message NEWER than customer → ai_conversation (stale)', () => {
      expect(activityBucketFromThreadContext('customer_replied', 'engaged', {
        lastCustomerMessageAt: minutesAgo(60),
        lastBusinessMessageAt: null,
        lastAiMessageAt:       minutesAgo(5),
      })).toBe('ai_conversation');
    });

    it('customer_replied + both AI and business newer, AI most recent → ai_conversation', () => {
      expect(activityBucketFromThreadContext('customer_replied', 'new', {
        lastCustomerMessageAt: minutesAgo(60),
        lastBusinessMessageAt: minutesAgo(30),
        lastAiMessageAt:       minutesAgo(5),
      })).toBe('ai_conversation');
    });

    it('customer_replied + customer message IS the latest → human_handoff (truly waiting)', () => {
      expect(activityBucketFromThreadContext('customer_replied', 'engaged', {
        lastCustomerMessageAt: minutesAgo(2),
        lastBusinessMessageAt: minutesAgo(30),
        lastAiMessageAt:       minutesAgo(60),
      })).toBe('human_handoff');
    });

    it('human_handling + business message newer → follow_up (stale handoff)', () => {
      expect(activityBucketFromThreadContext('human_handling', 'engaged', {
        lastCustomerMessageAt: minutesAgo(120),
        lastBusinessMessageAt: minutesAgo(20),
        lastAiMessageAt:       null,
      })).toBe('follow_up');
    });

    it('Macy McDaniel prod sample — TC=human_handling, manual reply newer → follow_up', () => {
      // Mirrors the 6be837bf row: customer 2026-05-27, business 2026-06-07.
      expect(activityBucketFromThreadContext('human_handling', 'engaged', {
        lastCustomerMessageAt: new Date('2026-05-27T16:21:32Z'),
        lastBusinessMessageAt: new Date('2026-06-07T16:20:01Z'),
        lastAiMessageAt:       new Date('2026-05-27T16:22:12Z'),
      })).toBe('follow_up');
    });

    it('Indya Campbell prod sample — TC=customer_replied, manual reply newer → follow_up', () => {
      // Mirrors the b584f42c row.
      expect(activityBucketFromThreadContext('customer_replied', 'new', {
        lastCustomerMessageAt: new Date('2026-05-26T19:09:14Z'),
        lastBusinessMessageAt: new Date('2026-06-07T16:19:29Z'),
        lastAiMessageAt:       new Date('2026-05-26T19:09:58Z'),
      })).toBe('follow_up');
    });

    it('override does NOT apply when no customer timestamp is present', () => {
      expect(activityBucketFromThreadContext('customer_replied', 'engaged', {
        lastCustomerMessageAt: null,
        lastBusinessMessageAt: minutesAgo(5),
        lastAiMessageAt:       null,
      })).toBe('human_handoff');
    });

    it('override does NOT apply to ai_engaging / awaiting_customer / others', () => {
      // ai_engaging stays ai_conversation regardless of timestamps
      expect(activityBucketFromThreadContext('ai_engaging', 'engaged', {
        lastCustomerMessageAt: minutesAgo(2),
        lastBusinessMessageAt: minutesAgo(60),
        lastAiMessageAt:       minutesAgo(120),
      })).toBe('ai_conversation');
      // awaiting_customer stays follow_up
      expect(activityBucketFromThreadContext('awaiting_customer', 'engaged', {
        lastCustomerMessageAt: minutesAgo(2),
        lastBusinessMessageAt: minutesAgo(60),
        lastAiMessageAt:       null,
      })).toBe('follow_up');
    });

    it('zero-arg / no-context call behaves identically to pre-refinement (back-compat)', () => {
      expect(activityBucketFromThreadContext('customer_replied', 'engaged')).toBe('human_handoff');
      expect(activityBucketFromThreadContext('human_handling',   'engaged')).toBe('human_handoff');
    });

    it('accepts ISO string + numeric timestamps too', () => {
      expect(activityBucketFromThreadContext('customer_replied', 'engaged', {
        lastCustomerMessageAt: '2026-05-26T19:09:14Z',
        lastBusinessMessageAt: '2026-06-07T16:19:29Z',
        lastAiMessageAt:       null,
      })).toBe('follow_up');
      expect(activityBucketFromThreadContext('customer_replied', 'engaged', {
        lastCustomerMessageAt: 1748286554000,  // older
        lastBusinessMessageAt: 1749312000000,  // newer
        lastAiMessageAt:       null,
      })).toBe('follow_up');
    });
  });

  describe('unknown TC vocabulary defaults to engagement (safest fallback)', () => {
    it('unknown TC value on active lead → engagement', () => {
      expect(activityBucketFromThreadContext('some_future_value', 'engaged')).toBe('engagement');
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
