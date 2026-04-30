/**
 * Yelp → LeadBridge canonical status mapping.
 *
 * Yelp inbox statuses (scraped by the Chrome extension) are translated into LB
 * canonical pipeline values before being written to Lead.status. The raw value
 * is preserved separately on Lead.platformStatus so we never lose what the
 * platform actually said.
 *
 * | Yelp raw                    | LB canonical |
 * |-----------------------------|--------------|
 * | Active                      | contacted    |
 * | Quoted                      | quoted       |
 * | Hired / Booked              | booked       |
 * | Scheduled                   | scheduled    |
 * | In progress                 | in_progress  |
 * | Done                        | completed    |
 * | Not hired                   | lost         |
 * | Closed                      | lost         |
 * | Cancelled / Canceled        | cancelled    |
 * | Archived                    | archived     |
 *
 * Unknown values return null — callers must still update platformStatus but
 * must NOT touch Lead.status. Keep this map narrow rather than guessing —
 * silent canonical writes for unverified raw values would corrupt downstream
 * filters / automation.
 */

export type YelpLbStatus =
  | 'contacted'
  | 'quoted'
  | 'booked'
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'lost'
  | 'cancelled'
  | 'archived';

export function mapYelpToLbStatus(raw: string | null | undefined): YelpLbStatus | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();

  switch (lower) {
    case 'active':
      return 'contacted';
    case 'quoted':
      return 'quoted';
    case 'hired':
    case 'booked':
      return 'booked';
    case 'scheduled':
      return 'scheduled';
    case 'in progress':
      return 'in_progress';
    case 'done':
      return 'completed';
    case 'not hired':
    case 'closed':
      return 'lost';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'archived':
      return 'archived';
    default:
      return null;
  }
}
