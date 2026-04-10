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

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../common/utils/prisma.service';

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
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

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

      // Dedup: if an unresolved error with the same fingerprint exists, update instead of insert
      if (options.accountId) {
        const existing = await this.prisma.systemErrorLog.findFirst({
          where: {
            category: options.category,
            accountId: options.accountId,
            ...(options.platform && { platform: options.platform }),
            ...(options.code && { code: options.code }),
            resolved: false,
          },
          orderBy: { createdAt: 'desc' },
        });

        if (existing) {
          await this.prisma.systemErrorLog.update({
            where: { id: existing.id },
            data: { message: options.message },
          });
          this.logger.debug(`[Monitoring] Deduped error for ${options.category}/${options.accountId}/${options.code || '-'}`);
          return;
        }
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

  async getRecentErrors(options?: { limit?: number; onlyUnresolved?: boolean; category?: string }) {
    return this.prisma.systemErrorLog.findMany({
      where: {
        ...(options?.onlyUnresolved && { resolved: false }),
        ...(options?.category && { category: options.category }),
      },
      orderBy: { createdAt: 'desc' },
      take: options?.limit ?? 50,
    });
  }

  async resolveError(id: string): Promise<void> {
    await this.prisma.systemErrorLog.update({ where: { id }, data: { resolved: true } });
  }

  async resolveAllByCategory(category: string): Promise<number> {
    const result = await this.prisma.systemErrorLog.updateMany({ where: { category, resolved: false }, data: { resolved: true } });
    return result.count;
  }

  async getErrorSummary(): Promise<{ totalUnresolved: number; byCategory: Record<string, number>; last24h: number }> {
    const [errors, last24hCount] = await Promise.all([
      this.prisma.systemErrorLog.groupBy({ by: ['category'], where: { resolved: false }, _count: { id: true } }),
      this.prisma.systemErrorLog.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
    ]);
    const byCategory: Record<string, number> = {};
    let totalUnresolved = 0;
    for (const e of errors) { byCategory[e.category] = e._count.id; totalUnresolved += e._count.id; }
    return { totalUnresolved, byCategory, last24h: last24hCount };
  }

  /**
   * Deduplicate historical error logs — collapse duplicates, keep latest per fingerprint.
   */
  async deduplicateErrors(): Promise<number> {
    const groups = await this.prisma.systemErrorLog.groupBy({
      by: ['category', 'accountId'],
      where: { resolved: false, accountId: { not: null } },
      _count: { id: true },
      having: { id: { _count: { gt: 1 } } },
    });

    let deduped = 0;
    for (const group of groups) {
      if (!group.accountId) continue;
      const rows = await this.prisma.systemErrorLog.findMany({
        where: { category: group.category, accountId: group.accountId, resolved: false },
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
