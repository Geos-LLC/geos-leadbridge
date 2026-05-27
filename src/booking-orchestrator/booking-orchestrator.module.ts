/**
 * BookingOrchestratorModule — Phase 2B PR-B2.
 *
 * Wires:
 *   - SlotPhrasingService (its own OpenAI client; falls back to template)
 *   - BookingOrchestratorService (state machine; flag-gated)
 *
 * Depends on:
 *   - ConfigModule (env: BOOKING_ORCHESTRATION_ENABLED_USER_IDS, OPENAI_API_KEY)
 *   - PrismaModule (ThreadContext + Lead lookups + writes)
 *   - SfOrchestrationModule (client, feature flag, metrics)
 *   - ConversationContextModule (BookingRuntimeService, ConversationRuntimeService)
 *
 * Exports BookingOrchestratorService so:
 *   - AutomationModule can wire it into handleCustomerReply
 *   - ServiceFlowModule can wire it into the new orchestration-event handler
 *
 * Both consumers use forwardRef() because AutomationModule already
 * depends on ConversationContextModule (which provides
 * BookingRuntimeService — also a dependency here).
 */

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../common/utils/prisma.module';
import { ConversationContextModule } from '../conversation-context/conversation-context.module';
import { SfOrchestrationModule } from '../sf-orchestration/sf-orchestration.module';
import { BookingOrchestratorService } from './booking-orchestrator.service';
import { SlotPhrasingService } from './slot-phrasing.service';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    SfOrchestrationModule,
    forwardRef(() => ConversationContextModule),
  ],
  providers: [SlotPhrasingService, BookingOrchestratorService],
  exports: [BookingOrchestratorService, SlotPhrasingService],
})
export class BookingOrchestratorModule {}
