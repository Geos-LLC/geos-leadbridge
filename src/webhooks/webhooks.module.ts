/**
 * Webhooks Module
 */

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookCrashFilter } from './webhook-crash.filter';
import { PlatformsModule } from '../platforms/platforms.module';
import { AutomationModule } from '../automation/automation.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CallConnectModule } from '../call-connect/call-connect.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { ConversationContextModule } from '../conversation-context/conversation-context.module';
import { FollowUpEngineModule } from '../follow-up-engine/follow-up-engine.module';
import { LeadsModule } from '../leads/leads.module';

@Module({
  imports: [
    ConfigModule,
    PlatformsModule,
    AnalyticsModule,
    ConversationContextModule,
    FollowUpEngineModule,
    forwardRef(() => AutomationModule),
    forwardRef(() => NotificationsModule),
    forwardRef(() => CallConnectModule),
    forwardRef(() => LeadsModule),
  ],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookCrashFilter],
  exports: [WebhooksService],
})
export class WebhooksModule {}
