/**
 * Automation Module
 * Handles automated message sending rules
 */

import { Module, forwardRef } from '@nestjs/common';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';
import { TemplatesModule } from '../templates/templates.module';
import { LeadsModule } from '../leads/leads.module';
import { PlatformsModule } from '../platforms/platforms.module';
import { AiModule } from '../ai/ai.module';
import { ConversationContextModule } from '../conversation-context/conversation-context.module';
import { FollowUpEngineModule } from '../follow-up-engine/follow-up-engine.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    TemplatesModule,
    forwardRef(() => LeadsModule),
    forwardRef(() => PlatformsModule),
    AiModule,
    ConversationContextModule,
    forwardRef(() => FollowUpEngineModule),
    NotificationsModule,
  ],
  controllers: [AutomationController],
  providers: [AutomationService],
  exports: [AutomationService],
})
export class AutomationModule {}
