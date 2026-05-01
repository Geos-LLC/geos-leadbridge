/**
 * Integrations Health Module
 *
 * Hosts the cross-cutting observability for the LB ↔ SF lead-status pipeline:
 *   - IntegrationMetricsService: in-memory ring counter for skip reasons
 *     (sf_protected, pipeline_downgrade) that don't persist anywhere else.
 *   - IntegrationsHealthController: GET /v1/integrations/health.
 *
 * @Global so any service can inject IntegrationMetricsService without a
 * circular module dependency. The service is stateless beyond its in-memory
 * ring buffer; nothing wires it transitively.
 */

import { Module, Global } from '@nestjs/common';
import { PrismaService } from '../../common/utils/prisma.service';
import { IntegrationMetricsService } from './integration-metrics.service';
import { IntegrationsHealthController } from './integrations-health.controller';

@Global()
@Module({
  providers: [PrismaService, IntegrationMetricsService],
  controllers: [IntegrationsHealthController],
  exports: [IntegrationMetricsService],
})
export class IntegrationsHealthModule {}
