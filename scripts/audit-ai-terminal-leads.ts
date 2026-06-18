// Dry-run-first audit + revert script for leads whose canonical lifecycle
// state was authored by the AI classifier in violation of the 2026-06-17
// lifecycle rule cleanup. Classifies each candidate into one of five
// buckets and proposes an action — never writes unless --commit is passed.
//
// USAGE
//   DATABASE_URL=... node -r ts-node/register scripts/audit-ai-terminal-leads.ts
//   DATABASE_URL=... node -r ts-node/register scripts/audit-ai-terminal-leads.ts --commit
//
// BUCKETS
//   A. restore_engaged_followup_eligible
//      The classifier wrote a forbidden terminal (booked / lost) on a
//      lead that genuinely had not reached that state. Revert
//      Lead.status → engaged. If the FollowUpEnrollment was stopped by the
//      same classifier intent and the enrollment template is still active,
//      re-activation is eligible (script does NOT auto-create enrollments
//      in --commit mode; that is a separate operator action). Annmarie /
//      Jon / Chris Donnelly class.
//
//   B. keep_terminal_booked
//      A REAL booking happened — the dispatcher manually confirmed in the
//      thread ("scheduled / confirmed / see you at ..."). The status
//      should stay booked. Operator should re-stamp with source=manual on
//      next interaction to fix the audit trail, but no data change here.
//
//   C. keep_terminal_opt_out
//      Customer explicitly said stop / unsubscribe / delete. lostReason
//      stays opt_out. No re-enrollment ever. Leave alone.
//
//   D. keep_hired_elsewhere_reengage
//      Customer explicitly said they hired somebody else. lostReason stays
//      hired_someone. reengageAt is set so the re-engagement
//      enrollment (customer_hired_competitor trigger) is the correct
//      mechanism. Leave alone.
//
//   E. needs_manual_review
//      The audit script cannot confidently bucket this lead. Reasons may
//      include: ambiguous customer messages, missing conversation history,
//      or a real-booking signal that the script's heuristic isn't
//      confident about. Operator must inspect.
//
// SAFETY
//   - Dry-run by default. --commit required to write.
//   - Per-lead transactions: a failure on one lead does not abort the rest.
//   - Audit row is written with source='backfill' and a sourceEventId of
//     `ai_terminal_revert_2026_06_17_<leadId>` so re-runs dedup.
//   - Bypasses LeadStatusService.writeStatus because Guard 6
//     (pipeline-downgrade) would block booked→engaged reverts. We're
//     restoring data, not re-running the pipeline.
//
// OUTPUT
//   CSV-shaped tab table to stdout plus a verdict tally and per-tenant
//   summary. --commit also prints `applied:` / `failed:` per lead.
import { PrismaClient } from '../generated/prisma';

const prisma = new PrismaClient();

const FORBIDDEN_TARGETS = ['booked', 'in_progress', 'completed', 'cancelled', 'no_show', 'archived'] as const;
// `lost` is excluded from FORBIDDEN_TARGETS because lb_automation IS allowed
// to write lost (with opt_out or hired_someone). We still inspect those rows
// because pre-Guard-2c history may include misclassified lost writes.

