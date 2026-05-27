import {
  labelConversationState,
  labelAiStatus,
  labelClassifierIntent,
  labelSfJobOutcome,
  labelFollowUp,
  labelHandoff,
} from './conversation-runtime-display';

describe('conversation-runtime-display helpers', () => {
  describe('labelConversationState', () => {
    it.each([
      ['new', 'New'],
      ['ai_engaging', 'AI engaging'],
      ['awaiting_customer', 'Awaiting customer'],
      ['customer_replied', 'Customer replied'],
      ['human_handling', 'Human handling'],
      ['deferred', 'Deferred'],
      ['opted_out', 'Opted out'],
      ['hired_elsewhere', 'Hired elsewhere'],
      ['booked_in_lb', 'Booked'],
      ['long_silent', 'Long silent'],
      ['closed', 'Closed'],
    ])('maps %s → %s', (state, expected) => {
      expect(labelConversationState(state)).toBe(expected);
    });

    it.each([null, undefined, ''])('returns em-dash for %s', (v) => {
      expect(labelConversationState(v as any)).toBe('—');
    });

    it('falls back to raw value for unknown state', () => {
      expect(labelConversationState('totally_made_up')).toBe('totally_made_up');
    });
  });

  describe('labelAiStatus', () => {
    it.each([
      ['disabled', 'AI disabled'],
      ['active', 'AI active'],
      ['paused_human', 'AI paused — human'],
      ['paused_deferral', 'AI paused — deferral'],
      ['stopped_terminal', 'AI stopped — terminal'],
      ['stopped_booked', 'AI stopped — booked'],
      ['unavailable', 'AI unavailable'],
    ])('maps %s → %s', (s, expected) => {
      expect(labelAiStatus(s)).toBe(expected);
    });

    it('null → em-dash', () => {
      expect(labelAiStatus(null)).toBe('—');
    });
  });

  describe('labelClassifierIntent', () => {
    it('maps known intents', () => {
      expect(labelClassifierIntent('agreed')).toBe('Ready to book');
      expect(labelClassifierIntent('wants_live_contact')).toBe('Wants live contact');
      expect(labelClassifierIntent('deferring')).toBe('Deferring');
    });
    it('null → em-dash', () => {
      expect(labelClassifierIntent(null)).toBe('—');
    });
  });

  describe('labelSfJobOutcome', () => {
    it('maps known outcomes', () => {
      expect(labelSfJobOutcome('scheduled')).toBe('SF: scheduled');
      expect(labelSfJobOutcome('completed')).toBe('SF: completed');
      expect(labelSfJobOutcome('cancelled')).toBe('SF: cancelled');
    });
    it('null → em-dash', () => {
      expect(labelSfJobOutcome(null)).toBe('—');
    });
  });

  describe('labelFollowUp', () => {
    it('null status → "No follow-up"', () => {
      expect(labelFollowUp(null, null)).toBe('No follow-up');
    });
    it('active + nextAt in 30 min → "Follow-up in 30m"', () => {
      const t = new Date(Date.now() + 30 * 60 * 1000);
      expect(labelFollowUp('active', t)).toMatch(/Follow-up in 3[01]m/);
    });
    it('active + nextAt in 5h → "Follow-up in 5h"', () => {
      const t = new Date(Date.now() + 5 * 60 * 60 * 1000);
      expect(labelFollowUp('active', t)).toMatch(/Follow-up in 5h/);
    });
    it('active + nextAt in 3d → "Follow-up in 3d"', () => {
      const t = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      expect(labelFollowUp('active', t)).toMatch(/Follow-up in 3d/);
    });
    it('active + nextAt past → "Follow-up due now"', () => {
      const t = new Date(Date.now() - 60 * 1000);
      expect(labelFollowUp('active', t)).toBe('Follow-up due now');
    });
    it('stopped → "Follow-up stopped"', () => {
      expect(labelFollowUp('stopped', null)).toBe('Follow-up stopped');
    });
    it('completed → "Follow-up completed"', () => {
      expect(labelFollowUp('completed', null)).toBe('Follow-up completed');
    });
  });

  describe('labelHandoff', () => {
    it('no requestedAt → "No handoff"', () => {
      expect(labelHandoff(null, null)).toBe('No handoff');
    });
    it('requested but not resolved → "Handoff requested"', () => {
      expect(labelHandoff(new Date(), null)).toBe('Handoff requested');
    });
    it('requested + resolved → "Handoff resolved"', () => {
      expect(labelHandoff(new Date(), new Date())).toBe('Handoff resolved');
    });
  });
});
