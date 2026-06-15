/**
 * Lead status display helper — marketplace terminology.
 *
 * The backend stores canonical statuses (see src/leads/canonical-status.ts on
 * the server). The UI groups them into outcome-aligned buckets using the
 * marketplace terms LB users know from Thumbtack / Yelp:
 *
 *   Active     = new / engaged (+ legacy contacted, plus quoted, in_progress)
 *   Scheduled  = booked        (+ legacy 'scheduled')
 *   Done       = completed
 *   Lost       = lost / cancelled (+ no_show, archived)
 *
 * The Analytics dashboard surfaces Cancelled as a separate KPI card (it
 * carries different operational meaning than Lost) — see Analytics.tsx. The
 * `lost` group here keeps them together for filter / pill purposes where
 * the distinction isn't surfaced.
 *
 * Legacy raw values (from older platform-sync writes) are mapped display-only
 * via LEGACY_DISPLAY_MAP — never stored back to the DB.
 */

export type StatusGroupId =
  | 'active'
  | 'booked'        // id stays 'booked' (canonical Lead.status value); label is "Scheduled"
  | 'completed'     // id stays 'completed' (canonical); label is "Done"
  | 'lost'
  | 'refunded'      // NOT a Lead.status — Lead.refundedAt-driven. See FILTER_PSEUDO_GROUPS.
  | 'refundable'    // NOT a Lead.status — Lead.refundableFlag-driven. See FILTER_PSEUDO_GROUPS.
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
  // booked → "Scheduled" in UX; 'scheduled' legacy synonym kept.
  { id: 'booked',    label: 'Scheduled', statuses: ['booked', 'scheduled'] },
  // completed → "Done" in UX.
  { id: 'completed', label: 'Done',      statuses: ['completed'] },
  // archived/no_show fold into Lost — see leadStatus.ts header.
  { id: 'lost',      label: 'Lost',      statuses: ['lost', 'cancelled', 'no_show', 'archived'] },
];

/**
 * "Pseudo-group" filter ids that don't match Lead.status — they match
 * a different Lead field. Listed in STATUS_FILTER_OPTIONS so users can
 * filter on them, but excluded from STATUS_GROUPS / displayGroup() so
 * a refunded lead still renders its real status badge ("Lost", "Active",
 * etc.) AND a separate refund pill.
 *
 * Current pseudo-groups:
 *   - 'refunded': Lead.refundedAt is set (or chargeStateRaw === 'Refunded').
 *                 See follow-up-scheduler.service.ts → classifyPlatformUnreachable
 *                 + the hourly sweepThumbtackChargeState cron.
 */
export const FILTER_PSEUDO_GROUPS: readonly { id: StatusGroupId; label: string }[] = [
  { id: 'refunded', label: 'Refunded' },
  // UI label uses the descriptive "Eligible for refund" — the dropdown
  // benefits from explicit phrasing, while the compact lead-card badge
  // keeps the shorter "Refundable" tag. Same underlying predicate
  // (matchesRefundableFilter — Lead.refundableFlag active + not refunded).
  { id: 'refundable', label: 'Eligible for refund' },
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
  // Filter pseudo-groups ('refunded', 'refundable') are never returned by
  // displayGroup() in practice — STATUS_TO_GROUP_ID is built from
  // STATUS_GROUPS only — but the explicit narrowing satisfies TS and
  // future-proofs against any drift in the type.
  if (id === 'unknown' || id === 'refunded' || id === 'refundable') return 'neutral';
  return id;
}

/**
 * Filter dropdown options. The "all" option is added by the consumer.
 * Status groups come first; pseudo-groups (Refunded) follow so they
 * appear after the canonical status pipeline in the dropdown.
 */
export const STATUS_FILTER_OPTIONS: readonly { id: StatusGroupId; label: string }[] = [
  ...STATUS_GROUPS.map((g) => ({ id: g.id, label: g.label })),
  ...FILTER_PSEUDO_GROUPS,
];

/** Predicate: does the lead's raw status match the group filter id. */
export function matchesGroupFilter(status: string | null | undefined, group: StatusGroupId): boolean {
  return displayGroup(status) === group;
}

/**
 * Predicate for the 'refunded' pseudo-filter. True when either:
 *   - Lead.refundedAt is set (the canonical "we observed a refund" signal), OR
 *   - Lead.chargeStateRaw === 'Refunded' (transient state where sweep
 *     captured chargeState but hadn't yet flipped refundedAt in the same
 *     write — defense-in-depth, real-world both ship together).
 *
 * Caller (Messages.tsx filter chain) routes the 'refunded' filter through
 * this helper instead of matchesGroupFilter, since Lead.status alone never
 * tells you if a lead was refunded.
 */
export function matchesRefundedFilter(lead: {
  refundedAt?: string | null;
  chargeStateRaw?: string | null;
}): boolean {
  if (lead.refundedAt) return true;
  if ((lead.chargeStateRaw ?? '').toLowerCase() === 'refunded') return true;
  return false;
}

/**
 * Predicate for the 'refundable' pseudo-filter. True when the lead has a
 * non-null `refundableFlag` AND is NOT already confirmed-refunded
 * (Refunded takes priority — same precedence rule used in the UI badge).
 *
 * The backend only surfaces flags with validUntil > now, so we don't
 * re-check expiry here.
 */
export function matchesRefundableFilter(lead: {
  refundedAt?: string | null;
  chargeStateRaw?: string | null;
  refundableFlag?: { validUntil: string } | null;
}): boolean {
  if (matchesRefundedFilter(lead)) return false;
  return !!lead.refundableFlag;
}
