/**
 * ServiceProfileService — read-side resolver.
 *
 * Picks the right ServiceProfile for a lead by classifying the lead's
 * category text into a service group and matching against
 * ServiceProfile.serviceGroup. After the A3 collapse (2026-06-19) this
 * is the resolver's ONLY matching rule — the previous 5-step priority
 * chain (gate, exact-match, User.defaultServiceProfileId fallback,
 * legacy SavedAccount columns, override merge) is gone.
 *
 * Scope:
 *  - Read-side only. No writes to ServiceProfile from this service.
 *  - Draft profile gating: if the classifier matches a draft profile,
 *    returns 'ai_paused' so the caller can skip auto-reply. Lead
 *    lifecycle independent — lead still created/tracked/notified.
 *  - Archived profiles are excluded from matching entirely.
 *  - No-match cases (no profiles at all OR no profile matches the
 *    lead's group) return status='no_match'; caller should answer
 *    without a pricing block. A fire-and-forget `pricing` capture
 *    fires in monitoring for every no-match so health-check dashboards
 *    can surface the tenants whose classifier coverage is broken.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import {
  LeadForResolver,
  ResolvedProfile,
  SavedAccountForResolver,
  parseServiceAssignments,
} from './service-profile.types';
import {
  classifyLeadCategory,
  deriveServiceGroupFromMappings,
  SERVICE_GROUP_PRIORITY,
  type ServiceGroup,
} from './service-group-classifier';
import { buildServiceProfileFromPreset, GENERIC_CUSTOM_SERVICE_PRESET } from './presets/service-presets';
import { AdminServiceTemplatesService } from '../admin/service-templates/admin-service-templates.service';
import { MonitoringService } from '../monitoring/monitoring.service';

/**
 * Per-field source tracking for telemetry. The top-level `source` field
 * answers "did a ServiceProfile drive this call?" (true even if some
 * fields fell back). `fieldSources` answers "which side actually
 * supplied each field?" — useful for monitoring how often the
 * per-field fallback fires (and therefore which tenants still have
 * legacy data the profile didn't migrate).
 */
type FieldSource = 'service_profile' | 'none';
type FieldSources = {
  pricing: FieldSource;
  faq: FieldSource;
  aiInstructions: FieldSource;
};

@Injectable()
export class ServiceProfileService {
  private readonly logger = new Logger(ServiceProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminTemplates: AdminServiceTemplatesService,
    private readonly monitoring: MonitoringService,
  ) {}

  /**
   * Main entry point. Classifies the lead's category text into a
   * service group and returns the matching profile (or a no-match
   * signal). Never throws — DB errors degrade to no_match with a warn
   * log so the AI can still answer (without a quote) instead of the
   * request 500ing.
   *
   * Returns:
   *  - 'resolved' — classifier matched, caller should use the profile's
   *    pricing/FAQ/AI overlay
   *  - 'ai_paused' (reason='draft_profile') — matched profile is still
   *    draft, caller should skip the AI auto-reply
   *  - 'no_match' — tenant has no profiles OR none match the lead's
   *    group, caller renders the AI without a pricing block
   */
  async resolveForLead(
    lead: LeadForResolver,
    savedAccount: SavedAccountForResolver | null,
  ): Promise<ResolvedProfile> {
    try {
      // Pull the tenant's active+draft profiles. Archived profiles are
      // excluded server-side so they can't even be considered for
      // matching.
      const profiles = await this.prisma.serviceProfile.findMany({
        where: {
          userId: lead.userId,
          status: { in: ['active', 'draft'] },
        },
      });

      if (profiles.length === 0) {
        this.emitNoMatchWarning(lead, savedAccount, 'no_profiles', null);
        return { status: 'no_match', reason: 'no_profiles' };
      }

      // Service-group classifier — the only matching rule after A3.
      //
      // classifyLeadCategory maps `lead.category` (e.g. "Regular home
      // cleaning", "Carpet and upholstery cleaning") to one or more
      // candidate groups ('cleaning' | 'upholstery_carpet' | 'other').
      // We walk SERVICE_GROUP_PRIORITY in order and pick the first
      // profile whose `serviceGroup` is in the candidate list. Result:
      // a tenant who runs cleaning + upholstery routes carpet leads to
      // the upholstery profile (specific wins), while a tenant who only
      // has a cleaning profile still catches "Carpet and upholstery
      // cleaning" via the cleaning candidate (no regression).
      const candidateGroups = classifyLeadCategory(lead.category);
      let matched: typeof profiles[number] | null = null;
      for (const g of SERVICE_GROUP_PRIORITY) {
        if (!candidateGroups.includes(g)) continue;
        const profile = profiles.find((p) => p.serviceGroup === g);
        if (profile) {
          matched = profile;
          break;
        }
      }

      if (!matched) {
        this.emitNoMatchWarning(lead, savedAccount, 'no_classifier_match', null);
        return { status: 'no_match', reason: 'no_classifier_match' };
      }

      // Draft gating — classifier matched but profile is still draft.
      // AI auto-reply pauses; lead lifecycle (tracking, notifications)
      // continues independently.
      if (matched.status === 'draft') {
        return {
          status: 'ai_paused',
          profileId: matched.id,
          profileName: matched.name,
          reason: 'draft_profile',
        };
      }

      return {
        status: 'resolved',
        profileId: matched.id,
        profileName: matched.name,
        effectivePricingJson: matched.pricingJson ?? null,
        effectiveFaqJson: matched.faqJson ?? null,
        effectiveAiInstructionsJson: matched.aiInstructionsJson ?? null,
        effectiveQualificationSchemaJson: matched.qualificationSchemaJson ?? null,
        matchedBy: 'serviceGroup',
      };
    } catch (err: any) {
      this.logger.warn(`[service-profile] resolveForLead failed: ${err?.message ?? err}`);
      return { status: 'no_match', reason: 'no_profiles' };
    }
  }

