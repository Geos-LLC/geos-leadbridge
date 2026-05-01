/**
 * Pipeline Integrity Service (Phase 5)
 *
 * Runs the same five drift/error checks as scripts/integrity-check-pipeline.js
 * but as a service method that returns a structured result. Used by the
 * weekly cron in MonitoringService and exposed for manual invocation.
 *
 * Checks (matching the standalone script):
 *   1. Lead.status not in canonical set
 *   2. platformStatus set but Lead.status legacy/raw
 *   3. SF-linked leads with statusSource ∉ {service_flow, manual}
 *   4. sf_inbound_events.processingError last 24h
 *   5. crm_webhook_deliveries failed/5xx last 24h
 *
 * Read-only — never mutates leads, never auto-fixes, never triggers backfills.
 *
 * Keep the SQL here in sync with scripts/integrity-check-pipeline.js. The
 * standalone script is independent for ops convenience; this service is the
 * cron-driven counterpart.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { CANONICAL_STATUSES } from '../leads/canonical-status';

const VALID_SF_STATUS_SOURCES = ['service_flow', 'manual'];

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

  constructor(private readonly prisma: PrismaService) {}

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
    ];

    const failed = results.filter((r) => r.severity === 'fail');
    const ok = failed.length === 0;
    const summary = ok
      ? 'All 5 integrity checks passed.'
      : `${failed.length} of 5 integrity checks failed: ` +
        failed.map((r) => `${r.check}=${r.count}`).join(', ');

    return { ok, failedCount: failed.length, results, summary };
  }
}
