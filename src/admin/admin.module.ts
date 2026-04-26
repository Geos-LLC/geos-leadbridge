import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminPhonePoolController } from './admin-phone-pool.controller';
import { AdminPhonePoolService } from './admin-phone-pool.service';
import { YelpBackfillService } from './yelp-backfill.service';
import { SigcoreWebhookMigrationController } from './sigcore-webhook-migration.controller';
import { SigcoreWebhookMigrationService } from './sigcore-webhook-migration.service';
import { StripeModule } from '../stripe/stripe.module';
import { SigcoreModule } from '../sigcore/sigcore.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TrialModule } from '../trial/trial.module';
import { PlatformsModule } from '../platforms/platforms.module';

@Module({
  imports: [
    ConfigModule,
    StripeModule,
    SigcoreModule,
    NotificationsModule,
    TrialModule,
    // forwardRef: PlatformsModule already uses forwardRef for LeadsModule, so this side stays defensive too.
    forwardRef(() => PlatformsModule),
  ],
  controllers: [AdminController, AdminPhonePoolController, SigcoreWebhookMigrationController],
  providers: [AdminService, AdminPhonePoolService, YelpBackfillService, SigcoreWebhookMigrationService],
  exports: [AdminService, AdminPhonePoolService, SigcoreWebhookMigrationService],
})
export class AdminModule {}
