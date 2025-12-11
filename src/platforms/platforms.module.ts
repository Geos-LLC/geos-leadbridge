/**
 * Platforms Module
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThumbtackAdapter } from './thumbtack/thumbtack.adapter';
import { ThumbtackController } from './thumbtack/thumbtack.controller';
import { PlatformFactory } from './platform.factory';
import { PlatformService } from './platform.service';
import { PrismaService } from '../common/utils/prisma.service';

@Module({
  imports: [ConfigModule],
  controllers: [ThumbtackController],
  providers: [ThumbtackAdapter, PlatformFactory, PlatformService, PrismaService],
  exports: [PlatformFactory, PlatformService],
})
export class PlatformsModule {}
