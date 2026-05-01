import {
  mapThumbtackToLbStatus,
  isRelevantThumbtackSignal,
} from './thumbtack-status-map';

describe('thumbtack-status-map', () => {
  describe('mapThumbtackToLbStatus', () => {
    it('maps Thumbtack Active → contacted', () => {
      expect(mapThumbtackToLbStatus('Active')).toBe('contacted');
    });

    it('maps Thumbtack Not scheduled yet → contacted', () => {
      expect(mapThumbtackToLbStatus('Not scheduled yet')).toBe('contacted');
      expect(mapThumbtackToLbStatus('NOT SCHEDULED YET')).toBe('contacted');
      expect(mapThumbtackToLbStatus('  not scheduled yet  ')).toBe('contacted');
    });

    it('maps Thumbtack Hired (and Job hired) → booked', () => {
      expect(mapThumbtackToLbStatus('Hired')).toBe('booked');
      expect(mapThumbtackToLbStatus('Job hired')).toBe('booked');
    });

    it('maps Thumbtack Scheduled (and Job Scheduled) → scheduled', () => {
      expect(mapThumbtackToLbStatus('Scheduled')).toBe('scheduled');
      expect(mapThumbtackToLbStatus('Job Scheduled')).toBe('scheduled');
    });

    it('maps Thumbtack In progress / Job in progress → in_progress', () => {
      expect(mapThumbtackToLbStatus('In progress')).toBe('in_progress');
      expect(mapThumbtackToLbStatus('Job in progress')).toBe('in_progress');
    });

    it('maps Thumbtack Done (and Job done) → completed', () => {
      expect(mapThumbtackToLbStatus('Done')).toBe('completed');
      expect(mapThumbtackToLbStatus('Job done')).toBe('completed');
    });

    // Production audit logs showed the Thumbtack pro inbox rendering "No hire"
    // (one word) — the map previously only handled "Not hired" so the canonical
    // status never updated, leaving leads stuck on legacy 'Open'.
    it('maps Thumbtack Not hired / No hire → lost', () => {
      expect(mapThumbtackToLbStatus('Not hired')).toBe('lost');
      expect(mapThumbtackToLbStatus('No hire')).toBe('lost');
      expect(mapThumbtackToLbStatus('NO HIRE')).toBe('lost');
    });

    it('maps Thumbtack Closed → lost', () => {
      expect(mapThumbtackToLbStatus('Closed')).toBe('lost');
    });

    it('maps Thumbtack Archived → archived', () => {
      expect(mapThumbtackToLbStatus('Archived')).toBe('archived');
    });

    it('handles case + whitespace variations', () => {
      expect(mapThumbtackToLbStatus('ACTIVE')).toBe('contacted');
      expect(mapThumbtackToLbStatus('  hired  ')).toBe('booked');
      expect(mapThumbtackToLbStatus('NOT HIRED')).toBe('lost');
      expect(mapThumbtackToLbStatus('done')).toBe('completed');
      expect(mapThumbtackToLbStatus('SCHEDULED')).toBe('scheduled');
    });

    it('returns null for unknown / empty / nullish values', () => {
      expect(mapThumbtackToLbStatus('Unknown')).toBeNull();
      expect(mapThumbtackToLbStatus('inquired')).toBeNull();
      expect(mapThumbtackToLbStatus('')).toBeNull();
      expect(mapThumbtackToLbStatus(null)).toBeNull();
      expect(mapThumbtackToLbStatus(undefined)).toBeNull();
    });
  });

  describe('isRelevantThumbtackSignal', () => {
    it('returns true for the engagement-relevant statuses', () => {
      [
        'Active',
        'Not scheduled yet',
        'Hired', 'Job hired',
        'Scheduled', 'Job Scheduled',
        'In progress', 'Job in progress',
        'Done', 'Job done',
        'Not hired', 'No hire',
        'Closed',
        'Archived',
      ].forEach((s) => expect(isRelevantThumbtackSignal(s)).toBe(true));
    });

    it('is case-insensitive', () => {
      expect(isRelevantThumbtackSignal('hired')).toBe(true);
      expect(isRelevantThumbtackSignal('NOT HIRED')).toBe(true);
    });

    it('returns false for unknown / nullish', () => {
      expect(isRelevantThumbtackSignal('Unknown')).toBe(false);
      expect(isRelevantThumbtackSignal('')).toBe(false);
      expect(isRelevantThumbtackSignal(null)).toBe(false);
      expect(isRelevantThumbtackSignal(undefined)).toBe(false);
    });
  });
});
