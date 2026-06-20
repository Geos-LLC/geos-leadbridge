/**
 * ServiceProfileController — preset consumer + management endpoints.
 *
 * Routes:
 *   GET    /v1/service-profile-presets              list curated registry
 *   POST   /v1/service-profiles/from-preset         create from preset
 *   GET    /v1/service-profiles                     list user's profiles
 *   GET    /v1/service-profiles/:id                 get one profile
 *   PATCH  /v1/service-profiles/:id                 edit fields
 *   PATCH  /v1/service-profiles/:id/status          transition status
 *   POST   /v1/service-profiles/:id/duplicate       duplicate as draft
 *   GET    /v1/service-profiles/:id/overrides       list per-account overrides
 *   PUT    /v1/service-profiles/:id/overrides/:savedAccountId  set override
 *   DELETE /v1/service-profiles/:id/overrides/:savedAccountId  clear override
 *
 * All endpoints JWT-guarded. Service methods scope by `req.user.id`
 * so tenants can't read or modify each other's rows even with a known
 * profile id (returns 404).
 */

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ServiceProfileService } from './service-profile.service';
import { AdminServiceTemplatesService } from '../admin/service-templates/admin-service-templates.service';

@Controller('v1')
@UseGuards(JwtAuthGuard)
export class ServiceProfileController {
  constructor(
    private readonly service: ServiceProfileService,
    private readonly adminTemplates: AdminServiceTemplatesService,
  ) {}

  // ─── Preset registry ──────────────────────────────────────────────

  /**
   * Public preset listing. Single source of truth = the
   * `service_template_presets` table. Returns only published rows;
   * drafts + archived templates are admin-only.
   *
   * The two historically-hardcoded code presets
   * (`upholstery_furniture_cleaning`, `generic_custom_service`) are
   * seeded into the same table at boot by AdminServiceTemplatesService,
   * so they appear here alongside any admin-authored rows. Every entry
   * carries `source: 'admin_template'` and `templateId` — the picker
   * routes subsequent creates via the templateId path.
   */
  @Get('service-profile-presets')
  async list() {
    const presets = await this.adminTemplates.listPublished();
    return { presets };
  }

