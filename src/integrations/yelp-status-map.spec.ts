import { mapYelpToLbStatus } from './yelp-status-map';

describe('yelp-status-map', () => {
  describe('mapYelpToLbStatus', () => {
    it('maps Yelp Active → contacted', () => {
      expect(mapYelpToLbStatus('Active')).toBe('contacted');
    });

    it('maps Yelp Quoted → quoted', () => {
      expect(mapYelpToLbStatus('Quoted')).toBe('quoted');
    });

    it('maps Yelp Hired / Booked → booked', () => {
      expect(mapYelpToLbStatus('Hired')).toBe('booked');
      expect(mapYelpToLbStatus('Booked')).toBe('booked');
    });

    it('maps Yelp Scheduled → scheduled', () => {
      expect(mapYelpToLbStatus('Scheduled')).toBe('scheduled');
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

    it('maps Yelp Archived → archived', () => {
      expect(mapYelpToLbStatus('Archived')).toBe('archived');
    });

    it('handles case + whitespace variations', () => {
      expect(mapYelpToLbStatus('ACTIVE')).toBe('contacted');
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
});
