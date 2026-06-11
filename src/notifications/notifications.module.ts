/**
 * Notifications Module
 * Manages SMS notification settings and Sigcore integration
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { ConversationContextModule } from '../conversation-context/conversation-context.module';

@Module({
  // ConversationContextModule wired in 2026-06-11 so notification-rule SMS
  // and ad-hoc SMS writes flow through recordMessage (TC freshness fix).
  imports: [ConfigModule, ConversationContextModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
