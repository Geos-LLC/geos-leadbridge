import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { ListUsersDto } from './dto/list-users.dto';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { CacheService } from '../common/cache/cache.service';
import { CacheKeys } from '../common/cache/cache-keys';
import { LeadCacheService } from '../common/cache/lead-cache.service';
import { PrismaService } from '../common/utils/prisma.service';
import { YelpBackfillService, BackfillDryRunInput } from './yelp-backfill.service';

@Controller('v1/admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly cache: CacheService,
    private readonly leadCache: LeadCacheService,
    private readonly prisma: PrismaService,
    private readonly yelpBackfill: YelpBackfillService,
  ) {}

  @Get('users')
  async listUsers(@Query() query: ListUsersDto) {
    const result = await this.adminService.listUsers(query);
    return {
      success: true,
      data: result,
    };
  }

  @Get('users/:userId')
  async getUserDetails(@Param('userId') userId: string) {
    const result = await this.adminService.getUserDetails(userId);
    return {
      success: true,
      data: result,
    };
  }

  @Patch('users/:userId/subscription')
  async updateUserSubscription(
    @Req() req: any,
    @Param('userId') userId: string,
    @Body() dto: UpdateSubscriptionDto,
  ) {
    const adminId = req.user.id;
    const result = await this.adminService.updateUserSubscription(
      adminId,
      userId,
      dto,
    );
    return {
      success: true,
      data: result,
    };
  }

  @Post('users/:userId/cancel-subscription')
  async cancelUserSubscription(
    @Req() req: any,
    @Param('userId') userId: string,
    @Body() body: { immediate?: boolean },
  ) {
    const adminId = req.user.id;
    const immediate = body.immediate !== false; // Default to true
    const result = await this.adminService.cancelUserSubscription(
      adminId,
      userId,
      immediate,
    );
    return {
      success: true,
      data: result,
    };
  }

  @Patch('users/:userId/trial-leads')
  async updateTrialLeads(
    @Req() req: any,
    @Param('userId') userId: string,
    @Body() body: { trialLeadsHandled?: number; trialLeadsLimit?: number },
  ) {
    const adminId = req.user.id;
    const result = await this.adminService.updateTrialLeads(adminId, userId, body);
    return {
      success: true,
      data: result,
    };
  }

  @Post('trials/reset-all')
  async resetAllTrials(@Req() req: any) {
    const adminId = req.user.id;
    const result = await this.adminService.resetAllTrials(adminId);
    return { success: true, data: result };
  }

  @Delete('users/:userId')
  async deleteUser(@Req() req: any, @Param('userId') userId: string) {
    const adminId = req.user.id;
    const result = await this.adminService.deleteUser(adminId, userId);
    return {
      success: true,
      data: result,
    };
  }

  @Get('stats')
  async getStats() {
    const result = await this.adminService.getStats();
    return {
      success: true,
      data: result,
    };
  }

  @Get('logs')
  async getAdminLogs(@Query() query: { limit?: number; offset?: number }) {
    const result = await this.adminService.getAdminLogs(query);
    return {
      success: true,
      data: result,
    };
  }

  @Get('notification-logs')
  async getNotificationLogs(@Query() query: { limit?: number }) {
    const result = await this.adminService.getNotificationLogs(query);
    return {
      success: true,
      ...result,
    };
  }

  @Get('tenant-numbers')
  async getTenantNumbers(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const result = await this.adminService.getTenantNumbers({
      search,
      status,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    return { success: true, data: result };
  }

  @Get('tenant-errors')
  async getTenantErrorFeed(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const result = await this.adminService.getTenantErrorFeed({
      status,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    return { success: true, data: result };
  }

  // ==========================================================================
  // Cache admin — protected by JwtAuthGuard + AdminGuard above.
  // ==========================================================================

  /**
   * GET /v1/admin/cache/status
   * Returns Redis connectivity + hit/miss counters. Safe to call frequently.
   */
  @Get('cache/status')
  getCacheStatus() {
    return {
      success: true,
      data: this.cache.getStats(),
    };
  }

  /**
   * POST /v1/admin/cache/invalidate-user/:userId
   * Wipe every cached entry we know about for a user: /auth/me, saved-accounts,
   * leads list. Does NOT invalidate per-lead detail keys (unknown set) — those
   * TTL out or can be invalidated individually via invalidate-lead.
   */
  @Post('cache/invalidate-user/:userId')
  async invalidateUserCache(@Param('userId') userId: string) {
    await Promise.all([
      this.cache.del(CacheKeys.me(userId)),
      this.cache.delPattern(CacheKeys.savedAccountsPattern(userId)),
      this.leadCache.invalidateLeadList(userId),
    ]);
    return { success: true, userId };
  }

  /**
   * POST /v1/admin/cache/invalidate-lead/:leadId
   * Wipe detail + messages for the lead, and the list for its owning user.
   * Looks up userId from the DB — the endpoint caller does not need to know it.
   */
  @Post('cache/invalidate-lead/:leadId')
  async invalidateLeadCache(@Param('leadId') leadId: string) {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { userId: true },
    });
    if (!lead) {
      return { success: false, leadId, error: 'Lead not found' };
    }
    await this.leadCache.invalidateLeadMessagesAndList(lead.userId, leadId);
    return { success: true, leadId, userId: lead.userId };
  }

  // ==========================================================================
  // Yelp backfill — dry-run only in this PR (cache plan Phase 2 prep).
  // The write path is deliberately not implemented here; dryRun=false → 400.
  // ==========================================================================

  /**
   * POST /v1/admin/backfill/yelp
   * Body: BackfillDryRunInput. Returns a per-lead breakdown of what the
   * webhook full-thread persist would create, without writing anything.
   */
  @Post('backfill/yelp')
  async backfillYelp(@Body() body: BackfillDryRunInput) {
    const result = await this.yelpBackfill.dryRun(body || {});
    return { success: true, data: result };
  }
}
