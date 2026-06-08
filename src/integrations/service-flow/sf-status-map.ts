/**
 * Service Flow → LeadBridge canonical status mapping.
 *
 * SF has its own status vocabulary (pending, confirmed, in-progress, completed,
 * cancelled, rescheduled, plus team-member-level en-route/started). We normalize
 * to LB's canonical pipeline enum so the follow-up engine and UI don't have to
 * care about upstream vocabulary.
 *
 * See plans/2026-04-17-job-sync-sf-lb.md §3.2.
 */

export const LB_PIPELINE_STATUSES = [
  'new',
  'engaged',
  'quoted',
  'booked',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
  'lost',
  'archived',
] as const;

export type LbPipelineStatus = (typeof LB_PIPELINE_STATUSES)[number];

/**
 * Statuses that are terminal for the follow-up engine — enrollment should stop
 * when the canonical status lands on one of these.
 *
 * `booked` is included: once the deal is won, lead-nurturing follow-ups must
 * stop even if a calendar slot hasn't been set yet. (`scheduled` was a
 * pre-simplification synonym for booked; collapsed into booked 2026-06-08.)
 *
 * Note: no_show is handled separately; it triggers a switch to long-term mode
 * rather than a hard stop.
 */
export const SF_TERMINAL_STATUSES: ReadonlyArray<LbPipelineStatus> = [
  'booked',
  'in_progress',
  'completed',
  'cancelled',
  'lost',
  'archived',
];

/**
 * Map a raw SF status string to a canonical LB pipeline status.
 * Returns null when the SF value is unknown — caller should return HTTP 422.
 */
export function mapSfStatus(raw: string | null | undefined): LbPipelineStatus | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();

  switch (lower) {
    // SF in connected mode emits literal lifecycle strings (Wave 1B/1C).
    // pending/confirmed/rescheduled/scheduled all collapse to LB `booked`
    // post-simplification (2026-06-08) — LB no longer distinguishes
    // "scheduled but not yet booked" from "booked". SF wire format unchanged;
    // only LB-side interpretation differs.
    case 'pending':
    case 'confirmed':
    case 'rescheduled':
    case 'scheduled':
    case 'booked':
      return 'booked';

    case 'in-progress':
    case 'in_progress':
    case 'en-route':
    case 'en_route':
    case 'started':
      return 'in_progress';

    case 'completed':
    case 'complete':
    case 'paid':
    case 'done':
      return 'completed';

    case 'cancelled':
    case 'canceled':
      return 'cancelled';

    case 'no-show':
    case 'no_show':
      return 'no_show';

    case 'archived':
      return 'archived';

    case 'lost':
      return 'lost';

    // Early-funnel values from SF (if ever emitted). `contacted` is a
    // pre-simplification SF value — collapses to canonical `engaged`.
    case 'new':
      return 'new';
    case 'contacted':
    case 'engaged':
      return 'engaged';
    case 'quoted':
      return 'quoted';

    default:
      return null;
  }
}

/**
 * Returns true when the canonical status stops follow-up enrollment.
 * no_show is NOT in this set — it switches to long-term mode.
 */
export function isSfTerminal(canonical: LbPipelineStatus): boolean {
  return (SF_TERMINAL_STATUSES as readonly string[]).includes(canonical);
}
