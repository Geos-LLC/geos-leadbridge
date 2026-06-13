/**
 * Business-info merger.
 *
 * Inputs come from three independent sources — Thumbtack on connect,
 * Yelp Fusion on connect, and the user's verified website. All three
 * write into the SAME canonical store: `playbookSeed.businessInformation`
 * on `User.websiteMetadataJson`. This module owns the merge rules so the
 * orchestration in users.service can stay readable.
 *
 * Five rules (per the spec):
 *   1. existing empty + new value         → write new (silent)
 *   2. existing same + new same           → no-op
 *   3. existing value + new empty         → keep existing (silent)
 *   4. existing value + new different     → queue as conflict (do NOT write)
 *   5. website-only soft fields           → write silently when empty
 *      (insurance, bonding, licensing, years, team, owner, etc.)
 *
 * Arrays (paymentMethods[], officeLocations[]) UNION rather than conflict.
 * A site listing more methods than Yelp's `attributes` block is normal and
 * shouldn't pop a modal.
 *
 * Source tracking lives alongside the seed in `websiteMetadataJson.sources`
 * as a flat `Record<'businessInformation.fieldKey', SourceMeta>` map. We
 * avoid wrapping each field in `{value, source}` to keep the existing
 * playbook-seed-applier readers unchanged.
 */

import type { PlaybookSeed } from './users.service';

export type BusinessInfoSource = 'thumbtack' | 'yelp' | 'website';

export interface SourceMeta {
  source: BusinessInfoSource;
  fetchedAt: string;
  /** Original raw value before our normalisation — useful for debugging. */
  rawValue?: any;
}

export interface BusinessInfoConflict {
  /** Stable ID so the resolver UI can ack a specific conflict. */
  id: string;
  /** Dotted path, e.g. "businessInformation.phone". */
  field: string;
  currentValue: any;
  currentSource?: BusinessInfoSource;
  newValue: any;
  newSource: BusinessInfoSource;
  detectedAt: string;
}

type BizInfo = NonNullable<PlaybookSeed['businessInformation']>;

/** Fields where the website is the only realistic source. We never produce a
 *  conflict for these — the site's value always wins when present. */
const WEBSITE_ONLY_FIELDS: readonly (keyof BizInfo)[] = [
  'yearsInBusiness',
  'teamSize',
  'ownerName',
  'suppliesPolicy',
  'petsPolicy',
  'insurance',
  'bonding',
  'licensing',
  'guarantees',
  'ecoFriendly',
];

/** Fields stored as arrays — we union rather than conflict. */
const ARRAY_FIELDS: readonly (keyof BizInfo)[] = [
  'paymentMethods',
  'officeLocations',
];

function normalize(v: any): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(normalize).join('|');
  return String(v).trim().toLowerCase().replace(/[\s.;:!?]+$/, '');
}

