/**
 * Thumbtack → LeadBridge canonical status mapping.
 *
 * Thumbtack inbox statuses (scraped by the Chrome extension) are translated
 * into LB canonical pipeline values before being written to Lead.status. The
 * raw value is preserved separately on Lead.platformStatus (and the legacy
 * Lead.thumbtackStatus column, kept in sync by LeadStatusService.applyPlatformSync).
 *
 * | Thumbtack raw | LB canonical |
 * |---------------|--------------|
 * | Active        | contacted    |
 * | Hired         | booked       |
 * | Scheduled     | scheduled    |
 * | Done          | completed    |
 * | Not hired     | lost         |
 * | Closed        | lost         |
 * | Archived      | archived     |
 *
 * Unknown / empty values return null — callers must still update
 * platformStatus but must NOT touch Lead.status.
 */

export type ThumbtackLbStatus =
  | 'contacted'
  | 'booked'
  | 'scheduled'
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
      return 'contacted';
    case 'hired':
      return 'booked';
    case 'scheduled':
      return 'scheduled';
    case 'done':
      return 'completed';
    case 'not hired':
      return 'lost';
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
 * Keep in sync with the regex used at the call site.
 */
const RELEVANT_SIGNAL = /^(active|hired|scheduled|done|not hired|closed|archived)$/i;

export function isRelevantThumbtackSignal(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return RELEVANT_SIGNAL.test(raw.trim());
}
