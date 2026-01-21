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

@Module({
  imports: [ConfigModule, PlatformsModule, forwardRef(() => AutomationModule)],
  controllers: [WebhooksController],
  providers: [WebhooksService, PrismaService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