  /**
   * Fire-and-forget monitoring signal for the two cases that mean the
   * AI will quote without a profile (or not at all). Surfaced via the
   * existing `pricing` capture bucket so the health-check dashboard
   * lights up when a tenant's classifier coverage breaks.
   */
  private emitNoMatchWarning(
    lead: LeadForResolver,
    savedAccount: SavedAccountForResolver | null,
    code: 'no_profiles' | 'no_classifier_match',
    matched: { id: string; name: string } | null,
  ): void {
    const message =
      code === 'no_profiles'
        ? 'Tenant has no active/draft ServiceProfile rows — resolver returned no_match.'
        : 'Lead category did not match any ServiceProfile.serviceGroup — resolver returned no_match.';
    this.monitoring
      .captureError({
        category: 'pricing',
        code,
        severity: 'warning',
        message,
        userId: lead.userId,
        accountId: savedAccount?.id,
        accountName: savedAccount?.businessName ?? undefined,
        platform: lead.platform ?? undefined,
        context: {
          leadId: lead.id,
          leadCategory: lead.category ?? null,
          leadCategoryId: lead.categoryId ?? null,
          matchedProfileId: matched?.id ?? null,
          matchedProfileName: matched?.name ?? null,
        },
      })
      .catch((err) => {
        this.logger.warn(`[service-profile] monitoring.captureError failed: ${err?.message ?? err}`);
      });
  }

