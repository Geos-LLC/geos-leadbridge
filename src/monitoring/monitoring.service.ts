/**
 * Monitoring Service
 *
 * System health monitoring with three concerns:
 * 1. Detection: hourly cron checks account health
 * 2. State: AccountHealthStatus table is source of truth
 * 3. Notification: SendGrid alerts on state change, not per-error spam
 *
 * Error logging is deduped by (category, accountId, platform, code).
 */

import { Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../common/utils/prisma.service';
import { PipelineIntegrityService } from './pipeline-integrity.service';

export interface CaptureErrorOptions {
  category: 'automation' | 'token_refresh' | 'webhook' | 'notification' | 'yelp' | 'other';
  code?: string; // Structured: 'token_expired', 'webhook_missing', 'automation_failure'
  platform?: string; // 'thumbtack' | 'yelp'
  severity?: 'error' | 'warning';
  message: string;
  userId?: string;
  accountId?: string;
  accountName?: string;
  context?: Record<string, any>;
}

export interface SystemHealthIssue {
  accountId: string;
  accountName: string;
  platform: string;
  issueCode: string;
  status: 'warning' | 'critical';
  message: string;
  firstDetectedAt: Date;
  lastDetectedAt: Date;
}

@Injectable()
export class MonitoringService implements OnModuleInit {
  private readonly logger = new Logger(MonitoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    // Optional so existing direct-instantiation patterns (live-* scripts,
    // pipeline-health.service.spec) don't have to wire it. Production DI
    // always populates it.
    @Optional() private readonly pipelineIntegrity: PipelineIntegrityService | null = null,
  ) {}

  /**
   * Run health check on startup to populate AccountHealthStatus immediately.
   */
  async onModuleInit(): Promise<void> {
    // Delay slightly to let other modules initialize
    setTimeout(() => {
      this.systemHealthCheck().catch(err =>
        this.logger.error(`[HealthCheck] Startup check failed: ${err.message}`),
      );
    }, 15_000);
  }

  // ==========================================
  // Error Capture (with dedup)
  // ==========================================

  /**
   * Capture an error: dedup by fingerprint, store in DB.
   * Fire-and-forget safe — never throws.
   */
  async captureError(options: CaptureErrorOptions): Promise<void> {
    try {
      const severity = options.severity ?? 'error';

      // Dedup: collapse a recurring unresolved error into a single row.
      //
      // Two dedup keys, in priority order:
      //   1. accountId+category+platform+code  — original per-account fingerprint
      //   2. userId+category+code              — for pipeline-level alerts
      //                                          (no accountId, but per-user)
      //
      // Without (2), the hourly Phase 2 pipeline cron creates a fresh row on
      // every run for the same condition (e.g. sf_inbound_stalled), flooding
      // SystemErrorLog. With (2) it updates the existing row instead.
      let existing: any = null;
      if (options.accountId) {
        existing = await this.prisma.systemErrorLog.findFirst({
          where: {
            category: options.category,
            accountId: options.accountId,
            ...(options.platform && { platform: options.platform }),
            ...(options.code && { code: options.code }),
            resolved: false,
          },
          orderBy: { createdAt: 'desc' },
        });
      } else if (options.userId && options.code) {
        existing = await this.prisma.systemErrorLog.findFirst({
          where: {
            category: options.category,
            userId: options.userId,
            code: options.code,
            accountId: null,
            resolved: false,
          },
          orderBy: { createdAt: 'desc' },
        });
      } else if (options.code) {
        // System-level dedup: neither userId nor accountId is set. Used by the
        // weekly pipeline integrity cron (code='pipeline_integrity_failed').
        existing = await this.prisma.systemErrorLog.findFirst({
          where: {
            category: options.category,
            code: options.code,
            userId: null,
            accountId: null,
            resolved: false,
          },
          orderBy: { createdAt: 'desc' },
        });
      }

      if (existing) {
        await this.prisma.systemErrorLog.update({
          where: { id: existing.id },
          data: { message: options.message },
        });
        this.logger.debug(
          `[Monitoring] Deduped error category=${options.category} code=${options.code || '-'} accountId=${options.accountId || 'null'} userId=${options.userId || 'null'}`,
        );
        return;
      }

      await this.prisma.systemErrorLog.create({
        data: {
          category: options.category,
          code: options.code,
          platform: options.platform,
          severity,
          message: options.message,
          userId: options.userId,
          accountId: options.accountId,
          accountName: options.accountName,
          context: options.context ? JSON.stringify(options.context) : null,
        },
      });

      this.logger.warn(`[${severity.toUpperCase()}] [${options.category}] ${options.message}${options.accountName ? ` (${options.accountName})` : ''}`);
    } catch (err: any) {
      this.logger.error(`MonitoringService.captureError internal failure: ${err.message}`);
    }
  }

  // ==========================================
  // Hourly System Health Check
  // ==========================================

  /**
   * Cron: 10 past every hour (after token refresh at :00).
   * Checks all accounts, upserts health incidents, sends SendGrid alerts.
   */
  @Cron('10 */1 * * *')
  async systemHealthCheck(): Promise<void> {
    // Advisory lock 7003 — prevent staging+production double-checking
    const lockResult = await this.prisma.$queryRawUnsafe<any[]>('SELECT pg_try_advisory_lock(7003) AS locked').catch(() => [{ locked: false }]);
    if (!lockResult?.[0]?.locked) {
      this.logger.debug('[HealthCheck] Another instance holds the lock — skipping');
      return;
    }

    try {
      // Pipeline health checks run BEFORE the per-account work and BEFORE the
      // no-accounts short-circuit, so SF↔LB pipeline alerts fire on a fresh
      // staging tenant with zero saved accounts too.
      await this.runPipelineHealthChecks();

      const accounts = await this.prisma.savedAccount.findMany({
        select: {
          id: true, userId: true, platform: true, businessId: true, businessName: true,
          webhookId: true, credentialsJson: true,
        },
      });

      if (accounts.length === 0) return;

      const now = new Date();
      const newIssues: { userId: string; issue: SystemHealthIssue }[] = [];

      for (const account of accounts) {
        const issues = await this.checkAccountHealth(account);

        // Upsert each issue into AccountHealthStatus
        for (const issue of issues) {
          const existing = await this.prisma.accountHealthStatus.findUnique({
            where: { accountId_issueCode: { accountId: account.id, issueCode: issue.issueCode } },
          });

          if (existing) {
            if (!existing.isActive) {
              // Reopen resolved issue
              await this.prisma.accountHealthStatus.update({
                where: { id: existing.id },
                data: {
                  isActive: true,
                  status: issue.status,
                  issueMessage: issue.message,
                  lastDetectedAt: now,
                  lastCheckedAt: now,
                  resolvedAt: null,
                  firstDetectedAt: now,
                  notificationCount: 0,
                  lastNotifiedAt: null,
                },
              });
              newIssues.push({ userId: account.userId, issue });
            } else {
              // Still active — update detection time
              await this.prisma.accountHealthStatus.update({
                where: { id: existing.id },
                data: { lastDetectedAt: now, lastCheckedAt: now, issueMessage: issue.message },
              });
            }
          } else {
            // New issue
            await this.prisma.accountHealthStatus.create({
              data: {
                userId: account.userId,
                accountId: account.id,
                platform: account.platform,
                status: issue.status,
                issueCode: issue.issueCode,
                issueMessage: issue.message,
                isActive: true,
                firstDetectedAt: now,
                lastDetectedAt: now,
                lastCheckedAt: now,
              },
            });
            newIssues.push({ userId: account.userId, issue });
          }
        }

        // Resolve issues that are no longer present
        const activeIssues = await this.prisma.accountHealthStatus.findMany({
          where: { accountId: account.id, isActive: true },
        });
        const currentIssueCodes = new Set(issues.map(i => i.issueCode));
        for (const active of activeIssues) {
          if (!currentIssueCodes.has(active.issueCode)) {
            await this.prisma.accountHealthStatus.update({
              where: { id: active.id },
              data: { isActive: false, resolvedAt: now, lastCheckedAt: now },
            });
            // Send recovery notification
            this.sendRecoveryEmail(account.userId, {
              accountName: account.businessName || account.businessId,
              platform: account.platform,
              issueCode: active.issueCode,
            }).catch(() => {});
          }
        }
      }

      // Send grouped alerts for new issues (per user)
      if (newIssues.length > 0) {
        const byUser = new Map<string, SystemHealthIssue[]>();
        for (const { userId, issue } of newIssues) {
          const arr = byUser.get(userId) || [];
          arr.push(issue);
          byUser.set(userId, arr);
        }
        for (const [userId, issues] of byUser) {
          await this.sendAlertEmail(userId, issues);
        }
      }

      // Send reminders for issues unresolved 24h+ (every 48h)
      await this.sendReminders();

      this.logger.log(`[HealthCheck] Complete — ${accounts.length} accounts, ${newIssues.length} new issues`);
    } catch (err: any) {
      this.logger.error(`[HealthCheck] Cron error: ${err.message}`);
    } finally {
      await this.prisma.$queryRawUnsafe('SELECT pg_advisory_unlock(7003)').catch(() => {});
    }
  }

  // ==========================================
  // Hourly stale-pending NotificationLog resolution
  //
  // Background: outbound SMS NotificationLog rows are created with
  // status='pending' and promoted to 'sent' / 'delivered' / 'failed' by
  // Sigcore's delivery-status webhook (see WebhooksService.handleSigcoreDelivery
  // Status). When a row stays 'pending' for hours, either the webhook never
  // fired (Sigcore-side issue, fixed 2026-05-01) or the message ID stored
  // doesn't match anything Sigcore knows about (orphaned tenant, deleted
  // message). Either way, leaving the UI label as "⌛ Pending" indefinitely is
  // misleading — the SMS almost certainly went through, we just can't prove it.
  //
  // Soft-resolution rule:
  //   status='pending' AND createdAt < NOW() - STALE_PENDING_HOURS  →  status='unknown'
  //
  // The UI renders 'unknown' as "Sent (delivery not confirmed)" — honest about
  // the gap without falsely claiming delivery.
  //
  // Cron expression '15 */1 * * *' = 15 past every hour (offset from the :00 token
  // refresh and :10 health check). Advisory lock 7005.
  // ==========================================

  @Cron('15 */1 * * *')
  async resolveStalePendingNotificationLogs(): Promise<void> {
    const lockResult = await this.prisma
      .$queryRawUnsafe<any[]>('SELECT pg_try_advisory_lock(7005) AS locked')
      .catch(() => [{ locked: false }]);
    if (!lockResult?.[0]?.locked) {
      this.logger.debug('[StalePending] Another instance holds the lock — skipping');
      return;
    }

    try {
      const result = await this.prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `WITH updated AS (
           UPDATE notification_logs
              SET status = 'unknown'
            WHERE status = 'pending'
              AND "createdAt" < NOW() - INTERVAL '${MonitoringService.STALE_PENDING_HOURS} hours'
            RETURNING id
         )
         SELECT COUNT(*)::int AS count FROM updated`,
      );
      const updatedCount = result?.[0]?.count ?? 0;

      // Single-line k=v log so Loki dashboards can filter on
      // result=stale_pending_resolved updated=N.
      this.logger.log(
        `[StalePending] result=stale_pending_resolved updated=${updatedCount} threshold_hours=${MonitoringService.STALE_PENDING_HOURS}`,
      );
    } catch (err: any) {
      this.logger.error(
        `[StalePending] result=error error=${(err?.message ?? 'unknown').replace(/\s+/g, ' ').slice(0, 300)}`,
      );
    } finally {
      await this.prisma.$queryRawUnsafe('SELECT pg_advisory_unlock(7005)').catch(() => {});
    }
  }

  // Threshold for the stale-pending resolver. Picked to be longer than any
  // realistic Twilio delivery callback (typically <60s, with the worst-case
  // carrier failure-and-retry path completing in ~minutes), so an
  // 'unknown'-marked row truly represents "we never heard back."
  private static readonly STALE_PENDING_HOURS = 6;

  // ==========================================
  // Weekly Pipeline Integrity Check (Phase 5)
  //
  // Runs the same 5 checks as scripts/integrity-check-pipeline.js. On failure,
  // creates a SystemErrorLog row with code='pipeline_integrity_failed' that
  // dedups via captureError's system-level branch (no userId, no accountId).
  //
  // Cron expression '0 3 * * 0' = Sunday 03:00 UTC. Advisory lock 7004 prevents
  // staging+production double-execution against the shared DB.
  //
  // Read-only — never mutates leads, never auto-fixes, never triggers backfills.
  // ==========================================

  @Cron('0 3 * * 0')
  async weeklyPipelineIntegrityCheck(): Promise<void> {
    if (!this.pipelineIntegrity) {
      this.logger.warn('[PipelineIntegrity] service not wired — cron skipped');
      return;
    }

    const lockResult = await this.prisma
      .$queryRawUnsafe<any[]>('SELECT pg_try_advisory_lock(7004) AS locked')
      .catch(() => [{ locked: false }]);
    if (!lockResult?.[0]?.locked) {
      this.logger.debug('[PipelineIntegrity] Another instance holds the lock — skipping');
      return;
    }

    try {
      const result = await this.pipelineIntegrity.runChecks();

      if (result.ok) {
        this.logger.log(`[PipelineIntegrity] result=ok failed_count=0 summary="all ${result.results.length} checks passed"`);
        return;
      }

      // Single k=v line so Loki/dashboards can filter on result=failed.
      const failedCheckNames = result.results
        .filter((r) => r.severity === 'fail')
        .map((r) => `${r.check}:${r.count}`)
        .join(',');
      this.logger.error(
        `[PipelineIntegrity] result=failed failed_count=${result.failedCount} checks=${failedCheckNames}`,
      );

      await this.captureError({
        category: 'webhook',
        code: 'pipeline_integrity_failed',
        severity: 'error',
        message: result.summary,
        context: {
          failedCount: result.failedCount,
          results: result.results.map((r) => ({
            check: r.check,
            count: r.count,
            severity: r.severity,
            sample: r.sample,
          })),
          ranAt: new Date().toISOString(),
        },
      });
    } catch (err: any) {
      this.logger.error(
        `[PipelineIntegrity] result=error error=${(err?.message ?? 'unknown').replace(/\s+/g, ' ').slice(0, 300)}`,
      );
    } finally {
      await this.prisma.$queryRawUnsafe('SELECT pg_advisory_unlock(7004)').catch(() => {});
    }
  }

  /**
   * Manual trigger for the integrity check — invoked from admin endpoint or
   * scripts. Bypasses the cron's advisory lock so a human can always run it
   * on demand.
   */
  async runPipelineIntegrityCheck(): Promise<{ ok: boolean; failedCount: number; summary: string }> {
    if (!this.pipelineIntegrity) {
      throw new Error('PipelineIntegrityService not available');
    }
    const result = await this.pipelineIntegrity.runChecks();
    if (result.ok) {
      this.logger.log(`[PipelineIntegrity] result=ok failed_count=0 summary="all ${result.results.length} checks passed" trigger=manual`);
    } else {
      const failedCheckNames = result.results
        .filter((r) => r.severity === 'fail')
        .map((r) => `${r.check}:${r.count}`)
        .join(',');
      this.logger.error(
        `[PipelineIntegrity] result=failed failed_count=${result.failedCount} checks=${failedCheckNames} trigger=manual`,
      );
      await this.captureError({
        category: 'webhook',
        code: 'pipeline_integrity_failed',
        severity: 'error',
        message: result.summary,
        context: {
          failedCount: result.failedCount,
          results: result.results.map((r) => ({ check: r.check, count: r.count, severity: r.severity, sample: r.sample })),
          ranAt: new Date().toISOString(),
          trigger: 'manual',
        },
      });
    }
    return { ok: result.ok, failedCount: result.failedCount, summary: result.summary };
  }

  /**
   * Check a single account's health. Returns detected issues.
   */
  private async checkAccountHealth(account: any): Promise<SystemHealthIssue[]> {
    const issues: SystemHealthIssue[] = [];
    const now = new Date();

    // 1. Token expired — check unresolved auth/refresh errors
    const tokenErrors = await this.prisma.systemErrorLog.findFirst({
      where: {
        resolved: false,
        OR: [
          { accountId: account.id, category: 'token_refresh' },
          { accountId: account.id, category: 'yelp' },
          { accountId: account.id, category: 'automation', message: { contains: '401' } },
          { accountId: account.id, category: 'automation', message: { contains: '403' } },
          { accountId: account.id, category: 'automation', message: { contains: 'TOKEN_INVALID' } },
          { accountId: account.id, category: 'automation', message: { contains: 'token expired' } },
        ],
      },
    });

    // Also check credential freshness as direct signal
    let tokenFresh = false;
    if (account.credentialsJson) {
      try {
        const { EncryptionUtil } = require('../common/utils/encryption.util');
        const encKey = this.configService.get<string>('encryption.key') || '';
        const creds = EncryptionUtil.decryptObject(account.credentialsJson, encKey) as any;
        if (creds.expiresAt) {
          const expiresAt = new Date(creds.expiresAt).getTime();
          tokenFresh = expiresAt > Date.now() - 2 * 60 * 60 * 1000; // not 2+ hours stale
        }
      } catch {}
    }

    if (tokenErrors && !tokenFresh) {
      issues.push({
        accountId: account.id, accountName: account.businessName || account.businessId,
        platform: account.platform, issueCode: 'token_expired', status: 'critical',
        message: 'Token expired or invalid — reconnect required',
        firstDetectedAt: now, lastDetectedAt: now,
      });
    }

    // 2. Webhook missing (Thumbtack only)
    if (account.platform === 'thumbtack' && !account.webhookId) {
      issues.push({
        accountId: account.id, accountName: account.businessName || account.businessId,
        platform: account.platform, issueCode: 'webhook_missing', status: 'critical',
        message: 'Webhook not registered — lead notifications disabled',
        firstDetectedAt: now, lastDetectedAt: now,
      });
    }

    // 3. Automation failures — 3+ in last hour
    const automationFailCount = await this.prisma.systemErrorLog.count({
      where: {
        accountId: account.id,
        category: 'automation',
        resolved: false,
        createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
      },
    });
    if (automationFailCount >= 3) {
      issues.push({
        accountId: account.id, accountName: account.businessName || account.businessId,
        platform: account.platform, issueCode: 'automation_failures', status: 'warning',
        message: `${automationFailCount} automation failures in the last hour`,
        firstDetectedAt: now, lastDetectedAt: now,
      });
    }

    // 4. Notifications disabled — only flag if account has notification settings configured
    const notifSettings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId: account.id },
      select: { enabled: true, notificationRules: { where: { triggerType: 'new_lead', enabled: true }, select: { id: true } } },
    });
    // Only flag if settings exist but all new_lead rules are disabled (user configured then turned off)
    if (notifSettings && notifSettings.enabled && notifSettings.notificationRules.length === 0) {
      // Check if there were ever any rules (user configured then disabled)
      const anyRules = await this.prisma.notificationRule.count({ where: { notificationSettingsId: account.id } }).catch(() => 0);
      if (anyRules > 0) {
        issues.push({
          accountId: account.id, accountName: account.businessName || account.businessId,
          platform: account.platform, issueCode: 'notifications_disabled', status: 'warning',
          message: 'Lead notifications are disabled — new leads will not trigger SMS alerts',
          firstDetectedAt: now, lastDetectedAt: now,
        });
      }
    }

    return issues;
  }

  // ==========================================
  // LB ↔ SF Pipeline Health (Phase 2)
  //
  // Reads the Phase 1 observability tables (sf_inbound_events.processingError,
  // crm_webhook_deliveries.{state,lastStatusCode}, CrmWebhookSubscription
  // lastEventAt) and raises SystemErrorLog incidents for failure conditions.
  //
  // Each check emits a `[PipelineHealth] check=... result=ok|warn|error count=...`
  // log line so dashboards/alerts can filter on the line shape.
  // ==========================================

  /** Pipeline-level health checks. Called from systemHealthCheck under the same advisory lock. */
  async runPipelineHealthChecks(): Promise<{
    inboundErrors: number;
    outboundFailures: number;
    crm5xx: number;
    staleSubscriptions: number;
  }> {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const [inboundErrors, outboundFailures, crm5xx, staleSubscriptions] = await Promise.all([
      this.checkInboundProcessingErrors(since),
      this.checkOutboundFailures(since),
      this.checkOutbound5xx(since),
      this.checkStaleTraffic(),
    ]);
    return { inboundErrors, outboundFailures, crm5xx, staleSubscriptions };
  }

  /** Any sf_inbound_events.processingError in last 1h → captureError per affected user. */
  private async checkInboundProcessingErrors(since: Date): Promise<number> {
    const rows = await this.prisma.sfInboundEvent.findMany({
      where: { processingError: { not: null }, receivedAt: { gte: since } },
      select: { userId: true, processingError: true, eventId: true },
    });
    if (rows.length === 0) {
      this.logger.log('[PipelineHealth] check=sf_inbound_processing_error result=ok count=0');
      return 0;
    }
    const byUser = new Map<string | null, { count: number; sample: string }>();
    for (const r of rows) {
      const key = r.userId ?? null;
      const cur = byUser.get(key) ?? { count: 0, sample: r.processingError ?? 'unknown' };
      cur.count += 1;
      byUser.set(key, cur);
    }
    for (const [userId, agg] of byUser) {
      await this.captureError({
        category: 'webhook',
        code: 'sf_inbound_processing_error',
        severity: 'error',
        userId: userId ?? undefined,
        message: `${agg.count} SF inbound processing error(s) in last 1h. Sample: ${agg.sample.slice(0, 200)}`,
      });
    }
    this.logger.error(`[PipelineHealth] check=sf_inbound_processing_error result=error count=${rows.length}`);
    return rows.length;
  }

  /** crm_webhook_deliveries.state='failed' in last 1h → captureError per affected subscription user. */
  private async checkOutboundFailures(since: Date): Promise<number> {
    const failed = await this.prisma.crmWebhookDelivery.findMany({
      where: { state: 'failed', createdAt: { gte: since } },
      select: { subscriptionId: true, lastError: true, eventId: true },
    });
    if (failed.length === 0) {
      this.logger.log('[PipelineHealth] check=crm_outbound_failed result=ok count=0');
      return 0;
    }
    await this.captureErrorsForDeliveries({
      rows: failed.map(r => ({ subscriptionId: r.subscriptionId, sample: r.lastError ?? 'no_error_text' })),
      code: 'crm_outbound_failed',
      messagePrefix: 'CRM webhook delivery failed',
    });
    this.logger.error(`[PipelineHealth] check=crm_outbound_failed result=error count=${failed.length}`);
    return failed.length;
  }

  /** crm_webhook_deliveries.lastStatusCode>=500 in last 1h → captureError per affected subscription user. */
  private async checkOutbound5xx(since: Date): Promise<number> {
    const fivexx = await this.prisma.crmWebhookDelivery.findMany({
      where: { lastStatusCode: { gte: 500 }, createdAt: { gte: since } },
      select: { subscriptionId: true, lastStatusCode: true, eventId: true },
    });
    if (fivexx.length === 0) {
      this.logger.log('[PipelineHealth] check=crm_outbound_5xx result=ok count=0');
      return 0;
    }
    await this.captureErrorsForDeliveries({
      rows: fivexx.map(r => ({ subscriptionId: r.subscriptionId, sample: `status_code=${r.lastStatusCode}` })),
      code: 'crm_outbound_5xx',
      messagePrefix: 'CRM webhook receiver returned 5xx',
    });
    this.logger.error(`[PipelineHealth] check=crm_outbound_5xx result=error count=${fivexx.length}`);
    return fivexx.length;
  }

  /**
   * Stale traffic: an active subscription (inbound or outbound) that previously
   * carried traffic but hasn't seen any in >24h.
   *
   *  - Inbound: subscription.lastEventAt set AND last SfInboundEvent.receivedAt
   *    for that subscription >24h ago.
   *  - Outbound: any CrmWebhookDelivery exists for subscription AND latest
   *    successful delivery (state='sent') >24h ago.
   *
   * "Previous traffic" gate prevents alerts on freshly-registered subscriptions
   * that simply haven't received their first event yet.
   */
  private async checkStaleTraffic(): Promise<number> {
    const stalenessCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const subs = await this.prisma.crmWebhookSubscription.findMany({
      where: { isActive: true },
      select: { id: true, userId: true, name: true, direction: true, lastEventAt: true },
    });

    let alerted = 0;
    for (const sub of subs) {
      if (sub.direction === 'inbound') {
        // Previous traffic gate: lastEventAt must be set.
        if (!sub.lastEventAt) continue;
        if (sub.lastEventAt >= stalenessCutoff) continue;
        const last = await this.prisma.sfInboundEvent.findFirst({
          where: { sfSubscriptionId: sub.id },
          orderBy: { receivedAt: 'desc' },
          select: { receivedAt: true },
        });
        if (!last) continue; // no events ever — already gated above, defensive
        if (last.receivedAt >= stalenessCutoff) continue;
        await this.captureError({
          category: 'webhook',
          code: 'sf_inbound_stalled',
          severity: 'warning',
          userId: sub.userId,
          message: `SF inbound subscription "${sub.name}" has not received an event in >24h (last: ${last.receivedAt.toISOString()})`,
        });
        alerted++;
      } else if (sub.direction === 'outbound') {
        // Previous traffic gate: at least one delivery row must exist.
        const everSent = await this.prisma.crmWebhookDelivery.findFirst({
          where: { subscriptionId: sub.id, state: 'sent' },
          orderBy: { deliveredAt: 'desc' },
          select: { deliveredAt: true },
        });
        if (!everSent || !everSent.deliveredAt) continue;
        if (everSent.deliveredAt >= stalenessCutoff) continue;
        await this.captureError({
          category: 'webhook',
          code: 'crm_outbound_stalled',
          severity: 'warning',
          userId: sub.userId,
          message: `CRM outbound subscription "${sub.name}" has not delivered a webhook in >24h (last: ${everSent.deliveredAt.toISOString()})`,
        });
        alerted++;
      }
    }

    if (alerted === 0) {
      this.logger.log('[PipelineHealth] check=stale_traffic result=ok count=0');
    } else {
      this.logger.warn(`[PipelineHealth] check=stale_traffic result=warn count=${alerted}`);
    }
    return alerted;
  }

  /** Group failed/5xx delivery rows by subscriptionId, look up userId, captureError once per user. */
  private async captureErrorsForDeliveries(opts: {
    rows: Array<{ subscriptionId: string; sample: string }>;
    code: string;
    messagePrefix: string;
  }): Promise<void> {
    const bySub = new Map<string, { count: number; sample: string }>();
    for (const r of opts.rows) {
      const cur = bySub.get(r.subscriptionId) ?? { count: 0, sample: r.sample };
      cur.count += 1;
      bySub.set(r.subscriptionId, cur);
    }
    const subIds = Array.from(bySub.keys());
    if (subIds.length === 0) return;
    const subs = await this.prisma.crmWebhookSubscription.findMany({
      where: { id: { in: subIds } },
      select: { id: true, userId: true, name: true },
    });
    for (const sub of subs) {
      const agg = bySub.get(sub.id);
      if (!agg) continue;
      await this.captureError({
        category: 'webhook',
        code: opts.code,
        severity: 'error',
        userId: sub.userId,
        message: `${opts.messagePrefix} on subscription "${sub.name}" — ${agg.count} occurrence(s) in last 1h. Sample: ${agg.sample.slice(0, 200)}`,
      });
    }
  }

  // ==========================================
  // Health API
  // ==========================================

  /**
   * Get system health for a specific user.
   */
  async getSystemHealthForUser(userId: string): Promise<{
    healthy: boolean;
    status: 'healthy' | 'warning' | 'critical';
    lastCheckedAt: Date | null;
    summary: { critical: number; warning: number };
    issues: SystemHealthIssue[];
  }> {
    const activeIssues = await this.prisma.accountHealthStatus.findMany({
      where: { userId, isActive: true },
      include: { savedAccount: { select: { businessName: true } } },
      orderBy: { lastDetectedAt: 'desc' },
    });

    const lastCheck = await this.prisma.accountHealthStatus.findFirst({
      where: { userId },
      orderBy: { lastCheckedAt: 'desc' },
      select: { lastCheckedAt: true },
    });

    const critical = activeIssues.filter(i => i.status === 'critical').length;
    const warning = activeIssues.filter(i => i.status === 'warning').length;

    return {
      healthy: activeIssues.length === 0,
      status: critical > 0 ? 'critical' : warning > 0 ? 'warning' : 'healthy',
      lastCheckedAt: lastCheck?.lastCheckedAt || null,
      summary: { critical, warning },
      issues: activeIssues.map(i => ({
        accountId: i.accountId,
        accountName: (i as any).savedAccount?.businessName || i.platform,
        platform: i.platform,
        issueCode: i.issueCode,
        status: i.status as 'warning' | 'critical',
        message: i.issueMessage,
        firstDetectedAt: i.firstDetectedAt,
        lastDetectedAt: i.lastDetectedAt,
      })),
    };
  }

  /**
   * Run health check for a specific user's accounts (manual trigger).
   */
  async runHealthCheckForUser(userId: string): Promise<any> {
    const accounts = await this.prisma.savedAccount.findMany({
      where: { userId },
      select: {
        id: true, userId: true, platform: true, businessId: true, businessName: true,
        webhookId: true, credentialsJson: true,
      },
    });

    const now = new Date();
    let newIssueCount = 0;

    for (const account of accounts) {
      const issues = await this.checkAccountHealth(account);

      for (const issue of issues) {
        await this.prisma.accountHealthStatus.upsert({
          where: { accountId_issueCode: { accountId: account.id, issueCode: issue.issueCode } },
          create: {
            userId: account.userId, accountId: account.id, platform: account.platform,
            status: issue.status, issueCode: issue.issueCode, issueMessage: issue.message,
            isActive: true, firstDetectedAt: now, lastDetectedAt: now, lastCheckedAt: now,
          },
          update: {
            isActive: true, status: issue.status, issueMessage: issue.message,
            lastDetectedAt: now, lastCheckedAt: now,
          },
        });
        newIssueCount++;
      }

      // Resolve issues no longer present
      const currentCodes = new Set(issues.map(i => i.issueCode));
      const activeRows = await this.prisma.accountHealthStatus.findMany({
        where: { accountId: account.id, isActive: true },
      });
      for (const row of activeRows) {
        if (!currentCodes.has(row.issueCode)) {
          await this.prisma.accountHealthStatus.update({
            where: { id: row.id },
            data: { isActive: false, resolvedAt: now, lastCheckedAt: now },
          });
        }
      }
    }

    return this.getSystemHealthForUser(userId);
  }

  // ==========================================
  // SendGrid Email Notifications
  // ==========================================

  /**
   * Send alert email for new issues (grouped per user).
   */
  private async sendAlertEmail(userId: string, issues: SystemHealthIssue[]): Promise<void> {
    const apiKey = this.configService.get<string>('SENDGRID_API_KEY') || process.env.SENDGRID_API_KEY;
    const fromEmail = this.configService.get<string>('SENDGRID_FROM_EMAIL') || process.env.SENDGRID_FROM_EMAIL || 'alerts@leadbridge360.com';

    if (!apiKey) {
      this.logger.warn('[HealthCheck] SendGrid not configured — skipping alert email');
      return;
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
    if (!user?.email) return;

    const frontendUrl = this.configService.get<string>('frontendUrl') || 'https://www.leadbridge360.com';

    const issueLines = issues.map(i =>
      `• ${i.accountName} (${i.platform}) — ${i.message}`
    ).join('\n');

    const subject = issues.length === 1
      ? `LeadBridge Alert — ${issues[0].message.split('—')[0].trim()} for ${issues[0].accountName}`
      : `LeadBridge Alert — ${issues.length} issues detected`;

    try {
      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(apiKey);
      await sgMail.send({
        to: user.email,
        from: { email: fromEmail, name: 'LeadBridge Alerts' },
        subject,
        text: `Hi ${user.name || 'there'},\n\nThe following issues were detected:\n\n${issueLines}\n\nReview and fix: ${frontendUrl}/dashboard\n\n— LeadBridge`,
        html: `<p>Hi ${user.name || 'there'},</p><p>The following issues were detected:</p><ul>${issues.map(i => `<li><strong>${i.accountName}</strong> (${i.platform}) — ${i.message}</li>`).join('')}</ul><p><a href="${frontendUrl}/dashboard">Review and fix in Dashboard</a></p><p>— LeadBridge</p>`,
      });

      // Mark issues as notified
      for (const issue of issues) {
        await this.prisma.accountHealthStatus.updateMany({
          where: { accountId: issue.accountId, issueCode: issue.issueCode, isActive: true },
          data: { lastNotifiedAt: new Date(), notificationCount: { increment: 1 } },
        });
      }

      this.logger.log(`[HealthCheck] Alert email sent to ${user.email}: ${issues.length} issue(s)`);
    } catch (err: any) {
      this.logger.error(`[HealthCheck] Failed to send alert email: ${err.message}`);
    }
  }

  /**
   * Send recovery email when an issue resolves.
   */
  private async sendRecoveryEmail(userId: string, resolved: { accountName: string; platform: string; issueCode: string }): Promise<void> {
    const apiKey = this.configService.get<string>('SENDGRID_API_KEY') || process.env.SENDGRID_API_KEY;
    const fromEmail = this.configService.get<string>('SENDGRID_FROM_EMAIL') || process.env.SENDGRID_FROM_EMAIL || 'alerts@leadbridge360.com';
    if (!apiKey) return;

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
    if (!user?.email) return;

    try {
      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(apiKey);
      await sgMail.send({
        to: user.email,
        from: { email: fromEmail, name: 'LeadBridge Alerts' },
        subject: `LeadBridge Resolved — ${resolved.accountName} is healthy`,
        text: `Hi ${user.name || 'there'},\n\nThe issue "${resolved.issueCode}" for ${resolved.accountName} (${resolved.platform}) has been resolved.\n\n— LeadBridge`,
        html: `<p>Hi ${user.name || 'there'},</p><p>The issue <strong>${resolved.issueCode}</strong> for <strong>${resolved.accountName}</strong> (${resolved.platform}) has been resolved.</p><p>— LeadBridge</p>`,
      });
      this.logger.log(`[HealthCheck] Recovery email sent for ${resolved.accountName}`);
    } catch (err: any) {
      this.logger.error(`[HealthCheck] Failed to send recovery email: ${err.message}`);
    }
  }

  /**
   * Send reminders for issues unresolved 24h+, every 48h.
   */
  private async sendReminders(): Promise<void> {
    const staleIssues = await this.prisma.accountHealthStatus.findMany({
      where: {
        isActive: true,
        firstDetectedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        OR: [
          { lastNotifiedAt: null },
          { lastNotifiedAt: { lt: new Date(Date.now() - 48 * 60 * 60 * 1000) } },
        ],
      },
      include: { savedAccount: { select: { businessName: true } } },
    });

    if (staleIssues.length === 0) return;

    // Group by user
    const byUser = new Map<string, typeof staleIssues>();
    for (const issue of staleIssues) {
      const arr = byUser.get(issue.userId) || [];
      arr.push(issue);
      byUser.set(issue.userId, arr);
    }

    for (const [userId, issues] of byUser) {
      const mapped: SystemHealthIssue[] = issues.map(i => ({
        accountId: i.accountId,
        accountName: (i as any).savedAccount?.businessName || i.platform,
        platform: i.platform,
        issueCode: i.issueCode,
        status: i.status as 'warning' | 'critical',
        message: `${i.issueMessage} (unresolved ${Math.round((Date.now() - i.firstDetectedAt.getTime()) / (60 * 60 * 1000))}h)`,
        firstDetectedAt: i.firstDetectedAt,
        lastDetectedAt: i.lastDetectedAt,
      }));
      await this.sendAlertEmail(userId, mapped);
    }
  }

  // ==========================================
  // Error Log Queries (existing)
  // ==========================================

  async getRecentErrors(
    userId: string,
    options?: { limit?: number; onlyUnresolved?: boolean; category?: string },
  ) {
    return this.prisma.systemErrorLog.findMany({
      where: {
        userId,
        ...(options?.onlyUnresolved && { resolved: false }),
        ...(options?.category && { category: options.category }),
      },
      orderBy: { createdAt: 'desc' },
      take: options?.limit ?? 50,
    });
  }

  async resolveError(userId: string, id: string): Promise<void> {
    // updateMany with userId in the filter — silently no-ops on cross-tenant ID,
    // which we surface as NotFoundException so the caller gets a 404, not a 200.
    const result = await this.prisma.systemErrorLog.updateMany({
      where: { id, userId },
      data: { resolved: true },
    });
    if (result.count === 0) {
      throw new NotFoundException('Error log not found');
    }
  }

  async resolveAllByCategory(userId: string, category: string): Promise<number> {
    const result = await this.prisma.systemErrorLog.updateMany({
      where: { userId, category, resolved: false },
      data: { resolved: true },
    });
    return result.count;
  }

  async getErrorSummary(
    userId: string,
  ): Promise<{ totalUnresolved: number; byCategory: Record<string, number>; last24h: number }> {
    const [errors, last24hCount] = await Promise.all([
      this.prisma.systemErrorLog.groupBy({
        by: ['category'],
        where: { userId, resolved: false },
        _count: { id: true },
      }),
      this.prisma.systemErrorLog.count({
        where: { userId, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      }),
    ]);
    const byCategory: Record<string, number> = {};
    let totalUnresolved = 0;
    for (const e of errors) { byCategory[e.category] = e._count.id; totalUnresolved += e._count.id; }
    return { totalUnresolved, byCategory, last24h: last24hCount };
  }

  /**
   * Deduplicate historical error logs — collapse duplicates, keep latest per fingerprint.
   * Scoped to a single tenant; only touches rows whose `userId` matches the caller.
   */
  async deduplicateErrors(userId: string): Promise<number> {
    const groups = await this.prisma.systemErrorLog.groupBy({
      by: ['category', 'accountId'],
      where: { userId, resolved: false, accountId: { not: null } },
      _count: { id: true },
      having: { id: { _count: { gt: 1 } } },
    });

    let deduped = 0;
    for (const group of groups) {
      if (!group.accountId) continue;
      const rows = await this.prisma.systemErrorLog.findMany({
        where: { userId, category: group.category, accountId: group.accountId, resolved: false },
        orderBy: { createdAt: 'desc' },
      });
      // Keep the latest, resolve the rest
      for (let i = 1; i < rows.length; i++) {
        await this.prisma.systemErrorLog.update({ where: { id: rows[i].id }, data: { resolved: true } });
        deduped++;
      }
    }
    return deduped;
  }
}
