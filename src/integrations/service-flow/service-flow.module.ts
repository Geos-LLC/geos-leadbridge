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