  /**
   * Convenience wrapper for the AI prompt assembler: returns the
   * effective pricing + FAQ + AI instructions the assembler should use.
   *
   * After A3 the resolver has exactly one matching rule (classifier →
   * serviceGroup). Three terminal states map to three caller behaviors:
   *
   *  - resolved → use the profile's pricing/FAQ/instructions (which may
   *    individually be null; the caller's prompt builder already knows
   *    how to render with missing slots)
   *  - ai_paused → pricingJson/faqJson/aiInstructionsJson are null,
   *    aiPaused=true. Caller should skip the AI auto-reply.
   *  - no_match → pricingJson/faqJson/aiInstructionsJson are null,
   *    aiPaused=false. Caller renders the AI without a pricing block,
   *    which prompts a "no price for that" style answer.
   *
   * Phase 1 callers: ai.controller.ts preview-for-lead, preview-with-context,
   * automation.service.ts, follow-up-generator.service.ts,
   * instant-text-ai.service.ts.
   */
  async resolveEffectivePromptInputs(
    lead: LeadForResolver,
    savedAccount: SavedAccountForResolver | null,
  ): Promise<{
    pricingJson: string | null;
    faqJson: string | null;
    aiInstructionsJson: string | null;
    // Profile-side qualification schema. Callers feed this into
    // buildQualificationBlockForStrategy alongside the SavedAccount-level
    // qualificationV2 so the qualify prompt sees service-specific fields
    // (e.g. "Number of seats", "Fabric type" for upholstery) instead of
    // defaulting to the prompt's hardcoded "square footage" example.
    qualificationSchemaJson: string | null;
    aiPaused: boolean;
    profileId: string | null;
    source: 'service_profile' | 'none';
    fieldSources: FieldSources;
  }> {
    const resolved = await this.resolveForLead(lead, savedAccount);

    if (resolved.status === 'ai_paused') {
      return {
        pricingJson: null,
        faqJson: null,
        aiInstructionsJson: null,
        qualificationSchemaJson: null,
        aiPaused: true,
        profileId: resolved.profileId,
        source: 'service_profile',
        fieldSources: { pricing: 'none', faq: 'none', aiInstructions: 'none' },
      };
    }

    if (resolved.status === 'resolved') {
      return {
        pricingJson: resolved.effectivePricingJson,
        faqJson: resolved.effectiveFaqJson,
        aiInstructionsJson: resolved.effectiveAiInstructionsJson,
        qualificationSchemaJson: resolved.effectiveQualificationSchemaJson,
        aiPaused: false,
        profileId: resolved.profileId,
        source: 'service_profile',
        fieldSources: {
          pricing: resolved.effectivePricingJson == null ? 'none' : 'service_profile',
          faq: resolved.effectiveFaqJson == null ? 'none' : 'service_profile',
          aiInstructions: resolved.effectiveAiInstructionsJson == null ? 'none' : 'service_profile',
        },
      };
    }

    // no_match — classifier returned no candidate group OR no profile
    // for any candidate. AI proceeds without pricing context; the
    // monitoring warning was already emitted inside resolveForLead.
    return {
      pricingJson: null,
      faqJson: null,
      aiInstructionsJson: null,
      qualificationSchemaJson: null,
      aiPaused: false,
      profileId: null,
      source: 'none',
      fieldSources: { pricing: 'none', faq: 'none', aiInstructions: 'none' },
    };
  }

  /**
   * Create a new ServiceProfile row from a published admin template.
   *
   * The admin Service Template Builder stores rows in the v2 shape
   * (serviceOptionsJson with grouped options, customerAnswersJson with
   * entries[]). The existing ServiceProfile reader expects the v1
   * shapes (qualificationSchemaJson with `questions[]`, faqJson with
   * `customQA[]`).
   *
   * We bridge at copy time so the runtime keeps working unchanged:
   *   serviceOptions.groups[].options[{key,label}]  →  qualification.questions[].options[label]
   *   customerAnswers.entries[]                     →  faq.customQA[]
   *
   * pricingJson is bridged from the v2 admin shape (room_quantity /
   * item_quantity / hourly / flat_rate / custom with basePrices+addOns)
   * to the v1 ServiceProfile UI shape (item_quantity with items[], or
   * hourly with laborRate+minimumCharge). See bridgeAdminPricingToV1.
   *
   * `additionalInstructions` was removed 2026-06-22 — inert at runtime,
   * never wired into the AI prompt builder. ServiceProfile.aiInstructionsJson
   * is now left null at template-creation time (the wrapper format is
   * still respected by future per-service playbook editors).
   *
   * Status forced to 'draft' per spec — never auto-activate.
   */
  async createFromAdminTemplate(args: {
    userId: string;
    templateId: string;
  }) {
    const template = await this.adminTemplates.getPublishedById(args.templateId);
    if (!template) {
      const err: any = new Error('Published service template not found');
      err.code = 'NOT_FOUND';
      throw err;
    }

    // Derive a slug from the template label, deduped per user (same
    // suffix dance as createBlank).
    const baseSlug =
      template.label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'new-service';
    let slug = baseSlug;
    let suffix = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const existing = await this.prisma.serviceProfile.findUnique({
        where: { userId_slug: { userId: args.userId, slug } },
        select: { id: true },
      });
      if (!existing) break;
      suffix += 1;
      slug = `${baseSlug}-${suffix}`;
      if (suffix > 999) break;
    }

