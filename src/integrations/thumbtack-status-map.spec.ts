import {
  mapThumbtackToLbStatus,
  isRelevantThumbtackSignal,
} from './thumbtack-status-map';

describe('thumbtack-status-map', () => {
  describe('mapThumbtackToLbStatus', () => {
    it('maps Thumbtack Active → contacted', () => {
      expect(mapThumbtackToLbStatus('Active')).toBe('contacted');
    });

    it('maps Thumbtack Hired → booked', () => {
      expect(mapThumbtackToLbStatus('Hired')).toBe('booked');
    });

    it('maps Thumbtack Scheduled → scheduled', () => {
      expect(mapThumbtackToLbStatus('Scheduled')).toBe('scheduled');
    });

    it('maps Thumbtack Done → completed', () => {
      expect(mapThumbtackToLbStatus('Done')).toBe('completed');
    });

    it('maps Thumbtack Not hired → lost', () => {
      expect(mapThumbtackToLbStatus('Not hired')).toBe('lost');
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
    it('returns true for the seven engagement-relevant statuses', () => {
      expect(isRelevantThumbtackSignal('Active')).toBe(true);
      expect(isRelevantThumbtackSignal('Hired')).toBe(true);
      expect(isRelevantThumbtackSignal('Scheduled')).toBe(true);
      expect(isRelevantThumbtackSignal('Done')).toBe(true);
      expect(isRelevantThumbtackSignal('Not hired')).toBe(true);
      expect(isRelevantThumbtackSignal('Closed')).toBe(true);
      expect(isRelevantThumbtackSignal('Archived')).toBe(true);
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
