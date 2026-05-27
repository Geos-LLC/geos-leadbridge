/**
 * SF Orchestration Module — Phase 2B PR-B1.
 *
 * Outbound LB → SF orchestration client + supporting plumbing
 * (feature flag, in-process metrics). Pure infrastructure: callable
 * but uncalled in PR-B1. PR-B2 will wire SfOrchestrationClient into
 * the booking orchestrator behind the feature flag.
 *
 * Public exports — all three are consumed by the runtime summary
 * endpoint for read-only observability:
 *   - SfOrchestrationClient
 *   - OrchestrationFeatureFlag
 *   - OrchestrationMetricsService
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { OrchestrationFeatureFlag } from './orchestration-feature-flag';
import { OrchestrationMetricsService } from './orchestration-metrics.service';
import { SfOrchestrationClient } from './sf-orchestration.client';

@Module({
  imports: [ConfigModule],
  providers: [
    OrchestrationFeatureFlag,
    OrchestrationMetricsService,
    SfOrchestrationClient,
  ],
  exports: [
    OrchestrationFeatureFlag,
    OrchestrationMetricsService,
    SfOrchestrationClient,
  ],
})
export class SfOrchestrationModule {}
