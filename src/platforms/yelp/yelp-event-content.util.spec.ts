/**
 * Pins the contract for the Yelp event → Message projection helpers.
 *
 * Same logic that drove the inline block at leads.service.ts ~L378-402 before
 * extraction. These tests guard against drift between the read path
 * (getYelpMessages) and the webhook write path (handleYelpNewEventInner).
 */

import {
  YELP_NON_DISPLAY_EVENT_TYPES,
  extractYelpEventContent,
  isDisplayableYelpEvent,
  yelpEventSender,
} from './yelp-event-content.util';

describe('yelp-event-content.util', () => {
  describe('isDisplayableYelpEvent', () => {
    it('rejects RAQ_SUBMIT (duplicates the lead row)', () => {
      expect(isDisplayableYelpEvent({ event_type: 'RAQ_SUBMIT' })).toBe(false);
    });

    it('rejects CONSUMER_PHONE_NUMBER_OPT_IN/OUT events', () => {
      expect(isDisplayableYelpEvent({ event_type: 'CONSUMER_PHONE_NUMBER_OPT_IN_EVENT' })).toBe(false);
      expect(isDisplayableYelpEvent({ event_type: 'CONSUMER_PHONE_NUMBER_OPT_OUT_EVENT' })).toBe(false);
    });

    it('accepts TEXT and structured event types', () => {
      expect(isDisplayableYelpEvent({ event_type: 'TEXT' })).toBe(true);
      expect(isDisplayableYelpEvent({ event_type: 'AVAILABILITY' })).toBe(true);
      expect(isDisplayableYelpEvent({ event_type: 'PRICE_ESTIMATE' })).toBe(true);
    });

    it('accepts events with an unknown event_type (forward-compatible)', () => {
      expect(isDisplayableYelpEvent({ event_type: 'SOMETHING_NEW' })).toBe(true);
    });

    it('treats null / missing event as displayable (caller still filters by content)', () => {
      // Null-safe — prevents crashes; downstream extractYelpEventContent returns ''.
      expect(isDisplayableYelpEvent(null)).toBe(true);
      expect(isDisplayableYelpEvent({})).toBe(true);
    });

    it('exports a non-empty allow-list set', () => {
      expect(YELP_NON_DISPLAY_EVENT_TYPES.size).toBeGreaterThan(0);
    });
  });

  describe('extractYelpEventContent', () => {
    it('prefers event_content.text', () => {
      expect(extractYelpEventContent({ event_content: { text: 'hi' } })).toBe('hi');
    });

    it('falls back to event_content.fallback_text', () => {
      expect(extractYelpEventContent({ event_content: { fallback_text: 'fallback' } })).toBe('fallback');
    });

    it('falls back to event.text (legacy shape)', () => {
      expect(extractYelpEventContent({ text: 'legacy' })).toBe('legacy');
    });

    it('formats price_estimate', () => {
      expect(extractYelpEventContent({ event_content: { price_estimate: '$100' } })).toBe('Price Estimate: $100');
    });

    it('formats price_range when price_estimate absent', () => {
      expect(extractYelpEventContent({ event_content: { price_range: '$50-$150' } })).toBe('Price Estimate: $50-$150');
    });

    it('formats low_estimate / high_estimate as a $-range', () => {
      expect(extractYelpEventContent({ event_content: { low_estimate: 50, high_estimate: 150 } })).toBe('$50 - $150');
    });

    it('formats availability', () => {
      expect(extractYelpEventContent({ event_content: { availability: 'Mon 9am' } })).toBe('Availability: Mon 9am');
    });

    it('joins multiple structured fields with newlines', () => {
      expect(
        extractYelpEventContent({
          event_content: { price_estimate: '$200', availability: 'Tomorrow', message: 'note' },
        }),
      ).toBe('Price Estimate: $200\nAvailability: Tomorrow\nnote');
    });

    it('falls back to [event_type] for non-TEXT events with no extractable content', () => {
      expect(extractYelpEventContent({ event_type: 'INVOICE', event_content: {} })).toBe('[INVOICE]');
    });

    it('returns empty string for TEXT events with no content (caller skips)', () => {
      expect(extractYelpEventContent({ event_type: 'TEXT', event_content: {} })).toBe('');
    });

    it('returns empty string for null / missing input', () => {
      expect(extractYelpEventContent(null)).toBe('');
      expect(extractYelpEventContent(undefined)).toBe('');
      expect(extractYelpEventContent({})).toBe('');
    });

    it('does not crash on string event_content (legacy Yelp format)', () => {
      // Read path receives this shape from the classifier today; util must not throw.
      // Returns '' because the structured extraction can't read .text from a string.
      expect(extractYelpEventContent({ event_content: 'plain string' })).toBe('');
    });
  });

  describe('yelpEventSender', () => {
    it('CONSUMER → customer', () => {
      expect(yelpEventSender({ user_type: 'CONSUMER' })).toBe('customer');
    });

    it('BIZ → pro', () => {
      expect(yelpEventSender({ user_type: 'BIZ' })).toBe('pro');
    });

    it('unknown / missing user_type → pro (defensive default — webhook path persists with senderType undefined)', () => {
      expect(yelpEventSender({})).toBe('pro');
      expect(yelpEventSender(null)).toBe('pro');
    });
  });

  describe('cross-helper invariants — read/write path parity', () => {
    it('every event the webhook would persist also passes the read-side display filter', () => {
      // Sample of event shapes the API can return.
      const events = [
        { event_type: 'TEXT', event_content: { text: 'hello' } },
        { event_type: 'TEXT', event_content: { text: '' } }, // empty text → util returns ''
        { event_type: 'PRICE_ESTIMATE', event_content: { price_estimate: '$200' } },
        { event_type: 'RAQ_SUBMIT' },
        { event_type: 'CONSUMER_PHONE_NUMBER_OPT_IN_EVENT' },
      ];

      // The webhook persist loop's filter: isDisplayableYelpEvent(ev) && extractYelpEventContent(ev).
      // The read-side messages array filters .filter(m => m.content) — same effective gate.
      const persistable = events.filter(e => isDisplayableYelpEvent(e) && extractYelpEventContent(e).length > 0);

      expect(persistable.map(e => e.event_type)).toEqual(['TEXT', 'PRICE_ESTIMATE']);
    });
  });
});
