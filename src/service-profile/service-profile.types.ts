/**
 * ServiceProfile types — shapes shared between the resolver service,
 * its tests, and downstream consumers (ai.controller and future
 * automation/notifications integrations).
 */

/**
 * Per-provider category attachment stored in
 * ServiceProfile.providerCategoryMappingsJson (an array of these).
 *
 * Either `providerCategoryId` or `categoryName` must be set — the
 * resolver tries ID match first, then case-insensitive name match.
 */
export type ProviderCategoryMapping = {
  provider: 'thumbtack' | 'yelp' | 'manual';
  providerCategoryId?: string;
  categoryName?: string;
};

/**
 * Shape of SavedAccount.serviceOverridesJson — per-location deltas
 * over the ServiceProfile base config. Keyed by serviceProfileId so
 * multi-profile tenants can override each profile independently.
 *
 * Phase 1 supports pricing + faq deltas only. Future phases can extend.
 */
export type ServiceOverrides = {
  [serviceProfileId: string]: {
    pricingDeltasJson?: string;
    faqAdditionsJson?: string;
  };
};

/**
 * Output of the resolver's main entry point. Either:
 *  - status='resolved' — a profile applies, the caller should use its
 *    pricing/FAQ/AI overlay
 *  - status='ai_paused' — a profile applies but is in draft; the AI
 *    auto-reply path should be gated off (lead still tracked)
 *  - status='legacy_fallback' — no profile applies; caller reads the
 *    legacy SavedAccount columns directly
 */
export type ResolvedProfile =
  | {
      status: 'resolved';
      profileId: string;
      profileName: string;
      effectivePricingJson: string | null;
      effectiveFaqJson: string | null;
      effectiveAiInstructionsJson: string | null;
      matchedBy: 'categoryId' | 'categoryName' | 'default';
    }
  | {
      status: 'ai_paused';
      profileId: string;
      profileName: string;
      reason: 'draft_profile';
    }
  | {
      status: 'legacy_fallback';
      reason: 'no_default_profile' | 'no_profile_matched_and_no_default';
    };

/**
 * Slimmed lead inputs for the resolver. Keeping a narrow type avoids
 * passing the full Lead model everywhere and makes test fixtures easy.
 */
export type LeadForResolver = {
  id: string;
  userId: string;
  category: string | null;
  // Lead.categoryId is added in PR #241 (TT categoryID extraction). When
  // that lands on staging, this field starts populating. Until then it
  // stays null — name-based matching covers the common case.
  categoryId?: string | null;
};

export type SavedAccountForResolver = {
  id: string;
  servicePricingJson: string | null;
  faqJson: string | null;
  serviceOverridesJson?: string | null;
  // Legacy carrier of aiPlaybookV2 — the resolver pulls .aiPlaybookV2
  // out via extractAiPlaybookV2 when the matched ServiceProfile has no
  // aiInstructionsJson of its own. Phase 1 backfill does not migrate
  // this nested data (different shape per section), so the per-field
  // fallback is the bridge until a future write switch.
  followUpSettingsJson?: string | null;
};

/**
 * Defensive parse — returns [] on any shape that isn't an array of
 * objects. Used by the resolver when reading
 * ServiceProfile.providerCategoryMappingsJson back from Prisma's
 * `Json` type.
 */
export function parseMappings(raw: unknown): ProviderCategoryMapping[] {
  if (!Array.isArray(raw)) return [];
  const out: ProviderCategoryMapping[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.provider !== 'string') continue;
    if (r.provider !== 'thumbtack' && r.provider !== 'yelp' && r.provider !== 'manual') continue;
    out.push({
      provider: r.provider,
      providerCategoryId:
        typeof r.providerCategoryId === 'string' && r.providerCategoryId.length > 0
          ? r.providerCategoryId
          : undefined,
      categoryName:
        typeof r.categoryName === 'string' && r.categoryName.trim().length > 0
          ? r.categoryName.trim()
          : undefined,
    });
  }
  return out;
}

export function parseServiceOverrides(raw: string | null | undefined): ServiceOverrides {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ServiceOverrides)
      : {};
  } catch {
    return {};
  }
}

/**
 * Merge SavedAccount's per-location pricing delta over the
 * ServiceProfile's base pricing JSON. Phase 1: shallow merge of the
 * top-level object. Delta keys win; missing keys fall through to base.
 *
 * Pricing JSON shape isn't standardized across the codebase, so we
 * keep this generic — if either side is invalid JSON, the other side
 * wins as-is. Never throws.
 */
