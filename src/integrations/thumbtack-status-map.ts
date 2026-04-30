/**
 * Thumbtack → LeadBridge canonical status mapping.
 *
 * Thumbtack inbox statuses (scraped by the Chrome extension) are translated
 * into LB canonical pipeline values before being written to Lead.status. The
 * raw value is preserved separately on Lead.platformStatus (and the legacy
 * Lead.thumbtackStatus column, kept in sync by LeadStatusService.applyPlatformSync).
 *
 * | Thumbtack raw                       | LB canonical |
 * |-------------------------------------|--------------|
 * | Active                              | contacted    |
 * | Not scheduled yet                   | contacted    |
 * | Hired / Job hired                   | booked       |
 * | Scheduled / Job scheduled           | scheduled    |
 * | Job in progress / In progress       | in_progress  |
 * | Done / Job done                     | completed    |
 * | Not hired / No hire                 | lost         |
 * | Closed                              | lost         |
 * | Archived                            | archived     |
 *
 * The `Job …` variants are what the Thumbtack pro inbox actually renders for
 * post-hire states (verified in production audit logs — e.g. raw value "No
 * hire" was being captured but failing to canonicalize because the map only
 * matched "Not hired"). The plain forms are kept for backwards compatibility
 * with older payloads / the Partner API webhook surface.
 *
 * Unknown / empty values return null — callers must still update
 * platformStatus but must NOT touch Lead.status.
 */

export type ThumbtackLbStatus =
  | 'contacted'
  | 'booked'
  | 'scheduled'
  | 'in_progress'
  | 'completed'
  | 'lost'
  | 'archived';

export function mapThumbtackToLbStatus(
  raw: string | null | undefined,
): ThumbtackLbStatus | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();

  switch (lower) {
    case 'active':
    case 'not scheduled yet':
      return 'contacted';
    case 'hired':
    case 'job hired':
      return 'booked';
    case 'scheduled':
    case 'job scheduled':
      return 'scheduled';
    case 'in progress':
    case 'job in progress':
      return 'in_progress';
    case 'done':
    case 'job done':
      return 'completed';
    case 'not hired':
    case 'no hire':
    case 'closed':
      return 'lost';
    case 'archived':
      return 'archived';
    default:
      return null;
  }
}

/**
 * Thumbtack raw statuses that should fan out to FollowUpEngine.handlePlatformSignal.
 * Keep in sync with mapThumbtackToLbStatus above — every value handled by the
 * map should also count as a relevant signal for the follow-up engine.
 */
const RELEVANT_SIGNAL = /^(active|not scheduled yet|hired|job hired|scheduled|job scheduled|in progress|job in progress|done|job done|not hired|no hire|closed|archived)$/i;

export function isRelevantThumbtackSignal(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return RELEVANT_SIGNAL.test(raw.trim());
}
