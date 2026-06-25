/**
 * Leads Module
 */

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadStatusService } from './lead-status.service';
import { AppointmentDetectorService } from './appointment-detector.service';
import { AppointmentSweeperService } from './appointment-sweeper.service';
import { PlatformsModule } from '../platforms/platforms.module';
import { TemplatesModule } from '../templates/templates.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { ConversationContextModule } from '../conversation-context/conversation-context.module';

@Module({
  imports: [forwardRef(() => PlatformsModule), ConfigModule, TemplatesModule, AnalyticsModule, ConversationContextModule],
  controllers: [LeadsController],
  providers: [LeadsService, LeadStatusService, AppointmentDetectorService, AppointmentSweeperService],
  exports: [LeadsService, LeadStatusService, AppointmentDetectorService, AppointmentSweeperService],
})
export class LeadsModule {}
