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
 * | Active                      | engaged      |                        |
 * | Quoted                      | quoted       |                        |
 * | Hired / Booked              | booked       |                        |
 * | Scheduled                   | booked       | post-simplification — was 'scheduled' |
 * | In progress                 | in_progress  |                        |
 * | Done                        | completed    |                        |
 * | Not hired                   | lost         | lostReason=archived    |
 * | Closed                      | lost         | lostReason=archived    |
 * | Archived                    | lost         | lostReason=archived — Yelp closed the thread on the customer's side; we don't know WHY, so we don't claim hired_someone. The customer_hired_competitor re-engage path only fires on lostReason='hired_someone' so these no longer trigger speculative re-engages (Hannah/Sophie/Minh 2026-06-20). |
 * | Cancelled / Canceled        | cancelled    |                        |
 *
 * Status simplification (2026-06-08): `contacted` collapsed into `engaged`,
 * `scheduled` collapsed into `booked`. See
 * plans/status-simplification-2026-06-08.md.
 *
 * Unknown values return null — callers must still update platformStatus but
 * must NOT touch Lead.status. Keep this map narrow rather than guessing —
 * silent canonical writes for unverified raw values would corrupt downstream
 * filters / automation.
 */

export type YelpLbStatus =
  | 'engaged'
  | 'quoted'
  | 'booked'
  | 'in_progress'
  | 'completed'
  | 'lost'
  | 'cancelled';

export function mapYelpToLbStatus(raw: string | null | undefined): YelpLbStatus | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();

  switch (lower) {
    case 'active':
      return 'engaged';
    case 'quoted':
      return 'quoted';
    case 'hired':
    case 'booked':
    case 'scheduled':
      return 'booked';
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
 * LeadStatusService.writeStatus should persist on Lead.lostReason.
 *
 * Yelp closes a thread in three ways: "Not hired", "Closed", "Archived". All
 * three mean "this conversation is over on Yelp's side" — but Yelp does NOT
 * tell us WHY (hired someone else? phone-only contact established? customer
 * frustrated? Yelp auto-aged it?). Previously we wrote 'hired_someone' for
 * all three, which then fed the customer_hired_competitor re-engage path and
 * sent "How did your cleaning service work out?" follow-ups to live customers
 * (Hannah/Sophie/Minh 2026-06-20 false positives).
 *
 * Now we write 'archived' — terminal but honest. The re-engage path keys on
 * 'hired_someone' specifically and so will no longer fire speculatively. If a
 * customer un-archives and replies, the existing isHiredReengage carve-out
 * in lead-status.service.ts allows lb_automation to re-promote
 * lost+archived -> engaged, same as it does for lost+hired_someone.
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
      return 'archived';
    default:
      return null;
  }
}
