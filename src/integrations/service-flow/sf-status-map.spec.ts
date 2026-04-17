import { mapSfStatus, isSfTerminal } from './sf-status-map';

describe('sf-status-map', () => {
  describe('mapSfStatus', () => {
    it('maps SF pending → scheduled', () => {
      expect(mapSfStatus('pending')).toBe('scheduled');
    });

    it('maps SF confirmed → scheduled', () => {
      expect(mapSfStatus('confirmed')).toBe('scheduled');
    });

    it('maps SF rescheduled → scheduled', () => {
      expect(mapSfStatus('rescheduled')).toBe('scheduled');
    });

    it('maps SF in-progress / in_progress / en-route / started → in_progress', () => {
      expect(mapSfStatus('in-progress')).toBe('in_progress');
      expect(mapSfStatus('in_progress')).toBe('in_progress');
      expect(mapSfStatus('en-route')).toBe('in_progress');
      expect(mapSfStatus('en_route')).toBe('in_progress');
      expect(mapSfStatus('started')).toBe('in_progress');
    });

    it('maps completed variants → completed', () => {
      expect(mapSfStatus('completed')).toBe('completed');
      expect(mapSfStatus('complete')).toBe('completed');
      expect(mapSfStatus('paid')).toBe('completed');
      expect(mapSfStatus('done')).toBe('completed');
    });

    it('maps cancelled variants → cancelled', () => {
      expect(mapSfStatus('cancelled')).toBe('cancelled');
      expect(mapSfStatus('canceled')).toBe('cancelled');
    });

    it('maps no-show variants → no_show', () => {
      expect(mapSfStatus('no-show')).toBe('no_show');
      expect(mapSfStatus('no_show')).toBe('no_show');
    });

    it('handles case variations', () => {
      expect(mapSfStatus('PENDING')).toBe('scheduled');
      expect(mapSfStatus('Confirmed')).toBe('scheduled');
      expect(mapSfStatus(' CoMpLeTeD ')).toBe('completed');
    });

    it('returns null for unknown values', () => {
      expect(mapSfStatus('on_hold')).toBeNull();
      expect(mapSfStatus('refunded')).toBeNull();
      expect(mapSfStatus('')).toBeNull();
      expect(mapSfStatus(null)).toBeNull();
      expect(mapSfStatus(undefined)).toBeNull();
    });

    it('passes through early-funnel values', () => {
      expect(mapSfStatus('new')).toBe('new');
      expect(mapSfStatus('contacted')).toBe('contacted');
      expect(mapSfStatus('quoted')).toBe('quoted');
    });
  });

  describe('isSfTerminal', () => {
    it('treats scheduled / in_progress / completed / cancelled / lost / archived as terminal', () => {
      expect(isSfTerminal('scheduled')).toBe(true);
      expect(isSfTerminal('in_progress')).toBe(true);
      expect(isSfTerminal('completed')).toBe(true);
      expect(isSfTerminal('cancelled')).toBe(true);
      expect(isSfTerminal('lost')).toBe(true);
      expect(isSfTerminal('archived')).toBe(true);
    });

    it('does NOT treat no_show as terminal (uses long-term mode)', () => {
      expect(isSfTerminal('no_show')).toBe(false);
    });

    it('does NOT treat early-funnel as terminal', () => {
      expect(isSfTerminal('new')).toBe(false);
      expect(isSfTerminal('contacted')).toBe(false);
      expect(isSfTerminal('quoted')).toBe(false);
    });
  });
});
