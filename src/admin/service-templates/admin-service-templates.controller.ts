/**
 * AdminServiceTemplatesController — admin-only endpoints for the Service
 * Template Builder. JwtAuthGuard + AdminGuard mirror the rest of the
 * /v1/admin/* surface; non-admin requests get 403 from the guard before
 * reaching any handler.
 *
 * Routes (all under /v1/admin/service-templates):
 *   GET    /              list all (admin)
 *   GET    /:id           one row
 *   POST   /generate      pure compute — no DB write
 *   POST   /              create draft from reviewed JSON
 *   PATCH  /:id           edit fields
 *   POST   /:id/publish   transition to published
 *   POST   /:id/archive   transition to archived
 *   POST   /:id/draft     transition back to draft (rare)
 *   DELETE /:id           hard-delete a template row
 *
 * Body shapes accept either parsed JSON objects or already-stringified
 * blobs for the four JSON columns — see toJsonString in the service.
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
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import {
  AdminServiceTemplatesService,
  CreateTemplateInput,
  PatchTemplateInput,
} from './admin-service-templates.service';
import { GenerateInput } from './template-generator';

@Controller('v1/admin/service-templates')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminServiceTemplatesController {
  constructor(private readonly service: AdminServiceTemplatesService) {}

  @Get()
  async list() {
    const templates = await this.service.listAll();
    return { templates };
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    try {
      return await this.service.getById(id);
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') throw new NotFoundException(err.message);
      throw err;
    }
  }

  /**
   * Pure compute — runs the deterministic generator and returns the
   * shape for admin review/edit. NO database write happens here.
   */
  @Post('generate')
  generate(@Body() body: Partial<GenerateInput>) {
    const required = ['serviceName', 'provider', 'providerCategoryName'] as const;
    for (const k of required) {
      const v = (body as any)?.[k];
      if (typeof v !== 'string' || v.trim().length === 0) {
        throw new BadRequestException(`${k} is required`);
      }
    }
    if (typeof body.rawOptionsText !== 'string') body.rawOptionsText = '';
    if (typeof body.rawPricingText !== 'string') body.rawPricingText = '';
    const generated = this.service.generate({
      serviceName: body.serviceName!,
      provider: body.provider!,
      providerCategoryName: body.providerCategoryName!,
      providerCategoryId: body.providerCategoryId ?? null,
      notes: body.notes ?? null,
      rawOptionsText: body.rawOptionsText,
      rawPricingText: body.rawPricingText,
    });
    return { generated };
  }

  /** Persist the admin's reviewed/edited template as a draft. */
  @Post()
  async create(@Req() req: any, @Body() body: CreateTemplateInput) {
    const adminUserId: string = req.user?.id;
    if (!adminUserId) throw new BadRequestException('Authenticated user required');
    if (!body || typeof body.label !== 'string' || body.label.trim().length === 0) {
      throw new BadRequestException('label is required');
    }
    if (typeof body.key !== 'string' || body.key.trim().length === 0) {
      throw new BadRequestException('key is required');
    }
    if (typeof body.provider !== 'string' || body.provider.trim().length === 0) {
      throw new BadRequestException('provider is required');
    }
    if (
      typeof body.providerCategoryName !== 'string' ||
      body.providerCategoryName.trim().length === 0
    ) {
      throw new BadRequestException('providerCategoryName is required');
    }
    try {
      const row = await this.service.create({ adminUserId, input: body });
      return { template: row };
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException(
          `A service template with key "${body.key}" already exists`,
        );
      }
      throw err;
    }
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body() body: PatchTemplateInput) {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException('patch body required');
    }
    try {
      const row = await this.service.patch({ templateId: id, patch: body });
      return { template: row };
    } catch (err: any) {
      if (err?.code === 'P2025') throw new NotFoundException('Service template not found');
      throw err;
    }
  }

  @Post(':id/publish')
  async publish(@Param('id') id: string) {
    try {
      const row = await this.service.setStatus({ templateId: id, nextStatus: 'published' });
      return { template: row };
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') throw new NotFoundException(err.message);
      throw err;
    }
  }

  @Post(':id/archive')
  async archive(@Param('id') id: string) {
    try {
      const row = await this.service.setStatus({ templateId: id, nextStatus: 'archived' });
      return { template: row };
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') throw new NotFoundException(err.message);
      throw err;
    }
  }

  /** Demote a published or archived row back to draft. */
  @Post(':id/draft')
  async demote(@Param('id') id: string) {
    try {
      const row = await this.service.setStatus({ templateId: id, nextStatus: 'draft' });
      return { template: row };
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') throw new NotFoundException(err.message);
      throw err;
    }
  }

  /**
   * Hard-delete the template row. ServiceProfile rows already created
   * from this template stay intact — the template id isn't referenced
   * after copy time. Prefer `archive` when the template was real but
   * no longer in rotation; use Delete for test rows / mistakes.
   */
  @Delete(':id')
  async remove(@Param('id') id: string) {
    try {
      return await this.service.delete({ templateId: id });
    } catch (err: any) {
      if (err?.code === 'NOT_FOUND') throw new NotFoundException(err.message);
      throw err;
    }
  }
}
