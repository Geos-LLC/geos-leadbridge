/**
 * Lead status display helper.
 *
 * The backend stores canonical statuses (see src/leads/canonical-status.ts on
 * the server). After the 2026-06-08 status simplification, the UI groups them
 * into 4 outcome-aligned buckets that mirror the analytics classification:
 *
 *   Active           = new / engaged (+ legacy contacted, plus quoted, in_progress)
 *   Booked           = booked      (+ legacy scheduled)
 *   Completed        = completed
 *   Lost             = lost / cancelled (+ no_show, archived)
 *
 * The dedicated Archived UI bucket was retired — `archived` Lead.status rows
 * fold into Lost (matching Yelp's archive semantic which already mapped to
 * 'lost'). Raw platformStatus='archived' is still available as source data
 * but is not exposed through this helper.
 *
 * Legacy raw values (from older platform-sync writes) are mapped display-only
 * via LEGACY_DISPLAY_MAP — never stored back to the DB.
 */

export type StatusGroupId =
  | 'active'
  | 'booked'
  | 'completed'
  | 'lost'
  | 'unknown';

export interface StatusGroup {
  id: StatusGroupId;
  label: string;
  statuses: readonly string[];
}

export const STATUS_GROUPS: readonly StatusGroup[] = [
  // 'contacted' kept as legacy-safe — should be zero rows post-migration but
  // tolerated if any drift remains. 'quoted' and 'in_progress' are legal-but-
  // inactive canonical values that route here so they never render as "Lost".
  { id: 'active',    label: 'Active',    statuses: ['new', 'engaged', 'contacted', 'quoted', 'in_progress'] },
  // 'scheduled' kept as legacy-safe synonym for booked.
  { id: 'booked',    label: 'Booked',    statuses: ['booked', 'scheduled'] },
  { id: 'completed', label: 'Completed', statuses: ['completed'] },
  // archived/no_show fold into Lost — see leadStatus.ts header.
  { id: 'lost',      label: 'Lost',      statuses: ['lost', 'cancelled', 'no_show', 'archived'] },
];

/**
 * Display-only mapping for legacy/non-canonical raw values that may still
 * sit on old leads. Never written back to the DB; purely for badge display
 * and filter matching. Keys are lowercase + trimmed; the normalize() helper
 * matches case-insensitively.
 *
 * Pre-canonical writers used 'Open' / 'active' for the active-pipeline state
 * (see webhooks.service.ts pre-2026-04-30) — both fold into 'new'.
 *
 * Thumbtack Partner API also writes 'Open' / 'Picked' / 'Canceled' as initial
 * Lead.status until the inbox-scraping Chrome extension lands a canonical value
 * (see thumbtack-status-map.ts comment: "the granular UI states are
 * extension-scraped separately"). 'Picked' folds to 'new' so the lead surfaces
 * under Active until a real signal comes in; 'canceled' (American spelling)
 * folds to canonical 'cancelled' (No hire).
 */
export const LEGACY_DISPLAY_MAP: Readonly<Record<string, string>> = {
  open: 'new',
  active: 'new',
  picked: 'new',
  canceled: 'cancelled',
  // Post-simplification: hired/scheduled raw values both display as Booked.
  hired: 'booked',
  done: 'completed',
  'not hired': 'lost',
  not_hired: 'lost',
  closed: 'lost',
};

const STATUS_TO_GROUP_ID: Readonly<Record<string, StatusGroupId>> = (() => {
  const m: Record<string, StatusGroupId> = {};
  for (const g of STATUS_GROUPS) for (const s of g.statuses) m[s] = g.id;
  return m;
})();

/** Normalize: lowercase + trim + legacy map. Returns the canonical key (may not be in STATUS_TO_GROUP_ID). */
function normalize(status: string | null | undefined): string {
  const raw = (status ?? '').toString().toLowerCase().trim().replace(/\s+/g, ' ');
  return LEGACY_DISPLAY_MAP[raw] ?? raw;
}

/** Returns the group id for any raw or legacy status, or 'unknown' when nothing matches. */
export function displayGroup(status: string | null | undefined): StatusGroupId {
  return STATUS_TO_GROUP_ID[normalize(status)] ?? 'unknown';
}

/** Human-readable label for a raw status. Falls back to "—" when unknown. */
export function displayLabel(status: string | null | undefined): string {
  const id = displayGroup(status);
  if (id === 'unknown') return '—';
  return STATUS_GROUPS.find((g) => g.id === id)!.label;
}

/**
 * Maps a status to the StatusPill kind used elsewhere. New canonical kinds
 * (active/booked/completed/lost) are added directly to the pill component;
 * this helper hands them back to callers.
 */
export type StatusPillKind =
  | 'active'
  | 'booked'
  | 'completed'
  | 'lost'
  | 'neutral';

export function displayPillKind(status: string | null | undefined): StatusPillKind {
  const id = displayGroup(status);
  return id === 'unknown' ? 'neutral' : id;
}

/**
 * Filter dropdown options. The "all" option is added by the consumer.
 */
export const STATUS_FILTER_OPTIONS: readonly { id: StatusGroupId; label: string }[] =
  STATUS_GROUPS.map((g) => ({ id: g.id, label: g.label }));

/** Predicate: does the lead's raw status match the group filter id. */
export function matchesGroupFilter(status: string | null | undefined, group: StatusGroupId): boolean {
  return displayGroup(status) === group;
}
