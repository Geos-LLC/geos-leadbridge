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
import { CronLockDb, isSkipped, withCronLock } from '../common/utils/cron-lock';
import { EmailService } from '../common/email/email.service';
import { PipelineIntegrityService } from './pipeline-integrity.service';

export interface CaptureErrorOptions {
  category: 'automation' | 'token_refresh' | 'webhook' | 'notification' | 'yelp' | 'associate_phones' | 'pricing' | 'other';
  code?: string; // Structured: 'token_expired', 'webhook_missing', 'automation_failure'
  platform?: string; // 'thumbtack' | 'yelp'
  severity?: 'error' | 'warning';
  message: string;
  userId?: string;
  accountId?: string;
  accountName?: string;
  context?: Record<string, any>;
}

/**
 * Reclassifier — keeps the `token_refresh` bucket clean of unrelated
 * failures that surface inside our refresh code paths.
 *
 * Background: the proactive-refresh cron wraps `serializedAccountRefresh`
 * in a try/catch and unconditionally tags any throw as
 * `category: 'token_refresh', code: 'token_expired'`. That swallowed
 * real OAuth rejections perfectly — but it also let DB schema
 * mismatches (e.g. the 2026-06-16 Wesley Chapel incident, where the
 * SavedAccount.update call hit a missing serviceProfileAssignmentsJson
 * column because the migration hadn't been applied yet) and crypto
 * errors land in the same bucket. The token-health UI and our health
 * sweep both treat any unresolved `token_refresh` row as "this tenant
 * needs to reconnect Thumbtack" — wrong action when the root cause is
 * actually our own bug.
 *
 * Strategy: inspect the message + code for non-OAuth signatures and
 * redirect them to `category: 'other'` with a structured `code` that
 * names the real cause. The redirect is intentionally conservative —
 * a real TT 400 with the standard `invalid_grant` wording never
 * matches any of these patterns.
 *
 * Exported so it can be unit-tested without instantiating the service.
 */
