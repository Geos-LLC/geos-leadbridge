/**
 * SfConnectionModule — Phase 2C PR-C2.1.
 *
 * Provisioning + lifecycle for the per-tenant SF orchestration connection.
 * Owns the OAuth handshake, all 7 inbound webhook event types, LB-initiated
 * disconnect, and the only writes to sf_connections + linked
 * CrmWebhookSubscription rows.
 *
 * Imports BookingOrchestratorModule (forward-ref) so the consolidated
 * webhook can dispatch service_* events to the orchestrator without
 * duplicating handling.
 */

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/utils/prisma.module';
import { BookingOrchestratorModule } from '../../booking-orchestrator/booking-orchestrator.module';
import { SfConnectionController } from './sf-connection.controller';
import { SfOAuthService } from './sf-oauth.service';
import { SfConnectionLifecycleService } from './sf-connection-lifecycle.service';
import { SfConnectionWebhookService } from './sf-connection-webhook.service';
import { SfDisconnectService } from './sf-disconnect.service';
import { SfConnectionStatusService } from './sf-connection-status.service';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    forwardRef(() => BookingOrchestratorModule),
  ],
  controllers: [SfConnectionController],
  providers: [
    SfOAuthService,
    SfConnectionLifecycleService,
    SfConnectionWebhookService,
    SfDisconnectService,
    SfConnectionStatusService,
  ],
  exports: [SfConnectionLifecycleService],
})
export class SfConnectionModule {}
