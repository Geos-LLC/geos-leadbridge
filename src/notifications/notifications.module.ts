/**
 * Notifications Module
 * Manages SMS notification settings and Sigcore integration
 */

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { InstantTextAiService } from './instant-text-ai.service';
import { ConversationContextModule } from '../conversation-context/conversation-context.module';
import { PlatformsModule } from '../platforms/platforms.module';
import { AiModule } from '../ai/ai.module';
import { ServiceProfileModule } from '../service-profile/service-profile.module';
import { PrismaService } from '../common/utils/prisma.service';

@Module({
  // ConversationContextModule wired in 2026-06-11 so notification-rule SMS
  // and ad-hoc SMS writes flow through recordMessage (TC freshness fix).
  // PlatformsModule (forwardRef) wired so TenantPhoneNumber lifecycle hooks
  // can re-sync the LB number as a TT associate phone (substitute sender).
  // AiModule wired 2026-06-12 so Instant Text can generate AI SMS bodies
  // via the same AiService the Lead Activity / Follow-up generators use.
  // ServiceProfileModule wired so Instant Text routes pricing/FAQ through
  // the per-field resolver (Phase 1b adoption).
  imports: [
    ConfigModule,
    ConversationContextModule,
    forwardRef(() => PlatformsModule),
    AiModule,
    ServiceProfileModule,
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService, InstantTextAiService, PrismaService],
  exports: [NotificationsService, InstantTextAiService],
})
export class NotificationsModule {}
