/**
 * Automation Module
 * Handles automated message sending rules
 */

import { Module, forwardRef } from '@nestjs/common';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';
import { PrismaService } from '../common/utils/prisma.service';
import { TemplatesModule } from '../templates/templates.module';
import { LeadsModule } from '../leads/leads.module';
import { PlatformsModule } from '../platforms/platforms.module';

@Module({
  imports: [
    TemplatesModule,
    forwardRef(() => LeadsModule),
    forwardRef(() => PlatformsModule),
  ],
  controllers: [AutomationController],
  providers: [AutomationService, PrismaService],
  exports: [AutomationService],
})
export class AutomationModule {}
