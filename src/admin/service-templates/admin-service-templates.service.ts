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

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/utils/prisma.service';
import {
  GeneratedTemplate,
  PublicTemplatePreset,
} from './admin-service-templates.types';
import { generateTemplate, GenerateInput } from './template-generator';

/** What `POST /v1/admin/service-templates` accepts as the body. */
export type CreateTemplateInput = GeneratedTemplate & {
  /** Optional override — admin can type a key explicitly. If absent we
   *  use the key the generator produced. */
  keyOverride?: string | null;
};

/** What `PATCH /v1/admin/service-templates/:id` accepts. All fields
 *  optional so admins can edit just the slices they reviewed. */
export type PatchTemplateInput = {
  label?: string;
  provider?: string;
  providerCategoryName?: string;
  providerCategoryId?: string | null;
  description?: string | null;
  serviceOptionsJson?: unknown;
  pricingJson?: unknown;
  customerAnswersJson?: unknown;
  additionalInstructions?: string | null;
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
export class AdminServiceTemplatesService {
  private readonly logger = new Logger(AdminServiceTemplatesService.name);

  constructor(private readonly prisma: PrismaService) {}

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
        additionalInstructions: input.additionalInstructions,
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
    if (patch.additionalInstructions !== undefined) {
      data.additionalInstructions = patch.additionalInstructions;
    }
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
      additionalInstructions: row.additionalInstructions,
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
