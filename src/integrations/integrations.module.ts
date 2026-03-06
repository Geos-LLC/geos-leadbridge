import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { AnalyticsModule } from '../analytics/analytics.module';
import { LeadsModule } from '../leads/leads.module';

@Module({
  imports: [AnalyticsModule, LeadsModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
