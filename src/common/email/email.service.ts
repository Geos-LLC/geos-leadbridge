/**
 * EmailService — single SendGrid transport for the entire app.
 *
 * Before this existed, six different call sites (auth password reset via
 * EmailJS; auth new-tenant admin notification; monitoring dev alerts;
 * monitoring tenant health alerts; monitoring tenant recovery emails;
 * trial-notification expiry warnings) each rebuilt the same
 * `require('@sendgrid/mail'); setApiKey; send` plumbing with their own
 * env-var lookups. EmailJS lived only for password reset and added a
 * second SDK + key pair to maintain.
 *
 * Callers stay responsible for their own *routing* logic — recipient
 * resolution, dedup windows, fallback chains, template choice — because
 * those are domain concerns (paging dev on-call vs nudging a tenant vs
 * mailing ops about a signup all want different policy). This service
 * just turns "send this email" into one SendGrid call with sensible
 * defaults and consistent error handling.
 *
 * Returns `true` on success, `false` on no-op (no API key) or failure —
 * never throws — so callers can fire-and-forget without try/catch noise.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface SendEmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
  fromEmail?: string;
  fromName?: string;
  /** Optional tag for logs — caller domain (e.g. 'auth/password-reset', 'monitoring/dev-alert'). */
  tag?: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly configService: ConfigService) {}

  async send(opts: SendEmailOptions): Promise<boolean> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      this.logger.warn(`[Email${opts.tag ? `/${opts.tag}` : ''}] SENDGRID_API_KEY unset — skipping send to ${opts.to}`);
      return false;
    }

    const fromEmail = opts.fromEmail || this.getDefaultFromEmail();
    const fromName = opts.fromName || 'LeadBridge';

    try {
      // require() avoids forcing every consumer to depend on @sendgrid/mail's
      // type surface at compile time and matches the pattern the previous
      // call sites used. The SDK is small and lazy-load is acceptable here.
      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(apiKey);
      await sgMail.send({
        to: opts.to,
        from: { email: fromEmail, name: fromName },
        subject: opts.subject,
        text: opts.text,
        ...(opts.html ? { html: opts.html } : {}),
      });
      this.logger.log(`[Email${opts.tag ? `/${opts.tag}` : ''}] sent to ${opts.to}`);
      return true;
    } catch (err: any) {
      this.logger.error(`[Email${opts.tag ? `/${opts.tag}` : ''}] send failed to ${opts.to}: ${err?.message || err}`);
      return false;
    }
  }

  private getApiKey(): string | undefined {
    return this.configService.get<string>('SENDGRID_API_KEY') || process.env.SENDGRID_API_KEY;
  }

  private getDefaultFromEmail(): string {
    return (
      this.configService.get<string>('SENDGRID_FROM_EMAIL') ||
      process.env.SENDGRID_FROM_EMAIL ||
      'alerts@leadbridge360.com'
    );
  }
}
