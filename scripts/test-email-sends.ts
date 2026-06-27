/**
 * Live end-to-end smoke test for every email path that flows through
 * EmailService. Fires real SendGrid sends — don't run against prod unless
 * you actually want the listed recipients to receive mail.
 *
 * Usage:
 *
 *   # Set env locally (matches Railway prod var names)
 *   export SENDGRID_API_KEY=SG.xxxxx
 *   export SENDGRID_FROM_EMAIL=alerts@leadbridge360.com   # optional
 *
 *   # Send a test of every path to one mailbox (default: your dev address)
 *   npx ts-node scripts/test-email-sends.ts                 # uses default recipient
 *   npx ts-node scripts/test-email-sends.ts you@example.com # override recipient
 *   npx ts-node scripts/test-email-sends.ts you@example.com password-reset
 *
 * Paths exercised (each maps to one production call site):
 *   - password-reset    → AuthService.sendPasswordResetEmail
 *   - new-tenant-admin  → AuthService.sendNewTenantAdminEmail (ops mailbox)
 *   - dev-alert         → MonitoringService.notifyDevAlert (ops dedup, this
 *                         test BYPASSES the dedup row by calling the
 *                         underlying transport directly)
 *   - tenant-alert      → MonitoringService.sendAlertEmail
 *   - tenant-recovery   → MonitoringService.sendRecoveryEmail
 *   - trial-expiry      → TrialNotificationService.sendEmail
 *
 * Each path runs the same EmailService.send() with the same body the
 * production code emits, so a successful send here proves the live
 * pipeline (env → SendGrid → mailbox) works for that template.
 *
 * Exit codes: 0 if every requested path returned ok; 1 if any failed.
 */

import { ConfigService } from '@nestjs/config';
import { EmailService } from '../src/common/email/email.service';

type PathKey = 'password-reset' | 'new-tenant-admin' | 'dev-alert' | 'tenant-alert' | 'tenant-recovery' | 'trial-expiry';

const ALL_PATHS: PathKey[] = [
  'password-reset',
  'new-tenant-admin',
  'dev-alert',
  'tenant-alert',
  'tenant-recovery',
  'trial-expiry',
];

interface PathBody {
  subject: string;
  text: string;
  html: string;
  fromName: string;
  tag: string;
}

