import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminPhonePoolController } from './admin-phone-pool.controller';
import { AdminPhonePoolService } from './admin-phone-pool.service';
import { SigcoreWebhookMigrationController } from './sigcore-webhook-migration.controller';
import { SigcoreWebhookMigrationService } from './sigcore-webhook-migration.service';
import { StripeModule } from '../stripe/stripe.module';
import { SigcoreModule } from '../sigcore/sigcore.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TrialModule } from '../trial/trial.module';

@Module({
  imports: [ConfigModule, StripeModule, SigcoreModule, NotificationsModule, TrialModule],
  controllers: [AdminController, AdminPhonePoolController, SigcoreWebhookMigrationController],
  providers: [AdminService, AdminPhonePoolService, SigcoreWebhookMigrationService],
  exports: [AdminService, AdminPhonePoolService, SigcoreWebhookMigrationService],
})
export class AdminModule {}
