import { Controller, Get, Query, UseGuards } from '@nestjs/common';
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
    const analytics = await this.analyticsService.getBasicAnalytics(
      user.userId,
      query,
    );

    return {
      success: true,
      data: analytics,
    };
  }

  @Get()
  async getAnalytics(
    @CurrentUser() user: any,
    @Query() query: AnalyticsQueryDto,
  ) {
    const analytics = await this.analyticsService.getAnalytics(
      user.userId,
      query,
    );

    return {
      success: true,
      data: analytics,
    };
  }
}
