/**
 * Yelp event → Message field projection.
 *
 * Single source of truth for: which Yelp events should produce a Message row,
 * how to extract their displayable content, and which sender they map to.
 *
 * Used by both the read path (`getYelpMessages` in leads.service.ts) and the
 * webhook write path (`handleYelpNewEventInner` in webhooks.service.ts) so
 * webhook-stored content matches what the API-driven read produces — no drift.
 */

/** Yelp event_type values that should never produce a Message row. */
export const YELP_NON_DISPLAY_EVENT_TYPES: ReadonlySet<string> = new Set([
  'RAQ_SUBMIT', // duplicates the lead's customer-name/message fields
  'CONSUMER_PHONE_NUMBER_OPT_IN_EVENT',
  'CONSUMER_PHONE_NUMBER_OPT_OUT_EVENT',
]);

/** True if the event should be persisted/displayed. Mirrors the read-side filter. */
export function isDisplayableYelpEvent(event: any): boolean {
  return !YELP_NON_DISPLAY_EVENT_TYPES.has(event?.event_type);
}

/**
 * Extract the displayable string for a Yelp event. Returns '' when nothing
 * displayable is present — callers should treat empty as a skip signal.
 *
 * Resolution order:
 *   1. event_content.text  / event_content.fallback_text / event.text
 *   2. Structured event_content fields (price estimate, availability, message)
 *      joined with newlines.
 *   3. Bracketed event-type fallback for non-TEXT events with no content.
 */
export function extractYelpEventContent(event: any): string {
  const ec = event?.event_content;
  let content: string = ec?.text || ec?.fallback_text || event?.text || '';

  if (!content && ec) {
    const parts: string[] = [];
    if (ec.price_estimate || ec.price_range) {
      parts.push(`Price Estimate: ${ec.price_estimate || ec.price_range}`);
    }
    if (ec.low_estimate || ec.high_estimate) {
      parts.push(`$${ec.low_estimate} - $${ec.high_estimate}`);
    }
    if (ec.availability) {
      parts.push(`Availability: ${ec.availability}`);
    }
    if (ec.message) {
      parts.push(ec.message);
    }
    if (parts.length > 0) content = parts.join('\n');
  }

  if (!content && event?.event_type && event.event_type !== 'TEXT') {
    content = `[${event.event_type}]`;
  }

  return content;
}

/** Map Yelp `user_type` to Message.sender. CONSUMER → customer, anything else → pro. */
export function yelpEventSender(event: any): 'customer' | 'pro' {
  return event?.user_type === 'CONSUMER' ? 'customer' : 'pro';
}
