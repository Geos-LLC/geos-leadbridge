/**
 * Pipeline Integrity Service (Phase 5)
 *
 * Runs drift/error/coverage checks as a service method that returns a
 * structured result. Used by the weekly cron in MonitoringService and
 * exposed for manual invocation.
 *
 * Checks (matching the standalone script):
 *   1. Lead.status not in canonical set
 *   2. platformStatus set but Lead.status legacy/raw
 *   3. SF-linked leads with statusSource ∉ {service_flow, manual}
 *   4. sf_inbound_events.processingError last 24h
 *   5. crm_webhook_deliveries failed/5xx last 24h
 *   6. sf_link_missing — leads that should have an sfJobId but don't
 *      (coverage signal: catches a broken outbound LB→SF→inbound round-trip
 *      before correctness drift can even occur)
 *
 * Read-only — never mutates leads, never auto-fixes, never triggers backfills.
 *
 * Keep the SQL here in sync with scripts/integrity-check-pipeline.js. The
 * standalone script is independent for ops convenience; this service is the
 * cron-driven counterpart.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/utils/prisma.service';
import { CANONICAL_STATUSES } from '../leads/canonical-status';
import { buildDeliveryStatusWebhookUrl } from '../notifications/sigcore-webhook-url';

const VALID_SF_STATUS_SOURCES = ['service_flow', 'manual'];

// Eligibility window for sf_link_missing. Leads younger than 1h are skipped
// (in-flight: SF round-trip may not have completed); leads older than 7d are
// skipped (already past the actionable window).
const SF_LINK_MISSING_NON_TERMINAL_STATUSES = ['new', 'contacted', 'engaged', 'quoted', 'booked'];
// Floor + ratio. Both must trip before we fail — protects against noise on
// tiny denominators while still surfacing systemic outage of the LB→SF link.
const SF_LINK_MISSING_FLOOR = 10;
const SF_LINK_MISSING_RATIO = 0.5;

export interface PipelineIntegrityCheckResult {
  check: string;
  count: number;
  severity: 'ok' | 'fail';
  /** First few rows for context — used in alert message */
  sample?: any[];
}

export interface PipelineIntegrityResult {
  ok: boolean;
  /** Number of failed checks (0..5). */
  failedCount: number;
  results: PipelineIntegrityCheckResult[];
  /** Human-readable summary used in SystemErrorLog.message. */
  summary: string;
}