  /**
   * Blank-service creation — for the "Start from scratch" tile in the
   * Add Service modal. Body just carries a name; everything else
   * (pricing, FAQ, qualification, mappings) is left null/empty so the
   * AI Playbook per-Service tab renders its generic editors.
   */
  @Post('service-profiles')
  async createBlankService(
    @Req() req: any,
    @Body() body: { name?: string },
  ) {
    const name = (body?.name ?? '').trim();
    if (!name) throw new BadRequestException('name is required');
    if (name.length > 80) {
      throw new BadRequestException('name must be 80 characters or fewer');
    }
    const userId: string = req.user?.id;
    if (!userId) throw new BadRequestException('Authenticated user required');
    try {
      const profile = await this.service.createBlank({ userId, name });
      return {
        profileId: profile.id,
        slug: profile.slug,
        status: profile.status,
        name: profile.name,
      };
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException('A service profile with that name already exists');
      }
      throw err;
    }
  }

  /**
   * Create a ServiceProfile from a published admin template. After the
   * code-side `SERVICE_PRESETS` registry was retired (the two historical
   * code presets now live in `service_template_presets` via boot seed),
   * `templateId` is the only accepted creation key. Lands as draft so the
   * operator must explicitly activate it.
   */
  @Post('service-profiles/from-preset')
  async createFromPreset(
    @Req() req: any,
    @Body() body: { templateId?: string },
  ) {
    const templateId = body?.templateId;
    if (typeof templateId !== 'string' || templateId.length === 0) {
      throw new BadRequestException('templateId is required');
    }
    const userId: string = req.user?.id;
    if (!userId) throw new BadRequestException('Authenticated user required');

    try {
      const profile = await this.service.createFromAdminTemplate({
        userId,
        templateId,
      });
      return {
        profileId: profile.id,
        slug: profile.slug,
        status: profile.status,
        name: profile.name,
      };
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') {
        throw new NotFoundException(err.message);
      }
      if (err?.code === 'P2002') {
        throw new ConflictException(
          'A service profile from this template already exists',
        );
      }
      throw err;
    }
  }

  // ─── Profile listing + details ────────────────────────────────────

  @Get('service-profiles')
  async listProfiles(@Req() req: any) {
    const userId: string = req.user?.id;
    if (!userId) throw new BadRequestException('Authenticated user required');
    const rows = await this.service.listByUser(userId);
    return {
      profiles: rows.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        status: p.status,
        isDefault: p.isDefault,
        providerCategoryMappingsJson: p.providerCategoryMappingsJson,
        pricingJson: p.pricingJson,
        faqJson: p.faqJson,
        qualificationSchemaJson: p.qualificationSchemaJson,
        aiInstructionsJson: p.aiInstructionsJson,
        archivedAt: p.archivedAt,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
    };
  }

  @Get('service-profiles/:id')
  async getProfile(@Req() req: any, @Param('id') id: string) {
    const userId: string = req.user?.id;
    if (!userId) throw new BadRequestException('Authenticated user required');
    const row = await this.service.getOneForUser(userId, id);
    if (!row) throw new NotFoundException('Service profile not found');
    return row;
  }

  // ─── Edit + transition + duplicate ────────────────────────────────

  @Patch('service-profiles/:id')
  async updateProfile(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: {
      name?: string;
      providerCategoryMappingsJson?: unknown;
      pricingJson?: string | null;
      faqJson?: string | null;
      qualificationSchemaJson?: string | null;
      aiInstructionsJson?: string | null;
    },
  ) {
    const userId: string = req.user?.id;
    if (!userId) throw new BadRequestException('Authenticated user required');
    try {
      return await this.service.updateProfile(userId, id, body ?? {});
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') throw new NotFoundException(err.message);
      if (err?.code === 'EMPTY_NAME' || err?.code === 'INVALID_MAPPINGS') {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  @Patch('service-profiles/:id/status')
  async transitionStatus(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { status?: 'draft' | 'active' | 'archived'; allowReactivate?: boolean },
  ) {
    const userId: string = req.user?.id;
    if (!userId) throw new BadRequestException('Authenticated user required');
    if (!body?.status || !['draft', 'active', 'archived'].includes(body.status)) {
      throw new BadRequestException('status must be draft | active | archived');
    }
    try {
      return await this.service.transitionStatus(userId, id, body.status, {
        allowReactivate: body.allowReactivate === true,
      });
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') throw new NotFoundException(err.message);
      if (
        err?.code === 'INVALID_TRANSITION' ||
        err?.code === 'EMPTY_CONFIG' ||
        err?.code === 'DEFAULT_BLOCKED'
      ) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  @Post('service-profiles/:id/duplicate')
  async duplicateProfile(@Req() req: any, @Param('id') id: string) {
    const userId: string = req.user?.id;
    if (!userId) throw new BadRequestException('Authenticated user required');
    try {
      return await this.service.duplicateProfile(userId, id);
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') throw new NotFoundException(err.message);
      throw err;
    }
  }

  @Delete('service-profiles/:id')
  async deleteProfile(@Req() req: any, @Param('id') id: string) {
    const userId: string = req.user?.id;
    if (!userId) throw new BadRequestException('Authenticated user required');
    try {
      return await this.service.deleteProfile(userId, id);
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') throw new NotFoundException(err.message);
      if (err?.code === 'DEFAULT_BLOCKED') throw new BadRequestException(err.message);
      throw err;
    }
  }

  // ─── Location overrides ───────────────────────────────────────────

  @Get('service-profiles/:id/overrides')
  async listOverrides(@Req() req: any, @Param('id') id: string) {
    const userId: string = req.user?.id;
    if (!userId) throw new BadRequestException('Authenticated user required');
    try {
      return { overrides: await this.service.listOverridesForProfile(userId, id) };
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') throw new NotFoundException(err.message);
      throw err;
    }
  }

  @Put('service-profiles/:id/overrides/:savedAccountId')
  async setOverride(
    @Req() req: any,
    @Param('id') id: string,
    @Param('savedAccountId') savedAccountId: string,
    @Body() body: { pricingDeltasJson?: string | null; faqAdditionsJson?: string | null },
  ) {
    const userId: string = req.user?.id;
    if (!userId) throw new BadRequestException('Authenticated user required');
    try {
      return await this.service.setOverride(userId, id, savedAccountId, body ?? {});
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') throw new NotFoundException(err.message);
      throw err;
    }
  }

  // ─── PR-E: account ↔ service assignments ──────────────────────────

  @Get('saved-accounts/service-assignments')
  async listSavedAccountAssignments(@Req() req: any) {
    const userId: string = req.user?.id;
    if (!userId) throw new BadRequestException('Authenticated user required');
    return { accounts: await this.service.listSavedAccountAssignments(userId) };
  }

  @Put('saved-accounts/:savedAccountId/service-assignments')
  async setSavedAccountAssignments(
    @Req() req: any,
    @Param('savedAccountId') savedAccountId: string,
    @Body() body: {
      enabledServiceProfileIds?: string[] | null;
      defaultServiceProfileId?: string | null;
    },
  ) {
    const userId: string = req.user?.id;
    if (!userId) throw new BadRequestException('Authenticated user required');
    // null is the explicit "clear assignments" signal; anything else
    // must be an array. Treat undefined as "no change" — but since
    // PUT semantics are full-replace, we require the caller to pass
    // either an explicit array or explicit null.
    const enabled = body?.enabledServiceProfileIds;
    if (enabled !== null && !Array.isArray(enabled)) {
      throw new BadRequestException('enabledServiceProfileIds must be an array or null');
    }
    try {
      return await this.service.setSavedAccountAssignments(userId, savedAccountId, {
        enabledServiceProfileIds: enabled,
        defaultServiceProfileId: body?.defaultServiceProfileId ?? null,
      });
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') throw new NotFoundException(err.message);
      if (err?.code === 'INVALID_ASSIGNMENT') throw new BadRequestException(err.message);
      throw err;
    }
  }

  @Delete('service-profiles/:id/overrides/:savedAccountId')
  async clearOverride(
    @Req() req: any,
    @Param('id') id: string,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    const userId: string = req.user?.id;
    if (!userId) throw new BadRequestException('Authenticated user required');
    try {
      return await this.service.setOverride(userId, id, savedAccountId, {
        pricingDeltasJson: null,
        faqAdditionsJson: null,
      });
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') throw new NotFoundException(err.message);
      throw err;
    }
  }
}
