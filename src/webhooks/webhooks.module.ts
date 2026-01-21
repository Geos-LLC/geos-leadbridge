/**
 * Webhooks Module
 */

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { PrismaService } from '../common/utils/prisma.service';
import { PlatformsModule } from '../platforms/platforms.module';
import { AutomationModule } from '../automation/automation.module';
import { LeadsModule } from '../leads/leads.module';

@Module({
  imports: [ConfigModule, PlatformsModule, forwardRef(() => AutomationModule), forwardRef(() => LeadsModule)],
  controllers: [WebhooksController],
  providers: [WebhooksService, PrismaService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