@Injectable()
export class PipelineIntegrityService {
  private readonly logger = new Logger(PipelineIntegrityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Run all five integrity checks. Returns a structured result.
   * Read-only — issues SELECTs only, never mutates.
   */
  async runChecks(): Promise<PipelineIntegrityResult> {
    const canonicalArray = [...CANONICAL_STATUSES];

    // ── 1. Lead.status outside canonical set ────────────────────────────
    const nonCanonical = await this.prisma.$queryRawUnsafe<Array<{ status: string; n: number }>>(
      `SELECT status, COUNT(*)::int AS n
       FROM leads
       WHERE status IS NOT NULL
         AND NOT (status = ANY($1::text[]))
       GROUP BY status
       ORDER BY n DESC
       LIMIT 20`,
      canonicalArray,
    );
    const nonCanonicalTotal = nonCanonical.reduce((s, r) => s + r.n, 0);

    // ── 2. platformStatus set but Lead.status legacy/raw ───────────────
    const driftLegacy = await this.prisma.$queryRawUnsafe<Array<{ platform: string; status: string; platformStatus: string; n: number }>>(
      `SELECT platform, status, "platformStatus", COUNT(*)::int AS n
       FROM leads
       WHERE "platformStatus" IS NOT NULL
         AND status IS NOT NULL
         AND NOT (status = ANY($1::text[]))
       GROUP BY platform, status, "platformStatus"
       ORDER BY n DESC
       LIMIT 20`,
      canonicalArray,
    );
    const driftTotal = driftLegacy.reduce((s, r) => s + r.n, 0);

    // ── 3. SF-linked leads with statusSource ∉ {service_flow, manual} ──
    const sfLinkedDrift = await this.prisma.$queryRawUnsafe<Array<{ statusSource: string; status: string; n: number }>>(
      `SELECT "statusSource", status, COUNT(*)::int AS n
       FROM leads
       WHERE "sfJobId" IS NOT NULL
         AND "statusSource" IS NOT NULL
         AND NOT ("statusSource" = ANY($1::text[]))
       GROUP BY "statusSource", status
       ORDER BY n DESC
       LIMIT 20`,
      VALID_SF_STATUS_SOURCES,
    );
    const sfLinkedTotal = sfLinkedDrift.reduce((s, r) => s + r.n, 0);

    // ── 4. sf_inbound_events with processingError in last 24h ──────────
    const inboundErrors = await this.prisma.$queryRawUnsafe<Array<{ processingError: string; status: string; n: number }>>(
      `SELECT "processingError", status, COUNT(*)::int AS n
       FROM sf_inbound_events
       WHERE "processingError" IS NOT NULL
         AND "receivedAt" > NOW() - INTERVAL '24 hours'
       GROUP BY "processingError", status
       ORDER BY n DESC
       LIMIT 20`,
    );
    const inboundErrorTotal = inboundErrors.reduce((s, r) => s + r.n, 0);

    // ── 5. crm_webhook_deliveries failed/5xx in last 24h ───────────────
    const outboundFailures = await this.prisma.$queryRawUnsafe<Array<{ reason: string; lastStatusCode: number | null; lastError: string | null; n: number }>>(
      `SELECT
        CASE WHEN state = 'failed' THEN 'state=failed' ELSE 'lastStatusCode>=500' END AS reason,
        "lastStatusCode",
        "lastError",
        COUNT(*)::int AS n
       FROM crm_webhook_deliveries
       WHERE ("state" = 'failed' OR "lastStatusCode" >= 500)
         AND "createdAt" > NOW() - INTERVAL '24 hours'
       GROUP BY reason, "lastStatusCode", "lastError"
       ORDER BY n DESC
       LIMIT 20`,
    );
    const outboundTotal = outboundFailures.reduce((s, r) => s + r.n, 0);

    // ── 6. sf_link_missing — coverage check ────────────────────────────
    // Eligible candidates: leads created in [NOW−7d, NOW−1h] that are SF-shaped
    // (have phone, non-terminal status) AND belong to a user with an active
    // outbound CrmWebhookSubscription emitting lead.created (i.e. SF link is
    // expected). Missing = the subset where sfJobId is still NULL — the LB→SF
    // round-trip never completed.
    const sfLinkCoverage = await this.prisma.$queryRawUnsafe<Array<{ missing: number; eligible: number }>>(
      `SELECT
         COUNT(*) FILTER (WHERE l."sfJobId" IS NULL)::int AS missing,
         COUNT(*)::int AS eligible
       FROM leads l
       WHERE l."createdAt" > NOW() - INTERVAL '7 days'
         AND l."createdAt" < NOW() - INTERVAL '1 hour'
         AND l."customerPhone" IS NOT NULL
         AND l.status = ANY($1::text[])
         AND EXISTS (
           SELECT 1 FROM crm_webhook_subscriptions s
           WHERE s."userId" = l."userId"
             AND s.direction = 'outbound'
             AND s."isActive" = true
             AND 'lead.created' = ANY(s.events)
         )`,
      SF_LINK_MISSING_NON_TERMINAL_STATUSES,
    );
    const linkMissing = sfLinkCoverage[0]?.missing ?? 0;
    const linkEligible = sfLinkCoverage[0]?.eligible ?? 0;
    const linkRatio = linkEligible === 0 ? 0 : linkMissing / linkEligible;
    const linkMissingFail =
      linkMissing >= SF_LINK_MISSING_FLOOR && linkRatio >= SF_LINK_MISSING_RATIO;

    // Per-user/platform breakdown of the missing subset — gives ops a place to
    // start when the check fails. Capped at 5 rows to keep alerts readable.
    let linkMissingSample: Array<{ userId: string; platform: string; n: number }> = [];
    if (linkMissing > 0) {
      linkMissingSample = await this.prisma.$queryRawUnsafe<Array<{ userId: string; platform: string; n: number }>>(
        `SELECT l."userId", l.platform, COUNT(*)::int AS n
         FROM leads l
         WHERE l."sfJobId" IS NULL
           AND l."createdAt" > NOW() - INTERVAL '7 days'
           AND l."createdAt" < NOW() - INTERVAL '1 hour'
           AND l."customerPhone" IS NOT NULL
           AND l.status = ANY($1::text[])
           AND EXISTS (
             SELECT 1 FROM crm_webhook_subscriptions s
             WHERE s."userId" = l."userId"
               AND s.direction = 'outbound'
               AND s."isActive" = true
               AND 'lead.created' = ANY(s.events)
           )
         GROUP BY l."userId", l.platform
         ORDER BY n DESC
         LIMIT 5`,
        SF_LINK_MISSING_NON_TERMINAL_STATUSES,
      );
    }

    // ── 7. Sigcore webhook health ──────────────────────────────────────
    // Verifies the workspace-level delivery-status subscription matches the
    // expected URL/events/status. Catches regressions like the 2026-04-20
    // misconfiguration where the URL pointed at the Vercel frontend host and
    // every outbound SMS got stuck at 'pending'.
    //
    // Failure modes flagged:
    //   - subscription missing entirely
    //   - URL drifted (e.g. someone changed BACKEND_PUBLIC_URL or manually edited)
    //   - events drifted (missing message.delivered/sent/failed)
    //   - status='paused' (auto-paused after MAX_FAILURES on the Sigcore side)
    //   - LB-host subs registered for delivery events on the wrong endpoint
    //     (delivery events MUST only go to /delivery-status, never to
    //     /inbound-sms or /call-connect — see tenant ee06c09a misconfiguration)
    //
    // Read-only — never patches the subscription. Patching is done explicitly
    // via NotificationsService.setupDeliveryStatusWebhook() at provision time.
    const webhookHealth = await this.checkSigcoreWebhookHealth();

    const results: PipelineIntegrityCheckResult[] = [
      {
        check: 'lead_status_not_canonical',
        count: nonCanonicalTotal,
        severity: nonCanonicalTotal === 0 ? 'ok' : 'fail',
        sample: nonCanonical.slice(0, 3),
      },
      {
        check: 'platform_status_with_legacy_lead_status',
        count: driftTotal,
        severity: driftTotal === 0 ? 'ok' : 'fail',
        sample: driftLegacy.slice(0, 3),
      },
      {
        check: 'sf_linked_unexpected_status_source',
        count: sfLinkedTotal,
        severity: sfLinkedTotal === 0 ? 'ok' : 'fail',
        sample: sfLinkedDrift.slice(0, 3),
      },
      {
        check: 'sf_inbound_processing_error_24h',
        count: inboundErrorTotal,
        severity: inboundErrorTotal === 0 ? 'ok' : 'fail',
        sample: inboundErrors.slice(0, 3),
      },
      {
        check: 'crm_webhook_failed_or_5xx_24h',
        count: outboundTotal,
        severity: outboundTotal === 0 ? 'ok' : 'fail',
        sample: outboundFailures.slice(0, 3),
      },
      {
        check: 'sf_link_missing',
        // Surface the missing count as the headline number. eligible+ratio
        // travel in the sample so alert consumers can read the denominator.
        count: linkMissing,
        severity: linkMissingFail ? 'fail' : 'ok',
        sample: [
          { eligible: linkEligible, missing: linkMissing, ratio: Number(linkRatio.toFixed(3)) },
          ...linkMissingSample,
        ],
      },
      {
        check: 'sigcore_webhook_health',
        count: webhookHealth.problems.length,
        severity: webhookHealth.problems.length === 0 ? 'ok' : 'fail',
        sample: webhookHealth.problems.slice(0, 5),
      },
    ];

    const failed = results.filter((r) => r.severity === 'fail');
    const ok = failed.length === 0;
    const totalCount = results.length;
    const summary = ok
      ? `All ${totalCount} integrity checks passed.`
      : `${failed.length} of ${totalCount} integrity checks failed: ` +
        failed.map((r) => `${r.check}=${r.count}`).join(', ');

    return { ok, failedCount: failed.length, results, summary };
  }

  /**
   * Verify the Sigcore webhook subscriptions are configured correctly for
   * LeadBridge's workspace.
   *
   * Returns a list of problems — empty list = healthy. Skips silently (returns
   * empty problems) if SIGCORE_API_KEY isn't configured, since this is a
   * production check and dev/test environments may not have it set.
   */
  private async checkSigcoreWebhookHealth(): Promise<{ problems: Array<Record<string, unknown>> }> {
    const sigcoreApiKey = this.configService.get<string>('SIGCORE_API_KEY');
    if (!sigcoreApiKey) {
      return { problems: [] };
    }

    let expectedDeliveryUrl: string;
    try {
      expectedDeliveryUrl = buildDeliveryStatusWebhookUrl(this.configService);
    } catch (err: any) {
      // The URL resolver itself rejected (e.g. only frontend hosts configured).
      // That's a config bug worth surfacing.
      return {
        problems: [
          {
            problem: 'backend_url_unresolvable',
            error: err?.message ?? 'unknown',
          },
        ],
      };
    }

    const sigcoreUrl = this.configService.get<string>(
      'SIGCORE_API_URL',
      'https://sigcore-production.up.railway.app/api',
    );
    const subsEndpoint = `${sigcoreUrl}/v1/webhook-subscriptions`;

    let subs: any[] = [];
    try {
      const resp = await fetch(subsEndpoint, { headers: { 'x-api-key': sigcoreApiKey } });
      if (!resp.ok) {
        return {
          problems: [
            {
              problem: 'sigcore_list_failed',
              status: resp.status,
            },
          ],
        };
      }
      const json: any = await resp.json();
      subs = json.data ?? json ?? [];
    } catch (err: any) {
      return {
        problems: [
          {
            problem: 'sigcore_unreachable',
            error: err?.message ?? 'unknown',
          },
        ],
      };
    }

    const problems: Array<Record<string, unknown>> = [];
    const expectedEvents = new Set(['message.sent', 'message.delivered', 'message.failed']);

    // Check 1: workspace-level delivery-status sub must exist with correct URL/events/status.
    const wsDeliverySubs = subs.filter(
      (s) => !s.tenantId && s.name === 'LeadBridge Delivery Notifications',
    );
    if (wsDeliverySubs.length === 0) {
      problems.push({ problem: 'workspace_delivery_sub_missing' });
    } else {
      if (wsDeliverySubs.length > 1) {
        problems.push({
          problem: 'duplicate_workspace_delivery_subs',
          count: wsDeliverySubs.length,
          ids: wsDeliverySubs.map((s) => s.id),
        });
      }
      const sub = wsDeliverySubs[0];
      if (sub.webhookUrl !== expectedDeliveryUrl) {
        problems.push({
          problem: 'workspace_delivery_url_drift',
          subId: sub.id,
          expected: expectedDeliveryUrl,
          actual: sub.webhookUrl,
        });
      }
      const subEvents = new Set<string>(sub.events ?? []);
      const missingEvents = Array.from(expectedEvents).filter((e) => !subEvents.has(e));
      if (missingEvents.length > 0) {
        problems.push({
          problem: 'workspace_delivery_events_drift',
          subId: sub.id,
          missingEvents,
          actualEvents: sub.events,
        });
      }
      if (sub.status !== 'active') {
        problems.push({
          problem: 'workspace_delivery_status_not_active',
          subId: sub.id,
          status: sub.status,
        });
      }
    }

    // Check 2: any LB-host sub with delivery events on the wrong endpoint.
    // Delivery events on /inbound-sms or /call-connect cause double-processing
    // and silent handler-mismatch bugs (see tenant ee06c09a fix 2026-05-01).
    const isLbHost = (url: string | undefined): boolean => {
      if (!url) return false;
      try {
        return /thumbtack-bridge.*\.up\.railway\.app/.test(new URL(url).host);
      } catch {
        return false;
      }
    };
    for (const sub of subs) {
      if (!isLbHost(sub.webhookUrl)) continue;
      const hasDeliveryEvents = (sub.events ?? []).some((e: string) => expectedEvents.has(e));
      if (!hasDeliveryEvents) continue;
      const isDeliveryEndpoint = (sub.webhookUrl ?? '').includes('/api/webhooks/sigcore/delivery-status');
      if (!isDeliveryEndpoint) {
        problems.push({
          problem: 'delivery_events_on_wrong_endpoint',
          subId: sub.id,
          tenantId: sub.tenantId,
          webhookUrl: sub.webhookUrl,
          events: sub.events,
        });
      }
    }

    return { problems };
  }
}
