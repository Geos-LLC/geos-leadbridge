/**
 * Platforms Module
 */

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThumbtackAdapter } from './thumbtack/thumbtack.adapter';
import { ThumbtackController } from './thumbtack/thumbtack.controller';
import { PlatformFactory } from './platform.factory';
import { PlatformService } from './platform.service';
import { PrismaService } from '../common/utils/prisma.service';
import { LeadsModule } from '../leads/leads.module';

@Module({
  imports: [ConfigModule, forwardRef(() => LeadsModule)],
  controllers: [ThumbtackController],
  providers: [ThumbtackAdapter, PlatformFactory, PlatformService, PrismaService],
  exports: [PlatformFactory, PlatformService],
})
export class PlatformsModule {}
