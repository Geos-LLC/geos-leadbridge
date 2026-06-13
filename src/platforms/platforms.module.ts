/**
 * Platforms Module
 */

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThumbtackAdapter } from './thumbtack/thumbtack.adapter';
import { ThumbtackController } from './thumbtack/thumbtack.controller';
import { YelpAdapter } from './yelp/yelp.adapter';
import { YelpController } from './yelp/yelp.controller';
import { PlatformsController } from './platforms.controller';
import { PlatformFactory } from './platform.factory';
import { PlatformService } from './platform.service';
import { LeadsModule } from '../leads/leads.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ConversationContextModule } from '../conversation-context/conversation-context.module';

@Module({
  imports: [
    ConfigModule,
    forwardRef(() => LeadsModule),
    forwardRef(() => NotificationsModule),
    ConversationContextModule,
  ],
  controllers: [ThumbtackController, YelpController, PlatformsController],
  providers: [ThumbtackAdapter, YelpAdapter, PlatformFactory, PlatformService],
  exports: [PlatformFactory, PlatformService, YelpAdapter],
})
export class PlatformsModule {}