function buildBody(path: PathKey, recipient: string): PathBody {
  const stamp = new Date().toISOString();
  const fakeResetUrl = `https://www.leadbridge360.com/reset-password?token=SMOKE_${stamp.replace(/[:.]/g, '-')}`;
  const fakePricingUrl = `https://www.leadbridge360.com/pricing`;

  switch (path) {
    case 'password-reset':
      return {
        subject: `[smoke ${stamp}] Reset your LeadBridge password`,
        text:
          `Hi there,\n\n` +
          `We received a request to reset your LeadBridge password. Open the link below to choose a new one. This link expires in 1 hour.\n\n` +
          `${fakeResetUrl}\n\n` +
          `(SMOKE TEST — not a real password reset.)\n\n— LeadBridge`,
        html:
          `<p>Hi there,</p>` +
          `<p>We received a request to reset your LeadBridge password. Use the button below to choose a new one. This link expires in 1&nbsp;hour.</p>` +
          `<p><a href="${fakeResetUrl}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600">Reset password</a></p>` +
          `<p style="color:#94a3b8;font-size:12px">SMOKE TEST — not a real password reset.</p>`,
        fromName: 'LeadBridge',
        tag: 'smoke/password-reset',
      };

    case 'new-tenant-admin':
      return {
        subject: `[smoke ${stamp}] LeadBridge — new signup: Smoke Test <smoke@example.com>`,
        text:
          `New tenant just signed up (SMOKE TEST).\n\n` +
          `Name:    Smoke Test\n` +
          `Email:   smoke@example.com\n` +
          `Phone:   +15551234567\n` +
          `User ID: smoke-${stamp}\n` +
          `When:    ${stamp}\n`,
        html:
          `<p>New tenant just signed up (SMOKE TEST).</p>` +
          `<ul>` +
          `<li><strong>Name:</strong> Smoke Test</li>` +
          `<li><strong>Email:</strong> smoke@example.com</li>` +
          `<li><strong>Phone:</strong> +15551234567</li>` +
          `</ul>` +
          `<p style="color:#94a3b8;font-size:12px">SMOKE TEST</p>`,
        fromName: 'LeadBridge Ops',
        tag: 'smoke/new-tenant-admin',
      };

    case 'dev-alert':
      return {
        subject: `[smoke ${stamp}] LeadBridge dev alert (smoke_test)`,
        text:
          `Kind: smoke_test\n` +
          `When: ${stamp}\n\n` +
          `This is the dev-alert body shape used by MonitoringService.notifyDevAlert. ` +
          `Production sends would be deduped via SystemErrorLog — this smoke test bypasses dedup.`,
        html: '', // notifyDevAlert sends text-only
        fromName: 'LeadBridge Dev Alerts',
        tag: 'smoke/dev-alert',
      };

    case 'tenant-alert':
      return {
        subject: `[smoke ${stamp}] LeadBridge Alert — Smoke Account`,
        text:
          `Hi there,\n\n` +
          `The following issues were detected:\n\n` +
          `• Smoke Account (thumbtack) — Token expired\n\n` +
          `Review and fix: https://www.leadbridge360.com/dashboard\n\n` +
          `(SMOKE TEST.)\n— LeadBridge`,
        html:
          `<p>Hi there,</p>` +
          `<p>The following issues were detected:</p>` +
          `<ul><li><strong>Smoke Account</strong> (thumbtack) — Token expired</li></ul>` +
          `<p><a href="https://www.leadbridge360.com/dashboard">Review and fix in Dashboard</a></p>` +
          `<p style="color:#94a3b8;font-size:12px">SMOKE TEST</p>`,
        fromName: 'LeadBridge Alerts',
        tag: 'smoke/tenant-alert',
      };

    case 'tenant-recovery':
      return {
        subject: `[smoke ${stamp}] LeadBridge Resolved — Smoke Account is healthy`,
        text:
          `Hi there,\n\n` +
          `The issue "token_expired" for Smoke Account (thumbtack) has been resolved.\n\n` +
          `(SMOKE TEST.)\n— LeadBridge`,
        html:
          `<p>Hi there,</p>` +
          `<p>The issue <strong>token_expired</strong> for <strong>Smoke Account</strong> (thumbtack) has been resolved.</p>` +
          `<p style="color:#94a3b8;font-size:12px">SMOKE TEST</p>`,
        fromName: 'LeadBridge Alerts',
        tag: 'smoke/tenant-recovery',
      };

    case 'trial-expiry':
      return {
        subject: `[smoke ${stamp}] Your LeadBridge trial has ended — keep responding to leads`,
        text:
          `Hi there,\n\n` +
          `Your free trial has ended.\n\n` +
          `Upgrade now to keep instant replies, follow-ups, and AI conversations running:\n${fakePricingUrl}\n\n` +
          `(SMOKE TEST.)\n— LeadBridge`,
        html:
          `<p>Hi there,</p>` +
          `<p><strong>Your free trial has ended.</strong></p>` +
          `<p>Upgrade now to keep instant replies, follow-ups, and AI conversations running.</p>` +
          `<p><a href="${fakePricingUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Pick a plan</a></p>` +
          `<p style="color:#94a3b8;font-size:12px">SMOKE TEST</p>`,
        fromName: 'LeadBridge',
        tag: 'smoke/trial-expiry',
      };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const recipient = args[0] || process.env.SMOKE_TEST_RECIPIENT || 'alerts@leadbridge360.com';
  const requestedPath = args[1] as PathKey | undefined;

  if (!process.env.SENDGRID_API_KEY) {
    console.error('SENDGRID_API_KEY is required. Set it before running this script.');
    process.exit(2);
  }

  const paths: PathKey[] = requestedPath ? [requestedPath] : ALL_PATHS;

  // Hand-rolled ConfigService stub — this script doesn't bootstrap NestJS.
  const config = new ConfigService();
  const email = new EmailService(config);

  console.log(`\nSmoke-testing ${paths.length} email path(s) to ${recipient}\n`);

  let failed = 0;
  for (const path of paths) {
    const body = buildBody(path, recipient);
    process.stdout.write(`  ${path.padEnd(20)} `);
    const ok = await email.send({
      to: recipient,
      subject: body.subject,
      text: body.text,
      html: body.html || undefined,
      fromName: body.fromName,
      tag: body.tag,
    });
    if (ok) {
      console.log('OK');
    } else {
      console.log('FAILED');
      failed++;
    }
  }

  console.log(
    failed === 0
      ? `\nAll ${paths.length} send(s) returned ok. Check ${recipient} inbox/spam.\n`
      : `\n${failed} of ${paths.length} send(s) failed — see EmailService logs above.\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
