import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { IntegrationsController } from './integrations.controller';
import { YelpIntegrationsController } from './yelp-integrations.controller';
import { IntegrationsService } from './integrations.service';
import { AnalyticsModule } from '../analytics/analytics.module';
import { LeadsModule } from '../leads/leads.module';
import { PlatformsModule } from '../platforms/platforms.module';
import { FollowUpEngineModule } from '../follow-up-engine/follow-up-engine.module';

@Module({
  imports: [
    AnalyticsModule,
    LeadsModule,
    PlatformsModule,
    ConfigModule,
    forwardRef(() => FollowUpEngineModule),
  ],
  controllers: [IntegrationsController, YelpIntegrationsController],
  providers: [IntegrationsService],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
