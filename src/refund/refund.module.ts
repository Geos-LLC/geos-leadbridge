import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/utils/prisma.module';
import { RefundableLeadDetectorService } from './refundable-lead-detector.service';

/**
 * Refundable-lead detection module.
 *
 * Hosts the hourly duplicate-detector cron + the daily prune cron. The
 * detector only writes RefundableLeadFlag rows; it never mutates Lead
 * (Lead.refundedAt is owned by the polling sweep + 404 handler).
 *
 * No HTTP surface — the flag is read via the leads list endpoint
 * (LeadsService.convertToNormalizedLead surfaces refundableFlag in the
 * NormalizedLead response).
 */
@Module({
  imports: [PrismaModule],
  providers: [RefundableLeadDetectorService],
  exports: [RefundableLeadDetectorService],
})
export class RefundModule {}
