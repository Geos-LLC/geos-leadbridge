/**
 * SfConnectionModule — Phase 2C PR-C2.
 *
 * Provisioning + lifecycle for the per-tenant SF orchestration connection.
 * Separate from `service-flow` module (which owns /job-status and the
 * orchestration-event endpoint) and from `sf-orchestration` (which owns
 * the outbound client + resolver).
 *
 * Responsibilities:
 *   - OAuth-style connect handshake (/connect/start → /callback)
 *   - LB-initiated disconnect (/disconnect)
 *   - Inbound connection-lifecycle webhook (/connection-webhook)
 *
 * Persistence flows through SfConnectionLifecycleService, which owns
 * the only writes to sf_connections + linked CrmWebhookSubscription.
 * SfOrchestrationModule's resolver/client only read those rows.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../common/utils/prisma.module';
import { SfConnectionController } from './sf-connection.controller';
import { SfOAuthService } from './sf-oauth.service';
import { SfConnectionLifecycleService } from './sf-connection-lifecycle.service';
import { SfConnectionWebhookService } from './sf-connection-webhook.service';
import { SfDisconnectService } from './sf-disconnect.service';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [SfConnectionController],
  providers: [
    SfOAuthService,
    SfConnectionLifecycleService,
    SfConnectionWebhookService,
    SfDisconnectService,
  ],
  exports: [SfConnectionLifecycleService],
})
export class SfConnectionModule {}
