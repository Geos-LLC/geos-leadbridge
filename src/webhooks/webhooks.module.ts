/**
 * Webhooks Module
 */

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { PlatformsModule } from '../platforms/platforms.module';
import { AutomationModule } from '../automation/automation.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CallConnectModule } from '../call-connect/call-connect.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { ConversationContextModule } from '../conversation-context/conversation-context.module';

@Module({
  imports: [
    ConfigModule,
    PlatformsModule,
    AnalyticsModule,
    ConversationContextModule,
    forwardRef(() => AutomationModule),
    forwardRef(() => NotificationsModule),
    forwardRef(() => CallConnectModule),
  ],
  controllers: [WebhooksController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
