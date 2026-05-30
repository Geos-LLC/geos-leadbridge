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
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../../common/utils/prisma.module';
import { BookingOrchestratorModule } from '../../booking-orchestrator/booking-orchestrator.module';
import { SfHistoricalSyncModule } from '../sf-historical-sync/sf-historical-sync.module';
import { SfConnectionController } from './sf-connection.controller';
import { SfOAuthService } from './sf-oauth.service';
import { SfConnectionLifecycleService } from './sf-connection-lifecycle.service';
import { SfConnectionWebhookService } from './sf-connection-webhook.service';
import { SfDisconnectService } from './sf-disconnect.service';
import { SfConnectionStatusService } from './sf-connection-status.service';
import { SfRotationRefreshService } from './sf-rotation-refresh.service';
import { SfProvisioningService } from './sf-provisioning.service';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    forwardRef(() => BookingOrchestratorModule),
    // Historical-sync provides the connection-time enumeration that
    // marks each unsynced lead as syncStatus='pending' (or 'skipped'
    // for terminal LB statuses). Optional in the lifecycle service to
    // keep connect resilient if this module is unavailable.
    forwardRef(() => SfHistoricalSyncModule),
    // Local JwtModule so SfProvisioningService can mint short-lived
    // link_token JWTs without depending on AuthModule's JwtService
    // configuration (which targets 7-day session tokens). Uses the
    // same secret since link_tokens are verified by the same library
    // and we want a single signing key on the machine.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.secret') || 'default-secret',
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [SfConnectionController],
  providers: [
    SfOAuthService,
    SfConnectionLifecycleService,
    SfConnectionWebhookService,
    SfDisconnectService,
    SfConnectionStatusService,
    SfRotationRefreshService,
    SfProvisioningService,
  ],
  exports: [SfConnectionLifecycleService],
})
export class SfConnectionModule {}
