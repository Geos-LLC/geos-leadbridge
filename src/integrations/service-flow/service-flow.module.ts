/**
 * Service Flow integration module.
 * Hosts the inbound SF → LB status sync endpoint + supporting services.
 */

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../../common/utils/prisma.service';
import { FollowUpEngineModule } from '../../follow-up-engine/follow-up-engine.module';
import { LeadsModule } from '../../leads/leads.module';
import { ServiceFlowInboundController } from './service-flow-inbound.controller';
import { SfInboundStatusService } from './sf-inbound-status.service';
import { SfOrchestrationEventService } from './sf-orchestration-event.service';
import { BookingOrchestratorModule } from '../../booking-orchestrator/booking-orchestrator.module';

@Module({
  imports: [
    ConfigModule,
    forwardRef(() => FollowUpEngineModule),
    forwardRef(() => LeadsModule),
    forwardRef(() => BookingOrchestratorModule),
  ],
  controllers: [ServiceFlowInboundController],
  providers: [PrismaService, SfInboundStatusService, SfOrchestrationEventService],
  exports: [SfInboundStatusService, SfOrchestrationEventService],
})
export class ServiceFlowModule {}
