/**
 * Frontend lib/leadStatus tests.
 *
 * The frontend has no test framework configured, so we host the spec in the
 * backend jest tree and import the helper via relative path. The helper is
 * pure TypeScript with no React/Vite deps so ts-jest compiles it cleanly.
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
  it('exposes the 6 groups in the locked label order', () => {
    expect(STATUS_GROUPS.map((g) => g.label)).toEqual([
      'Active',
      'Scheduled',
      'Job in progress',
      'Done',
      'No hire',
      'Archived',
    ]);
  });

  it('Active contains new/contacted/engaged/quoted', () => {
    expect(STATUS_GROUPS.find((g) => g.id === 'active')!.statuses).toEqual([
      'new', 'contacted', 'engaged', 'quoted',
    ]);
  });

  it('Scheduled contains booked + scheduled', () => {
    expect(STATUS_GROUPS.find((g) => g.id === 'scheduled')!.statuses).toEqual([
      'booked', 'scheduled',
    ]);
  });

  it('No hire contains lost/cancelled/no_show', () => {
    expect(STATUS_GROUPS.find((g) => g.id === 'no_hire')!.statuses).toEqual([
      'lost', 'cancelled', 'no_show',
    ]);
  });
});

describe('displayGroup', () => {
  const cases: Array<[string, string]> = [
    ['new', 'active'],
    ['contacted', 'active'],
    ['engaged', 'active'],
    ['quoted', 'active'],
    ['booked', 'scheduled'],
    ['scheduled', 'scheduled'],
    ['in_progress', 'in_progress'],
    ['completed', 'done'],
    ['lost', 'no_hire'],
    ['cancelled', 'no_hire'],
    ['no_show', 'no_hire'],
    ['archived', 'archived'],
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
    expect(displayGroup('Booked')).toBe('scheduled');
  });
});

describe('LEGACY_DISPLAY_MAP', () => {
  it('maps hired -> scheduled (display only)', () => {
    expect(LEGACY_DISPLAY_MAP.hired).toBe('scheduled');
    expect(displayLabel('hired')).toBe('Scheduled');
  });

  it('maps done -> completed -> "Done"', () => {
    expect(LEGACY_DISPLAY_MAP.done).toBe('completed');
    expect(displayLabel('done')).toBe('Done');
  });

  it('maps "not hired" / not_hired -> lost -> "No hire"', () => {
    expect(LEGACY_DISPLAY_MAP['not hired']).toBe('lost');
    expect(LEGACY_DISPLAY_MAP.not_hired).toBe('lost');
    expect(displayLabel('not hired')).toBe('No hire');
    expect(displayLabel('Not Hired')).toBe('No hire');
  });

  it('maps closed -> lost -> "No hire"', () => {
    expect(LEGACY_DISPLAY_MAP.closed).toBe('lost');
    expect(displayLabel('closed')).toBe('No hire');
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

  it('maps canceled (American) -> cancelled -> "No hire"', () => {
    expect(LEGACY_DISPLAY_MAP.canceled).toBe('cancelled');
    expect(displayLabel('Canceled')).toBe('No hire');
  });
});

describe('displayLabel', () => {
  it('returns the group label for a canonical status', () => {
    expect(displayLabel('engaged')).toBe('Active');
    expect(displayLabel('booked')).toBe('Scheduled');
    expect(displayLabel('in_progress')).toBe('Job in progress');
    expect(displayLabel('completed')).toBe('Done');
    expect(displayLabel('lost')).toBe('No hire');
    expect(displayLabel('archived')).toBe('Archived');
  });

  it('returns "—" for unknown statuses', () => {
    expect(displayLabel('snoozed')).toBe('—');
    expect(displayLabel(null)).toBe('—');
  });
});

describe('displayPillKind', () => {
  it('returns the matching pill kind for a canonical status', () => {
    expect(displayPillKind('engaged')).toBe('active');
    expect(displayPillKind('booked')).toBe('scheduled');
    expect(displayPillKind('completed')).toBe('done');
    expect(displayPillKind('lost')).toBe('no_hire');
  });

  it('falls back to neutral for unknown', () => {
    expect(displayPillKind('snoozed')).toBe('neutral');
    expect(displayPillKind(null)).toBe('neutral');
  });
});

describe('matchesGroupFilter', () => {
  it('matches all canonical statuses in their group', () => {
    expect(matchesGroupFilter('engaged', 'active')).toBe(true);
    expect(matchesGroupFilter('booked', 'scheduled')).toBe(true);
    expect(matchesGroupFilter('lost', 'no_hire')).toBe(true);
  });

  it('rejects mismatches', () => {
    expect(matchesGroupFilter('engaged', 'no_hire')).toBe(false);
    expect(matchesGroupFilter('lost', 'active')).toBe(false);
  });

  it('respects legacy display mapping', () => {
    // 'hired' is legacy for scheduled
    expect(matchesGroupFilter('hired', 'scheduled')).toBe(true);
    // 'done' is legacy for completed -> Done
    expect(matchesGroupFilter('done', 'done')).toBe(true);
  });

  // Per-group coverage — the dropdown sets statusFilter to one of these group
  // ids and the Messages page filters in-memory via this predicate. Each test
  // mirrors the spec for that group from src/leads/canonical-status.ts.
  describe('per group, all members included', () => {
    it('Active includes new/contacted/engaged/quoted (canonical) + open/active/picked (legacy)', () => {
      ['new', 'contacted', 'engaged', 'quoted', 'open', 'active', 'Open', 'picked', 'Picked'].forEach(
        (s) => expect(matchesGroupFilter(s, 'active')).toBe(true),
      );
      // Cross-group leads must be filtered out.
      ['booked', 'completed', 'lost', 'archived'].forEach((s) =>
        expect(matchesGroupFilter(s, 'active')).toBe(false),
      );
    });

    it('Scheduled includes booked/scheduled (canonical) + hired (legacy)', () => {
      ['booked', 'scheduled', 'hired', 'Hired'].forEach((s) =>
        expect(matchesGroupFilter(s, 'scheduled')).toBe(true),
      );
      ['new', 'in_progress', 'completed', 'lost'].forEach((s) =>
        expect(matchesGroupFilter(s, 'scheduled')).toBe(false),
      );
    });

    it('Job in progress only includes in_progress', () => {
      expect(matchesGroupFilter('in_progress', 'in_progress')).toBe(true);
      ['booked', 'scheduled', 'completed'].forEach((s) =>
        expect(matchesGroupFilter(s, 'in_progress')).toBe(false),
      );
    });

    it('Done includes completed (canonical) + done (legacy)', () => {
      ['completed', 'done', 'Done'].forEach((s) =>
        expect(matchesGroupFilter(s, 'done')).toBe(true),
      );
      ['in_progress', 'booked', 'lost'].forEach((s) =>
        expect(matchesGroupFilter(s, 'done')).toBe(false),
      );
    });

    it('No hire includes lost/cancelled/no_show (canonical) + not hired/closed/canceled (legacy)', () => {
      [
        'lost', 'cancelled', 'no_show',
        'not hired', 'Not Hired', 'not_hired', 'closed',
        'canceled', 'Canceled',
      ].forEach((s) => expect(matchesGroupFilter(s, 'no_hire')).toBe(true));
      ['new', 'engaged', 'completed', 'archived'].forEach((s) =>
        expect(matchesGroupFilter(s, 'no_hire')).toBe(false),
      );
    });

    it('Archived only includes archived', () => {
      expect(matchesGroupFilter('archived', 'archived')).toBe(true);
      ['lost', 'completed', 'cancelled'].forEach((s) =>
        expect(matchesGroupFilter(s, 'archived')).toBe(false),
      );
    });
  });
});

describe('STATUS_FILTER_OPTIONS', () => {
  it('contains all 6 groups (no "all" / no "unknown") in locked order', () => {
    expect(STATUS_FILTER_OPTIONS.map((o) => o.id)).toEqual([
      'active', 'scheduled', 'in_progress', 'done', 'no_hire', 'archived',
    ]);
  });
});