export function reclassifyCapture(
  options: Pick<CaptureErrorOptions, 'category' | 'code' | 'message'>,
): { category: CaptureErrorOptions['category']; code: string | undefined } {
  const { category, code, message } = options;
  // Only reclassify rows that COULD have been mislabeled. We never
  // re-bucket non-token_refresh inputs — those callers know their domain.
  if (category !== 'token_refresh') return { category, code };
  const text = (message ?? '').toLowerCase();

  // Prisma surfaces these phrases in its error.message. Any one of them
  // means we hit a query-layer failure before TT was ever called, so
  // it's an LB-side bug, not a tenant reconnect signal.
  const prismaSignatures = [
    'prisma',
    'invalid `prisma.',
    'does not exist in the current database',
    'unknown argument',
    'unknown field',
    'foreign key constraint',
    'unique constraint',
    'pls migrate', // shows up when prisma generate skipped
  ];
  if (prismaSignatures.some((s) => text.includes(s))) {
    return { category: 'other', code: 'db_error' };
  }

  // Local crypto failures (decryption key mismatch, malformed
  // ciphertext after a manual DB edit, etc.). The token text isn't
  // even loaded yet — calling this a token_refresh failure tells the
  // tenant to reconnect when really our key/state is broken.
  const cryptoSignatures = [
    'encryptionutil',
    'bad decrypt',
    'failed to decrypt',
    'unable to authenticate data',
    'wrong final block length',
    'invalid initialization vector',
  ];
  if (cryptoSignatures.some((s) => text.includes(s))) {
    return { category: 'other', code: 'crypto_error' };
  }

  // Outbound network errors from OUR side — DNS or socket-level
  // failures that didn't reach Thumbtack's OAuth server. These are
  // transient and don't mean the refresh token is dead.
  const networkSignatures = [
    'econnrefused',
    'enotfound',
    'etimedout',
    'socket hang up',
    'network error',
  ];
  if (networkSignatures.some((s) => text.includes(s))) {
    return { category: 'other', code: 'network_error' };
  }

  return { category, code };
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

// Local alias so existing helper signatures stay readable.
type Db = CronLockDb;

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
    // Optional for the same reason — direct-instantiation in scripts/specs
    // shouldn't have to wire EmailService. Production DI always populates
    // it; when null we just log-and-skip the actual send below.
    @Optional() private readonly email: EmailService | null = null,
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
   *
   * `db` defaults to the standalone client. Cron callers that hold a
   * transaction-scoped advisory lock pass their `tx` so the row write happens
   * on the same connection that holds the lock.
   */
  async captureError(options: CaptureErrorOptions, db: Db = this.prisma): Promise<void> {
    try {
      // Defensive: redirect non-OAuth failures out of the token_refresh
      // bucket so the dead-token UI + sweeps don't ask tenants to
      // reconnect when the actual cause is an LB-side bug (DB schema,
      // crypto, transient network). See reclassifyCapture for the rules
      // and the Wesley Chapel incident motivation.
      const reclassified = reclassifyCapture(options);
      if (reclassified.category !== options.category) {
        this.logger.warn(
          `[captureError] reclassified ${options.category}→${reclassified.category} ` +
          `(code=${reclassified.code}) accountId=${options.accountId ?? '-'} ` +
          `msg="${(options.message ?? '').slice(0, 120)}"`,
        );
      }
      options = { ...options, category: reclassified.category, code: reclassified.code };

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
        existing = await db.systemErrorLog.findFirst({
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
        existing = await db.systemErrorLog.findFirst({
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
        existing = await db.systemErrorLog.findFirst({
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
        await db.systemErrorLog.update({
          where: { id: existing.id },
          data: { message: options.message },
        });
        this.logger.debug(
          `[Monitoring] Deduped error category=${options.category} code=${options.code || '-'} accountId=${options.accountId || 'null'} userId=${options.userId || 'null'}`,
        );
        return;
      }

      await db.systemErrorLog.create({
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

      // Auto-detect platform-level OpenAI failures inside any captured error.
      // These affect every tenant and need an out-of-band dev alert (the
      // per-account email goes to the customer, not the developer).
      if (this.isOpenAiAuthError(options.message)) {
        this.notifyDevAlert({
          kind: 'openai_auth_failure',
          subject: 'LeadBridge: OpenAI API key broken',
          message: options.message,
          context: options.context,
        }).catch(err => this.logger.error(`[DevAlert] notify failed: ${err.message}`));
      } else if (this.isOpenAiQuotaError(options.message)) {
        this.notifyDevAlert({
          kind: 'openai_quota_exceeded',
          subject: 'LeadBridge: OpenAI quota exceeded — AI replies degraded',
          message:
            'OpenAI is returning 429 quota errors. Every AI follow-up and AI Conversation reply is falling back to generic templates. ' +
            'Top up billing on the OpenAI project for the key in OPENAI_API_KEY.\n\n' +
            `First failure message: ${options.message}`,
          context: options.context,
        }).catch(err => this.logger.error(`[DevAlert] notify failed: ${err.message}`));
      }
    } catch (err: any) {
      this.logger.error(`MonitoringService.captureError internal failure: ${err.message}`);
    }
  }

  // ==========================================
  // Dev Alerts — platform-wide failures (broken keys, dead infra)
  // ==========================================

  private isOpenAiAuthError(msg: string | undefined | null): boolean {
    if (!msg) return false;
    return /401\s*incorrect api key|invalid_api_key|invalid api key/i.test(msg);
  }

  private isOpenAiQuotaError(msg: string | undefined | null): boolean {
    if (!msg) return false;
    // OpenAI 429 quota exhaustion. Matches the body text returned by both
    // chat-completions and the responses API. Avoids matching transient
    // rate-limit 429s ("Rate limit reached for ..."), which are recoverable
    // and shouldn't page the developer.
    return /(429[^a-z]*you exceeded your current quota|insufficient_quota|exceeded your current quota)/i.test(msg);
  }

  /** Public accessor — lets other services (e.g. automation, follow-up generator) ask
   *  whether an OpenAI failure is platform-wide before deciding to short-circuit. */
  isOpenAiPlatformFailure(msg: string | undefined | null): boolean {
    return this.isOpenAiAuthError(msg) || this.isOpenAiQuotaError(msg);
  }

  /**
   * Send a developer-facing email alert for platform-level failures.
   * Dedups to one email per 24h per `kind` via SystemErrorLog.emailedAt.
   * Fire-and-forget safe — never throws.
   *
   * Recipient: alerts@leadbridge360.com (also the from address). Override via
   * DEV_ALERT_EMAIL env var.
   */
  async notifyDevAlert(opts: {
    kind: string;            // stable code, e.g. 'openai_auth_failure'
    subject: string;
    message: string;
    context?: Record<string, any>;
  }): Promise<void> {
    try {
      const toEmail = this.configService.get<string>('DEV_ALERT_EMAIL') || process.env.DEV_ALERT_EMAIL || 'alerts@leadbridge360.com';

      // Dedup via SystemErrorLog (category='other', code=kind, no accountId).
      const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
      const existing = await this.prisma.systemErrorLog.findFirst({
        where: { category: 'other', code: opts.kind, accountId: null, userId: null },
        orderBy: { createdAt: 'desc' },
      });
      if (existing?.emailedAt && Date.now() - existing.emailedAt.getTime() < DEDUP_WINDOW_MS) {
        this.logger.debug(`[DevAlert] suppressed (sent ${Math.round((Date.now() - existing.emailedAt.getTime()) / 60000)}m ago): ${opts.kind}`);
        return;
      }

      const ctxJson = opts.context ? JSON.stringify(opts.context, null, 2) : null;
      const body = [
        `Kind: ${opts.kind}`,
        `When: ${new Date().toISOString()}`,
        '',
        opts.message,
        ctxJson ? `\nContext:\n${ctxJson}` : '',
      ].join('\n');

      if (!this.email) {
        this.logger.warn(`[DevAlert] EmailService not wired — skipping ${opts.kind}`);
        return;
      }
      const sent = await this.email.send({
        to: toEmail,
        subject: opts.subject,
        text: body,
        fromName: 'LeadBridge Dev Alerts',
        tag: 'monitoring/dev-alert',
      });
      // Only write the dedup row when the message actually went out. If
      // SendGrid is unconfigured / the API call failed we want the next
      // attempt to try again, not get suppressed.
      if (!sent) return;

      // Update or create the dedup row
      if (existing) {
        await this.prisma.systemErrorLog.update({
          where: { id: existing.id },
          data: { emailedAt: new Date(), message: opts.message },
        });
      } else {
        await this.prisma.systemErrorLog.create({
          data: {
            category: 'other',
            code: opts.kind,
            severity: 'error',
            message: opts.message,
            context: ctxJson,
            emailedAt: new Date(),
          },
        });
      }
      this.logger.warn(`[DevAlert] sent: ${opts.kind} → ${toEmail}`);
    } catch (err: any) {
      this.logger.error(`[DevAlert] internal failure (${opts.kind}): ${err.message}`);
    }
  }

  /**
   * Dev SMS alert — pages the on-call dev's phone via the LeadBridge **platform**
   * Sigcore workspace (NOT a tenant's). Per [SIGCORE_HIERARCHY.md], pool numbers
   * routed via the platform `SIGCORE_API_KEY` are "alerts only" by design, which
   * is exactly the use case here. Using a tenant's key would bill that tenant
   * for our debug pages and confuse their outbound log — don't do that.
   *
   * Sigcore contract (changed in the PR4 outbound resolver work): `/v1/messages`
   * runs the profile resolver for every request UNLESS `phoneNumberId` is
   * provided. The resolver requires `tenantId`, which the platform workspace
   * key does NOT carry — so a workspace-keyed call without `phoneNumberId`
   * always 422s with `AMBIGUOUS_FROM_NUMBER: tenantId is required for
   * profile-based outbound routing`. The legacy direct-send path (pass
   * `phoneNumberId`, skip the resolver) is preserved for SF/Callio back-compat
   * and is what we use here.
   *
   * Required env to actually send:
   *   - SIGCORE_API_KEY                 (platform workspace key)
   *   - DEV_ALERT_SMS_TO                (defaults to +12483462681)
   *   - DEV_ALERT_SMS_PHONE_NUMBER_ID   (Sigcore phone_number_id of a pool
   *                                      number — required since the PR4
   *                                      resolver change. Without it the
   *                                      Sigcore call 422s and we fall back to
   *                                      email. Look up the id in the platform
   *                                      Sigcore workspace's phone_numbers
   *                                      table for whichever pool number you
   *                                      want as the stable dev-alert sender.)
   *
   * Dedup window is shorter than the email path (1h vs 24h) because these are
   * critical and we want a fresh page after a quiet hour. When the Sigcore
   * call fails for any reason we fall back to notifyDevAlert (email) so the
   * alert isn't lost. Dedup row stored as
   * SystemErrorLog(category='other', code='dev_sms_<kind>').
   */
  async notifyDevSms(opts: {
    kind: string;
    message: string;
    context?: Record<string, any>;
  }): Promise<void> {
    try {
      const to = this.configService.get<string>('DEV_ALERT_SMS_TO') || process.env.DEV_ALERT_SMS_TO || '+12483462681';
      const phoneNumberId =
        this.configService.get<string>('DEV_ALERT_SMS_PHONE_NUMBER_ID') ||
        process.env.DEV_ALERT_SMS_PHONE_NUMBER_ID ||
        '';
      const apiKey = this.configService.get<string>('SIGCORE_API_KEY') || process.env.SIGCORE_API_KEY || '';

      // Without the platform key we can't reach Sigcore. Fall back to email so
      // the alert isn't lost — the dev will see it in their inbox.
      if (!apiKey) {
        this.logger.warn(`[DevSms] SIGCORE_API_KEY unset — falling back to email for ${opts.kind}`);
        await this.notifyDevAlert({
          kind: opts.kind,
          subject: `LeadBridge: ${opts.kind}`,
          message: opts.message,
          context: opts.context,
        });
        return;
      }

      // Without phoneNumberId, Sigcore's resolver will reject the call
      // (tenantId-less workspace key). Skip the doomed network round-trip and
      // go straight to email — the operator gets the same content and the
      // hourly dedup row is still written via the email path.
      if (!phoneNumberId) {
        this.logger.warn(
          `[DevSms] DEV_ALERT_SMS_PHONE_NUMBER_ID unset — Sigcore would 422 (tenantId required). Falling back to email for ${opts.kind}`,
        );
        await this.notifyDevAlert({
          kind: opts.kind,
          subject: `LeadBridge: ${opts.kind}`,
          message: opts.message,
          context: opts.context,
        });
        return;
      }

      const code = `dev_sms_${opts.kind}`;
      const DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1h — critical paths should re-page after an hour
      const existing = await this.prisma.systemErrorLog.findFirst({
        where: { category: 'other', code, accountId: null, userId: null },
        orderBy: { createdAt: 'desc' },
      });
      if (existing?.emailedAt && Date.now() - existing.emailedAt.getTime() < DEDUP_WINDOW_MS) {
        this.logger.debug(`[DevSms] suppressed (sent ${Math.round((Date.now() - existing.emailedAt.getTime()) / 60000)}m ago): ${opts.kind}`);
        return;
      }

      // Truncate to a single SMS segment — operator reads details on the dashboard.
      const body = `LB: ${opts.message}`.slice(0, 320);

      const sigcoreUrl = this.configService.get<string>('SIGCORE_API_URL', 'https://sigcore-production.up.railway.app/api');
      // phoneNumberId is what bypasses Sigcore's profile resolver — the only
      // path that works for workspace-keyed (no-tenant) calls today.
      const requestBody: Record<string, unknown> = {
        toNumber: to,
        body,
        channel: 'sms',
        phoneNumberId,
        metadata: { purpose: 'dev_alert', kind: opts.kind },
      };

      const response = await fetch(`${sigcoreUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        this.logger.error(`[DevSms] Sigcore ${response.status} ${text.slice(0, 200)} — falling back to email for ${opts.kind}`);
        await this.notifyDevAlert({
          kind: opts.kind,
          subject: `LeadBridge: ${opts.kind} (SMS failed ${response.status})`,
          message: opts.message,
          context: { ...opts.context, smsError: text.slice(0, 200) },
        });
        return;
      }

      const ctxJson = opts.context ? JSON.stringify(opts.context, null, 2) : null;
      if (existing) {
        await this.prisma.systemErrorLog.update({
          where: { id: existing.id },
          data: { emailedAt: new Date(), message: opts.message },
        });
      } else {
        await this.prisma.systemErrorLog.create({
          data: {
            category: 'other',
            code,
            severity: 'error',
            message: opts.message,
            context: ctxJson,
            emailedAt: new Date(),
          },
        });
      }
      this.logger.warn(`[DevSms] sent: ${opts.kind} → ${to}`);
    } catch (err: any) {
      this.logger.error(`[DevSms] internal failure (${opts.kind}): ${err.message}`);
    }
  }

  /**
   * Cron: every hour, probe OpenAI to detect a broken key even when no leads
   * are coming in. Catches outages on quiet days.
   */
  @Cron('30 */1 * * *')
  async openAiKeyProbe(): Promise<void> {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY') || process.env.OPENAI_API_KEY;
    if (!apiKey) return;
    try {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (r.status === 401) {
        const body = await r.text().catch(() => '');
        this.logger.error(`[OpenAIProbe] 401 — ${body.slice(0, 200)}`);
        await this.notifyDevAlert({
          kind: 'openai_auth_failure',
          subject: 'LeadBridge: OpenAI API key broken (probe)',
          message: `Hourly probe got 401 from OpenAI /v1/models. Key suffix: ...${apiKey.slice(-6)}.`,
          context: { source: 'probe', responseExcerpt: body.slice(0, 200) },
        });
      } else if (!r.ok) {
        this.logger.warn(`[OpenAIProbe] non-OK status ${r.status}`);
      }
    } catch (err: any) {
      this.logger.warn(`[OpenAIProbe] network error: ${err.message}`);
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
    try {
      // Lock key 17003 — MonitoringService namespace (17000+).
      const outcome = await withCronLock(this.prisma, this.logger, 17003, 'HealthCheck', async tx => {
        // Pipeline health checks run BEFORE the per-account work and BEFORE
        // the no-accounts short-circuit, so SF↔LB pipeline alerts fire on a
        // fresh staging tenant with zero saved accounts too.
        const pipelineCounts = await this.runPipelineHealthChecks(tx);

        const accounts = await tx.savedAccount.findMany({
          select: {
            id: true, userId: true, platform: true, businessId: true, businessName: true,
            webhookId: true, credentialsJson: true,
          },
        });

        if (accounts.length === 0) {
          return { accountCount: 0, newIssues: [], recoveries: [], pipelineCounts };
        }

        const now = new Date();
        const newIssues: { userId: string; issue: SystemHealthIssue }[] = [];
        const recoveries: { userId: string; accountName: string; platform: string; issueCode: string }[] = [];

        for (const account of accounts) {
          const issues = await this.checkAccountHealth(account, tx);

          for (const issue of issues) {
            const existing = await tx.accountHealthStatus.findUnique({
              where: { accountId_issueCode: { accountId: account.id, issueCode: issue.issueCode } },
            });

            if (existing) {
              if (!existing.isActive) {
                await tx.accountHealthStatus.update({
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
                await tx.accountHealthStatus.update({
                  where: { id: existing.id },
                  data: { lastDetectedAt: now, lastCheckedAt: now, issueMessage: issue.message },
                });
              }
            } else {
              await tx.accountHealthStatus.create({
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

          const activeIssues = await tx.accountHealthStatus.findMany({
            where: { accountId: account.id, isActive: true },
          });
          const currentIssueCodes = new Set(issues.map(i => i.issueCode));
          for (const active of activeIssues) {
            if (!currentIssueCodes.has(active.issueCode)) {
              await tx.accountHealthStatus.update({
                where: { id: active.id },
                data: { isActive: false, resolvedAt: now, lastCheckedAt: now },
              });
              // Defer recovery email until the transaction commits — we don't
              // hold an open DB connection (and the advisory lock with it)
              // across SendGrid network calls.
              recoveries.push({
                userId: account.userId,
                accountName: account.businessName || account.businessId,
                platform: account.platform,
                issueCode: active.issueCode,
              });
            }
          }
        }

        return { accountCount: accounts.length, newIssues, recoveries, pipelineCounts };
      });

      if (isSkipped(outcome)) return;

      // Email I/O happens after the transaction commits — keeps SendGrid
      // network latency out of the lock window.
      for (const r of outcome.recoveries) {
        this.sendRecoveryEmail(r.userId, {
          accountName: r.accountName,
          platform: r.platform,
          issueCode: r.issueCode,
        }).catch(() => {});
      }

      if (outcome.newIssues.length > 0) {
        const byUser = new Map<string, SystemHealthIssue[]>();
        for (const { userId, issue } of outcome.newIssues) {
          const arr = byUser.get(userId) || [];
          arr.push(issue);
          byUser.set(userId, arr);
        }
        for (const [userId, issues] of byUser) {
          await this.sendAlertEmail(userId, issues);
        }
      }

      // Cross-tenant dev SMS — aggregate this sweep's new critical issues into a
      // single page. Per-tenant emails already went out above; this is the on-call
      // dev's signal that something needs a human, deduped at 1h via notifyDevSms.
      await this.maybeSendCrossTenantDevAlert(outcome.newIssues, outcome.pipelineCounts);

      await this.sendReminders();

      this.logger.log(`[HealthCheck] Complete — ${outcome.accountCount} accounts, ${outcome.newIssues.length} new issues`);
    } catch (err: any) {
      this.logger.error(`[HealthCheck] Cron error: ${err.message}`);
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
    try {
      // Lock key 17005 — MonitoringService namespace.
      const outcome = await withCronLock(this.prisma, this.logger, 17005, 'StalePending', async tx => {
        const result = await tx.$queryRawUnsafe<Array<{ count: number }>>(
          `WITH updated AS (
             UPDATE notification_logs
                SET status = 'unknown'
              WHERE status = 'pending'
                AND "createdAt" < NOW() - INTERVAL '${MonitoringService.STALE_PENDING_HOURS} hours'
              RETURNING id
           )
           SELECT COUNT(*)::int AS count FROM updated`,
        );
        return { updatedCount: result?.[0]?.count ?? 0 };
      });

      if (isSkipped(outcome)) return;

      // Single-line k=v log so Loki dashboards can filter on
      // result=stale_pending_resolved updated=N.
      this.logger.log(
        `[StalePending] result=stale_pending_resolved updated=${outcome.updatedCount} threshold_hours=${MonitoringService.STALE_PENDING_HOURS}`,
      );
    } catch (err: any) {
      this.logger.error(
        `[StalePending] result=error error=${(err?.message ?? 'unknown').replace(/\s+/g, ' ').slice(0, 300)}`,
      );
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

    try {
      // Lock key 17004 — MonitoringService namespace.
      const outcome = await withCronLock(
        this.prisma,
        this.logger,
        17004,
        'PipelineIntegrity',
        async tx => {
          // PipelineIntegrityService runs its own queries against this.prisma
          // (read-only checks against the broader schema). They land on
          // separate pooler connections — that's fine. The xact lock is held
          // by THIS transaction's connection for the lifetime of the callback,
          // which is what enforces single-runner exclusion.
          const result = await this.pipelineIntegrity!.runChecks();

          if (result.ok) {
            return { kind: 'ok' as const, length: result.results.length };
          }

          await this.captureError(
            {
              category: 'webhook',
              code: 'pipeline_integrity_failed',
              severity: 'error',
              message: result.summary,
              context: {
                failedCount: result.failedCount,
                results: result.results.map(r => ({
                  check: r.check,
                  count: r.count,
                  severity: r.severity,
                  sample: r.sample,
                })),
                ranAt: new Date().toISOString(),
              },
            },
            tx,
          );

          return { kind: 'failed' as const, result };
        },
        // Integrity checks are heavier than the hourly health check.
        { timeoutMs: 600_000 },
      );

      if (isSkipped(outcome)) return;

      if (outcome.kind === 'ok') {
        this.logger.log(`[PipelineIntegrity] result=ok failed_count=0 summary="all ${outcome.length} checks passed"`);
        return;
      }

      const failedCheckNames = outcome.result.results
        .filter(r => r.severity === 'fail')
        .map(r => `${r.check}:${r.count}`)
        .join(',');
      this.logger.error(
        `[PipelineIntegrity] result=failed failed_count=${outcome.result.failedCount} checks=${failedCheckNames}`,
      );
    } catch (err: any) {
      this.logger.error(
        `[PipelineIntegrity] result=error error=${(err?.message ?? 'unknown').replace(/\s+/g, ' ').slice(0, 300)}`,
      );
    }
  }

  // ==========================================
  // Daily SavedAccount Auto-Archive Sweep
  //
  // Background: when a tenant deletes their LeadBridge integration on
  // the platform side (e.g. Wesley Chapel — operator deleted the TT
  // business itself), our refresh tokens go permanently invalid. We
  // can't probe the platform to confirm "deleted vs transient" since
  // we have no auth, so we use **time** as the proxy: 30 days of
  // unresolved token_refresh failures is a strong signal the account
  // is gone for good (real expiries get reconnected within days).
  //
  // What it does:
  //   - Find SavedAccount rows where archivedAt IS NULL AND there's
  //     an unresolved SystemErrorLog row of category='token_refresh'
  //     with createdAt >= 30 days ago.
  //   - Set archivedAt = now(). The row stays in the DB — user-facing
  //     reads (loadSavedAccounts) filter archivedAt:null, so it drops
  //     out of the connected-accounts list and dead-token warning.
  //   - A fresh OAuth reconnect on the same userId+platform+businessId
  //     hits the upsert path in saveAccount() which clears archivedAt,
  //     resurrecting the row with all its config (FAQ, pricing, AI
  //     playbook, follow-up settings) intact.
  //
  // Schedule: '0 4 * * *' = 04:00 UTC daily. Advisory lock 17005
  // prevents staging+production double-execution on the shared DB.
  // ==========================================

  /** Threshold for auto-archiving an account with dead refresh tokens. */
  private static readonly ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

  @Cron('0 4 * * *')
  async archiveOrphanedAccounts(): Promise<void> {
    try {
      await withCronLock(
        this.prisma,
        this.logger,
        17005,
        'ArchiveOrphanedAccounts',
        async (tx) => {
          const result = await this.runArchiveOrphanedAccountsSweep(tx);
          this.logger.log(
            `[ArchiveOrphanedAccounts] swept candidates=${result.candidates} archived=${result.archived}`,
          );
        },
      );
    } catch (err: any) {
      if (isSkipped(err)) {
        this.logger.log('[ArchiveOrphanedAccounts] skipped — another instance holds the lock');
        return;
      }
      this.logger.error(
        `[ArchiveOrphanedAccounts] result=error error=${(err?.message ?? 'unknown').slice(0, 300)}`,
      );
    }
  }

  /**
   * The sweep itself, factored out so the cron, manual admin trigger,
   * and unit tests can all share one implementation. Returns counts
   * for logging — pure side-effect on the DB otherwise.
   */
  async runArchiveOrphanedAccountsSweep(db: Db = this.prisma): Promise<{
    candidates: number;
    archived: number;
  }> {
    const threshold = new Date(Date.now() - MonitoringService.ARCHIVE_AFTER_MS);

    const stale = await db.systemErrorLog.findMany({
      where: {
        category: 'token_refresh',
        resolved: false,
        createdAt: { lte: threshold },
        accountId: { not: null },
      },
      select: { accountId: true, createdAt: true },
    });

    const oldestByAccount = new Map<string, Date>();
    for (const e of stale) {
      const id = e.accountId!;
      const prev = oldestByAccount.get(id);
      if (!prev || e.createdAt < prev) oldestByAccount.set(id, e.createdAt);
    }

    const accountIds = Array.from(oldestByAccount.keys());
    if (accountIds.length === 0) {
      return { candidates: 0, archived: 0 };
    }

    const candidates = await db.savedAccount.findMany({
      where: { id: { in: accountIds }, archivedAt: null },
      select: { id: true, businessName: true, platform: true, userId: true },
    });

    if (candidates.length === 0) {
      return { candidates: accountIds.length, archived: 0 };
    }

    const now = new Date();
    const result = await db.savedAccount.updateMany({
      where: { id: { in: candidates.map((c) => c.id) }, archivedAt: null },
      data: { archivedAt: now },
    });

    for (const c of candidates) {
      const sinceWhen = oldestByAccount.get(c.id);
      this.logger.warn(
        `[ArchiveOrphanedAccounts] archived ${c.platform}/${c.businessName} ` +
        `(id=${c.id} user=${c.userId}) — first dead-token error at ` +
        `${sinceWhen?.toISOString() ?? '?'}`,
      );
    }

    return { candidates: accountIds.length, archived: result.count };
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
  private async checkAccountHealth(account: any, db: Db = this.prisma): Promise<SystemHealthIssue[]> {
    const issues: SystemHealthIssue[] = [];
    const now = new Date();

    // 1. Token expired — check unresolved auth/refresh errors
    const tokenErrors = await db.systemErrorLog.findFirst({
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
    const automationFailCount = await db.systemErrorLog.count({
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
    const notifSettings = await db.notificationSettings.findUnique({
      where: { savedAccountId: account.id },
      select: { enabled: true, notificationRules: { where: { triggerType: 'new_lead', enabled: true }, select: { id: true } } },
    });
    // Only flag if settings exist but all new_lead rules are disabled (user configured then turned off)
    if (notifSettings && notifSettings.enabled && notifSettings.notificationRules.length === 0) {
      // Check if there were ever any rules (user configured then disabled)
      const anyRules = await db.notificationRule.count({ where: { notificationSettingsId: account.id } }).catch(() => 0);
      if (anyRules > 0) {
        issues.push({
          accountId: account.id, accountName: account.businessName || account.businessId,
          platform: account.platform, issueCode: 'notifications_disabled', status: 'warning',
          message: 'Lead notifications are disabled — new leads will not trigger SMS alerts',
          firstDetectedAt: now, lastDetectedAt: now,
        });
      }
    }

    // Sigcore outbound chain incomplete (FargiPro/Globus/SheNe 2026-06-17 class).
    // The Sigcore ensureOutboundReady chain (purchase → business → profile → PPA)
    // is supposed to run inside purchaseNumber, but historically didn't — a TPN
    // row was created with sigcoreAllocationId=NULL and every outbound /v1/messages
    // returned 422 INVALID_PROFILE_PHONE. We wait 1h after purchase before flagging
    // so a freshly-running provisioner doesn't trip the alert.
    const incompleteTpn = await db.tenantPhoneNumber.findFirst({
      where: {
        savedAccountId: account.id,
        sigcoreAllocationId: null,
        status: 'ACTIVE',
        purchasedAt: { lt: new Date(Date.now() - 60 * 60 * 1000) },
      },
      select: { phoneNumber: true, purchasedAt: true },
    });
    if (incompleteTpn) {
      issues.push({
        accountId: account.id, accountName: account.businessName || account.businessId,
        platform: account.platform, issueCode: 'sigcore_chain_incomplete', status: 'critical',
        message: `Phone ${incompleteTpn.phoneNumber} has no Sigcore PPA — outbound will 422 INVALID_PROFILE_PHONE`,
        firstDetectedAt: now, lastDetectedAt: now,
      });
    }

    // Outbound send-failure streak — 3+ NotificationLog rows with status='failed'
    // in the last hour for this account. Catches silent feature failures where
    // the routing chain or the sender-auth path broke for this tenant but
    // automation/token_refresh buckets don't see it.
    const settingsRow = await db.notificationSettings.findUnique({
      where: { savedAccountId: account.id },
      select: { id: true },
    });
    if (settingsRow) {
      const recentFailures = await db.notificationLog.count({
        where: {
          notificationSettingsId: settingsRow.id,
          status: 'failed',
          createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
        },
      });
      if (recentFailures >= 3) {
        issues.push({
          accountId: account.id, accountName: account.businessName || account.businessId,
          platform: account.platform, issueCode: 'send_failure_streak', status: 'critical',
          message: `${recentFailures} outbound SMS sends failed in the last hour`,
          firstDetectedAt: now, lastDetectedAt: now,
        });
      }
    }

    // 5. Associate-phone sync failure (Thumbtack only). LB pushes owner phone +
    // LB dedicated number + custom associates to TT after every OAuth and on
    // demand. When that fails, proxy calls won't honor LB-side senders — leads
    // route to a number the customer can't reach. Surfaced today by reading
    // unresolved category='associate_phones' rows; resolved when a subsequent
    // successful sync calls `markAssociatePhoneSyncResolved`.
    if (account.platform === 'thumbtack') {
      const associatePhonesError = await db.systemErrorLog.findFirst({
        where: { accountId: account.id, category: 'associate_phones', resolved: false },
        orderBy: { createdAt: 'desc' },
      });
      if (associatePhonesError) {
        issues.push({
          accountId: account.id, accountName: account.businessName || account.businessId,
          platform: account.platform, issueCode: 'associate_phones_failed', status: 'warning',
          message: associatePhonesError.message || 'Associate-phone sync failed — proxy calls may not honor LB-side senders',
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
  async runPipelineHealthChecks(db: Db = this.prisma): Promise<{
    inboundErrors: number;
    outboundFailures: number;
    crm5xx: number;
    staleSubscriptions: number;
    stuckEnrollments: number;
  }> {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const [inboundErrors, outboundFailures, crm5xx, staleSubscriptions, stuckEnrollments] = await Promise.all([
      this.checkInboundProcessingErrors(since, db),
      this.checkOutboundFailures(since, db),
      this.checkOutbound5xx(since, db),
      this.checkStaleTraffic(db),
      this.checkStuckFollowUpEnrollments(db),
    ]);
    return { inboundErrors, outboundFailures, crm5xx, staleSubscriptions, stuckEnrollments };
  }

  /**
   * Stuck follow-up enrollments — active enrollments whose `nextStepDueAt` is
   * >1h in the past with no recent `FollowUpStepExecution`. This is the
   * silent-failure class that bit Kristian Anthony 2026-06-20 (resume restarts
   * at step 0, then never moves) and the Padma 2026-05-12 evaluateThread gap.
   *
   * Threshold of 5 across all tenants suppresses single-account hiccups —
   * a real regression in the scheduler shows up as dozens of rows.
   *
   * Suggest-mode parking is excluded: when an enrollment has a pending
   * `FollowUpStepExecution(status='suggested')`, the scheduler intentionally
   * does NOT advance it (see follow-up-scheduler.service.ts claim query) —
   * the user is expected to action the suggestion. Those rows are not
   * "stuck", they're awaiting input, and without this filter every
   * un-actioned suggest-mode tenant counts as a stuck enrollment. That was
   * driving the 2026-06-24 fu_stuck×100 false-positive page.
   */
  private async checkStuckFollowUpEnrollments(db: Db = this.prisma): Promise<number> {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const stuck = await db.followUpEnrollment.findMany({
      where: {
        status: 'active',
        nextStepDueAt: { lt: cutoff, not: null },
        stepExecutions: { none: { status: 'suggested' } },
      },
      select: { id: true, conversationId: true, platform: true, lastExecutedAt: true },
      take: 100,
    });
    // Filter out ones that DID execute recently (lastExecutedAt is the
    // authoritative "moved forward" signal — nextStepDueAt can lag the
    // actual scheduler write by a tick).
    const actuallyStuck = stuck.filter(e => !e.lastExecutedAt || e.lastExecutedAt < cutoff);
    if (actuallyStuck.length < 5) {
      this.logger.log(`[PipelineHealth] check=follow_up_stuck result=ok count=${actuallyStuck.length}`);
      return 0;
    }
    const byPlatform = actuallyStuck.reduce<Record<string, number>>((acc, e) => {
      acc[e.platform] = (acc[e.platform] ?? 0) + 1;
      return acc;
    }, {});
    const sample = actuallyStuck.slice(0, 3).map(e => e.conversationId).join(', ');
    await this.captureError(
      {
        category: 'webhook',
        code: 'follow_up_stuck',
        severity: 'error',
        message:
          `${actuallyStuck.length} follow-up enrollments are stuck (nextStepDueAt >1h past, no recent execution). ` +
          `By platform: ${JSON.stringify(byPlatform)}. Sample conversation ids: ${sample}`,
      },
      db,
    );
    this.logger.error(`[PipelineHealth] check=follow_up_stuck result=error count=${actuallyStuck.length}`);
    return actuallyStuck.length;
  }

  /** Any sf_inbound_events.processingError in last 1h → captureError per affected user. */
  private async checkInboundProcessingErrors(since: Date, db: Db = this.prisma): Promise<number> {
    const rows = await db.sfInboundEvent.findMany({
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
      await this.captureError(
        {
          category: 'webhook',
          code: 'sf_inbound_processing_error',
          severity: 'error',
          userId: userId ?? undefined,
          message: `${agg.count} SF inbound processing error(s) in last 1h. Sample: ${agg.sample.slice(0, 200)}`,
        },
        db,
      );
    }
    this.logger.error(`[PipelineHealth] check=sf_inbound_processing_error result=error count=${rows.length}`);
    return rows.length;
  }

  /** crm_webhook_deliveries.state='failed' in last 1h → captureError per affected subscription user. */
  private async checkOutboundFailures(since: Date, db: Db = this.prisma): Promise<number> {
    const failed = await db.crmWebhookDelivery.findMany({
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
    }, db);
    this.logger.error(`[PipelineHealth] check=crm_outbound_failed result=error count=${failed.length}`);
    return failed.length;
  }

  /** crm_webhook_deliveries.lastStatusCode>=500 in last 1h → captureError per affected subscription user. */
  private async checkOutbound5xx(since: Date, db: Db = this.prisma): Promise<number> {
    const fivexx = await db.crmWebhookDelivery.findMany({
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
    }, db);
    this.logger.error(`[PipelineHealth] check=crm_outbound_5xx result=error count=${fivexx.length}`);
    return fivexx.length;
  }

  /**
   * Stale traffic: an active subscription (inbound or outbound) that previously
   * carried traffic but hasn't seen any recently.
   *
   *  - Inbound: any sf_inbound_event with processingError=NULL in the last 24h
   *    proves the pipeline is alive (accepted noops count). Only when zero such
   *    healthy rows exist AND the historical lastEventAt is >72h old do we warn.
   *    Threshold widened from 24h → 72h because real SF traffic is naturally
   *    sparse (multi-day gaps between status changes are normal); the prior
   *    24h cutoff false-fired on quiet accounts.
   *  - Outbound: any CrmWebhookDelivery exists for subscription AND latest
   *    successful delivery (state='sent') >24h ago.
   *
   * "Previous traffic" gate prevents alerts on freshly-registered subscriptions
   * that simply haven't received their first event yet.
   *
   * On a healthy inbound result we also auto-resolve any unresolved
   * sf_inbound_stalled SystemErrorLog row for the user — captureError never
   * resolves on its own, so without this the row would persist forever after
   * a transient stall clears.
   */
  private async checkStaleTraffic(db: Db = this.prisma): Promise<number> {
    const inboundStaleCutoff = new Date(Date.now() - 72 * 60 * 60 * 1000);
    const inboundHealthyCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const outboundStaleCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const subs = await db.crmWebhookSubscription.findMany({
      where: { isActive: true },
      select: { id: true, userId: true, name: true, direction: true, lastEventAt: true },
    });

    let alerted = 0;
    for (const sub of subs) {
      if (sub.direction === 'inbound') {
        // Health gate: any clean inbound event in last 24h means the pipeline is
        // demonstrably alive. processingError=NULL is the "accepted by handler"
        // marker — accepted noop/skip results count as healthy; only rows with a
        // real internal error fail the gate (those have their own dedicated
        // alert via checkInboundProcessingErrors). Match by subscriptionId, with
        // userId as a fallback for legacy rows written before sfSubscriptionId
        // was populated.
        const recentClean = await db.sfInboundEvent.findFirst({
          where: {
            OR: [{ sfSubscriptionId: sub.id }, { userId: sub.userId }],
            receivedAt: { gte: inboundHealthyCutoff },
            processingError: null,
          },
          select: { receivedAt: true },
        });
        if (recentClean) {
          await this.resolveInboundStalledFor(sub.userId, db);
          continue;
        }

        // Previous-traffic gate: don't warn on a fresh subscription with no history.
        if (!sub.lastEventAt) continue;
        if (sub.lastEventAt >= inboundStaleCutoff) continue;
        const last = await db.sfInboundEvent.findFirst({
          where: { sfSubscriptionId: sub.id },
          orderBy: { receivedAt: 'desc' },
          select: { receivedAt: true },
        });
        if (!last) continue;
        if (last.receivedAt >= inboundStaleCutoff) continue;
        await this.captureError(
          {
            category: 'webhook',
            code: 'sf_inbound_stalled',
            severity: 'warning',
            userId: sub.userId,
            message: `SF inbound subscription "${sub.name}" has not received an event in >72h (last: ${last.receivedAt.toISOString()})`,
          },
          db,
        );
        alerted++;
      } else if (sub.direction === 'outbound') {
        // Previous traffic gate: at least one delivery row must exist.
        const everSent = await db.crmWebhookDelivery.findFirst({
          where: { subscriptionId: sub.id, state: 'sent' },
          orderBy: { deliveredAt: 'desc' },
          select: { deliveredAt: true },
        });
        if (!everSent || !everSent.deliveredAt) continue;
        if (everSent.deliveredAt >= outboundStaleCutoff) continue;
        await this.captureError(
          {
            category: 'webhook',
            code: 'crm_outbound_stalled',
            severity: 'warning',
            userId: sub.userId,
            message: `CRM outbound subscription "${sub.name}" has not delivered a webhook in >24h (last: ${everSent.deliveredAt.toISOString()})`,
          },
          db,
        );
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

  /**
   * Clear any unresolved sf_inbound_stalled rows for a user once we've observed
   * recent healthy traffic. captureError only updates messages, never resolves,
   * so without this hook a transient stall would leave a permanent UI alert.
   */
  private async resolveInboundStalledFor(userId: string, db: Db = this.prisma): Promise<void> {
    try {
      await db.systemErrorLog.updateMany({
        where: { userId, code: 'sf_inbound_stalled', resolved: false },
        data: { resolved: true },
      });
    } catch {
      /* fire-and-forget — never break the health check loop */
    }
  }

  /** Group failed/5xx delivery rows by subscriptionId, look up userId, captureError once per user. */
  private async captureErrorsForDeliveries(
    opts: {
      rows: Array<{ subscriptionId: string; sample: string }>;
      code: string;
      messagePrefix: string;
    },
    db: Db = this.prisma,
  ): Promise<void> {
    const bySub = new Map<string, { count: number; sample: string }>();
    for (const r of opts.rows) {
      const cur = bySub.get(r.subscriptionId) ?? { count: 0, sample: r.sample };
      cur.count += 1;
      bySub.set(r.subscriptionId, cur);
    }
    const subIds = Array.from(bySub.keys());
    if (subIds.length === 0) return;
    const subs = await db.crmWebhookSubscription.findMany({
      where: { id: { in: subIds } },
      select: { id: true, userId: true, name: true },
    });
    for (const sub of subs) {
      const agg = bySub.get(sub.id);
      if (!agg) continue;
      await this.captureError(
        {
          category: 'webhook',
          code: opts.code,
          severity: 'error',
          userId: sub.userId,
          message: `${opts.messagePrefix} on subscription "${sub.name}" — ${agg.count} occurrence(s) in last 1h. Sample: ${agg.sample.slice(0, 200)}`,
        },
        db,
      );
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
  // Tenant-facing Email Notifications (via EmailService)
  // ==========================================

  /**
   * Send alert email for new issues (grouped per user).
   */
  private async sendAlertEmail(userId: string, issues: SystemHealthIssue[]): Promise<void> {
    if (!this.email) {
      this.logger.warn('[HealthCheck] EmailService not wired — skipping alert email');
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

    const sent = await this.email.send({
      to: user.email,
      subject,
      text: `Hi ${user.name || 'there'},\n\nThe following issues were detected:\n\n${issueLines}\n\nReview and fix: ${frontendUrl}/dashboard\n\n— LeadBridge`,
      html: `<p>Hi ${user.name || 'there'},</p><p>The following issues were detected:</p><ul>${issues.map(i => `<li><strong>${i.accountName}</strong> (${i.platform}) — ${i.message}</li>`).join('')}</ul><p><a href="${frontendUrl}/dashboard">Review and fix in Dashboard</a></p><p>— LeadBridge</p>`,
      fromName: 'LeadBridge Alerts',
      tag: 'monitoring/tenant-alert',
    });

    if (!sent) return;

    // Mark issues as notified — only when the send actually succeeded.
    for (const issue of issues) {
      await this.prisma.accountHealthStatus.updateMany({
        where: { accountId: issue.accountId, issueCode: issue.issueCode, isActive: true },
        data: { lastNotifiedAt: new Date(), notificationCount: { increment: 1 } },
      });
    }
  }

  /**
   * Send recovery email when an issue resolves.
   */
  private async sendRecoveryEmail(userId: string, resolved: { accountName: string; platform: string; issueCode: string }): Promise<void> {
    if (!this.email) return;

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
    if (!user?.email) return;

    await this.email.send({
      to: user.email,
      subject: `LeadBridge Resolved — ${resolved.accountName} is healthy`,
      text: `Hi ${user.name || 'there'},\n\nThe issue "${resolved.issueCode}" for ${resolved.accountName} (${resolved.platform}) has been resolved.\n\n— LeadBridge`,
      html: `<p>Hi ${user.name || 'there'},</p><p>The issue <strong>${resolved.issueCode}</strong> for <strong>${resolved.accountName}</strong> (${resolved.platform}) has been resolved.</p><p>— LeadBridge</p>`,
      fromName: 'LeadBridge Alerts',
      tag: 'monitoring/tenant-recovery',
    });
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
  // Cross-tenant dev alert + admin summary
  // ==========================================

  /**
   * Fire ONE aggregated SMS at end of a sweep when the sweep produced new
   * critical issues — across tenants. Per-tenant emails already went out to the
   * affected tenants; this is the dev's wake-up call. Dedup is on the inner
   * notifyDevSms (1h window per `kind`), so a sustained outage pages at most
   * once an hour even if the sweep keeps finding new rows.
   *
   * Pipeline-level criticals (the `pipelineCounts` numbers from
   * runPipelineHealthChecks) also drive a page when they're non-zero — those
   * don't show up in `newIssues` because they're written to SystemErrorLog
   * directly, not to AccountHealthStatus.
   */
  private async maybeSendCrossTenantDevAlert(
    newIssues: { userId: string; issue: SystemHealthIssue }[],
    pipelineCounts: {
      inboundErrors: number;
      outboundFailures: number;
      crm5xx: number;
      staleSubscriptions: number;
      stuckEnrollments: number;
    },
  ): Promise<void> {
    const newCritical = newIssues.filter(n => n.issue.status === 'critical');
    const pipelineCritical =
      pipelineCounts.inboundErrors +
      pipelineCounts.outboundFailures +
      pipelineCounts.crm5xx +
      pipelineCounts.stuckEnrollments;

    if (newCritical.length === 0 && pipelineCritical === 0) return;

    const tenantIds = new Set(newCritical.map(n => n.userId));
    const codeCounts: Record<string, number> = {};
    for (const n of newCritical) {
      codeCounts[n.issue.issueCode] = (codeCounts[n.issue.issueCode] ?? 0) + 1;
    }
    const topCodes = Object.entries(codeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([code, count]) => `${code}×${count}`)
      .join(', ');

    const pipelineBits: string[] = [];
    if (pipelineCounts.inboundErrors) pipelineBits.push(`sf_inbound×${pipelineCounts.inboundErrors}`);
    if (pipelineCounts.outboundFailures) pipelineBits.push(`crm_out_failed×${pipelineCounts.outboundFailures}`);
    if (pipelineCounts.crm5xx) pipelineBits.push(`crm_5xx×${pipelineCounts.crm5xx}`);
    if (pipelineCounts.stuckEnrollments) pipelineBits.push(`fu_stuck×${pipelineCounts.stuckEnrollments}`);

    const summary = [
      newCritical.length > 0
        ? `${newCritical.length} new critical issue${newCritical.length > 1 ? 's' : ''} across ${tenantIds.size} tenant${tenantIds.size > 1 ? 's' : ''} (${topCodes})`
        : null,
      pipelineBits.length > 0 ? `pipeline: ${pipelineBits.join(', ')}` : null,
      'See /admin/tenant-health',
    ]
      .filter(Boolean)
      .join('. ');

    await this.notifyDevSms({
      kind: 'health_sweep_critical',
      message: summary,
      context: {
        newCriticalCount: newCritical.length,
        tenantCount: tenantIds.size,
        codeCounts,
        pipelineCounts,
      },
    });
  }

  /**
   * Cross-tenant health summary for the admin /admin/tenant-health page.
   * Returns active issues across ALL tenants — admin-only consumer.
   *
   * Caller is responsible for admin guard. This method does NOT filter by
   * caller userId — that's the whole point.
   */
  async getCrossTenantHealthSummary(): Promise<{
    summary: {
      totalActive: number;
      critical: number;
      warning: number;
      tenantsAffected: number;
      lastCheckedAt: Date | null;
    };
    byCode: Array<{ issueCode: string; count: number; status: string }>;
    activeIssues: Array<{
      id: string;
      userId: string;
      userEmail: string | null;
      userName: string | null;
      accountId: string;
      accountName: string;
      platform: string;
      issueCode: string;
      issueMessage: string;
      status: string;
      firstDetectedAt: Date;
      lastDetectedAt: Date;
      notificationCount: number;
    }>;
    recentDevAlerts: Array<{
      id: string;
      code: string | null;
      message: string;
      emailedAt: Date | null;
      createdAt: Date;
    }>;
  }> {
    const activeRows = await this.prisma.accountHealthStatus.findMany({
      where: { isActive: true },
      include: {
        user: { select: { email: true, name: true } },
        savedAccount: { select: { businessName: true } },
      },
      orderBy: [{ status: 'asc' }, { lastDetectedAt: 'desc' }],
      take: 500,
    });

    const lastCheck = await this.prisma.accountHealthStatus.findFirst({
      orderBy: { lastCheckedAt: 'desc' },
      select: { lastCheckedAt: true },
    });

    const critical = activeRows.filter(r => r.status === 'critical').length;
    const warning = activeRows.filter(r => r.status === 'warning').length;
    const tenantsAffected = new Set(activeRows.map(r => r.userId)).size;

    const codeMap = new Map<string, { count: number; status: string }>();
    for (const r of activeRows) {
      const cur = codeMap.get(r.issueCode);
      if (cur) {
        cur.count += 1;
        if (r.status === 'critical') cur.status = 'critical';
      } else {
        codeMap.set(r.issueCode, { count: 1, status: r.status });
      }
    }
    const byCode = Array.from(codeMap.entries())
      .map(([issueCode, v]) => ({ issueCode, ...v }))
      .sort((a, b) => b.count - a.count);

    // Recent dev alerts — pull SystemErrorLog rows the dev SMS / email path
    // wrote, so operator can see what's been paged about recently. Both
    // category='other' code='dev_sms_*' and platform-level dev alerts qualify.
    const recentDevAlerts = await this.prisma.systemErrorLog.findMany({
      where: {
        category: 'other',
        emailedAt: { not: null },
      },
      orderBy: { emailedAt: 'desc' },
      take: 20,
      select: { id: true, code: true, message: true, emailedAt: true, createdAt: true },
    });

    return {
      summary: {
        totalActive: activeRows.length,
        critical,
        warning,
        tenantsAffected,
        lastCheckedAt: lastCheck?.lastCheckedAt ?? null,
      },
      byCode,
      activeIssues: activeRows.map(r => ({
        id: r.id,
        userId: r.userId,
        userEmail: (r as any).user?.email ?? null,
        userName: (r as any).user?.name ?? null,
        accountId: r.accountId,
        accountName: (r as any).savedAccount?.businessName ?? r.platform,
        platform: r.platform,
        issueCode: r.issueCode,
        issueMessage: r.issueMessage,
        status: r.status,
        firstDetectedAt: r.firstDetectedAt,
        lastDetectedAt: r.lastDetectedAt,
        notificationCount: r.notificationCount,
      })),
      recentDevAlerts,
    };
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
