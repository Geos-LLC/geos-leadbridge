import { mapYelpToLbStatus, getYelpLostReason } from './yelp-status-map';

describe('yelp-status-map', () => {
  describe('mapYelpToLbStatus', () => {
    it('maps Yelp Active → engaged', () => {
      expect(mapYelpToLbStatus('Active')).toBe('engaged');
    });

    it('maps Yelp Quoted → quoted', () => {
      expect(mapYelpToLbStatus('Quoted')).toBe('quoted');
    });

    it('maps Yelp Hired / Booked / Scheduled → booked (post-simplification)', () => {
      expect(mapYelpToLbStatus('Hired')).toBe('booked');
      expect(mapYelpToLbStatus('Booked')).toBe('booked');
      expect(mapYelpToLbStatus('Scheduled')).toBe('booked');
    });

    it('maps Yelp In progress → in_progress', () => {
      expect(mapYelpToLbStatus('In progress')).toBe('in_progress');
    });

    it('maps Yelp Not hired → lost', () => {
      expect(mapYelpToLbStatus('Not hired')).toBe('lost');
    });

    it('maps Yelp Done → completed', () => {
      expect(mapYelpToLbStatus('Done')).toBe('completed');
    });

    it('maps Yelp Closed → lost', () => {
      expect(mapYelpToLbStatus('Closed')).toBe('lost');
    });

    it('maps Yelp Cancelled / Canceled → cancelled (both spellings)', () => {
      expect(mapYelpToLbStatus('Cancelled')).toBe('cancelled');
      expect(mapYelpToLbStatus('Canceled')).toBe('cancelled');
    });

    it('maps Yelp Archived → lost (Yelp archive = "No hire" in LB, not "Archived")', () => {
      // Spec: Yelp-archived means the lead didn't convert (customer hired
      // someone else / stopped engaging). Surfaces as "No hire" in the UI.
      // The Archived UI bucket is reserved for explicit LB-side archives.
      expect(mapYelpToLbStatus('Archived')).toBe('lost');
    });

    it('handles case + whitespace variations', () => {
      expect(mapYelpToLbStatus('ACTIVE')).toBe('engaged');
      expect(mapYelpToLbStatus('  hired  ')).toBe('booked');
      expect(mapYelpToLbStatus('NOT HIRED')).toBe('lost');
      expect(mapYelpToLbStatus('done')).toBe('completed');
      expect(mapYelpToLbStatus('IN PROGRESS')).toBe('in_progress');
    });

    it('returns null for unknown / empty / nullish values', () => {
      expect(mapYelpToLbStatus('inquired')).toBeNull();
      expect(mapYelpToLbStatus('no response')).toBeNull(); // intentionally unmapped
      expect(mapYelpToLbStatus('')).toBeNull();
      expect(mapYelpToLbStatus(null)).toBeNull();
      expect(mapYelpToLbStatus(undefined)).toBeNull();
    });
  });

  describe('getYelpLostReason', () => {
    it.each([
      ['Archived'],
      ['archived'],
      ['Not hired'],
      ['NOT HIRED'],
      ['Closed'],
      ['  closed  '],
    ])('returns archived for %s (Yelp closed the thread; cause unknown so not hired_someone)', (raw) => {
      expect(getYelpLostReason(raw)).toBe('archived');
    });

    it.each([
      ['Active'],
      ['Hired'],
      ['Booked'],
      ['Done'],
      ['Quoted'],
      ['Cancelled'],
      ['Canceled'],
      ['In progress'],
    ])('returns null for non-lost raw value %s', (raw) => {
      expect(getYelpLostReason(raw)).toBeNull();
    });

    it('returns null for nullish / empty', () => {
      expect(getYelpLostReason(null)).toBeNull();
      expect(getYelpLostReason(undefined)).toBeNull();
      expect(getYelpLostReason('')).toBeNull();
    });
  });
});
