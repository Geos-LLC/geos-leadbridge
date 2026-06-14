/**
 * Read-only admin view of accumulated service schemas.
 *
 * Step-1 mounts only `GET /v1/service-schemas?provider=thumbtack` — no
 * mutations, no per-tenant filtering (the table is cross-tenant by
 * design). Gated by JwtAuthGuard + AdminGuard since the catalog leaks
 * which categories LeadBridge as a whole has observed leads in.
 *
 * No frontend in PR1. Operators query it via curl during verification.
 */

import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../admin/guards/admin.guard';
import { ServiceSchemaService } from './service-schema.service';

const ALLOWED_PROVIDERS = new Set(['thumbtack', 'yelp', 'manual']);

@Controller('v1/service-schemas')
@UseGuards(JwtAuthGuard, AdminGuard)
export class ServiceSchemaController {
  constructor(private readonly serviceSchema: ServiceSchemaService) {}

  @Get()
  async list(@Query('provider') provider?: string) {
    const p = (provider ?? 'thumbtack').toLowerCase();
    if (!ALLOWED_PROVIDERS.has(p)) {
      throw new BadRequestException(
        `Unknown provider "${provider}". Expected one of: ${[...ALLOWED_PROVIDERS].join(', ')}.`,
      );
    }
    const rows = await this.serviceSchema.listByProvider(p);
    return {
      provider: p,
      count: rows.length,
      rows,
    };
  }
}
