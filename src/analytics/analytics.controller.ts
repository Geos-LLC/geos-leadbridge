import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AnalyticsService } from './analytics.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';

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

  @Get('cache-info')
  async getCacheInfo(
    @CurrentUser() user: any,
    @Query('businessId') businessId?: string,
  ) {
    const info = await this.analyticsService.getCacheInfo(user.id, businessId);
    return { success: true, data: info };
  }
}
