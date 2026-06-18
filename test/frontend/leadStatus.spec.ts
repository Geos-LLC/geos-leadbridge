/**
 * Frontend lib/leadStatus tests.
 *
 * The frontend has no test framework configured, so we host the spec in the
 * backend jest tree and import the helper via relative path. The helper is
 * pure TypeScript with no React/Vite deps so ts-jest compiles it cleanly.
 *
 * 2026-06-18: rewritten to match the post-consolidation status model.
 * Canonical groups collapsed from 6 → 4 (Active / Scheduled / Done / Lost),
 * with archived/cancelled/no_show folded into Lost, in_progress folded into
 * Active, and 2 pseudo-groups (Refunded / Refundable) bolted onto the
 * filter dropdown. Old IDs ('scheduled'/'done'/'no_hire'/'archived'/
 * 'in_progress') were dropped from `StatusGroupId`.
 */

import {
  STATUS_GROUPS,
  STATUS_FILTER_OPTIONS,
  LEGACY_DISPLAY_MAP,
  displayGroup,
  displayLabel,
  displayPillKind,
  matchesGroupFilter,
} from '../../frontend/src/lib/leadStatus';

describe('STATUS_GROUPS', () => {
  it('exposes the 4 canonical groups in the locked label order', () => {
    expect(STATUS_GROUPS.map((g) => g.label)).toEqual([
      'Active',
      'Scheduled',
      'Done',
      'Lost',
    ]);
  });

  it('Active contains new/engaged/contacted/quoted/in_progress', () => {
    expect(STATUS_GROUPS.find((g) => g.id === 'active')!.statuses).toEqual([
      'new', 'engaged', 'contacted', 'quoted', 'in_progress',
    ]);
  });

  it('Scheduled (id="booked") contains booked + scheduled', () => {
    // id stays 'booked' (canonical Lead.status value); label is "Scheduled".
    expect(STATUS_GROUPS.find((g) => g.id === 'booked')!.statuses).toEqual([
      'booked', 'scheduled',
    ]);
  });

  it('Done (id="completed") contains completed', () => {
    expect(STATUS_GROUPS.find((g) => g.id === 'completed')!.statuses).toEqual([
      'completed',
    ]);
  });

  it('Lost contains lost/cancelled/no_show/archived', () => {
    expect(STATUS_GROUPS.find((g) => g.id === 'lost')!.statuses).toEqual([
      'lost', 'cancelled', 'no_show', 'archived',
    ]);
  });
});

describe('displayGroup', () => {
  const cases: Array<[string, string]> = [
    ['new', 'active'],
    ['contacted', 'active'],
    ['engaged', 'active'],
    ['quoted', 'active'],
    ['in_progress', 'active'],
    ['booked', 'booked'],
    ['scheduled', 'booked'],
    ['completed', 'completed'],
    ['lost', 'lost'],
    ['cancelled', 'lost'],
    ['no_show', 'lost'],
    ['archived', 'lost'],
  ];

  it.each(cases)('maps "%s" -> %s', (status, group) => {
    expect(displayGroup(status)).toBe(group);
  });

  it('returns "unknown" for unknown statuses', () => {
    expect(displayGroup('snoozed')).toBe('unknown');
    expect(displayGroup('')).toBe('unknown');
    expect(displayGroup(null)).toBe('unknown');
    expect(displayGroup(undefined)).toBe('unknown');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(displayGroup('  ENGAGED  ')).toBe('active');
    expect(displayGroup('Booked')).toBe('booked');
  });
});

describe('LEGACY_DISPLAY_MAP', () => {
  it('maps hired -> booked -> "Scheduled"', () => {
    expect(LEGACY_DISPLAY_MAP.hired).toBe('booked');
    expect(displayLabel('hired')).toBe('Scheduled');
  });

  it('maps done -> completed -> "Done"', () => {
    expect(LEGACY_DISPLAY_MAP.done).toBe('completed');
    expect(displayLabel('done')).toBe('Done');
  });

  it('maps "not hired" / not_hired -> lost -> "Lost"', () => {
    expect(LEGACY_DISPLAY_MAP['not hired']).toBe('lost');
    expect(LEGACY_DISPLAY_MAP.not_hired).toBe('lost');
    expect(displayLabel('not hired')).toBe('Lost');
    expect(displayLabel('Not Hired')).toBe('Lost');
  });

  it('maps closed -> lost -> "Lost"', () => {
    expect(LEGACY_DISPLAY_MAP.closed).toBe('lost');
    expect(displayLabel('closed')).toBe('Lost');
  });

  // Legacy values written by pre-canonical creators (webhooks.service.ts upsert
  // path used 'Open' for new leads, conversation creators used 'active'). Both
  // belong in the Active group alongside 'new'.
  it('maps open / active -> new -> "Active"', () => {
    expect(LEGACY_DISPLAY_MAP.open).toBe('new');
    expect(LEGACY_DISPLAY_MAP.active).toBe('new');
    expect(displayLabel('Open')).toBe('Active');
    expect(displayLabel('active')).toBe('Active');
  });

  // Thumbtack Partner API initial states — the inbox-scraping extension lands
  // canonical values later, but until then leads sit on these raw strings.
  it('maps picked -> new -> "Active" (Thumbtack Partner API)', () => {
    expect(LEGACY_DISPLAY_MAP.picked).toBe('new');
    expect(displayLabel('Picked')).toBe('Active');
  });

  it('maps canceled (American) -> cancelled -> "Lost"', () => {
    expect(LEGACY_DISPLAY_MAP.canceled).toBe('cancelled');
    expect(displayLabel('Canceled')).toBe('Lost');
  });
});

