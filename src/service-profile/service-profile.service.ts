/**
 * ServiceProfileService — Phase 1 read-side resolver.
 *
 * Selects the right ServiceProfile for a lead and merges any
 * per-location override from SavedAccount.serviceOverridesJson over
 * the profile's base pricing/FAQ.
 *
 * Phase 1 scope:
 *  - Read-side only. No writes to ServiceProfile from this service.
 *  - Dual-read: if no profile matches AND the tenant has no default,
 *    returns 'legacy_fallback' so the caller reads the legacy
 *    SavedAccount columns. Existing tenants without a backfilled
 *    profile see zero behavior change.
 *  - Draft profile gating: if the matched profile is in draft, returns
 *    'ai_paused' so the caller can skip auto-reply. Lead lifecycle
 *    independent — lead still created/tracked/notified.
 *  - Archived profiles are excluded from matching entirely.
 *
 * Resolution priority (in order, first match wins):
 *   1. Lead.categoryId   → mapping with matching providerCategoryId
 *   2. Lead.category     → mapping with case-insensitive name match
 *   3. User.defaultServiceProfileId fallback
 *
 * Operator-pinned override is reserved for a Phase 1b PR (needs a UI
 * surface that doesn't exist yet).
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import {
  LeadForResolver,
  ResolvedProfile,
  SavedAccountForResolver,
  ServiceOverrides,
  extractAiPlaybookV2,
  isEffectivelyEmpty,
  mergeFaqJson,
  mergePricingJson,
  parseMappings,
  parseServiceOverrides,
} from './service-profile.types';

/**
 * Per-field source tracking for telemetry. The top-level `source` field
 * answers "did a ServiceProfile drive this call?" (true even if some
 * fields fell back). `fieldSources` answers "which side actually
 * supplied each field?" — useful for monitoring how often the
 * per-field fallback fires (and therefore which tenants still have
 * legacy data the profile didn't migrate).
 */
type FieldSource = 'service_profile' | 'legacy_saved_account' | 'none';
type FieldSources = {
  pricing: FieldSource;
  faq: FieldSource;
  aiInstructions: FieldSource;
};

