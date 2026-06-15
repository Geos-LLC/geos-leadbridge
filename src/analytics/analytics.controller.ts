import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AnalyticsService } from './analytics.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { TimeSeriesQueryDto } from './dto/analytics-timeseries-query.dto';

@Controller('v1/analytics')
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  constructor(private analyticsService: AnalyticsService) {}

  @Get('basic')
  async getBasicAnalytics(
    @CurrentUser() user: any,
    @Query() query: AnalyticsQueryDto,
  ) {
    const analytics = await this.analyticsService.getBasicAnalytics(user.id, query);
    return { success: true, data: analytics };
  }

  @Get()
  async getAnalytics(
    @CurrentUser() user: any,
    @Query() query: AnalyticsQueryDto,
  ) {
    const { data, calculatedAt } = await this.analyticsService.getAnalytics(user.id, query);
    return { success: true, data, calculatedAt };
  }

  @Post('refresh')
  async refreshAnalytics(
    @CurrentUser() user: any,
    @Query() query: AnalyticsQueryDto,
  ) {
    const { data, calculatedAt } = await this.analyticsService.refreshAnalytics(user.id, query);
    return { success: true, data, calculatedAt };
  }

  @Get('timeseries')
  async getTimeSeries(
    @CurrentUser() user: any,
    @Query() query: TimeSeriesQueryDto,
  ) {
    const data = await this.analyticsService.getTimeSeries(user.id, query);
    return { success: true, data };
  }

  @Get('cache-info')
  async getCacheInfo(
    @CurrentUser() user: any,
    @Query('businessId') businessId?: string,
  ) {
    const info = await this.analyticsService.getCacheInfo(user.id, businessId);
    return { success: true, data: info };
  }

  /**
   * Skipped + refunded leads — tenant-facing visibility for leads where
   * the follow-up engine couldn't deliver (refund, platform-side removal,
   * thread closed, etc.). Replaces "operator runs the batch-report CLI"
   * for the day-to-day case.
   *
   * Returns one row per Lead where EITHER:
   *   - Lead.refundedAt IS NOT NULL (regardless of enrollment state), OR
   *   - any FollowUpEnrollment for the lead was stopped with a platform-
   *     side stoppedReason (platform_thread_unreachable, etc.)
   *
   * Auth: JwtAuthGuard scopes to user.id — tenants can only see their
   * own leads. Same query shape as other analytics endpoints.
   */
  @Get('skipped')
  async getSkippedLeads(
    @CurrentUser() user: any,
    @Query() query: AnalyticsQueryDto,
  ) {
    const data = await this.analyticsService.getSkippedLeads(user.id, query);
    return { success: true, data };
  }

  /**
   * Refundable-lead summary — small 2-stat widget on the Overview tab:
   *   - activeCount: leads with a currently-active RefundableLeadFlag
   *     and refundedAt IS NULL (matches the UI Refundable badge predicate)
   *   - estimatedValue: SUM(rawJson.leadPrice) for those leads
   *
   * No full table — the per-lead view is the Messages page badge +
   * popover. This endpoint is purely the headline number.
   */
  @Get('refundable-summary')
  async getRefundableSummary(@CurrentUser() user: any) {
    const data = await this.analyticsService.getRefundableSummary(user.id);
    return { success: true, data };
  }
}
