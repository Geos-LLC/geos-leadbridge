/**
 * AdminServiceTemplatesService — DB-backed admin Service Template registry.
 *
 * Owns the lifecycle of `ServiceTemplatePreset` rows:
 *   - generate (pure compute, no DB)
 *   - create draft
 *   - patch draft (admin reviewed/edited the generated JSON)
 *   - publish (now visible in the public preset picker)
 *   - archive (soft delete — hidden from public + admin defaults)
 *   - list (admin sees all; public consumer filters to status='published')
 *
 * Tenant scoping: there's no tenant column. These rows are platform-level
 * presets. The createdByUserId is purely informational — any admin can
 * publish / archive any row.
 *
 * Read path used by the public preset picker:
 *   `listPublished()` — returns published rows in `PublicTemplatePreset`
 *   shape so the service-profile controller can splice them into the
 *   GET /v1/service-profile-presets response.
 */

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../common/utils/prisma.service';
import {
  GeneratedTemplate,
  PublicTemplatePreset,
} from './admin-service-templates.types';
import { generateTemplate, GenerateInput } from './template-generator';
import {
  UPHOLSTERY_FURNITURE_CLEANING_PRESET,
  GENERIC_CUSTOM_SERVICE_PRESET,
  HOUSE_CLEANING_PRESET,
} from '../../service-profile/presets/service-presets';
import type { ServicePreset } from '../../service-profile/presets/service-presets.types';

/** What `POST /v1/admin/service-templates` accepts as the body. */
export type CreateTemplateInput = GeneratedTemplate & {
  /** Optional override — admin can type a key explicitly. If absent we
   *  use the key the generator produced. */
  keyOverride?: string | null;
};

/** What `PATCH /v1/admin/service-templates/:id` accepts. All fields
 *  optional so admins can edit just the slices they reviewed.
 *  The four v1 fields at the bottom were silently dropped by the
 *  PATCH handler before — admins could see them in code-seeded rows
 *  but couldn't edit them via API. */
export type PatchTemplateInput = {
  label?: string;
  provider?: string;
  providerCategoryName?: string;
  providerCategoryId?: string | null;
  description?: string | null;
  serviceOptionsJson?: unknown;
  pricingJson?: unknown;
  customerAnswersJson?: unknown;
  // v1 fields used by the runtime ServiceProfile reader. Accepted here
  // so a future v1-aware admin editor can write them too.
  qualificationSchemaJson?: unknown;
  faqJson?: unknown;
  serviceRules?: unknown;
  aliases?: unknown;
};

/** Coerce admin-provided JSON to a string for storage. We accept either
 *  a parsed object (typical from admin UI) or a pre-stringified blob
 *  (when admins edit the raw JSON in the preview pane). */
function toJsonString(value: unknown): string {
  if (typeof value === 'string') {
    // Validate it parses — if not, store the raw text so the admin can
    // fix it on the next edit pass.
    try {
      JSON.parse(value);
      return value;
    } catch {
      return value;
    }
  }
  return JSON.stringify(value ?? null);
}

/**
 * Treat the FAQ block as "real" only when it has at least one populated
 * field (scope text or a QA pair). Stops the create path from writing
 * an empty `{customQA: []}` placeholder over the column when the admin
 * skipped the FAQ paste box entirely.
 */
function hasFaqContent(value: unknown): boolean {
  if (!value) return false;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '""' || trimmed === '{}') return false;
    try {
      return hasFaqContent(JSON.parse(trimmed));
    } catch {
      return trimmed.length > 0;
    }
  }
  if (typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  if (typeof o.standardScope === 'string' && o.standardScope.trim().length > 0) return true;
  if (typeof o.deepScope === 'string' && o.deepScope.trim().length > 0) return true;
  if (Array.isArray(o.customQA) && o.customQA.length > 0) return true;
  // Any other populated key (insuredAndBonded, paymentMethods, etc.)
  // counts as content too — admins may hand-author the richer cleaning
  // FAQ shape in the JSON pane.
  for (const k of Object.keys(o)) {
    if (k === 'standardScope' || k === 'deepScope' || k === 'customQA') continue;
    const v = o[k];
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'string' && v.trim().length === 0) continue;
    return true;
  }
  return false;
}

/** Defensive parse — returns null when the blob isn't valid JSON. */
function safeParse<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

