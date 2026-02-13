import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminPhonePoolController } from './admin-phone-pool.controller';
import { AdminPhonePoolService } from './admin-phone-pool.service';
import { PrismaService } from '../common/utils/prisma.service';
import { StripeModule } from '../stripe/stripe.module';
import { SigcoreModule } from '../sigcore/sigcore.module';

@Module({
  imports: [StripeModule, SigcoreModule],
  controllers: [AdminController, AdminPhonePoolController],
  providers: [AdminService, AdminPhonePoolService, PrismaService],
  exports: [AdminService, AdminPhonePoolService],
})
export class AdminModule {}
