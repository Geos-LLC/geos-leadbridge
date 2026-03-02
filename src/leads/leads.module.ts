/**
 * Leads Module
 */

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { PlatformsModule } from '../platforms/platforms.module';
import { TemplatesModule } from '../templates/templates.module';
import { AnalyticsModule } from '../analytics/analytics.module';

@Module({
  imports: [forwardRef(() => PlatformsModule), ConfigModule, TemplatesModule, AnalyticsModule],
  controllers: [LeadsController],
  providers: [LeadsService],
  exports: [LeadsService],
})
export class LeadsModule {}