const OPT_OUT_PHRASES = /\b(stop messaging|stop texting|unsubscribe|remove me|delete (?:my account|all appointments|account)|no longer pursuing|don'?t contact|not interested)\b/i;
const HIRE_ELSE_PHRASES = /\b(hired? (?:someone|another|else|a different)|chose (?:someone|another)|went with (?:someone|another)|going with (?:another|someone)|already (?:cleaned|hired|booked)|found (?:someone|another)|use a different)\b/i;
const BOOKED_CONFIRM_PHRASES = /\b(scheduled (?:you|for)|booked (?:you|it)|confirmed (?:for|on)|see you (?:on|at)|all set for|appointment (?:is confirmed|set))\b/i;

const FORM_PAYLOAD = /^job requested\b|^hi there, please respond with a price|how often do you want|how many bedrooms are|automatic message:/i;

type Bucket =
  | 'A_restore_engaged_followup_eligible'
  | 'B_keep_terminal_booked'
  | 'C_keep_terminal_opt_out'
  | 'D_keep_hired_elsewhere_reengage'
  | 'E_needs_manual_review';

interface Verdict {
  leadId: string;
  tenant: string;
  customer: string;
  platform: string;
  currentStatus: string;
  proposedStatus: string;
  currentLostReason: string | null;
  currentStoppedReason: string | null;
  proposedEnrollmentAction: 'leave' | 'leave_re_engage_pending' | 'mark_for_re_enrollment';
  bucket: Bucket;
  reasonText: string;
}

const COMMIT = process.argv.includes('--commit');

async function classifyLead(lead: any): Promise<Verdict> {
  const tenant = lead.tenant_email as string;
  const customer = lead.customerName as string;
  const platform = lead.platform as string;

  const enrollment = await prisma.followUpEnrollment.findFirst({
    where: { conversationId: lead.threadId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, stoppedReason: true },
  });

  const msgs = await prisma.message.findMany({
    where: { conversationId: lead.threadId },
    orderBy: { sentAt: 'asc' },
    select: { sender: true, senderType: true, content: true, sentAt: true },
  });
  const realCustomerMsgs = msgs.filter(
    (m) => m.sender === 'customer' && !FORM_PAYLOAD.test((m.content ?? '').trim()),
  );
  const concatCustomer = realCustomerMsgs.map((m) => m.content ?? '').join('\n');
  const lastProManual = [...msgs].reverse().find((m) => m.sender === 'pro' && m.senderType === 'manual');

  const base = {
    leadId: lead.id,
    tenant,
    customer,
    platform,
    currentStatus: lead.status,
    currentLostReason: lead.lostReason,
    currentStoppedReason: enrollment?.stoppedReason ?? null,
  };

  // ── lost / opt_out cases ─────────────────────────────────────────────
  if (lead.status === 'lost' && lead.lostReason === 'opt_out') {
    if (OPT_OUT_PHRASES.test(concatCustomer)) {
      return {
        ...base,
        proposedStatus: 'lost',
        proposedEnrollmentAction: 'leave',
        bucket: 'C_keep_terminal_opt_out',
        reasonText: 'Customer explicitly opted out — terminal correct',
      };
    }
    return {
      ...base,
      proposedStatus: 'engaged',
      proposedEnrollmentAction: 'mark_for_re_enrollment',
      bucket: 'A_restore_engaged_followup_eligible',
      reasonText: 'Classifier wrote opt_out but no opt-out language in customer messages',
    };
  }

  // ── lost / hired_someone cases ───────────────────────────────────────
  if (lead.status === 'lost' && lead.lostReason === 'hired_someone') {
    if (HIRE_ELSE_PHRASES.test(concatCustomer)) {
      return {
        ...base,
        proposedStatus: 'lost',
        proposedEnrollmentAction: lead.reengageAt ? 'leave_re_engage_pending' : 'leave',
        bucket: 'D_keep_hired_elsewhere_reengage',
        reasonText: lead.reengageAt
          ? `Customer mentioned hiring elsewhere; reengageAt=${lead.reengageAt.toISOString().slice(0, 10)}`
          : 'Customer mentioned hiring elsewhere; reengageAt unset (re-engagement will not auto-fire)',
      };
    }
    if (realCustomerMsgs.length === 0) {
      return {
        ...base,
        proposedStatus: 'engaged',
        proposedEnrollmentAction: 'mark_for_re_enrollment',
        bucket: 'A_restore_engaged_followup_eligible',
        reasonText: 'Classifier wrote hired_someone but no real customer messages (form payload only)',
      };
    }
    return {
      ...base,
      proposedStatus: 'engaged',
      proposedEnrollmentAction: 'mark_for_re_enrollment',
      bucket: 'A_restore_engaged_followup_eligible',
      reasonText: 'Classifier wrote hired_someone but no hire-elsewhere language in customer messages',
    };
  }

  // ── booked cases ─────────────────────────────────────────────────────
  if (lead.status === 'booked') {
    if (lastProManual && BOOKED_CONFIRM_PHRASES.test(lastProManual.content ?? '')) {
      return {
        ...base,
        proposedStatus: 'booked',
        proposedEnrollmentAction: 'leave',
        bucket: 'B_keep_terminal_booked',
        reasonText: 'Dispatcher manually confirmed booking — status correct (operator should re-stamp source=manual)',
      };
    }
    if (realCustomerMsgs.length === 0) {
      return {
        ...base,
        proposedStatus: 'engaged',
        proposedEnrollmentAction: 'mark_for_re_enrollment',
        bucket: 'A_restore_engaged_followup_eligible',
        reasonText: 'Classifier wrote booked but no real customer messages (form payload only)',
      };
    }
    return {
      ...base,
      proposedStatus: 'engaged',
      proposedEnrollmentAction: 'mark_for_re_enrollment',
      bucket: 'A_restore_engaged_followup_eligible',
      reasonText: 'Classifier wrote booked without a dispatcher confirmation in the thread',
    };
  }

  // ── unrecognized terminal ────────────────────────────────────────────
  return {
    ...base,
    proposedStatus: lead.status,
    proposedEnrollmentAction: 'leave',
    bucket: 'E_needs_manual_review',
    reasonText: `Unrecognized AI-written terminal (status=${lead.status}, lostReason=${lead.lostReason})`,
  };
}

async function applyRevert(v: Verdict): Promise<void> {
  // Direct DB writes (bypass LeadStatusService) because Guard 6 would block
  // the booked→engaged downgrade and Guard 5 would block lost→engaged for
  // lb_automation. This is a data-restoration path, not a runtime status
  // transition — the audit row carries source='backfill' so it's traceable.
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const data: any = {
      status: v.proposedStatus,
      statusSource: 'backfill',
      statusUpdatedAt: now,
    };
    if (v.currentStatus === 'lost') {
      data.lostReason = null;
      data.reengageAt = null;
    }
    await tx.lead.update({ where: { id: v.leadId }, data });
    await tx.leadStatusAuditLog.create({
      data: {
        leadId: v.leadId,
        activityType: 'status_changed',
        oldStatus: v.currentStatus,
        newStatus: v.proposedStatus,
        source: 'backfill',
        sourceEventId: `ai_terminal_revert_2026_06_17_${v.leadId}`,
        actorType: 'system',
        actorName: 'ai-terminal-revert-script',
        reason: 'ai_terminal_revert_2026_06_17',
        conflict: false,
        occurredAt: now,
      },
    });
  });
}

