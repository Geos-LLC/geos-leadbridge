import { mapYelpToLbStatus } from './yelp-status-map';

describe('yelp-status-map', () => {
  describe('mapYelpToLbStatus', () => {
    it('maps Yelp Active → contacted', () => {
      expect(mapYelpToLbStatus('Active')).toBe('contacted');
    });

    it('maps Yelp Hired → booked', () => {
      expect(mapYelpToLbStatus('Hired')).toBe('booked');
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

    it('maps Yelp Archived → archived', () => {
      expect(mapYelpToLbStatus('Archived')).toBe('archived');
    });

    it('handles case + whitespace variations', () => {
      expect(mapYelpToLbStatus('ACTIVE')).toBe('contacted');
      expect(mapYelpToLbStatus('  hired  ')).toBe('booked');
      expect(mapYelpToLbStatus('NOT HIRED')).toBe('lost');
      expect(mapYelpToLbStatus('done')).toBe('completed');
    });

    it('returns null for unknown / empty / nullish values', () => {
      expect(mapYelpToLbStatus('inquired')).toBeNull();
      expect(mapYelpToLbStatus('quoted')).toBeNull();
      expect(mapYelpToLbStatus('')).toBeNull();
      expect(mapYelpToLbStatus(null)).toBeNull();
      expect(mapYelpToLbStatus(undefined)).toBeNull();
    });
  });
});
