/**
 * Integrations Health Controller
 *
 * Public endpoint summarising the LB ↔ SF lead-status pipeline. Used to
 * detect a stalled pipeline without manual DB inspection.
 *
 * Response shape (Phase 1 spec):
 *  {
 *    "status": "ok",
 *    "lastInboundAt": "...",     // SfInboundEvent.receivedAt max
 *    "lastOutboundAt": "...",    // CrmWebhookDelivery.deliveredAt max (state=sent)
 *    "countsLast1h": {
 *      "applied": 0,
 *      "noop": 0,
 *      "failed": 0,              // SfInboundEvent.processingError IS NOT NULL
 *      "sf_protected": 0         // in-memory counter
 *    },
 *    "crm": {
 *      "5xx": 0,                 // CrmWebhookDelivery.lastStatusCode >= 500
 *      "failures": 0             // CrmWebhookDelivery.state = 'failed'
 *    },
 *    "dlq": 0                    // always 0 in Phase 1 (no retry worker)
 *  }
 */

import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../common/utils/prisma.service';
import { IntegrationMetricsService } from './integration-metrics.service';

const ONE_HOUR_MS = 60 * 60 * 1000;

@Controller('v1/integrations')
export class IntegrationsHealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: IntegrationMetricsService,
  ) {}

  @Public()
  @Get('health')
  async health() {
    const since = new Date(Date.now() - ONE_HOUR_MS);

    const [
      lastInbound,
      lastOutbound,
      appliedCount,
      noopCount,
      failedCount,
      crm5xxCount,
      crmFailureCount,
    ] = await Promise.all([
      this.prisma.sfInboundEvent.findFirst({
        orderBy: { receivedAt: 'desc' },
        select: { receivedAt: true },
      }),
      this.prisma.crmWebhookDelivery.findFirst({
        where: { state: 'sent', deliveredAt: { not: null } },
        orderBy: { deliveredAt: 'desc' },
        select: { deliveredAt: true },
      }),
      this.prisma.sfInboundEvent.count({
        where: { status: 'applied', receivedAt: { gte: since } },
      }),
      this.prisma.sfInboundEvent.count({
        where: { status: 'noop', receivedAt: { gte: since } },
      }),
      this.prisma.sfInboundEvent.count({
        where: { processingError: { not: null }, receivedAt: { gte: since } },
      }),
      this.prisma.crmWebhookDelivery.count({
        where: { lastStatusCode: { gte: 500 }, createdAt: { gte: since } },
      }),
      this.prisma.crmWebhookDelivery.count({
        where: { state: 'failed', createdAt: { gte: since } },
      }),
    ]);

    return {
      status: 'ok',
      lastInboundAt: lastInbound?.receivedAt?.toISOString() ?? null,
      lastOutboundAt: lastOutbound?.deliveredAt?.toISOString() ?? null,
      countsLast1h: {
        applied: appliedCount,
        noop: noopCount,
        failed: failedCount,
        sf_protected: this.metrics.countSkipLastHour('sf_protected'),
        sf_archived_reactivations: this.metrics.countSfReactivationsLastHour(),
      },
      crm: {
        '5xx': crm5xxCount,
        failures: crmFailureCount,
      },
      // Phase 2: convenience block clients can poll without re-deriving from
      // countsLast1h + crm. Same numbers, exposed under their alert names.
      alertsLast1h: {
        inboundErrors: failedCount,
        outboundFailures: crmFailureCount,
        crm5xx: crm5xxCount,
      },
      dlq: 0,
    };
  }
}
