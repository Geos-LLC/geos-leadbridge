/**
 * Service-group classifier.
 *
 * Maps a free-text `Lead.category` string to one or more service groups
 * the resolver can route on. Replaces the exact-string match that
 * required tenants to enumerate every provider variant (e.g. Yelp ships
 * "Regular home cleaning", "Deep cleaning", "Move-in or move-out
 * cleaning" — six distinct strings for the same business need).
 *
 * Groups:
 *   - 'cleaning'         — house/maid/janitorial/housekeeping
 *   - 'upholstery_carpet' — upholstery, furniture, carpet, rug
 *   - 'other'            — fallback when nothing matches
 *
 * Returns multiple candidate groups when a string indicates more than
 * one (e.g. Yelp's "Carpet and upholstery cleaning" hits both
 * upholstery_carpet AND cleaning). Caller walks the candidate list in
 * priority order and picks the first group it has a profile for.
 *
 * Priority order (most-specific first):
 *   PRIORITY = ['upholstery_carpet', 'cleaning', 'other']
 *
 * Rationale: a tenant who runs both cleaning + upholstery wants carpet
 * leads quoted with carpet rates, not house-cleaning rates. So when the
 * string matches both groups, the upholstery_carpet profile wins.
 * Tenants who only have a cleaning profile still match the cleaning
 * candidate, so they continue quoting (no regression).
 */

export type ServiceGroup = 'cleaning' | 'upholstery_carpet' | 'other';

export const SERVICE_GROUP_PRIORITY: readonly ServiceGroup[] = [
  'upholstery_carpet',
  'cleaning',
  'other',
] as const;

// Carpet / upholstery / furniture niche. Word boundaries keep
// "rugged" / "carbon" / etc. from triggering.
const UPHOLSTERY_CARPET_RE =
  /\b(carpet|rug|upholstery|furniture|sofa|couch|chair|drapery|drapes|curtains?)\b/i;

// Cleaning niche. "Maid" / "janitorial" / "housekeeping" /
// "post-construction cleaning" all roll up here. Singular vs plural
// handled via the optional 's' on a few stems.
const CLEANING_RE =
  /\b(cleaning|cleaners?|cleanup|maids?|janitorial|housekeeping|housekeeper)\b/i;

/**
 * Classify a single category string into candidate groups. Returns
 * groups in priority order so callers can short-circuit on the first
 * group their profile set supports.
 *
 * Empty / null / whitespace input → ['other'] so the caller still has
 * a deterministic fall-through.
 */
export function classifyLeadCategory(
  category: string | null | undefined,
): ServiceGroup[] {
  const text = (category ?? '').trim();
  if (text.length === 0) return ['other'];

  const matches: ServiceGroup[] = [];
  if (UPHOLSTERY_CARPET_RE.test(text)) matches.push('upholstery_carpet');
  if (CLEANING_RE.test(text)) matches.push('cleaning');

  if (matches.length === 0) return ['other'];
  // Re-order to PRIORITY ordering — both pushes above happened in code
  // order, not priority order, but in practice the array is identical.
  // We re-sort defensively in case future groups are added.
  return SERVICE_GROUP_PRIORITY.filter((g) => matches.includes(g));
}

/**
 * Reverse helper used by the migration that backfills `serviceGroup`
 * onto every ServiceProfile from its existing `providerCategoryMappingsJson`.
 * Examines all mapping strings, classifies each, and returns the most-
 * specific group seen (carpet > cleaning > other). When mappings list
 * categories from multiple groups, the more-specific group wins —
 * because manually setting an upholstery category implies the operator
 * cares about that niche specifically.
 */
export function deriveServiceGroupFromMappings(
  mappings: Array<{ provider?: string; categoryName?: string | null }>,
): ServiceGroup {
  let upholstery = 0;
  let cleaning = 0;
  for (const m of mappings) {
    const groups = classifyLeadCategory(m.categoryName ?? '');
    if (groups.includes('upholstery_carpet')) upholstery++;
    if (groups.includes('cleaning')) cleaning++;
  }
  if (upholstery > 0) return 'upholstery_carpet';
  if (cleaning > 0) return 'cleaning';
  return 'other';
}
