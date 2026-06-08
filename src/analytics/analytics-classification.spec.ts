/**
 * Regression tests for the 2026-06-08 status simplification.
 *
 * Pins the canonical Lead.status → outcome-class mapping that drives the
 * Conversion Rate (won / (won + lost)) and Active Lead Rate (active / total)
 * KPIs. Future refactors must not silently re-classify a status — these
 * tests will catch the drift.
 *
 * See plans/status-simplification-2026-06-08.md and Lead.status spec.
 */

import {
  classifyStatus,
  computeOutcomeBreakdown,
  statusDisplayLabel,
  statusBucketLabel,
  ACTIVE_STATUSES,
  WON_STATUSES,
  LOST_STATUSES,
} from './analytics.service';

describe('analytics status classification (2026-06-08)', () => {
  describe('classifyStatus — canonical Lead.status', () => {
    // Target production statuses
    it('classifies target production statuses correctly', () => {
      expect(classifyStatus('new')).toBe('active');
      expect(classifyStatus('engaged')).toBe('active');
      expect(classifyStatus('booked')).toBe('won');
      expect(classifyStatus('completed')).toBe('won');
      expect(classifyStatus('lost')).toBe('lost');
      expect(classifyStatus('cancelled')).toBe('lost');
    });

    // Legal-but-inactive statuses must route explicitly — not default to lost
    it('classifies legal-but-inactive statuses explicitly (never default to lost)', () => {
      expect(classifyStatus('quoted')).toBe('active');
      expect(classifyStatus('in_progress')).toBe('active');
      expect(classifyStatus('no_show')).toBe('lost');
      expect(classifyStatus('archived')).toBe('lost');
    });

    // Legacy-safe synonyms — pre-2026-06-08 values must still classify correctly
    it('handles legacy-safe synonyms (contacted, scheduled) after migration window', () => {
      expect(classifyStatus('contacted')).toBe('active'); // legacy synonym for engaged
      expect(classifyStatus('scheduled')).toBe('won');     // legacy synonym for booked
    });

    it('is case + whitespace insensitive', () => {
      expect(classifyStatus('NEW')).toBe('active');
      expect(classifyStatus('  booked  ')).toBe('won');
      expect(classifyStatus('Lost')).toBe('lost');
    });

    it('returns unknown for unknown / nullish / empty values', () => {
      expect(classifyStatus(null)).toBe('unknown');
      expect(classifyStatus(undefined)).toBe('unknown');
      expect(classifyStatus('')).toBe('unknown');
      expect(classifyStatus('imaginary')).toBe('unknown');
    });
  });

  describe('classification sets do not overlap', () => {
    it('no status appears in more than one set', () => {
      const all = [...ACTIVE_STATUSES, ...WON_STATUSES, ...LOST_STATUSES];
      const dedup = new Set(all);
      expect(all.length).toBe(dedup.size);
    });
  });

  describe('computeOutcomeBreakdown', () => {
    it('produces zeros + null rates on empty input', () => {
      const r = computeOutcomeBreakdown([]);
      expect(r).toMatchObject({
        active: 0, scheduled: 0, done: 0, won: 0, lost: 0, cancelled: 0, total: 0,
        hireRate: null, conversionRate: null,
        activeRate: null, activeLeadRate: null,
      });
    });

    it('matches the production sample (post-migration distribution, marketplace buckets)', () => {
      const r = computeOutcomeBreakdown([
        { status: 'new',       count: 763 },
        { status: 'engaged',   count: 162 },
        { status: 'booked',    count: 15  },
        { status: 'completed', count: 260 },
        { status: 'lost',      count: 1151 },
        { status: 'cancelled', count: 42  },
      ]);
      expect(r.active).toBe(925);     // new + engaged
      expect(r.scheduled).toBe(15);   // booked
      expect(r.done).toBe(260);       // completed
      expect(r.won).toBe(275);        // scheduled + done
      expect(r.lost).toBe(1151);
      expect(r.cancelled).toBe(42);
      expect(r.total).toBe(2393);
      // Hire Rate = won / (won + lost + cancelled) = 275 / 1468
      expect(r.hireRate).toBeCloseTo(18.73, 1);
      expect(r.conversionRate).toBe(r.hireRate);     // alias
      expect(r.activeRate).toBeCloseTo(38.65, 1);    // 925 / 2393
      expect(r.activeLeadRate).toBe(r.activeRate);   // alias
    });

    it('legacy-safe synonyms collapse correctly (contacted→active, scheduled-canonical→scheduled bucket)', () => {
      const r = computeOutcomeBreakdown([
        { status: 'contacted', count: 88 }, // legacy → Active
        { status: 'engaged',   count: 74 },
        { status: 'scheduled', count: 4  }, // legacy → Scheduled bucket (alongside booked)
        { status: 'booked',    count: 11 },
      ]);
      expect(r.active).toBe(88 + 74);
      expect(r.scheduled).toBe(4 + 11);
      expect(r.won).toBe(15);
    });

    it('drops unknown statuses from the breakdown (does not silently absorb)', () => {
      const r = computeOutcomeBreakdown([
        { status: 'booked', count: 5 },
        { status: 'lost',   count: 5 },
        { status: 'made_up_status', count: 99 }, // unknown — excluded
      ]);
      expect(r.scheduled).toBe(5);
      expect(r.lost).toBe(5);
      expect(r.cancelled).toBe(0);
      expect(r.active).toBe(0);
      expect(r.total).toBe(10);                  // unknown NOT counted in total
      expect(r.hireRate).toBe(50);
      expect(r.activeRate).toBe(0);
    });

    it('Hire Rate denominator includes lost + cancelled but excludes active', () => {
      // 100 active, 10 booked, 5 lost, 5 cancelled
      const r = computeOutcomeBreakdown([
        { status: 'new',       count: 100 },
        { status: 'booked',    count: 10 },
        { status: 'lost',      count: 5 },
        { status: 'cancelled', count: 5 },
      ]);
      // Hire Rate = 10 / (10 + 5 + 5) = 50%
      expect(r.hireRate).toBeCloseTo(50.0, 4);
      // Active Rate = 100 / 120 ≈ 83.3%
      expect(r.activeRate).toBeCloseTo(83.33, 1);
    });

    it('returns null Hire Rate when there are zero resolved leads', () => {
      const r = computeOutcomeBreakdown([{ status: 'new', count: 50 }]);
      expect(r.hireRate).toBeNull();
      expect(r.conversionRate).toBeNull();
      expect(r.activeRate).toBe(100);
    });
  });

  describe('statusBucketLabel — analytics 5-bucket aggregation', () => {
    it.each([
      // Active bucket — granular pipeline statuses collapsed
      ['new',         'Active'],
      ['engaged',     'Active'],
      ['contacted',   'Active'],   // legacy
      ['quoted',      'Active'],
      ['in_progress', 'Active'],
      // Scheduled bucket
      ['booked',      'Scheduled'],
      ['scheduled',   'Scheduled'], // legacy
      // Done bucket
      ['completed',   'Done'],
      // Cancelled is its own bucket (separated from Lost)
      ['cancelled',   'Cancelled'],
      // Lost bucket — terminal-not-won
      ['lost',        'Lost'],
      ['no_show',     'Lost'],
      ['archived',    'Lost'],
    ])('%s → %s', (s, bucket) => {
      expect(statusBucketLabel(s)).toBe(bucket);
    });

    it('returns Unknown for nullish / empty / unknown', () => {
      expect(statusBucketLabel(null)).toBe('Unknown');
      expect(statusBucketLabel(undefined)).toBe('Unknown');
      expect(statusBucketLabel('')).toBe('Unknown');
      expect(statusBucketLabel('imaginary')).toBe('Unknown');
    });
  });

  describe('statusDisplayLabel (granular per-lead pill labels)', () => {
    it.each([
      // Marketplace terminology — booked surfaces as "Scheduled",
      // completed as "Done". new/engaged keep granular labels for the
      // conversation view (analytics aggregates them via statusBucketLabel).
      ['new',         'New'],
      ['engaged',     'Engaged'],
      ['contacted',   'Engaged'],     // legacy-safe label
      ['quoted',      'Quoted'],
      ['in_progress', 'In progress'],
      ['booked',      'Scheduled'],
      ['scheduled',   'Scheduled'],   // legacy-safe label
      ['completed',   'Done'],
      ['lost',        'Lost'],
      ['cancelled',   'Cancelled'],
      ['no_show',     'No show'],
      ['archived',    'Archived'],
    ])('labels %s → %s', (canonical, expected) => {
      expect(statusDisplayLabel(canonical)).toBe(expected);
    });

    it('returns Unknown for nullish / empty', () => {
      expect(statusDisplayLabel(null)).toBe('Unknown');
      expect(statusDisplayLabel(undefined)).toBe('Unknown');
      expect(statusDisplayLabel('')).toBe('Unknown');
    });
  });
});
