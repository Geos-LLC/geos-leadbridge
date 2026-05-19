import { Module, forwardRef } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { SigcoreModule } from '../sigcore/sigcore.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { StripeModule } from '../stripe/stripe.module';
import { PlatformsModule } from '../platforms/platforms.module';

@Module({
  imports: [
    SigcoreModule,
    NotificationsModule,
    StripeModule,
    // forwardRef because PlatformsModule pulls in NotificationsModule which
    // (transitively) can reach back here.
    forwardRef(() => PlatformsModule),
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