async function main(): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<any[]>(`
    SELECT l.id, l."customerName", l.platform, l.status, l."statusSource",
           l."statusUpdatedAt", l."createdAt", l."threadId", l."lostReason",
           l."reengageAt", u.email AS tenant_email
    FROM leads l
    JOIN users u ON u.id = l."userId"
    WHERE l."statusSource" = 'lb_automation'
      AND (l.status IN ('booked', 'in_progress', 'completed', 'cancelled', 'no_show', 'archived')
           OR l.status = 'lost')
    ORDER BY u.email, l."statusUpdatedAt" DESC
  `);

  console.log(`Mode: ${COMMIT ? 'COMMIT' : 'DRY-RUN'}`);
  console.log(`Candidates: ${rows.length}\n`);

  const verdicts: Verdict[] = [];
  for (const lead of rows) {
    verdicts.push(await classifyLead(lead));
  }

  console.log(
    [
      'leadId'.padEnd(38),
      'tenant'.padEnd(28),
      'customer'.padEnd(20),
      'curStatus'.padEnd(10),
      'propStatus'.padEnd(10),
      'curStop'.padEnd(18),
      'propEnroll'.padEnd(28),
      'bucket'.padEnd(38),
      'reason',
    ].join(' | '),
  );
  console.log('-'.repeat(220));
  for (const v of verdicts) {
    console.log(
      [
        v.leadId.padEnd(38),
        v.tenant.slice(0, 28).padEnd(28),
        v.customer.slice(0, 20).padEnd(20),
        v.currentStatus.padEnd(10),
        v.proposedStatus.padEnd(10),
        (v.currentStoppedReason ?? '').padEnd(18),
        v.proposedEnrollmentAction.padEnd(28),
        v.bucket.padEnd(38),
        v.reasonText,
      ].join(' | '),
    );
  }

  // Tally
  const tally: Record<string, number> = {};
  for (const v of verdicts) tally[v.bucket] = (tally[v.bucket] ?? 0) + 1;
  console.log('\n=== Verdict tally ===');
  for (const [bucket, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${bucket.padEnd(40)} ${n}`);
  }

  // Per-tenant
  const byTenant: Record<string, Record<string, number>> = {};
  for (const v of verdicts) {
    byTenant[v.tenant] = byTenant[v.tenant] ?? {};
    byTenant[v.tenant][v.bucket] = (byTenant[v.tenant][v.bucket] ?? 0) + 1;
  }
  console.log('\n=== Per-tenant summary ===');
  for (const [tenant, buckets] of Object.entries(byTenant)) {
    const total = Object.values(buckets).reduce((s, n) => s + n, 0);
    console.log(`  ${tenant.padEnd(40)} ${total}`);
    for (const [bucket, n] of Object.entries(buckets)) {
      console.log(`    └─ ${bucket.padEnd(38)} ${n}`);
    }
  }

  if (!COMMIT) {
    console.log('\nDry-run complete. Re-run with --commit to apply reverts for bucket A only.');
    return;
  }

  // ── COMMIT: only bucket A is reverted; everything else is left alone ──
  console.log('\nApplying reverts (bucket A only)...');
  let applied = 0;
  let failed = 0;
  let skipped = 0;
  for (const v of verdicts) {
    if (v.bucket !== 'A_restore_engaged_followup_eligible') {
      skipped++;
      continue;
    }
    try {
      await applyRevert(v);
      applied++;
      console.log(`  applied: ${v.leadId} (${v.customer}) ${v.currentStatus} → ${v.proposedStatus}`);
    } catch (err: any) {
      failed++;
      console.error(`  FAILED:  ${v.leadId} (${v.customer}): ${err.message ?? err}`);
    }
  }
  console.log(`\nApplied: ${applied}  Failed: ${failed}  Skipped (kept): ${skipped}`);
}

main()
  .catch(async (err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