describe('displayLabel', () => {
  it('returns the group label for a canonical status', () => {
    expect(displayLabel('engaged')).toBe('Active');
    expect(displayLabel('in_progress')).toBe('Active');
    expect(displayLabel('booked')).toBe('Scheduled');
    expect(displayLabel('completed')).toBe('Done');
    expect(displayLabel('lost')).toBe('Lost');
    expect(displayLabel('archived')).toBe('Lost');
  });

  it('returns "—" for unknown statuses', () => {
    expect(displayLabel('snoozed')).toBe('—');
    expect(displayLabel(null)).toBe('—');
  });
});

describe('displayPillKind', () => {
  it('returns the matching pill kind for a canonical status', () => {
    expect(displayPillKind('engaged')).toBe('active');
    expect(displayPillKind('booked')).toBe('booked');
    expect(displayPillKind('completed')).toBe('completed');
    expect(displayPillKind('lost')).toBe('lost');
  });

  it('falls back to neutral for unknown', () => {
    expect(displayPillKind('snoozed')).toBe('neutral');
    expect(displayPillKind(null)).toBe('neutral');
  });
});

describe('matchesGroupFilter', () => {
  it('matches all canonical statuses in their group', () => {
    expect(matchesGroupFilter('engaged', 'active')).toBe(true);
    expect(matchesGroupFilter('booked', 'booked')).toBe(true);
    expect(matchesGroupFilter('lost', 'lost')).toBe(true);
  });

  it('rejects mismatches', () => {
    expect(matchesGroupFilter('engaged', 'lost')).toBe(false);
    expect(matchesGroupFilter('lost', 'active')).toBe(false);
  });

  it('respects legacy display mapping', () => {
    // 'hired' is legacy for booked
    expect(matchesGroupFilter('hired', 'booked')).toBe(true);
    // 'done' is legacy for completed
    expect(matchesGroupFilter('done', 'completed')).toBe(true);
  });

  // Per-group coverage — the dropdown sets statusFilter to one of these group
  // ids and the Messages page filters in-memory via this predicate.
  describe('per group, all members included', () => {
    it('Active includes new/contacted/engaged/quoted/in_progress (canonical) + open/active/picked (legacy)', () => {
      ['new', 'contacted', 'engaged', 'quoted', 'in_progress', 'open', 'active', 'Open', 'picked', 'Picked'].forEach(
        (s) => expect(matchesGroupFilter(s, 'active')).toBe(true),
      );
      // Cross-group leads must be filtered out.
      ['booked', 'completed', 'lost', 'archived'].forEach((s) =>
        expect(matchesGroupFilter(s, 'active')).toBe(false),
      );
    });

    it('Scheduled (id="booked") includes booked/scheduled (canonical) + hired (legacy)', () => {
      ['booked', 'scheduled', 'hired', 'Hired'].forEach((s) =>
        expect(matchesGroupFilter(s, 'booked')).toBe(true),
      );
      ['new', 'in_progress', 'completed', 'lost'].forEach((s) =>
        expect(matchesGroupFilter(s, 'booked')).toBe(false),
      );
    });

    it('Done (id="completed") includes completed + done (legacy)', () => {
      ['completed', 'done', 'Done'].forEach((s) =>
        expect(matchesGroupFilter(s, 'completed')).toBe(true),
      );
      ['in_progress', 'booked', 'lost'].forEach((s) =>
        expect(matchesGroupFilter(s, 'completed')).toBe(false),
      );
    });

    it('Lost includes lost/cancelled/no_show/archived (canonical) + not hired/closed/canceled (legacy)', () => {
      [
        'lost', 'cancelled', 'no_show', 'archived',
        'not hired', 'Not Hired', 'not_hired', 'closed',
        'canceled', 'Canceled',
      ].forEach((s) => expect(matchesGroupFilter(s, 'lost')).toBe(true));
      ['new', 'engaged', 'in_progress', 'completed'].forEach((s) =>
        expect(matchesGroupFilter(s, 'lost')).toBe(false),
      );
    });
  });
});

describe('STATUS_FILTER_OPTIONS', () => {
  it('contains the 4 canonical groups + 2 pseudo-groups (refunded, refundable) in locked order', () => {
    expect(STATUS_FILTER_OPTIONS.map((o) => o.id)).toEqual([
      'active', 'booked', 'completed', 'lost', 'refunded', 'refundable',
    ]);
  });
});
