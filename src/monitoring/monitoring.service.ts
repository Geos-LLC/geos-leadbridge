/**
 * Monitoring Service
 * Captures system errors, stores them in DB, and sends email alerts via EmailJS.
 * Rate-limited: max 1 email per category per 10 minutes to prevent inbox spam.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/utils/prisma.service';
import emailjs from '@emailjs/nodejs';

export interface CaptureErrorOptions {
  category: 'automation' | 'token_refresh' | 'webhook' | 'notification' | 'yelp' | 'other';
  severity?: 'error' | 'warning';
  message: string;
  userId?: string;
  accountId?: string;
  accountName?: string;
  context?: Record<string, any>;
}

const EMAIL_RATE_LIMIT_MS = 10 * 60 * 1000; // 10 minutes per category

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Capture an error: store in DB and send email alert (rate-limited).
   * Fire-and-forget safe — never throws.
   */
  async captureError(options: CaptureErrorOptions): Promise<void> {
    try {
      const severity = options.severity ?? 'error';

      const log = await this.prisma.systemErrorLog.create({
        data: {
          category: options.category,
          severity,
          message: options.message,
          userId: options.userId,
          accountId: options.accountId,
          accountName: options.accountName,
          context: options.context ? JSON.stringify(options.context) : null,
        },
      });

      this.logger.warn(`[${severity.toUpperCase()}] [${options.category}] ${options.message}${options.accountName ? ` (${options.accountName})` : ''}`);

      // Check rate limit: has an alert email already been sent for this category recently?
      const recentAlert = await this.prisma.systemErrorLog.findFirst({
        where: {
          category: options.category,
          emailedAt: { gte: new Date(Date.now() - EMAIL_RATE_LIMIT_MS) },
        },
        orderBy: { emailedAt: 'desc' },
      });

      if (!recentAlert) {
        await this.sendAlertEmail(log.id, options);
      }
    } catch (err: any) {
      // Never let monitoring break the app
      this.logger.error(`MonitoringService.captureError internal failure: ${err.message}`);
    }
  }

  private async sendAlertEmail(logId: string, options: CaptureErrorOptions): Promise<void> {
    const publicKey = process.env.EMAILJS_PUBLIC_KEY;
    const privateKey = process.env.EMAILJS_PRIVATE_KEY;
    const templateId = process.env.EMAILJS_ALERT_TEMPLATE_ID;
    const alertEmail = process.env.MONITORING_ALERT_EMAIL || 'info@geos-ai.com';

    if (!publicKey || !templateId) {
      this.logger.warn('Email alert skipped — EMAILJS_ALERT_TEMPLATE_ID or MONITORING_ALERT_EMAIL not configured');
      return;
    }

    try {
      const frontendUrl = this.configService.get<string>('frontendUrl') || 'https://www.leadbridge360.com';
      const contextStr = options.context ? JSON.stringify(options.context, null, 2) : 'none';

      await emailjs.send(
        'service_3krrjqe',
        templateId,
        {
          to_email: alertEmail,
          error_category: options.category,
          error_severity: options.severity ?? 'error',
          error_message: options.message,
          account_name: options.accountName ?? 'N/A',
          error_context: contextStr,
          error_time: new Date().toUTCString(),
          dashboard_url: `${frontendUrl}/admin`,
        },
        { publicKey, privateKey },
      );

      // Mark this log entry as the one that triggered the email
      await this.prisma.systemErrorLog.update({
        where: { id: logId },
        data: { emailedAt: new Date() },
      });

      this.logger.log(`Alert email sent for [${options.category}]: ${options.message}`);
    } catch (err: any) {
      this.logger.warn(`Failed to send alert email: ${err.message}`);
    }
  }

  /**
   * Get recent errors for the dashboard.
   */
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

  /**
   * Mark an error as resolved.
   */
  async resolveError(id: string): Promise<void> {
    await this.prisma.systemErrorLog.update({
      where: { id },
      data: { resolved: true },
    });
  }

  /**
   * Mark all errors in a category as resolved.
   */
  async resolveAllByCategory(category: string): Promise<number> {
    const result = await this.prisma.systemErrorLog.updateMany({
      where: { category, resolved: false },
      data: { resolved: true },
    });
    return result.count;
  }

  /**
   * Summary counts for dashboard header badge.
   */
  async getErrorSummary(): Promise<{ totalUnresolved: number; byCategory: Record<string, number>; last24h: number }> {
    const [errors, last24hCount] = await Promise.all([
      this.prisma.systemErrorLog.groupBy({
        by: ['category'],
        where: { resolved: false },
        _count: { id: true },
      }),
      this.prisma.systemErrorLog.count({
        where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      }),
    ]);

    const byCategory: Record<string, number> = {};
    let totalUnresolved = 0;
    for (const e of errors) {
      byCategory[e.category] = e._count.id;
      totalUnresolved += e._count.id;
    }

    return { totalUnresolved, byCategory, last24h: last24hCount };
  }
}