function isEmpty(v: any): boolean {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function makeId(field: string): string {
  return `${field}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export interface MergeArgs {
  existing: BizInfo | undefined;
  existingSources: Record<string, SourceMeta>;
  newPatch: Partial<BizInfo>;
  newSource: BusinessInfoSource;
  fetchedAt?: string;
  /** When true, override existing without producing conflicts. Used by the
   *  conflict-resolver "Use website value" action. Default false. */
  overrideExisting?: boolean;
}

export interface MergeResult {
  merged: BizInfo;
  /** Updated source map — only the keys we touched are rewritten. */
  sources: Record<string, SourceMeta>;
  /** Conflicts that need user resolution before they can land. */
  conflicts: BusinessInfoConflict[];
}

export function mergeBusinessInfo(args: MergeArgs): MergeResult {
  const existing = (args.existing || {}) as BizInfo;
  const sources = { ...args.existingSources };
  const merged: BizInfo = { ...existing };
  const conflicts: BusinessInfoConflict[] = [];
  const fetchedAt = args.fetchedAt || new Date().toISOString();
  const override = !!args.overrideExisting;

  const recordSource = (field: keyof BizInfo, rawValue?: any) => {
    sources[`businessInformation.${field}`] = {
      source: args.newSource,
      fetchedAt,
      ...(rawValue !== undefined ? { rawValue } : {}),
    };
  };

  // ARRAY FIELDS — union the values, dedupe case-insensitive. No conflicts.
  for (const field of ARRAY_FIELDS) {
    const incoming = args.newPatch[field] as string[] | undefined;
    if (!incoming || incoming.length === 0) continue;
    const current = (existing[field] as string[] | undefined) || [];
    const seen = new Set(current.map((v) => normalize(v)));
    let changed = false;
    const result = [...current];
    for (const v of incoming) {
      const n = normalize(v);
      if (n.length === 0 || seen.has(n)) continue;
      seen.add(n);
      result.push(v);
      changed = true;
    }
    if (changed) {
      (merged as any)[field] = result;
      recordSource(field, incoming);
    }
  }

  // SCALAR FIELDS — string-valued. Apply the 5 rules.
  for (const key of Object.keys(args.newPatch) as (keyof BizInfo)[]) {
    if (ARRAY_FIELDS.includes(key)) continue;
    const incomingRaw = args.newPatch[key];
    if (incomingRaw === undefined) continue;
    const incoming = typeof incomingRaw === 'string' ? incomingRaw.trim() : incomingRaw;
    if (isEmpty(incoming)) continue; // rule 3 (or no-op)

    const current = (existing as any)[key];
    if (isEmpty(current)) {
      // rule 1: write silently
      (merged as any)[key] = incoming;
      recordSource(key, incomingRaw);
      continue;
    }

    if (normalize(current) === normalize(incoming)) {
      // rule 2: same value — refresh the fetchedAt to keep source meta fresh
      // (handy for "last refreshed" UI later) but don't touch the value.
      recordSource(key, incomingRaw);
      continue;
    }

    if (WEBSITE_ONLY_FIELDS.includes(key) && args.newSource === 'website') {
      // rule 5: website is the canonical source for the "soft" facts.
      // We do NOT treat this as a conflict — the website wins.
      (merged as any)[key] = incoming;
      recordSource(key, incomingRaw);
      continue;
    }

    if (override) {
      // Conflict resolver granted explicit "use this value" — write it.
      (merged as any)[key] = incoming;
      recordSource(key, incomingRaw);
      continue;
    }

    // rule 4: queue as conflict — do NOT write.
    const existingSource = sources[`businessInformation.${key}`]?.source;
    conflicts.push({
      id: makeId(`businessInformation.${String(key)}`),
      field: `businessInformation.${String(key)}`,
      currentValue: current,
      currentSource: existingSource,
      newValue: incoming,
      newSource: args.newSource,
      detectedAt: fetchedAt,
    });
  }

  return { merged, sources, conflicts };
}

/**
 * Apply a single conflict resolution. Called from the resolver endpoint
 * when the user clicks "Use website" / "Keep current".
 *
 * action='use_new' → writes the new value, clears the conflict
 * action='keep'    → no value change, clears the conflict, records a
 *                    "user kept original" stamp so re-runs don't re-raise
 *                    it for the same site snapshot.
 */
export function applyConflictResolution(args: {
  existing: BizInfo | undefined;
  existingSources: Record<string, SourceMeta>;
  conflict: BusinessInfoConflict;
  action: 'use_new' | 'keep';
}): { merged: BizInfo; sources: Record<string, SourceMeta> } {
  const merged: BizInfo = { ...(args.existing || {}) } as BizInfo;
  const sources = { ...args.existingSources };
  if (args.action === 'use_new') {
    const key = args.conflict.field.replace(/^businessInformation\./, '') as keyof BizInfo;
    (merged as any)[key] = args.conflict.newValue;
    sources[args.conflict.field] = {
      source: args.conflict.newSource,
      fetchedAt: args.conflict.detectedAt,
    };
  }
  return { merged, sources };
}
