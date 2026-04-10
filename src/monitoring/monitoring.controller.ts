import { Controller, Get, Post, Patch, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MonitoringService } from './monitoring.service';

@Controller('v1/monitoring')
@UseGuards(JwtAuthGuard)
export class MonitoringController {
  constructor(private monitoringService: MonitoringService) {}

  // ==========================================
  // System Health
  // ==========================================

  /**
   * Get system health for current user.
   * Source of truth for dashboard + layout banner.
   */
  @Get('system-health')
  async getSystemHealth(@CurrentUser() user: any) {
    return this.monitoringService.getSystemHealthForUser(user.id);
  }

  /**
   * Run health check manually for current user's accounts.
   * Rate-limited by advisory lock (returns cached if another run is in progress).
   */
  @Post('system-health/run')
  async runHealthCheck(@CurrentUser() user: any) {
    return this.monitoringService.runHealthCheckForUser(user.id);
  }

  // ==========================================
  // Error Logs
  // ==========================================

  @Get('errors')
  async getErrors(
    @Query('limit') limit?: string,
    @Query('onlyUnresolved') onlyUnresolved?: string,
    @Query('category') category?: string,
  ) {
    const errors = await this.monitoringService.getRecentErrors({
      limit: limit ? parseInt(limit, 10) : 50,
      onlyUnresolved: onlyUnresolved === 'true',
      category,
    });
    return { errors };
  }

  @Get('errors/summary')
  async getSummary() {
    return this.monitoringService.getErrorSummary();
  }

  @Patch('errors/:id/resolve')
  async resolveError(@Param('id') id: string) {
    await this.monitoringService.resolveError(id);
    return { success: true };
  }

  @Patch('errors/resolve-all/:category')
  async resolveAllByCategory(@Param('category') category: string) {
    const count = await this.monitoringService.resolveAllByCategory(category);
    return { success: true, resolved: count };
  }

  @Patch('errors/deduplicate')
  async deduplicateErrors() {
    const count = await this.monitoringService.deduplicateErrors();
    return { success: true, deduplicatedCount: count };
  }
}