    // Bridge v2 → v1 shapes.
    const qualificationSchemaJson = bridgeServiceOptionsToQualification(
      template.serviceOptionsJson,
    );
    const faqJson = bridgeCustomerAnswersToFaq(template.customerAnswersJson);
    const pricingJson = bridgeAdminPricingToV1(template.pricingJson);

    this.logger.log(
      `[service-profile] createFromAdminTemplate userId=${args.userId} ` +
      `templateId=${template.id} slug=${slug}`,
    );

    // Derive serviceGroup from the template's provider category so the
    // resolver's classifier match works on day 1. Without this the row
    // ships with the schema default 'other', which never matches any
    // lead category and silently pauses AI for the whole tenant.
    const mappings = [
      {
        provider: template.provider,
        providerCategoryId: template.providerCategoryId ?? undefined,
        categoryName: template.providerCategoryName,
      },
    ];
    const serviceGroup = deriveServiceGroupFromMappings(mappings);
    return this.prisma.serviceProfile.create({
      data: {
        userId: args.userId,
        name: template.label,
        slug,
        status: 'draft',
        isDefault: false,
        providerCategoryMappingsJson: mappings as any,
        serviceGroup,
        pricingJson,
        faqJson,
        qualificationSchemaJson,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
      },
    });
  }

  /**
   * Custom-service factory — powers the "Create custom service" tile in
   * AddServiceModal. Tenants land here when none of the curated presets
   * fits their actual line of work (roofing, mobile mechanic,
   * photography, etc.).
   *
   * We seed the new profile from GENERIC_CUSTOM_SERVICE_PRESET so the
   * AI has safe defaults from the moment the row exists:
   *
   *   - hourly pricing model with a $100 laborRate + minimumCharge.
   *     AI shares those as guidance ("starts around $X / $X/hour") and
   *     defers any bound quote to the owner (quoteRequired=true).
   *   - generic FAQ that defers on insurance, area, payment, on-site
   *     access — nothing the AI could turn into a wrong promise.
   *   - 4 required qualification questions (phone / address / date /
   *     project description) + 2 optional (photos / ZIP).
   *   - service rules that force scope-first questioning and forbid
   *     license / insurance / warranty claims until the tenant
   *     explicitly opts in.
   *
   * We override the preset's display fields with the tenant's chosen
   * name (the preset label "Custom Service" would be wrong for every
   * tenant after the first) and clear providerCategoryMappingsJson
   * because there's no provider category to map this to.
   *
   * The new profile is always status='draft' regardless of the preset's
   * default — a custom service should never auto-activate without the
   * operator reviewing the starter text first.
   *
   * Slug uniqueness: derive from name, then append -2, -3, ... on
   * collision. The Prisma partial unique index (userId, slug) prevents
   * the race-condition window — a duplicate Postgres write still
   * surfaces as P2002 and the caller maps it to a 409.
   */
  async createBlank(args: { userId: string; name: string }) {
    const trimmed = args.name.trim();
    const baseSlug = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'new-service';
    let slug = baseSlug;
    let suffix = 1;
    // Loop is bounded: the slug column is varchar(64), so worst-case
    // ~9999 attempts before we'd need a longer suffix. In practice
    // tenants rarely have more than ~10 profiles. The lookup uses the
    // compound unique key (userId, slug) — race-condition window still
    // exists, but P2002 from the subsequent create() surfaces a clean
    // 409 in that path.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const existing = await this.prisma.serviceProfile.findUnique({
        where: { userId_slug: { userId: args.userId, slug } },
        select: { id: true },
      });
      if (!existing) break;
      suffix += 1;
      slug = `${baseSlug}-${suffix}`;
      if (suffix > 999) break; // safety net — P2002 will surface a clean 409 if we hit this
    }
    // Seed from the generic preset, then override name + slug + clear
    // provider mappings. Status is forced to 'draft' regardless of any
    // preset-side default — custom services must be reviewed before
    // they go live.
    const payload = buildServiceProfileFromPreset(
      GENERIC_CUSTOM_SERVICE_PRESET,
      { userId: args.userId, slug, status: 'draft' },
    );
    this.logger.log(
      `[service-profile] createBlank userId=${args.userId} name="${trimmed}" slug=${slug} ` +
      `preset=${GENERIC_CUSTOM_SERVICE_PRESET.key}`,
    );
    // Custom services have no provider mapping, so derive serviceGroup
    // from the user-supplied name (e.g. "Carpet Cleaning" → 'cleaning').
    // Falls through to 'other' for genuinely off-niche names — that's
    // the right outcome since the classifier can't route off-niche
    // leads anyway.
    const serviceGroup = deriveServiceGroupFromMappings([{ categoryName: trimmed }]);
    return this.prisma.serviceProfile.create({
      data: {
        userId: payload.userId,
        name: trimmed,
        slug: payload.slug,
        status: payload.status,
        isDefault: payload.isDefault,
        providerCategoryMappingsJson: [] as any,
        serviceGroup,
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

    // On draft → active, auto-promote this profile to the tenant default
    // if (and only if) the tenant has no default yet. Without this, the
    // wizard ships tenants with profiles but `User.defaultServiceProfileId
    // = null`, leaving the runtime resolver with no fallback for leads
    // whose category falls outside the classifier's regex coverage.
    const shouldAutoPromote =
      nextStatus === 'active' && cur === 'draft' && !profile.isDefault;
    if (shouldAutoPromote) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { defaultServiceProfileId: true },
      });
      const tenantHasDefault = !!user?.defaultServiceProfileId;
      if (!tenantHasDefault) {
        return this.prisma.$transaction(async (tx) => {
          const updated = await tx.serviceProfile.update({
            where: { id: profileId },
            data: {
              status: nextStatus,
              archivedAt: null,
              isDefault: true,
            },
          });
          await tx.user.update({
            where: { id: userId },
            data: { defaultServiceProfileId: profileId },
          });
          this.logger.log(
            `[service-profile] auto-promoted profile ${profileId} as default for user ${userId} on first activation`,
          );
          return updated;
        });
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
   * Hard-delete a service profile. Used by the AI Playbook → Danger
   * zone affordance for owner-initiated removal of a service the
   * operator no longer wants. Soft-archive (status='archived') is the
   * normal flow and stays the recommended path; this exists for the
   * rare case where the operator wants the row gone (e.g. a test
   * service created by accident, or a misconfigured draft that's
   * cluttering the tab strip).
   *
   * Guards:
   *   - 404 when the profile doesn't exist or belongs to another user.
   *   - DEFAULT_BLOCKED when isDefault=true. The tenant always needs
   *     a fallback profile for non-matching leads; the operator must
   *     promote another profile as default before this one can be
   *     deleted (same constraint as archive).
   *   - DEFAULT_BLOCKED when User.defaultServiceProfileId still points
   *     at this row. The FK is onDelete: SetNull so the DB would
   *     accept the delete, but the resolver loses its safety net the
   *     moment that pointer flips to null — guard at the service
   *     layer so the UI can surface a clear error.
   *
   * Side-effects: orphan keys in any SavedAccount.serviceProfileOverridesJson
   * (a JSON map keyed by profileId) are NOT cleaned up here — they're
   * inert (the resolver only walks active profiles) and a follow-up
   * sweep cron can reap them. The cost of an extra prisma roundtrip
   * per delete isn't worth the cleanup.
   */
  async deleteProfile(userId: string, profileId: string) {
    const profile = await this.getOneForUser(userId, profileId);
    if (!profile) {
      const err: any = new Error('Service profile not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (profile.isDefault) {
      const err: any = new Error(
        'Cannot delete default profile: promote another profile as default first',
      );
      err.code = 'DEFAULT_BLOCKED';
      throw err;
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { defaultServiceProfileId: true },
    });
    if (user?.defaultServiceProfileId === profileId) {
      const err: any = new Error(
        'Cannot delete: this profile is set as the account default. Promote another profile first.',
      );
      err.code = 'DEFAULT_BLOCKED';
      throw err;
    }
    await this.prisma.serviceProfile.delete({ where: { id: profileId } });
    return { id: profileId, deleted: true as const };
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

// ─── Admin template v2 → ServiceProfile v1 shape bridges ──────────────
//
// These helpers live outside the class because they're pure functions
// with no DI / Prisma access. They translate the admin Service Template
// Builder's v2 JSON blobs into the v1 shapes the runtime resolver +
// prompt assembler already understand. Bridging at copy time keeps the
// runtime untouched (no new shape branches in faq-context / pricing
// engine / playbook renderer).
//
// Defensive on every input: malformed JSON returns a benign default,
// never throws. The new profile is always created as draft, so even a
// silently-broken bridge can be cleaned up by the operator before
// activation.

/**
 * Admin serviceOptionsJson:
 *   { groups: [{ key, label, type, options: [{ key, label }] }] }
 * → ServiceProfile.qualificationSchemaJson (stored as stringified JSON):
 *   { questions: [{ key, label, type, options: string[] }] }
 *
 * The runtime qualification reader walks `questions[]` with `options`
 * as a flat string[] — we drop the per-option keys (the option labels
 * are stable enough for the AI's purposes) and forward everything else.
 */
function bridgeServiceOptionsToQualification(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const groups = Array.isArray(parsed?.groups) ? parsed.groups : [];
  const questions = groups
    .map((g: any) => {
      if (!g || typeof g !== 'object') return null;
      const key = typeof g.key === 'string' ? g.key : '';
      const label = typeof g.label === 'string' ? g.label : '';
      const type =
        g.type === 'single_select' || g.type === 'multi_select' ? g.type : 'multi_select';
      const options = Array.isArray(g.options)
        ? g.options
            .map((o: any) => (typeof o?.label === 'string' ? o.label : null))
            .filter((s: string | null): s is string => s !== null && s.length > 0)
        : [];
      if (!key || !label) return null;
      return { key, label, type, options };
    })
    .filter((q: any): q is { key: string; label: string; type: string; options: string[] } => q !== null);
  return JSON.stringify({ questions });
}

/**
 * Admin customerAnswersJson:
 *   { entries: [{ question, answer }] }
 * → ServiceProfile.faqJson (stored as stringified JSON):
 *   { customQA: [{ question, answer }] }
 *
 * The runtime FAQ reader walks `customQA[]`; renaming the wrapper key
 * is all the bridge needs to do.
 */
function bridgeCustomerAnswersToFaq(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  const customQA = entries
    .map((e: any) => {
      if (!e || typeof e !== 'object') return null;
      const q = typeof e.question === 'string' ? e.question : '';
      const a = typeof e.answer === 'string' ? e.answer : '';
      if (!q || !a) return null;
      return { question: q, answer: a };
    })
    .filter((e: any): e is { question: string; answer: string } => e !== null);
  return JSON.stringify({ customQA });
}

/**
 * Admin pricingJson (v2 shape) → ServiceProfile.pricingJson (v1 shape
 * the existing PricingEditor / pricing engine consume).
 *
 * v2 input shapes (one of):
 *   { pricingModel: 'room_quantity', basePrices: [{ quantity, label, price, source }], addOns: [...] }
 *   { pricingModel: 'item_quantity', basePrices: [...], addOns: [...] }
 *   { pricingModel: 'hourly', laborRate, minimumCharge, quoteRequired, ... }
 *   { pricingModel: 'flat_rate', basePrices: [{ ..., price }] }
 *   { pricingModel: 'custom', ... }
 *
 * v1 output shape (what PricingEditor reads):
 *   { pricingModel: 'item_quantity', items: [{ key, label, price, source, active }], addOns: [...] }
 *   { pricingModel: 'hourly', currency, laborRate, minimumCharge, quoteRequired, notes }
 *
 * Mapping:
 *  - room_quantity, item_quantity → v1 item_quantity. basePrices rows
 *    map 1:1 to items rows. Source values are remapped to the existing
 *    PresetPricing source union (`admin_input` → `manual`,
 *    `missing` → `missing_from_thumbtack`).
 *  - hourly → v1 hourly. laborRate / minimumCharge / quoteRequired
 *    carried through. If absent on the template (rare), defaults of
 *    100/100/true match the existing custom-service starter.
 *  - flat_rate → v1 hourly with minimumCharge from the single basePrice.
 *    (v1 doesn't have a flat_rate model; the hourly editor with just a
 *    minimum is the closest match.)
 *  - custom → v1 item_quantity with no items so the operator gets an
 *    empty Price Table editor to fill in (rather than a JSON textarea).
 *
 * On parse failure or unrecognised shape → returns null (the profile's
 * pricing column stays empty and the editor renders the empty-state
 * "Add your first priced item" affordance).
 */
function bridgeAdminPricingToV1(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const model: string = typeof parsed.pricingModel === 'string' ? parsed.pricingModel : 'custom';

  const mapSource = (s: unknown): string => {
    if (s === 'thumbtack_average') return 'thumbtack_average';
    if (s === 'interpolated') return 'interpolated';
    if (s === 'admin_input') return 'manual';
    if (s === 'missing') return 'missing_from_thumbtack';
    return 'manual';
  };

  const slugify = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'item';

  const mapBasePrices = (arr: any): any[] => {
    if (!Array.isArray(arr)) return [];
    return arr
      .map((b: any) => {
        if (!b || typeof b !== 'object') return null;
        const label = typeof b.label === 'string' && b.label.length > 0 ? b.label : '';
        if (!label) return null;
        const price = typeof b.price === 'number' ? b.price : 0;
        return {
          key: slugify(label),
          label,
          price,
          source: mapSource(b.source),
          active: true,
        };
      })
      .filter((x: any): x is object => x !== null);
  };

  /**
   * Convert admin add-ons → v1 items so they render as editable rows in
   * the PricingEditor table. The existing PricingEditor only iterates
   * `items[]` for the rendered rows; a separate `addOns[]` field gets
   * passed through silently and never reaches the user. That broke the
   * common Thumbtack flow where add-on labels arrive without prices
   * (admin marks each "incl." or fills the number later) — the labels
   * were captured by the parser but invisible in the per-service UI.
   *
   * We tag each converted row with `notes: 'Add-on'` so an operator can
   * distinguish them in the table at a glance. `active: true` so the
   * row is included in default views; price 0 / source 'missing_from_…'
   * indicates the number still needs to be entered.
   */
  const mapAddOnsAsItems = (arr: any): any[] => {
    if (!Array.isArray(arr)) return [];
    return arr
      .map((a: any) => {
        if (!a || typeof a !== 'object') return null;
        const label = typeof a.label === 'string' && a.label.length > 0 ? a.label : '';
        if (!label) return null;
        const price = typeof a.price === 'number' ? a.price : 0;
        return {
          key: typeof a.key === 'string' && a.key.length > 0 ? a.key : slugify(label),
          label,
          price,
          source: mapSource(a.source),
          notes: 'Add-on',
          active: true,
        };
      })
      .filter((x: any): x is object => x !== null);
  };

  if (model === 'hourly') {
    return JSON.stringify({
      pricingModel: 'hourly',
      currency: typeof parsed.currency === 'string' ? parsed.currency : 'USD',
      laborRate: typeof parsed.laborRate === 'number' ? parsed.laborRate : 100,
      minimumCharge: typeof parsed.minimumCharge === 'number' ? parsed.minimumCharge : 100,
      quoteRequired: parsed.quoteRequired !== false,
      notes: typeof parsed.notes === 'string' ? parsed.notes : '',
    });
  }

  if (model === 'flat_rate') {
    const first = Array.isArray(parsed.basePrices) ? parsed.basePrices[0] : null;
    const minimum = first && typeof first.price === 'number' ? first.price : 0;
    return JSON.stringify({
      pricingModel: 'hourly',
      currency: typeof parsed.currency === 'string' ? parsed.currency : 'USD',
      laborRate: 0,
      minimumCharge: minimum,
      quoteRequired: true,
      notes: typeof parsed.notes === 'string' ? parsed.notes : '',
    });
  }

  // room_quantity, item_quantity, custom → all collapse to v1 item_quantity.
  // Add-on rows are flattened INTO `items[]` (rather than kept as a
  // separate `addOns[]` field) so the per-service PricingEditor renders
  // them as editable rows. Without this, priceless add-ons captured by
  // the parser were invisible in the price table — the editor only
  // renders `items[]`. The `notes: 'Add-on'` tag from mapAddOnsAsItems
  // lets operators tell them apart at a glance.
  const baseItems = mapBasePrices(parsed.basePrices);
  const addOnItems = mapAddOnsAsItems(parsed.addOns);
  return JSON.stringify({
    pricingModel: 'item_quantity',
    items: [...baseItems, ...addOnItems],
    currency: typeof parsed.currency === 'string' ? parsed.currency : 'USD',
  });
}

