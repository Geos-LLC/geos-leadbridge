/**
 * ServiceProfileController — v1 preset consumer endpoints.
 *
 * Two endpoints:
 *   GET  /v1/service-profile-presets       — list the curated registry
 *   POST /v1/service-profiles/from-preset  — create a draft profile
 *                                            from a preset key
 *
 * Both require JWT auth. The POST endpoint is per-user — creates a
 * row under `req.user.id`. No admin/cross-tenant operations in v1.
 */

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ServiceProfileService } from './service-profile.service';
import { SERVICE_PRESETS, lookupPresetByKey } from './presets/service-presets';

@Controller('v1')
@UseGuards(JwtAuthGuard)
export class ServiceProfileController {
  constructor(private readonly service: ServiceProfileService) {}

  /**
   * List every curated preset. Returns the full preset object — preset
   * data is intentionally tenant-facing (operators see the pricing
   * sources, descriptions, etc. before opting in). No PII, no
   * tenant-scoped data.
   */
  @Get('service-profile-presets')
  list() {
    return {
      presets: SERVICE_PRESETS.map((p) => ({
        key: p.key,
        provider: p.provider,
        providerCategoryName: p.providerCategoryName,
        label: p.label,
        description: p.description,
        aliases: p.aliases,
        qualificationSchemaJson: p.qualificationSchemaJson,
        pricingJson: p.pricingJson,
        faqJson: p.faqJson,
      })),
    };
  }

  /**
   * Create a draft ServiceProfile from a preset. Body:
   *   { presetKey: string, status?: 'draft' | 'active' }
   *
   * Status defaults to 'draft' — operator must promote to active
   * before the resolver's aiPaused short-circuit stops gating leads.
   * No silent activation, even if the caller passes status='active'
   * explicitly — we honor that, but the typical UX flow shouldn't
   * send anything but 'draft' in v1.
   *
   * 400 — unknown presetKey
   * 409 — a profile with the preset's default slug already exists
   *       for this user (preset already used — only one per tenant)
   */
  @Post('service-profiles/from-preset')
  async createFromPreset(
    @Req() req: any,
    @Body() body: { presetKey?: string; status?: 'draft' | 'active' },
  ) {
    if (!body?.presetKey || typeof body.presetKey !== 'string') {
      throw new BadRequestException('presetKey is required');
    }
    const preset = lookupPresetByKey(body.presetKey);
    if (!preset) {
      throw new BadRequestException(`Unknown preset key: ${body.presetKey}`);
    }
    if (body.status && body.status !== 'draft' && body.status !== 'active') {
      throw new BadRequestException(`Invalid status: ${body.status}`);
    }

    const userId: string = req.user?.id;
    if (!userId) {
      throw new BadRequestException('Authenticated user required');
    }

    try {
      const profile = await this.service.createFromPreset({
        userId,
        preset,
        status: body.status ?? 'draft',
      });
      return {
        profileId: profile.id,
        slug: profile.slug,
        status: profile.status,
        name: profile.name,
      };
    } catch (err: any) {
      // Prisma P2002 — unique constraint violation on (userId, slug).
      // Convert into a 409 so the UI can show a meaningful message.
      if (err?.code === 'P2002') {
        throw new ConflictException(
          `A service profile from this preset already exists for this user`,
        );
      }
      throw err;
    }
  }
}
