import { Controller, Get, Patch, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { MonitoringService } from './monitoring.service';

@Controller('v1/monitoring')
@UseGuards(JwtAuthGuard)
export class MonitoringController {
  constructor(private monitoringService: MonitoringService) {}

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
}
