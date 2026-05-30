/**
 * SfHistoricalSyncModule — SF→LB historical reconciliation.
 *
 * Exposes:
 *   - Admin endpoints for dashboard, candidate list, sync trigger, manual link
 *   - HMAC-signed SF receiver endpoint for bulk match-result posting
 *   - SfHistoricalSyncService for the connection-time enumeration hook
 *     (consumed by SfConnectionLifecycleService via DI)
 *
 * Architecture: SF is source of truth. This module never creates SF
 * records; it only reconciles LB's view of leads to SF's data.
 */

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/utils/prisma.module';
import { LeadsModule } from '../../leads/leads.module';
import { SupportGrantsModule } from '../../admin/support-grants/support-grants.module';
import { SfHistoricalSyncService } from './sf-historical-sync.service';
import { SfHistoricalSyncController } from './sf-historical-sync.controller';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    // LeadsModule exports LeadStatusService, which the historical-sync
    // service uses to write SF-driven status updates through the same
    // guard chain (downgrade, dedup, stale) as live SF inbound webhooks.
    forwardRef(() => LeadsModule),
    SupportGrantsModule,
  ],
  controllers: [SfHistoricalSyncController],
  providers: [SfHistoricalSyncService],
  exports: [SfHistoricalSyncService],
})
export class SfHistoricalSyncModule {}
