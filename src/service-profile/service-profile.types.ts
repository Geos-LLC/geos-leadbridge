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
