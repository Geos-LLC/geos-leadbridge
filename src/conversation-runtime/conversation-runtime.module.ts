/**
 * Conversation Runtime Observability Module — Phase 1.5.
 *
 * Hosts the tenant-wide diagnostic endpoints under
 * /v1/conversation-runtime. The per-lead inspection endpoint
 * (/v1/leads/:id/runtime-state) lives on LeadsController so it sits next
 * to the existing lead routes.
 *
 * Pure read layer — no writers, no decision logic. Phase 3 will read
 * against the new runtime fields directly; until then this module is the
 * only way to see what those fields look like at a tenant level.
 */

import { Module } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { TenancyModule } from '../common/tenancy/tenancy.module';
import { SfOrchestrationModule } from '../sf-orchestration/sf-orchestration.module';
import { ConversationRuntimeController } from './conversation-runtime.controller';

@Module({
  // SfOrchestrationModule is imported (not duplicated) so the controller
  // can read OrchestrationMetricsService + OrchestrationFeatureFlag for
  // the orchestrationMetrics + orchestrationFlag summary blocks. The
  // metrics service is a tenant-scoped singleton across the app.
  imports: [TenancyModule, SfOrchestrationModule],
  providers: [PrismaService],
  controllers: [ConversationRuntimeController],
})
export class ConversationRuntimeObservabilityModule {}