export function mergePricingJson(
  baseJson: string | null,
  overrideJson: string | undefined,
): string | null {
  if (!overrideJson) return baseJson;
  if (!baseJson) return overrideJson;
  try {
    const base = JSON.parse(baseJson);
    const override = JSON.parse(overrideJson);
    if (
      base &&
      typeof base === 'object' &&
      !Array.isArray(base) &&
      override &&
      typeof override === 'object' &&
      !Array.isArray(override)
    ) {
      return JSON.stringify({ ...base, ...override });
    }
    // Non-object payload (array or primitive) — override wins outright.
    return overrideJson;
  } catch {
    return baseJson;
  }
}

/**
 * Merge SavedAccount's FAQ additions onto the ServiceProfile base.
 * Both sides are arrays of `{ question, answer }` objects in current
 * usage; we append the delta entries to the base array. Defensive on
 * shape — if either side is not an array, return the side that is.
 */
export function mergeFaqJson(
  baseJson: string | null,
  additionsJson: string | undefined,
): string | null {
  if (!additionsJson) return baseJson;
  if (!baseJson) return additionsJson;
  try {
    const base = JSON.parse(baseJson);
    const additions = JSON.parse(additionsJson);
    if (Array.isArray(base) && Array.isArray(additions)) {
      return JSON.stringify([...base, ...additions]);
    }
    return baseJson;
  } catch {
    return baseJson;
  }
}

/**
 * "Does this JSON blob carry meaningful content?"
 *
 * Returns true when:
 *  - the value is null / undefined / empty string
 *  - the value is whitespace
 *  - the value JSON-parses to `[]`, `{}`, or null
 *  - the value isn't valid JSON at all (defensive)
 *
 * Used by the per-field fallback: a profile column carrying `"[]"` is
 * semantically the same as null for prompt-assembly purposes, so the
 * resolver should fall through to the SavedAccount equivalent rather
 * than pass an empty array into buildFaqBlock.
 *
 * Conservative — when in doubt, returns false (treats unknown shapes
 * as "has content"). Better to over-include than to silently drop.
 */
export function isEffectivelyEmpty(json: string | null | undefined): boolean {
  if (json == null) return true;
  const trimmed = json.trim();
  if (trimmed.length === 0) return true;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed == null) return true;
    if (Array.isArray(parsed) && parsed.length === 0) return true;
    if (typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0) return true;
    return false;
  } catch {
    // Not parseable JSON — treat as empty so the fallback wins. The
    // alternative (treating it as "has content") would feed garbage
    // into the AI assembler.
    return true;
  }
}

/**
 * Extract the `aiPlaybookV2` sub-tree from a SavedAccount's
 * `followUpSettingsJson` blob. Returns it re-stringified, or null when
 * the blob is missing, unparseable, or has no V2 sections with
 * meaningful `customInstructions`.
 *
 * Today's storage (from users.service.ts:850):
 *   followUpSettingsJson = JSON.stringify({
 *     ...existingSettings,
 *     aiPlaybookV2: {
 *       brand_voice: { customInstructions: "..." },
 *       faq:         { customInstructions: "..." },
 *       pricing_guidance: { ... },
 *       ...
 *     }
 *   })
 *
 * The resolver uses this when ServiceProfile.aiInstructionsJson is
 * empty — a tenant who already authored V2 sections per-account
 * shouldn't lose them just because their default ServiceProfile was
 * backfilled with a null aiInstructionsJson column.
 */
export function extractAiPlaybookV2(followUpSettingsJson: string | null | undefined): string | null {
  if (!followUpSettingsJson) return null;
  try {
    const parsed = JSON.parse(followUpSettingsJson);
    const v2 = parsed?.aiPlaybookV2;
    if (!v2 || typeof v2 !== 'object' || Array.isArray(v2)) return null;
    const sections = Object.values(v2);
    if (sections.length === 0) return null;
    // Only return content when at least one section has a non-empty
    // customInstructions string. Empty sections aren't worth
    // preserving — they'd just bloat the AI prompt assembler input.
    const hasContent = sections.some((section) => {
      if (!section || typeof section !== 'object') return false;
      const ci = (section as Record<string, unknown>).customInstructions;
      return typeof ci === 'string' && ci.trim().length > 0;
    });
    if (!hasContent) return null;
    return JSON.stringify(v2);
  } catch {
    return null;
  }
}

