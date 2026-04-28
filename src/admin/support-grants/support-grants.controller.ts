/**
 * Support Grants Controller — Phase 3
 *
 * Admin-only endpoints for issuing the time-bound, scope-limited grants that
 * gate access to customer-data admin routes.
 *
 * Routes
 *   POST /v1/me/support-grants — issue a new grant. Body:
 *     { tenantId: string, scopes: string[], reason: string,
 *       durationMinutes?: number }
 *
 * "/me" reflects "this admin's own grants" (admins issue grants to themselves
 * with reason + scope + expiry). The `JwtAuthGuard` is applied globally; the
 * `AdminGuard` is applied here at the controller level.
 */
import { Body, Controller, Logger, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import { CreateSupportGrantDto } from './dto/create-support-grant.dto';
import { SupportGrantsService } from './support-grants.service';

@Controller('v1/me/support-grants')
@UseGuards(JwtAuthGuard, AdminGuard)
export class SupportGrantsController {
  private readonly logger = new Logger(SupportGrantsController.name);

  constructor(private readonly supportGrantsService: SupportGrantsService) {}

  @Post()
  async create(@Req() req: any, @Body() dto: CreateSupportGrantDto) {
    const adminUserId = req.user.id;
    const grant = await this.supportGrantsService.createGrant(adminUserId, dto);
    return {
      success: true,
      grant: {
        id: grant.id,
        tenantId: grant.tenantId,
        scopes: grant.scopes,
        reason: grant.reason,
        expiresAt: grant.expiresAt,
        createdAt: grant.createdAt,
      },
    };
  }
}
