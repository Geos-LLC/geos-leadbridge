/**
 * Yelp → LeadBridge canonical status mapping.
 *
 * Yelp inbox statuses (scraped by the Chrome extension) are translated into LB
 * canonical pipeline values before being written to Lead.status. The raw value
 * is preserved separately on Lead.platformStatus so we never lose what the
 * platform actually said.
 *
 * | Yelp raw    | LB canonical |
 * |-------------|--------------|
 * | Active      | contacted    |
 * | Hired       | booked       |
 * | Not hired   | lost         |
 * | Done        | completed    |
 * | Closed      | lost         |
 * | Archived    | archived     |
 *
 * Unknown values return null — callers must still update platformStatus but
 * must NOT touch Lead.status.
 */

export type YelpLbStatus =
  | 'contacted'
  | 'booked'
  | 'lost'
  | 'completed'
  | 'archived';

export function mapYelpToLbStatus(raw: string | null | undefined): YelpLbStatus | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();

  switch (lower) {
    case 'active':
      return 'contacted';
    case 'hired':
      return 'booked';
    case 'not hired':
      return 'lost';
    case 'done':
      return 'completed';
    case 'closed':
      return 'lost';
    case 'archived':
      return 'archived';
    default:
      return null;
  }
}