/**
 * Bridge the resolver's `aiInstructionsJson` into the shape
 * `renderPlaybookBlock` already consumes (legacy `followUpSettingsJson`
 * with nested `aiPlaybookV2`).
 *
 * Phase 1b note: today the resolver's per-field fallback re-extracts
 * the SAME `aiPlaybookV2` sub-tree the legacy renderer would have read,
 * so this helper is a near-no-op. Its purpose is forward compatibility
 * for Phase 2, when tenants will start authoring profile-level
 * `aiInstructionsJson` separately from the per-account V2 storage —
 * synthesizing the legacy shape from the profile-side value lets every
 * downstream consumer keep calling `renderPlaybookBlock` unchanged.
 *
 * - profile value present → splice it as the `aiPlaybookV2` key on top
 *   of whatever else lives in the legacy settings blob (`priceQuoteMode`,
 *   `qualificationV2`, `followUpStrategy`, etc.).
 * - profile value absent → return the legacy blob untouched.
 *
 * Always returns a JSON string (or null) — the same shape callers
 * already pass to `renderPlaybookBlock({ followUpSettingsJson })`.
 */
export function buildPlaybookSettingsForRenderer(
  profileAiInstructionsJson: string | null,
  legacyFollowUpSettingsJson: string | null,
): string | null {
  if (!profileAiInstructionsJson) return legacyFollowUpSettingsJson;
  let v2: unknown;
  try {
    v2 = JSON.parse(profileAiInstructionsJson);
  } catch {
    return legacyFollowUpSettingsJson;
  }
  let legacyParsed: Record<string, unknown> = {};
  if (legacyFollowUpSettingsJson) {
    try {
      const parsed = JSON.parse(legacyFollowUpSettingsJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        legacyParsed = parsed as Record<string, unknown>;
      }
    } catch {
      // Keep legacyParsed = {} so we still emit a valid blob below.
    }
  }
  return JSON.stringify({ ...legacyParsed, aiPlaybookV2: v2 });
}

/**
 * Inputs the picker needs from a SavedAccount row. Subset of the full
 * SavedAccount Prisma row — kept narrow so the script's findMany select
 * stays small and tests can build fixtures cheaply.
 */
export type PrimaryPickerInput = {
  id: string;
  servicePricingJson: string | null;
  faqJson: string | null;
  lastUsedAt: Date | null;
};

/**
 * Pick the "primary" SavedAccount for backfill seeding. Phase 1's
 * naive "most-recently-used" heuristic broke for Spotless: Wesley
 * Chapel's account was touched last but had null faqJson — so the
 * tenant's default ServiceProfile inherited null FAQ even though 6
 * sibling accounts carried a populated one.
 *
 * Phase 1b tiered preference:
 *   Tier 1 — both servicePricingJson AND faqJson populated (best)
 *   Tier 2 — servicePricingJson populated (FAQ missing)
 *   Tier 3 — faqJson populated (pricing missing)
 *   Tier 4 — neither (fallback so we always pick *something*)
 * Within tier, ties break on most-recently-used.
 *
 * Pure function — easy to unit-test without a DB. The backfill script
 * loads all accounts for a user with findMany and runs this picker
 * client-side. Pulling all rows for one user is cheap (Spotless's
 * worst case is 7 rows).
 */
export function pickPrimarySavedAccount<T extends PrimaryPickerInput>(accounts: T[]): T | null {
  if (accounts.length === 0) return null;

  const tier = (a: PrimaryPickerInput): number => {
    const hasPricing = a.servicePricingJson != null && a.servicePricingJson.length > 0;
    const hasFaq = a.faqJson != null && a.faqJson.length > 0;
    if (hasPricing && hasFaq) return 1;
    if (hasPricing) return 2;
    if (hasFaq) return 3;
    return 4;
  };

  return [...accounts].sort((a, b) => {
    const tDiff = tier(a) - tier(b);
    if (tDiff !== 0) return tDiff;
    const aTime = a.lastUsedAt?.getTime() ?? 0;
    const bTime = b.lastUsedAt?.getTime() ?? 0;
    return bTime - aTime;
  })[0];
}
