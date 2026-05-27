/**
 * SF Orchestration Module.
 *
 * Phase 2B PR-B1: introduced SfOrchestrationClient + feature flag +
 *   in-process metrics. Outbound infrastructure, callable-but-uncalled.
 * Phase 2B PR-B2: wired into the BookingOrchestrator state machine
 *   behind BOOKING_ORCHESTRATION_ENABLED_USER_IDS env canary.
 * Phase 2C PR-C1: added SfConnectionResolver — per-tenant SF-issued
 *   credentials from the new `sf_connections` table take priority over
 *   the env canary. Env canary retained as emergency override only.
 *
 * Public exports — consumed by booking-orchestrator + runtime summary
 * endpoint:
 *   - SfOrchestrationClient        — outbound HTTP client
 *   - OrchestrationFeatureFlag     — gate API (now async, delegates to resolver)
 *   - OrchestrationMetricsService  — in-process per-tenant counters
 *   - SfConnectionResolver         — credential ladder (DB → env → none)
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { OrchestrationFeatureFlag } from './orchestration-feature-flag';
import { OrchestrationMetricsService } from './orchestration-metrics.service';
import { SfConnectionResolver } from './sf-connection-resolver.service';
import { SfOrchestrationClient } from './sf-orchestration.client';
import { PrismaModule } from '../common/utils/prisma.module';

@Module({
  imports: [ConfigModule, PrismaModule],
  providers: [
    SfConnectionResolver,
    OrchestrationFeatureFlag,
    OrchestrationMetricsService,
    SfOrchestrationClient,
  ],
  exports: [
    SfConnectionResolver,
    OrchestrationFeatureFlag,
    OrchestrationMetricsService,
    SfOrchestrationClient,
  ],
})
export class SfOrchestrationModule {}
