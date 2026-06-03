/**
 * Yelp → LeadBridge canonical status mapping.
 *
 * Yelp inbox statuses (scraped by the Chrome extension) are translated into LB
 * canonical pipeline values before being written to Lead.status. The raw value
 * is preserved separately on Lead.platformStatus so we never lose what the
 * platform actually said.
 *
 * | Yelp raw                    | LB canonical | Notes                  |
 * |-----------------------------|--------------|------------------------|
 * | Active                      | contacted    |                        |
 * | Quoted                      | quoted       |                        |
 * | Hired / Booked              | booked       |                        |
 * | Scheduled                   | scheduled    |                        |
 * | In progress                 | in_progress  |                        |
 * | Done                        | completed    |                        |
 * | Not hired                   | lost         | lostReason=hired_someone |
 * | Closed                      | lost         | lostReason=hired_someone |
 * | Archived                    | lost         | lostReason=hired_someone — Yelp "archived" is "the lead didn't pan out"; surfaces as "No hire" in the UI |
 * | Cancelled / Canceled        | cancelled    |                        |
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
  | 'cancelled';

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
    case 'archived':
      return 'lost';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return null;
  }
}

/**
 * For raw values that map to LB `lost`, return the canonical lostReason that
 * LeadStatusService.writeStatus should persist on Lead.lostReason. Yelp
 * vocabulary collapses three different end-states ("Not hired", "Closed",
 * "Archived") into LB `lost` — they all mean the same thing to the operator:
 * the customer ended up hiring someone else (or stopped engaging entirely),
 * so the lead is no longer actionable. The UI groups `lost` under "No hire".
 *
 * Returns null for raw values that don't map to `lost`.
 */
export function getYelpLostReason(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();
  switch (lower) {
    case 'not hired':
    case 'closed':
    case 'archived':
      return 'hired_someone';
    default:
      return null;
  }
}
