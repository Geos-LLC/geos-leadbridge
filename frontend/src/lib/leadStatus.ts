/**
 * Lead status display helper.
 *
 * The backend stores canonical statuses (see src/leads/canonical-status.ts on
 * the server). The UI groups them into 6 buckets so operators see a tighter
 * vocabulary than the engineering pipeline:
 *
 *   Active         = new / contacted / engaged / quoted
 *   Scheduled      = booked / scheduled
 *   Job in progress = in_progress
 *   Done           = completed
 *   No hire        = lost / cancelled / no_show
 *   Archived       = archived
 *
 * Legacy raw values (from older platform-sync writes) are mapped display-only
 * via LEGACY_DISPLAY_MAP — never stored back to the DB.
 */

export type StatusGroupId =
  | 'active'
  | 'scheduled'
  | 'in_progress'
  | 'done'
  | 'no_hire'
  | 'archived'
  | 'unknown';

export interface StatusGroup {
  id: StatusGroupId;
  label: string;
  statuses: readonly string[];
}

export const STATUS_GROUPS: readonly StatusGroup[] = [
  { id: 'active',       label: 'Active',           statuses: ['new', 'contacted', 'engaged', 'quoted'] },
  { id: 'scheduled',    label: 'Scheduled',        statuses: ['booked', 'scheduled'] },
  { id: 'in_progress',  label: 'Job in progress',  statuses: ['in_progress'] },
  { id: 'done',         label: 'Done',             statuses: ['completed'] },
  { id: 'no_hire',      label: 'No hire',          statuses: ['lost', 'cancelled', 'no_show'] },
  { id: 'archived',     label: 'Archived',         statuses: ['archived'] },
];

/**
 * Display-only mapping for legacy/non-canonical raw values that may still
 * sit on old leads. Never written back to the DB; purely for badge display
 * and filter matching.
 */
export const LEGACY_DISPLAY_MAP: Readonly<Record<string, string>> = {
  hired: 'scheduled',
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
 * (active/scheduled/in_progress/done/no_hire/archived) are added directly to
 * the pill component; this helper hands them back to callers.
 */
export type StatusPillKind =
  | 'active'
  | 'scheduled'
  | 'in_progress'
  | 'done'
  | 'no_hire'
  | 'archived'
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
