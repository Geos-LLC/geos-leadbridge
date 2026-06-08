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
      expect(r).toEqual({
        active: 0, won: 0, lost: 0, total: 0,
        conversionRate: null, activeLeadRate: null,
      });
    });

    it('matches the production sample (snapshot 2026-06-08 pre-migration)', () => {
      // Production status distribution at the time the spec was written.
      // After migration, contacted→engaged + scheduled→booked, but the
      // resulting Conversion Rate is unchanged (the migration collapses
      // synonyms within the same outcome class).
      const r = computeOutcomeBreakdown([
        { status: 'new',       count: 758 },
        { status: 'contacted', count: 88  }, // legacy synonym for engaged
        { status: 'engaged',   count: 73  },
        { status: 'booked',    count: 11  },
        { status: 'scheduled', count: 4   }, // legacy synonym for booked
        { status: 'completed', count: 260 },
        { status: 'lost',      count: 1151 },
        { status: 'cancelled', count: 42  },
      ]);
      const active = 758 + 88 + 73;       // 919
      const won    = 11 + 4 + 260;        // 275
      const lost   = 1151 + 42;           // 1193
      const total  = active + won + lost; // 2387
      const resolved = won + lost;        // 1468
      expect(r.active).toBe(active);
      expect(r.won).toBe(won);
      expect(r.lost).toBe(lost);
      expect(r.total).toBe(total);
      expect(r.conversionRate).toBeCloseTo((won / resolved) * 100, 4);
      expect(r.activeLeadRate).toBeCloseTo((active / total) * 100, 4);
      // Sanity check on the absolute numbers the spec author was looking at:
      expect(r.conversionRate).toBeCloseTo(18.7, 1);
      expect(r.activeLeadRate).toBeCloseTo(38.5, 1);
    });

    it('drops unknown statuses from the won/active/lost split (does not silently absorb)', () => {
      const r = computeOutcomeBreakdown([
        { status: 'booked', count: 5 },
        { status: 'lost',   count: 5 },
        { status: 'made_up_status', count: 99 }, // unknown — excluded
      ]);
      expect(r.won).toBe(5);
      expect(r.lost).toBe(5);
      expect(r.active).toBe(0);
      expect(r.total).toBe(10);                  // unknown NOT counted in total
      expect(r.conversionRate).toBe(50);
      expect(r.activeLeadRate).toBe(0);
    });

    it('Conversion Rate denominator excludes active leads (spec rule 4A)', () => {
      // 100 active, 10 won, 5 lost
      const r = computeOutcomeBreakdown([
        { status: 'new',     count: 100 },
        { status: 'booked',  count: 10 },
        { status: 'lost',    count: 5 },
      ]);
      // Conversion Rate should be 10 / (10 + 5) = 66.7%, not 10/115 ≈ 8.7%.
      expect(r.conversionRate).toBeCloseTo(66.67, 1);
      // Active Lead Rate should be 100 / 115 ≈ 87.0%
      expect(r.activeLeadRate).toBeCloseTo(86.96, 1);
    });

    it('returns null Conversion Rate when there are zero resolved leads', () => {
      const r = computeOutcomeBreakdown([{ status: 'new', count: 50 }]);
      expect(r.conversionRate).toBeNull();
      expect(r.activeLeadRate).toBe(100);
    });
  });

  describe('statusDisplayLabel', () => {
    it.each([
      ['new',         'New'],
      ['engaged',     'Engaged'],
      ['contacted',   'Engaged'],   // legacy-safe label
      ['quoted',      'Quoted'],
      ['in_progress', 'In progress'],
      ['booked',      'Booked'],
      ['scheduled',   'Booked'],    // legacy-safe label
      ['completed',   'Completed'],
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