@Injectable()
export class AdminServiceTemplatesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminServiceTemplatesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Boot-time seed: ensures the two historical code-side presets exist
   * as published rows in `service_template_presets`. Idempotent via
   * `upsert({ update: {} })` — admin edits to seeded rows are never
   * clobbered on subsequent boots.
   *
   * Together with Phase 2 (removing the merge branch in
   * service-profile.controller.ts), this makes the DB the single source
   * of truth for both the admin Templates page and the customer-facing
   * preset picker.
   */
  async onApplicationBootstrap(): Promise<void> {
    const presets: ServicePreset[] = [
      HOUSE_CLEANING_PRESET,
      UPHOLSTERY_FURNITURE_CLEANING_PRESET,
      GENERIC_CUSTOM_SERVICE_PRESET,
    ];
    for (const p of presets) {
      try {
        const row = await this.prisma.serviceTemplatePreset.upsert({
          where: { key: p.key },
          create: {
            key: p.key,
            label: p.label,
            provider: p.provider,
            providerCategoryName: p.providerCategoryName,
            providerCategoryId: null,
            description: p.description ?? null,
            // v2 fields. serviceOptionsJson defaults to empty groups —
            // these seeded rows carry their structured questions on
            // qualificationSchemaJson (v1) instead. customerAnswersJson
            // mirrors the v1 FAQ entries so the admin editor renders the
            // QA pairs even before the v1-editor work lands.
            serviceOptionsJson: JSON.stringify({ groups: [] }),
            pricingJson: JSON.stringify(p.pricingJson),
            customerAnswersJson: JSON.stringify({
              entries: (p.faqJson?.customQA ?? []).map((qa) => ({
                question: qa.question,
                answer: qa.answer,
              })),
            }),
            // additionalInstructions removed 2026-06-22 (was always
            // null on seeded rows anyway). Prisma column still exists
            // but no longer written.
            // v1 fields — verbatim from the code preset.
            qualificationSchemaJson: JSON.stringify(p.qualificationSchemaJson),
            faqJson: p.faqJson ? JSON.stringify(p.faqJson) : null,
            serviceRules: p.serviceRules ? JSON.stringify(p.serviceRules) : null,
            aliases: JSON.stringify(p.aliases ?? []),
            status: 'published',
            sourceJson: JSON.stringify({
              kind: 'code_preset_seed',
              seededAt: new Date().toISOString(),
            }),
          },
          update: {},
        });
        this.logger.log(
          `[admin-service-templates] seed key=${row.key} status=${row.status} id=${row.id}`,
        );
      } catch (err: any) {
        this.logger.error(
          `[admin-service-templates] failed to seed code preset key=${p.key}: ${err?.message}`,
        );
      }
    }
  }

  /** Pure compute. Returns the generated shape for admin review. */
  generate(input: GenerateInput): GeneratedTemplate {
    return generateTemplate(input);
  }

  /**
   * Persist a new admin template. Always lands as `status='draft'`
   * regardless of caller hint — the spec is explicit: no auto-publish.
   * Promotion is a separate explicit endpoint.
   */
  async create(args: { adminUserId: string; input: CreateTemplateInput }) {
    const { adminUserId, input } = args;
    const key = (input.keyOverride && input.keyOverride.trim().length > 0
      ? input.keyOverride.trim()
      : input.key
    ).slice(0, 96);

    const row = await this.prisma.serviceTemplatePreset.create({
      data: {
        key,
        label: input.label,
        provider: input.provider,
        providerCategoryName: input.providerCategoryName,
        providerCategoryId: input.providerCategoryId,
        description: input.description,
        serviceOptionsJson: toJsonString(input.serviceOptionsJson),
        pricingJson: toJsonString(input.pricingJson),
        customerAnswersJson: toJsonString(input.customerAnswersJson),
        // FAQ block — written only when the admin actually populated
        // it. Empty `{customQA: []}` from the generator stays null in
        // the DB so the runtime preset reader can fall back cleanly.
        faqJson: hasFaqContent(input.faqJson) ? toJsonString(input.faqJson) : null,
        sourceJson: input.sourceJson ? toJsonString(input.sourceJson) : null,
        status: 'draft',
        createdByUserId: adminUserId,
      },
    });

    this.logger.log(
      `[admin-service-templates] create id=${row.id} key=${row.key} adminId=${adminUserId}`,
    );
    return row;
  }

  /**
   * Edit any field. Each field is optional — only present keys are
   * written. JSON blobs come in as parsed objects (or strings); both
   * are coerced via `toJsonString` so storage stays uniform.
   */
  async patch(args: { templateId: string; patch: PatchTemplateInput }) {
    const { templateId, patch } = args;
    const data: any = {};
    if (typeof patch.label === 'string') data.label = patch.label.trim();
    if (typeof patch.provider === 'string') data.provider = patch.provider.trim();
    if (typeof patch.providerCategoryName === 'string') {
      data.providerCategoryName = patch.providerCategoryName.trim();
    }
    if (patch.providerCategoryId !== undefined) data.providerCategoryId = patch.providerCategoryId;
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.serviceOptionsJson !== undefined) {
      data.serviceOptionsJson = toJsonString(patch.serviceOptionsJson);
    }
    if (patch.pricingJson !== undefined) data.pricingJson = toJsonString(patch.pricingJson);
    if (patch.customerAnswersJson !== undefined) {
      data.customerAnswersJson = toJsonString(patch.customerAnswersJson);
    }
    // v1 fields — silently dropped before this fix. Same toJsonString
    // coercion as the v2 fields so storage stays uniform whether the
    // admin sent a parsed object or a pre-stringified blob.
    if (patch.qualificationSchemaJson !== undefined) {
      data.qualificationSchemaJson = toJsonString(patch.qualificationSchemaJson);
    }
    if (patch.faqJson !== undefined) data.faqJson = toJsonString(patch.faqJson);
    if (patch.serviceRules !== undefined) data.serviceRules = toJsonString(patch.serviceRules);
    if (patch.aliases !== undefined) data.aliases = toJsonString(patch.aliases);
    return this.prisma.serviceTemplatePreset.update({
      where: { id: templateId },
      data,
    });
  }

  /**
   * Status transitions. Spec is permissive — any of draft / published /
   * archived can be set explicitly. We do guard re-activation: archived
   * → published is allowed (the admin should be able to undo an archive),
   * but we log it so the trail is visible.
   */
  async setStatus(args: {
    templateId: string;
    nextStatus: 'draft' | 'published' | 'archived';
  }) {
    const row = await this.prisma.serviceTemplatePreset.findUnique({
      where: { id: args.templateId },
    });
    if (!row) {
      const err: any = new Error('Service template not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (row.status === args.nextStatus) {
      return row; // idempotent
    }
    if (row.status === 'archived' && args.nextStatus === 'published') {
      this.logger.warn(
        `[admin-service-templates] reactivating archived id=${args.templateId} key=${row.key}`,
      );
    }
    return this.prisma.serviceTemplatePreset.update({
      where: { id: args.templateId },
      data: { status: args.nextStatus },
    });
  }

  /**
   * Hard-delete an admin template row. Used by the trash-can on the
   * admin Service Templates page when an operator wants to remove a
   * test / misconfigured row entirely. Soft-archive (status='archived')
   * remains the recommended path and stays separate; this is for the
   * "delete forever" case.
   *
   * No tenant cascade — ServiceProfile rows created from this template
   * stay untouched. They already copied the template's fields at
   * creation time and don't reference the template id beyond that copy,
   * so deletion is safe for the runtime resolver.
   */
  async delete(args: { templateId: string }) {
    const row = await this.prisma.serviceTemplatePreset.findUnique({
      where: { id: args.templateId },
      select: { id: true, key: true },
    });
    if (!row) {
      const err: any = new Error('Service template not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    await this.prisma.serviceTemplatePreset.delete({ where: { id: args.templateId } });
    this.logger.log(
      `[admin-service-templates] delete id=${row.id} key=${row.key}`,
    );
    return { id: row.id, deleted: true as const };
  }

  /** Admin list — all rows, all statuses, newest first. */
  async listAll() {
    return this.prisma.serviceTemplatePreset.findMany({
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });
  }

  async getById(id: string) {
    const row = await this.prisma.serviceTemplatePreset.findUnique({
      where: { id },
    });
    if (!row) {
      const err: any = new Error('Service template not found');
      err.code = 'NOT_FOUND';
      throw err;
    }
    return row;
  }

  /**
   * Public read path — drives the GET /v1/service-profile-presets merge.
   * Returns only published rows; drafts + archived are never surfaced
   * to non-admin consumers.
   */
  async listPublished(): Promise<PublicTemplatePreset[]> {
    const rows = await this.prisma.serviceTemplatePreset.findMany({
      where: { status: 'published' },
      orderBy: { label: 'asc' },
    });
    return rows.map((row) => ({
      source: 'admin_template' as const,
      templateId: row.id,
      key: row.key,
      label: row.label,
      provider: row.provider,
      providerCategoryName: row.providerCategoryName,
      providerCategoryId: row.providerCategoryId,
      description: row.description,
      serviceOptionsJson: safeParse(row.serviceOptionsJson) ?? { groups: [] },
      pricingJson:
        safeParse(row.pricingJson) ?? {
          pricingModel: 'custom',
          currency: 'USD',
          basePrices: [],
          addOns: [],
          quoteRequired: true,
        },
      customerAnswersJson: safeParse(row.customerAnswersJson) ?? { entries: [] },
      qualificationSchemaJson: safeParse(row.qualificationSchemaJson),
      faqJson: safeParse(row.faqJson),
      serviceRules: safeParse(row.serviceRules),
      aliases: safeParse<string[]>(row.aliases) ?? [],
    }));
  }

  /**
   * Fetch a published template by id for the create-profile-from-template
   * flow. Returns null when the row is missing OR not published — we
   * never let a draft slip into a tenant's account by id-guess.
   */
  async getPublishedById(templateId: string) {
    const row = await this.prisma.serviceTemplatePreset.findUnique({
      where: { id: templateId },
    });
    if (!row || row.status !== 'published') return null;
    return row;
  }
}
