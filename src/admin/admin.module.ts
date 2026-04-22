import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminPhonePoolController } from './admin-phone-pool.controller';
import { AdminPhonePoolService } from './admin-phone-pool.service';
import { StripeModule } from '../stripe/stripe.module';
import { SigcoreModule } from '../sigcore/sigcore.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TrialModule } from '../trial/trial.module';

@Module({
  imports: [ConfigModule, StripeModule, SigcoreModule, NotificationsModule, TrialModule],
  controllers: [AdminController, AdminPhonePoolController],
  providers: [AdminService, AdminPhonePoolService],
  exports: [AdminService, AdminPhonePoolService],
})
export class AdminModule {}
