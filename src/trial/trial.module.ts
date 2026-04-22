import { Global, Module, forwardRef } from '@nestjs/common';
import { TrialService } from './trial.service';
import { TrialNotificationService } from './trial-notification.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Global()
@Module({
  imports: [forwardRef(() => NotificationsModule)],
  providers: [TrialService, TrialNotificationService],
  exports: [TrialService, TrialNotificationService],
})
export class TrialModule {}