@Injectable()
export class ServiceProfileService {
  private readonly logger = new Logger(ServiceProfileService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Main entry point. Picks a ServiceProfile for the lead, merges
   * SavedAccount overrides on top, and returns either:
   *  - 'resolved' values the caller should use,
   *  - 'ai_paused' if the matched profile is draft,
   *  - 'legacy_fallback' if no profile applies (caller reads legacy).
   *
   * Never throws — any DB error degrades to legacy_fallback with a
   * warn log, since the only consequence is "use the old read path."
   */
  async resolveForLead(
    lead: LeadForResolver,
    savedAccount: SavedAccountForResolver | null,
  ): Promise<ResolvedProfile> {
    try {
      // Pull the tenant's active+draft profiles + the default pointer
      // in one round trip. Archived profiles are excluded server-side
      // so they can't even be considered for matching.
      const [profiles, user] = await Promise.all([
        this.prisma.serviceProfile.findMany({
          where: {
            userId: lead.userId,
            status: { in: ['active', 'draft'] },
          },
        }),
        this.prisma.user.findUnique({
          where: { id: lead.userId },
          select: { defaultServiceProfileId: true },
        }),
      ]);

      if (profiles.length === 0) {
        return { status: 'legacy_fallback', reason: 'no_default_profile' };
      }

      // Priority 1+2: try to match by mapping. categoryId wins; name
      // is the fallback. The first match across the iteration wins,
      // so callers that want strict priority should put categoryId
      // mappings first (we don't enforce ordering since both lookups
      // run independently below).
      let matched: typeof profiles[number] | null = null;
      let matchedBy: 'categoryId' | 'categoryName' | 'default' = 'default';

      if (lead.categoryId) {
        for (const p of profiles) {
          const mappings = parseMappings(p.providerCategoryMappingsJson);
          if (mappings.some((m) => m.providerCategoryId === lead.categoryId)) {
            matched = p;
            matchedBy = 'categoryId';
            break;
          }
        }
      }

      if (!matched && lead.category) {
        const normalized = lead.category.trim().toLowerCase();
        if (normalized.length > 0) {
          for (const p of profiles) {
            const mappings = parseMappings(p.providerCategoryMappingsJson);
            if (
              mappings.some(
                (m) => typeof m.categoryName === 'string' && m.categoryName.toLowerCase() === normalized,
              )
            ) {
              matched = p;
              matchedBy = 'categoryName';
              break;
            }
          }
        }
      }

      // Priority 3: fall through to default.
      if (!matched && user?.defaultServiceProfileId) {
        const defaultMatch = profiles.find((p) => p.id === user.defaultServiceProfileId);
        if (defaultMatch) {
          matched = defaultMatch;
          matchedBy = 'default';
        }
      }

      if (!matched) {
        return { status: 'legacy_fallback', reason: 'no_profile_matched_and_no_default' };
      }

      // Draft gating — even if matched, AI auto-reply is paused.
      if (matched.status === 'draft') {
        return {
          status: 'ai_paused',
          profileId: matched.id,
          profileName: matched.name,
          reason: 'draft_profile',
        };
      }

      // Merge SavedAccount override (if any) on top of profile base.
      const overrides: ServiceOverrides = parseServiceOverrides(
        savedAccount?.serviceOverridesJson ?? null,
      );
      const ownOverride = overrides[matched.id] ?? {};

      return {
        status: 'resolved',
        profileId: matched.id,
        profileName: matched.name,
        effectivePricingJson: mergePricingJson(
          matched.pricingJson ?? null,
          ownOverride.pricingDeltasJson,
        ),
        effectiveFaqJson: mergeFaqJson(matched.faqJson ?? null, ownOverride.faqAdditionsJson),
        effectiveAiInstructionsJson: matched.aiInstructionsJson ?? null,
        matchedBy,
      };
    } catch (err: any) {
      this.logger.warn(`[service-profile] resolveForLead failed: ${err?.message ?? err}`);
      return { status: 'legacy_fallback', reason: 'no_default_profile' };
    }
  }

  /**
   * Convenience wrapper for the AI prompt assembler: returns the
   * effective pricing + FAQ + AI instructions the assembler should
   * use, with **per-field fallback** to SavedAccount when the matched
   * ServiceProfile is missing that specific field.
   *
   * Phase 1 callers: ai.controller.ts preview-for-lead, preview-with-context.
   *
   * Returns the same shape regardless of source, so the assembler
   * doesn't need branching. `fieldSources` is included for telemetry
   * — callers can ignore it.
   *
   * The per-field fallback is what stops the Spotless-shaped incident
   * from PR #244: a default profile backfilled from an account whose
   * faqJson was null would have wiped the tenant's FAQ for every
   * lead. With per-field fallback, an empty profile field falls
   * through to the SavedAccount equivalent rather than overriding it
   * with null.
   */
  async resolveEffectivePromptInputs(
    lead: LeadForResolver,
    savedAccount: SavedAccountForResolver | null,
  ): Promise<{
    pricingJson: string | null;
    faqJson: string | null;
    aiInstructionsJson: string | null;
    aiPaused: boolean;
    profileId: string | null;
    source: 'service_profile' | 'legacy_saved_account';
    fieldSources: FieldSources;
  }> {
    const resolved = await this.resolveForLead(lead, savedAccount);

    if (resolved.status === 'ai_paused') {
      return {
        pricingJson: null,
        faqJson: null,
        aiInstructionsJson: null,
        aiPaused: true,
        profileId: resolved.profileId,
        source: 'service_profile',
        fieldSources: { pricing: 'none', faq: 'none', aiInstructions: 'none' },
      };
    }

    // Legacy SavedAccount values we may need to fall through to.
    const legacyPricing = savedAccount?.servicePricingJson ?? null;
    const legacyFaq = savedAccount?.faqJson ?? null;
    const legacyAi = extractAiPlaybookV2(savedAccount?.followUpSettingsJson ?? null);

    if (resolved.status === 'resolved') {
      const profilePricing = resolved.effectivePricingJson;
      const profileFaq = resolved.effectiveFaqJson;
      const profileAi = resolved.effectiveAiInstructionsJson;

      // Per-field fallback: profile wins when it has content, else SA.
      // `isEffectivelyEmpty` treats null, '', '[]', '{}', and unparseable
      // strings as empty — anything past that is preserved verbatim.
      const pricingUseLegacy = isEffectivelyEmpty(profilePricing);
      const faqUseLegacy = isEffectivelyEmpty(profileFaq);
      const aiUseLegacy = isEffectivelyEmpty(profileAi);

      const pricingJson = pricingUseLegacy ? legacyPricing : profilePricing;
      const faqJson = faqUseLegacy ? legacyFaq : profileFaq;
      const aiInstructionsJson = aiUseLegacy ? legacyAi : profileAi;

      const fieldSources: FieldSources = {
        pricing: pricingJson == null ? 'none' : pricingUseLegacy ? 'legacy_saved_account' : 'service_profile',
        faq: faqJson == null ? 'none' : faqUseLegacy ? 'legacy_saved_account' : 'service_profile',
        aiInstructions: aiInstructionsJson == null ? 'none' : aiUseLegacy ? 'legacy_saved_account' : 'service_profile',
      };

      return {
        pricingJson,
        faqJson,
        aiInstructionsJson,
        aiPaused: false,
        profileId: resolved.profileId,
        source: 'service_profile',
        fieldSources,
      };
    }

    // legacy_fallback — read directly from SavedAccount columns. The AI
    // instructions extractor now runs here too so consumers that adopt
    // aiInstructionsJson get the legacy data even when no profile exists.
    return {
      pricingJson: legacyPricing,
      faqJson: legacyFaq,
      aiInstructionsJson: legacyAi,
      aiPaused: false,
      profileId: null,
      source: 'legacy_saved_account',
      fieldSources: {
        pricing: legacyPricing == null ? 'none' : 'legacy_saved_account',
        faq: legacyFaq == null ? 'none' : 'legacy_saved_account',
        aiInstructions: legacyAi == null ? 'none' : 'legacy_saved_account',
      },
    };
  }
}
