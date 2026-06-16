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
  parseServiceAssignments,
} from './service-profile.types';
import { buildServiceProfileFromPreset } from './presets/service-presets';
import type { ServicePreset } from './presets/service-presets.types';

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

      // PR-E — account ↔ service assignment enforcement.
      //
      // The resolver runs this check before draft gating so a tenant
      // who hasn't enabled a service for an account never accidentally
      // pulls in stale draft content either.
      //
      //   null  → not configured, preserve legacy behavior (no change).
      //   []    → configured but empty, treat as "no service selected".
      //           Today the safest fallthrough is the existing default
      //           behavior — the matched profile still resolves so we
      //           don't break existing leads. The UI surfaces a "no
      //           services selected" warning so operators notice.
      //   [...] → enforcement on. Matched profile must be in the list
      //           or the resolver returns ai_paused/setup_mismatch.
      const assignments = parseServiceAssignments(
        savedAccount?.serviceProfileAssignmentsJson ?? null,
      );
      if (assignments && assignments.enabledServiceProfileIds.length > 0) {
        if (!assignments.enabledServiceProfileIds.includes(matched.id)) {
          return {
            status: 'ai_paused',
            profileId: matched.id,
            profileName: matched.name,
            reason: 'setup_mismatch',
          };
        }
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

  /**
   * Create a new ServiceProfile row from a preset. Pure write path
   * — no resolver / runtime invocation.
   *
   * Defaults match the v1 brief:
   *   - status='draft'   → resolver's aiPaused short-circuit gates AI
   *                       replies for matched leads until the operator
   *                       promotes the profile to 'active'
   *   - isDefault=false  → never collides with the tenant's existing
   *                       default profile (which keeps the partial
   *                       unique index from PR #244 happy)
   *
   * Throws Prisma P2002 on (userId, slug) collision — caller maps to
   * a 409 in the controller so the operator sees "preset already used"
   * rather than a generic 500.
   */
  async createFromPreset(args: {
    userId: string;
    preset: ServicePreset;
    status?: 'draft' | 'active';
  }) {
    const payload = buildServiceProfileFromPreset(args.preset, {
      userId: args.userId,
      status: args.status ?? 'draft',
    });
    this.logger.log(
      `[service-profile] createFromPreset userId=${args.userId} preset=${args.preset.key} ` +
      `slug=${payload.slug} status=${payload.status}`,
    );
    return this.prisma.serviceProfile.create({
      data: {
        userId: payload.userId,
        name: payload.name,
        slug: payload.slug,
        status: payload.status,
        isDefault: payload.isDefault,
        providerCategoryMappingsJson: payload.providerCategoryMappingsJson as any,
        pricingJson: payload.pricingJson,
        faqJson: payload.faqJson,
        qualificationSchemaJson: payload.qualificationSchemaJson,
        aiInstructionsJson: payload.aiInstructionsJson,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
      },
    });
  }

  // ─── Phase 1 management endpoints ─────────────────────────────────

  /**
   * List every non-archived ServiceProfile for this user, plus the
   * archived ones tail-included so the UI can still surface them in
   * a "Show archived" toggle. Default sort: drafts first (highest
   * urgency to configure), then active (alphabetical by name), then
   * archived at the bottom.
   */
  async listByUser(userId: string) {
    const rows = await this.prisma.serviceProfile.findMany({
      where: { userId },
      orderBy: [
        { status: 'asc' }, // active < archived < draft alphabetically — we re-sort below
        { isDefault: 'desc' },
        { name: 'asc' },
      ],
    });
    // Re-sort: drafts first, then active (default first), then archived.
    const order = (s: string) => (s === 'draft' ? 0 : s === 'active' ? 1 : 2);
    return rows.sort((a, b) => {
      const d = order(a.status) - order(b.status);
      if (d !== 0) return d;
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * Get one profile by id, scoped to the calling user. Returns null
   * when the row exists but belongs to another tenant (the controller
   * converts that into a 404 — never leaking existence across tenants).
   */
  async getOneForUser(userId: string, profileId: string) {
    const row = await this.prisma.serviceProfile.findUnique({
      where: { id: profileId },
    });
    if (!row || row.userId !== userId) return null;
    return row;
  }

  /**
   * Transition a profile's status under the spec's allowed transitions:
   *
   *   draft    → active     (gates that the profile has at least one
   *                          non-empty config field before activating)
   *   active   → archived   (rejected when this is the tenant's only
   *                          default profile and there's no other
   *                          active default to take its place)
   *   draft    → archived   (always allowed — never used yet)
   *   archived → active     (only when caller passes allowReactivate=true;
   *                          UI defaults to not setting it to avoid
   *                          accidental resurrection)
   *
   * Throws BadRequestException-shaped errors via thrown `Error` with
   * a `.code` field the controller maps to 400.
   */
  async transitionStatus(
    userId: string,
    profileId: string,
    nextStatus: 'draft' | 'active' | 'archived',
    opts: { allowReactivate?: boolean } = {},
  ) {
    const profile = await this.getOneForUser(userId, profileId);
    if (!profile) {
      const err: any = new Error('Service profile not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (profile.status === nextStatus) {
      return profile; // idempotent — no-op
    }

    const cur = profile.status;
    const valid =
      (cur === 'draft' && (nextStatus === 'active' || nextStatus === 'archived')) ||
      (cur === 'active' && nextStatus === 'archived') ||
      (cur === 'archived' && nextStatus === 'active' && opts.allowReactivate === true);
    if (!valid) {
      const err: any = new Error(
        `Invalid transition: ${cur} → ${nextStatus}${cur === 'archived' && nextStatus === 'active' ? ' (set allowReactivate=true)' : ''}`,
      );
      err.code = 'INVALID_TRANSITION';
      throw err;
    }

    if (nextStatus === 'active') {
      // Require at least one config field non-empty before activation.
      // The activation surface should let an operator catch a still-blank
      // preset before it starts driving AI replies.
      const hasConfig =
        (profile.pricingJson?.trim().length ?? 0) > 0 ||
        (profile.faqJson?.trim().length ?? 0) > 0 ||
        (profile.qualificationSchemaJson?.trim().length ?? 0) > 0;
      if (!hasConfig) {
        const err: any = new Error(
          'Cannot activate: profile has no pricing, FAQ, or qualification questions configured',
        );
        err.code = 'EMPTY_CONFIG';
        throw err;
      }
    }

    if (nextStatus === 'archived' && profile.isDefault) {
      // Archiving the default means the resolver loses its safety net
      // for non-matching leads. Require the operator to point the user
      // pointer at a different active profile first.
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { defaultServiceProfileId: true },
      });
      const stillDefault = user?.defaultServiceProfileId === profileId;
      const otherActiveDefault = await this.prisma.serviceProfile.findFirst({
        where: {
          userId,
          isDefault: true,
          status: 'active',
          NOT: { id: profileId },
        },
        select: { id: true },
      });
      if (stillDefault && !otherActiveDefault) {
        const err: any = new Error(
          'Cannot archive default profile: promote another profile as default first',
        );
        err.code = 'DEFAULT_BLOCKED';
        throw err;
      }
    }

    return this.prisma.serviceProfile.update({
      where: { id: profileId },
      data: {
        status: nextStatus,
        archivedAt: nextStatus === 'archived' ? new Date() : null,
      },
    });
  }

  /**
   * Edit the basic fields. Each field is optional — only the keys
   * present in `patch` are written. Mappings are validated to be a
   * JSON array; pricing/FAQ/qualification are stored as strings (the
   * AI prompt assembler parses them on read). No size limits enforced
   * at the service layer — the controller should reject obviously
   * abusive payloads.
   */
  async updateProfile(
    userId: string,
    profileId: string,
    patch: {
      name?: string;
      providerCategoryMappingsJson?: unknown;
      pricingJson?: string | null;
      faqJson?: string | null;
      qualificationSchemaJson?: string | null;
      aiInstructionsJson?: string | null;
    },
  ) {
    const profile = await this.getOneForUser(userId, profileId);
    if (!profile) {
      const err: any = new Error('Service profile not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const data: any = {};
    if (typeof patch.name === 'string') {
      const trimmed = patch.name.trim();
      if (trimmed.length === 0) {
        const err: any = new Error('Name cannot be empty');
        err.code = 'EMPTY_NAME';
        throw err;
      }
      data.name = trimmed;
    }
    if (patch.providerCategoryMappingsJson !== undefined) {
      if (!Array.isArray(patch.providerCategoryMappingsJson)) {
        const err: any = new Error('providerCategoryMappingsJson must be an array');
        err.code = 'INVALID_MAPPINGS';
        throw err;
      }
      data.providerCategoryMappingsJson = patch.providerCategoryMappingsJson as any;
    }
    // Allow explicit null to clear a field; undefined leaves it alone.
    if (patch.pricingJson !== undefined) data.pricingJson = patch.pricingJson;
    if (patch.faqJson !== undefined) data.faqJson = patch.faqJson;
    if (patch.qualificationSchemaJson !== undefined) data.qualificationSchemaJson = patch.qualificationSchemaJson;
    if (patch.aiInstructionsJson !== undefined) data.aiInstructionsJson = patch.aiInstructionsJson;
    return this.prisma.serviceProfile.update({
      where: { id: profileId },
      data,
    });
  }

  /**
   * Duplicate an existing profile under a new slug. New copy lands as
   * 'draft' regardless of source status — duplicating an active
   * profile should not silently double the AI surface.
   */
  async duplicateProfile(userId: string, profileId: string) {
    const src = await this.getOneForUser(userId, profileId);
    if (!src) {
      const err: any = new Error('Service profile not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    // Generate a unique slug. Append -copy[-N] until we find a free one.
    let attempt = `${src.slug}-copy`;
    let n = 1;
    while (n < 100) {
      const collision = await this.prisma.serviceProfile.findUnique({
        where: { userId_slug: { userId, slug: attempt } },
      });
      if (!collision) break;
      n += 1;
      attempt = `${src.slug}-copy-${n}`;
    }
    return this.prisma.serviceProfile.create({
      data: {
        userId,
        name: `${src.name} (copy)`,
        slug: attempt,
        status: 'draft',
        isDefault: false,
        providerCategoryMappingsJson: src.providerCategoryMappingsJson as any,
        pricingJson: src.pricingJson,
        faqJson: src.faqJson,
        qualificationSchemaJson: src.qualificationSchemaJson,
        aiInstructionsJson: src.aiInstructionsJson,
      },
    });
  }

  // ─── Phase 4: location overrides on SavedAccount ──────────────────

  /**
   * List the override state for one ServiceProfile across every
   * SavedAccount the user owns. UI uses this for the "Location
   * overrides" section — shows each account, marks whether it
   * currently overrides this profile, and surfaces the override
   * deltas inline.
   */
  async listOverridesForProfile(userId: string, profileId: string) {
    const profile = await this.getOneForUser(userId, profileId);
    if (!profile) {
      const err: any = new Error('Service profile not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const accounts = await this.prisma.savedAccount.findMany({
      where: { userId },
      select: {
        id: true,
        businessName: true,
        platform: true,
        serviceOverridesJson: true,
      },
      orderBy: { businessName: 'asc' },
    });
    return accounts.map((a) => {
      let override: { pricingDeltasJson?: string; faqAdditionsJson?: string } | null = null;
      if (a.serviceOverridesJson) {
        try {
          const all = JSON.parse(a.serviceOverridesJson);
          if (all && typeof all === 'object' && all[profileId]) {
            override = all[profileId];
          }
        } catch {
          // unparseable — treated as "no override" so the operator can
          // write a fresh one
        }
      }
      return {
        savedAccountId: a.id,
        businessName: a.businessName,
        platform: a.platform,
        hasOverride: override !== null,
        override,
      };
    });
  }

  /**
   * Upsert (or clear) the override for one (savedAccountId, profileId)
   * pair. Passing `pricingDeltasJson: null` + `faqAdditionsJson: null`
   * clears the override entry for this profile.
   */
  async setOverride(
    userId: string,
    profileId: string,
    savedAccountId: string,
    patch: {
      pricingDeltasJson?: string | null;
      faqAdditionsJson?: string | null;
    },
  ) {
    const profile = await this.getOneForUser(userId, profileId);
    if (!profile) {
      const err: any = new Error('Service profile not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const account = await this.prisma.savedAccount.findUnique({
      where: { id: savedAccountId },
      select: { id: true, userId: true, serviceOverridesJson: true },
    });
    if (!account || account.userId !== userId) {
      const err: any = new Error('Saved account not found');
      err.code = 'NOT_FOUND';
      throw err;
    }

    let all: Record<string, { pricingDeltasJson?: string; faqAdditionsJson?: string }> = {};
    if (account.serviceOverridesJson) {
      try {
        const parsed = JSON.parse(account.serviceOverridesJson);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          all = parsed as any;
        }
      } catch {
        // Reset to empty — better than refusing the operation due to a
        // legacy malformed blob.
      }
    }

    const willBeEmpty =
      (patch.pricingDeltasJson == null || patch.pricingDeltasJson === '') &&
      (patch.faqAdditionsJson == null || patch.faqAdditionsJson === '');
    if (willBeEmpty) {
      delete all[profileId];
    } else {
      const entry: any = { ...(all[profileId] ?? {}) };
      if (patch.pricingDeltasJson !== undefined) {
        if (patch.pricingDeltasJson === null || patch.pricingDeltasJson === '') delete entry.pricingDeltasJson;
        else entry.pricingDeltasJson = patch.pricingDeltasJson;
      }
      if (patch.faqAdditionsJson !== undefined) {
        if (patch.faqAdditionsJson === null || patch.faqAdditionsJson === '') delete entry.faqAdditionsJson;
        else entry.faqAdditionsJson = patch.faqAdditionsJson;
      }
      all[profileId] = entry;
    }

    await this.prisma.savedAccount.update({
      where: { id: savedAccountId },
      data: {
        serviceOverridesJson: Object.keys(all).length === 0 ? null : JSON.stringify(all),
      },
    });

    return { savedAccountId, profileId, override: willBeEmpty ? null : all[profileId] };
  }

  // ─── PR-E: account ↔ service assignments ──────────────────────────

  /**
   * List every connected SavedAccount for a tenant along with its
   * current service-assignment state. Powers the Manage Availability
   * modal in Settings → General → Services Offered.
   *
   * Profile validation isn't required here — the resolver tolerates
   * stale profileIds (they just don't match anything), and the UI
   * trims unknown ids on display.
   */
  async listSavedAccountAssignments(userId: string) {
    const accounts = await this.prisma.savedAccount.findMany({
      where: { userId },
      select: {
        id: true,
        businessName: true,
        platform: true,
        serviceProfileAssignmentsJson: true,
      },
      orderBy: [{ platform: 'asc' }, { businessName: 'asc' }],
    });
    return accounts.map((a) => {
      const assignments = parseServiceAssignments(a.serviceProfileAssignmentsJson);
      return {
        savedAccountId: a.id,
        businessName: a.businessName ?? '',
        platform: a.platform ?? '',
        configured: assignments !== null,
        enabledServiceProfileIds: assignments?.enabledServiceProfileIds ?? [],
        defaultServiceProfileId: assignments?.defaultServiceProfileId ?? null,
      };
    });
  }

  /**
   * Set the service assignments for one SavedAccount. Passing
   * { enabledServiceProfileIds: null } CLEARS the assignment back to
   * its "not configured" state — the resolver returns to legacy
   * category-only behavior for that account.
   *
   * IDs are not validated against the user's ServiceProfile table —
   * unknown ids are stored verbatim. The resolver tolerates them
   * (no profile matches them) and the UI filters on display. Cheaper
   * than a join + safer if the user is mid-edit while a profile is
   * being archived elsewhere.
   */
  async setSavedAccountAssignments(
    userId: string,
    savedAccountId: string,
    patch: {
      enabledServiceProfileIds: string[] | null;
      defaultServiceProfileId?: string | null;
    },
  ) {
    const account = await this.prisma.savedAccount.findUnique({
      where: { id: savedAccountId },
      select: { id: true, userId: true },
    });
    if (!account || account.userId !== userId) {
      const err: any = new Error('Saved account not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (patch.enabledServiceProfileIds === null) {
      await this.prisma.savedAccount.update({
        where: { id: savedAccountId },
        data: { serviceProfileAssignmentsJson: null },
      });
      return {
        savedAccountId,
        configured: false,
        enabledServiceProfileIds: [],
        defaultServiceProfileId: null,
      };
    }
    if (!Array.isArray(patch.enabledServiceProfileIds)) {
      const err: any = new Error('enabledServiceProfileIds must be an array or null');
      err.code = 'INVALID_ASSIGNMENT';
      throw err;
    }
    const enabled = patch.enabledServiceProfileIds.filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    // Default must be in the enabled list (or null) — otherwise the
    // resolver would never reach it. We don't auto-correct; we
    // explicitly null it so the UI surfaces the corrected state.
    const defaultId =
      typeof patch.defaultServiceProfileId === 'string' &&
      patch.defaultServiceProfileId.length > 0 &&
      enabled.includes(patch.defaultServiceProfileId)
        ? patch.defaultServiceProfileId
        : null;
    const payload = JSON.stringify({
      enabledServiceProfileIds: enabled,
      defaultServiceProfileId: defaultId,
    });
    await this.prisma.savedAccount.update({
      where: { id: savedAccountId },
      data: { serviceProfileAssignmentsJson: payload },
    });
    return {
      savedAccountId,
      configured: true,
      enabledServiceProfileIds: enabled,
      defaultServiceProfileId: defaultId,
    };
  }
}
