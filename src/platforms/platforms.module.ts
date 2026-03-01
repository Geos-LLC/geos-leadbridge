/**
 * Platforms Module
 */

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThumbtackAdapter } from './thumbtack/thumbtack.adapter';
import { ThumbtackController } from './thumbtack/thumbtack.controller';
import { PlatformsController } from './platforms.controller';
import { PlatformFactory } from './platform.factory';
import { PlatformService } from './platform.service';
import { LeadsModule } from '../leads/leads.module';

@Module({
  imports: [ConfigModule, forwardRef(() => LeadsModule)],
  controllers: [ThumbtackController, PlatformsController],
  providers: [ThumbtackAdapter, PlatformFactory, PlatformService],
  exports: [PlatformFactory, PlatformService],
})
export class PlatformsModule {}
