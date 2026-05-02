import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../common/utils/prisma.service';
import { withCronLock } from '../common/utils/cron-lock';
import { NotificationsService } from '../notifications/notifications.service';
import { TrialService, TRIAL_ENDED_EVENT } from './trial.service';
import { TrialType } from '../../generated/prisma';

@Injectable()
export class TrialNotificationService {
  private readonly logger = new Logger(TrialNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trialService: TrialService,
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => NotificationsService))
    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Listener: TrialService emits `trial.ended` the first time a trial flips
   * to ended (either from consumeLead exhausting leads, or sweepExpiredTrials
   * for time-based). This is the instant-trigger path for usage expiry.
   */
  @OnEvent(TRIAL_ENDED_EVENT)
  async handleTrialEnded(payload: { userId: string }): Promise<void> {
    try {
      await this.notify(payload.userId);
    } catch (err: any) {
      this.logger.error(`[handleTrialEnded] notify ${payload.userId} failed: ${err.message}`);
    }
  }

  /**
   * Notify a single user that their trial has ended. Idempotent — only the
   * first call per user actually sends; subsequent calls no-op.
   */
  async notify(userId: string): Promise<void> {
    // Atomic claim — only the caller that flips trialEndNotifiedAt sends.
    const claimed = await this.prisma.user.updateMany({
      where: { id: userId, trialEndNotifiedAt: null },
      data: { trialEndNotifiedAt: new Date() },
    });
    if (claimed.count === 0) {
      this.logger.log(`[notify] Skipped ${userId} — already notified`);
      return;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        name: true,
        businessPhone: true,
        trialType: true,
        trialLeadsHandled: true,
        trialLeadsLimit: true,
      },
    });
    if (!user) return;

    const reason = this.formatReason(user.trialType, user.trialLeadsHandled, user.trialLeadsLimit);
    const frontendUrl =
      this.configService.get<string>('frontendUrl') || 'https://www.leadbridge360.com';
    const pricingUrl = `${frontendUrl}/pricing`;

    const emailRes = await this.sendEmail(user.email, user.name, reason, pricingUrl);
    const smsRes = await this.notificationsService.sendSystemSmsToUser(
      userId,
      `LeadBridge: ${reason}. Pick a plan to keep responding to leads → ${pricingUrl}`,
    );

    this.logger.log(
      `[notify] user=${userId} reason="${reason}" email=${emailRes.ok ? 'ok' : 'skipped:' + emailRes.error} sms=${smsRes.success ? 'ok' : 'skipped:' + smsRes.error}`,
    );
  }

  /**
   * Cron sweeper — every 5 minutes finds users whose trial has ended (by time
   * or otherwise) and that haven't been notified yet. Catches time-based
   * expiries; usage-based expiries are notified inline via TrialService.consumeLead.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweepExpiredTrials(): Promise<void> {
    // Lock 7004 = trial-notification sweeper. Sweep loops over candidates
    // calling markEnded + notify (which sends email + SMS), so allow up to
    // 5 min for a worst-case backlog.
    await withCronLock(
      this.prisma,
      this.logger,
      7004,
      'TrialSweep',
      async tx => {
        // Candidates: non-paid users with a trialType that haven't been
        // notified. We then evaluate each via buildTrialView to decide if
        // truly ended.
        const candidates = await tx.user.findMany({
          where: {
            subscriptionTier: null,
            trialType: { not: null },
            trialEndNotifiedAt: null,
          },
          select: {
            id: true,
            subscriptionTier: true,
            trialType: true,
            trialEndDate: true,
            trialEndedAt: true,
            trialLeadsHandled: true,
            trialLeadsLimit: true,
          },
        });

        let notified = 0;
        for (const c of candidates) {
          const view = this.trialService.buildTrialView(c);
          if (!view.isEnded) continue;

          // markEnded + notify go through this.trialService / this.notify,
          // which use the standalone PrismaService (not tx). That's intentional
          // — those writes don't need to be atomic with the lock; the lock is
          // only here to prevent staging+production from both running the sweep.
          await this.trialService.markEnded(c.id);
          await this.notify(c.id);
          notified++;
        }

        if (notified > 0) {
          this.logger.log(`[sweep] Notified ${notified} expired trial(s) of ${candidates.length} candidate(s)`);
        }
      },
      { timeoutMs: 300_000 },
    );
  }

  private formatReason(
    trialType: TrialType | null,
    leadsHandled: number,
    leadsLimit: number,
  ): string {
    if (trialType === TrialType.TIME_BASED) return 'Your free trial has ended';
    if (trialType === TrialType.LEAD_BASED) return `You've used all ${leadsLimit} trial leads`;
    if (trialType === TrialType.HYBRID) return `Trial ended (${leadsHandled}/${leadsLimit} leads used)`;
    return 'Your free trial has ended';
  }

  private async sendEmail(
    to: string,
    name: string | null,
    reason: string,
    pricingUrl: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const apiKey =
      this.configService.get<string>('SENDGRID_API_KEY') || process.env.SENDGRID_API_KEY;
    const fromEmail =
      this.configService.get<string>('SENDGRID_FROM_EMAIL') ||
      process.env.SENDGRID_FROM_EMAIL ||
      'alerts@leadbridge360.com';

    if (!apiKey) return { ok: false, error: 'no_sendgrid_key' };
    if (!to) return { ok: false, error: 'no_email' };

    const greeting = name ? `Hi ${name},` : 'Hi there,';
    const subject = `Your LeadBridge trial has ended — keep responding to leads`;

    try {
      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(apiKey);
      await sgMail.send({
        to,
        from: { email: fromEmail, name: 'LeadBridge' },
        subject,
        text: `${greeting}\n\n${reason}.\n\nUpgrade now to keep instant replies, follow-ups, and AI conversations running:\n${pricingUrl}\n\n— LeadBridge`,
        html: `<p>${greeting}</p><p><strong>${reason}.</strong></p><p>Upgrade now to keep instant replies, follow-ups, and AI conversations running.</p><p><a href="${pricingUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Pick a plan</a></p><p style="color:#64748b;font-size:14px">Or copy this link: <a href="${pricingUrl}">${pricingUrl}</a></p><p>— LeadBridge</p>`,
      });
      return { ok: true };
    } catch (err: any) {
      this.logger.error(`[sendEmail] Failed for ${to}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }
}
