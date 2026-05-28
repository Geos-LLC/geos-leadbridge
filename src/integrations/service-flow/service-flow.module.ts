/**
 * Service Flow integration module.
 *
 * Hosts the inbound SF → LB job-status sync endpoint + subscription
 * registration. Lead-status mirroring path; pre-dates orchestration.
 *
 * Phase 2C PR-C2.1 — the SfOrchestrationEventService has been removed.
 * All orchestration events (service_*, connection.*, credential.*) now
 * flow through SfConnectionModule's single /v1/integrations/sf/
 * orchestration-webhook endpoint per the canonical SF S4 contract.
 */

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../../common/utils/prisma.service';
import { FollowUpEngineModule } from '../../follow-up-engine/follow-up-engine.module';
import { LeadsModule } from '../../leads/leads.module';
import { ServiceFlowInboundController } from './service-flow-inbound.controller';
import { SfInboundStatusService } from './sf-inbound-status.service';

@Module({
  imports: [
    ConfigModule,
    forwardRef(() => FollowUpEngineModule),
    forwardRef(() => LeadsModule),
  ],
  controllers: [ServiceFlowInboundController],
  providers: [PrismaService, SfInboundStatusService],
  exports: [SfInboundStatusService],
})
export class ServiceFlowModule {}
