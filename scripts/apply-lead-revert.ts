// Apply per-lead lifecycle reverts from an explicit approve-list file.
//
// USAGE
//   DATABASE_URL=... npx ts-node scripts/apply-lead-revert.ts \
//     --approve-list scripts/approve-lists/2026-06-18-a2-batch1.json
//
//   DATABASE_URL=... npx ts-node scripts/apply-lead-revert.ts \
//     --approve-list scripts/approve-lists/2026-06-18-a2-batch1.json --commit
//
// SAFETY MODEL
//   - Dry-run by default: prints the exact before/after for every lead, no writes.
//   - `--commit` is required to apply, AND `--approve-list <path>` must be passed
//     (no bucket-auto-commit; every lead must be named in the file).
//   - Each lead is applied in its own transaction. Failure on one does not
//     abort the rest.
//   - Audit row uses source='backfill' for restore_engaged_followup_eligible
//     (data restoration) and source='manual' for restore_booked (a dispatcher
//     manually confirmed the booking; manual is the truthful source).
//   - Bypasses LeadStatusService because Guard 6 (pipeline_downgrade) would
//     reject booked→engaged and Guard 5 would reject lost→engaged for
//     lb_automation. We're restoring data, not running a transition.
//
// ACTION TYPES (per scripts/approve-lists/*.json schema)
//   restore_engaged_followup_eligible
//     Lead.status     → engaged    statusSource → backfill
//     Lead.lostReason → null       Lead.reengageAt → null (if was lost)
//     ThreadContext   → conversationState='awaiting_customer', aiStatus='active'
//     Enrollment      → leave as-is (next pro/AI send re-enrolls via
//                       leads.service.ts:1180-1221)
//     Audit row       → source='backfill', reason='ai_terminal_revert_2026_06_17'
//
//   restore_booked
//     Lead.status     → booked     statusSource → manual
//     Lead.lostReason → null       Lead.reengageAt → null (if was lost)
//     ThreadContext   → conversationState='booked_in_lb', aiStatus='stopped_booked'
//     Enrollment      → leave as-is (already stopped+completed)
//     Audit row       → source='manual', reason='dispatcher_confirmed_booking'
//
//   keep_hired_elsewhere_reengage    No writes. Lead stays at lost+hired_someone.
//   keep_opt_out                     No writes. Lead stays at lost+opt_out.
//   manual_review_noop               No writes. Operator follow-up required.

import { PrismaClient } from '../generated/prisma';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();

const ALLOWED_ACTIONS = new Set([
  'restore_engaged_followup_eligible',
  'restore_booked',
  'keep_hired_elsewhere_reengage',
  'keep_opt_out',
  'manual_review_noop',
] as const);

type ActionType = typeof ALLOWED_ACTIONS extends Set<infer T> ? T : never;

interface ApprovalEntry {
  leadId: string;
  customer?: string;
  tenant?: string;
  action: ActionType;
  note?: string;
}

interface ApprovalFile {
  schemaVersion: number;
  approvedAt: string;
  approver: string;
  description: string;
  context?: Record<string, unknown>;
  entries: ApprovalEntry[];
}

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const approveListIdx = argv.indexOf('--approve-list');
const APPROVE_LIST_PATH = approveListIdx >= 0 ? argv[approveListIdx + 1] : null;

if (!APPROVE_LIST_PATH) {
  console.error('ERROR: --approve-list <path> is required.');
  console.error('Usage: npx ts-node scripts/apply-lead-revert.ts --approve-list <file.json> [--commit]');
  process.exit(2);
}

const resolved = path.isAbsolute(APPROVE_LIST_PATH) ? APPROVE_LIST_PATH : path.resolve(process.cwd(), APPROVE_LIST_PATH);
if (!fs.existsSync(resolved)) {
  console.error(`ERROR: approve-list file not found: ${resolved}`);
  process.exit(2);
}

const approval: ApprovalFile = JSON.parse(fs.readFileSync(resolved, 'utf8'));

// ── Validate file shape ─────────────────────────────────────────────────────
if (!Array.isArray(approval.entries) || approval.entries.length === 0) {
  console.error('ERROR: approve-list has no entries');
  process.exit(2);
}
const seen = new Set<string>();
for (const e of approval.entries) {
  if (!e.leadId || typeof e.leadId !== 'string') {
    console.error(`ERROR: entry has missing/invalid leadId: ${JSON.stringify(e)}`);
    process.exit(2);
  }
  if (seen.has(e.leadId)) {
    console.error(`ERROR: duplicate leadId in approve-list: ${e.leadId}`);
    process.exit(2);
  }
  seen.add(e.leadId);
  if (!ALLOWED_ACTIONS.has(e.action as ActionType)) {
    console.error(`ERROR: invalid action '${e.action}' for ${e.leadId}. Allowed: ${Array.from(ALLOWED_ACTIONS).join(', ')}`);
    process.exit(2);
  }
}

interface PlanState {
  leadUpdate: Record<string, any> | null;
  tcUpdate: Record<string, any> | null;
  enrollmentUpdate: Record<string, any> | null;
  auditCreate: Record<string, any> | null;
  noopReason: string | null;
}

function buildPlan(action: ActionType, leadId: string, currentLead: any, now: Date): PlanState {
  const baseAudit = (oldStatus: string, newStatus: string, source: string, reason: string, actorName: string) => ({
    leadId,
    activityType: 'status_changed',
    oldStatus,
    newStatus,
    source,
    sourceEventId: `ai_terminal_revert_2026_06_17_${leadId}`,
    actorType: 'system',
    actorName,
    reason,
    conflict: false,
    occurredAt: now,
  });

  switch (action) {
    case 'restore_engaged_followup_eligible': {
      const leadUpdate: Record<string, any> = {
        status: 'engaged',
        statusSource: 'backfill',
        statusUpdatedAt: now,
      };
      if (currentLead.status === 'lost') {
        leadUpdate.lostReason = null;
        leadUpdate.reengageAt = null;
      }
      return {
        leadUpdate,
        tcUpdate: {
          conversationState: 'awaiting_customer',
          conversationStateAt: now,
          conversationStateReason: 'ai_terminal_revert_2026_06_17',
          aiStatus: 'active',
          aiStatusAt: now,
          aiStatusReason: 'ai_terminal_revert_2026_06_17',
        },
        enrollmentUpdate: null,
        auditCreate: baseAudit(
          currentLead.status,
          'engaged',
          'backfill',
          'ai_terminal_revert_2026_06_17',
          'apply-lead-revert.ts',
        ),
        noopReason: null,
      };
    }

    case 'restore_booked': {
      const leadUpdate: Record<string, any> = {
        status: 'booked',
        statusSource: 'manual',
        statusUpdatedAt: now,
      };
      if (currentLead.status === 'lost') {
        leadUpdate.lostReason = null;
        leadUpdate.reengageAt = null;
      }
      return {
        leadUpdate,
        tcUpdate: {
          conversationState: 'booked_in_lb',
          conversationStateAt: now,
          conversationStateReason: 'ai_terminal_revert_2026_06_17_dispatcher_confirmed',
          aiStatus: 'stopped_booked',
          aiStatusAt: now,
          aiStatusReason: 'ai_terminal_revert_2026_06_17_dispatcher_confirmed',
        },
        enrollmentUpdate: null,
        auditCreate: baseAudit(
          currentLead.status,
          'booked',
          'manual',
          'dispatcher_confirmed_booking',
          'apply-lead-revert.ts',
        ),
        noopReason: null,
      };
    }

    case 'keep_hired_elsewhere_reengage':
      return {
        leadUpdate: null, tcUpdate: null, enrollmentUpdate: null, auditCreate: null,
        noopReason: 'Lead stays at lost+hired_someone; re-engagement should fire via reengageAt + customer_hired_competitor enrollment',
      };

    case 'keep_opt_out':
      return {
        leadUpdate: null, tcUpdate: null, enrollmentUpdate: null, auditCreate: null,
        noopReason: 'Lead stays at lost+opt_out; never re-engage',
      };

    case 'manual_review_noop':
      return {
        leadUpdate: null, tcUpdate: null, enrollmentUpdate: null, auditCreate: null,
        noopReason: 'Operator review required — left untouched',
      };
  }
}

function diffLine(label: string, before: any, after: any): string {
  const b = before === null ? 'null' : before === undefined ? '(unset)' : String(before);
  const a = after === null ? 'null' : after === undefined ? '(unset)' : String(after);
  if (b === a) return `      ${label.padEnd(28)} ${b}    (no change)`;
  return `      ${label.padEnd(28)} ${b}  →  ${a}`;
}

async function processEntry(entry: ApprovalEntry, idx: number, total: number) {
  console.log(`\n── ${idx + 1}/${total} ────────────────────────────────────────────────`);
  console.log(`  leadId:   ${entry.leadId}`);
  console.log(`  customer: ${entry.customer ?? '(unknown)'}`);
  console.log(`  tenant:   ${entry.tenant ?? '(unknown)'}`);
  console.log(`  action:   ${entry.action}`);
  if (entry.note) console.log(`  note:     ${entry.note}`);

  const lead = await prisma.lead.findUnique({ where: { id: entry.leadId } });
  if (!lead) {
    console.log(`  ⚠ Lead not found in DB — skipping`);
    return { status: 'missing' as const };
  }

  const tc = await prisma.threadContext.findFirst({ where: { conversationId: lead.threadId ?? '' } });
  const enr = await prisma.followUpEnrollment.findFirst({
    where: { conversationId: lead.threadId ?? '' },
    orderBy: { createdAt: 'desc' },
  });

  const now = new Date();
  const plan = buildPlan(entry.action, entry.leadId, lead, now);

  console.log(`\n  Current state:`);
  console.log(`      Lead.status                   ${lead.status}`);
  console.log(`      Lead.statusSource             ${lead.statusSource}`);
  console.log(`      Lead.lostReason               ${lead.lostReason ?? 'null'}`);
  console.log(`      Lead.reengageAt               ${lead.reengageAt ? lead.reengageAt.toISOString().slice(0, 10) : 'null'}`);
  console.log(`      ThreadContext.conversationState  ${tc?.conversationState ?? '(no TC row)'}`);
  console.log(`      ThreadContext.aiStatus           ${tc?.aiStatus ?? '(no TC row)'}`);
  console.log(`      ThreadContext.followUpStatus     ${tc?.followUpStatus ?? '(no TC row)'}`);
  console.log(`      FollowUpEnrollment.status        ${enr?.status ?? '(no enrollment)'}  stoppedReason=${enr?.stoppedReason ?? 'null'}`);

  if (plan.noopReason) {
    console.log(`\n  Proposed: NO-OP`);
    console.log(`      ${plan.noopReason}`);
    return { status: 'noop' as const };
  }

  console.log(`\n  Proposed diff:`);
  if (plan.leadUpdate) {
    for (const [k, v] of Object.entries(plan.leadUpdate)) {
      diffLineLog(`Lead.${k}`, (lead as any)[k], v);
    }
  }
  if (plan.tcUpdate && tc) {
    for (const [k, v] of Object.entries(plan.tcUpdate)) {
      diffLineLog(`ThreadContext.${k}`, (tc as any)[k], v);
    }
  } else if (plan.tcUpdate && !tc) {
    console.log(`      (no ThreadContext row; skipping TC update — Lead-only revert)`);
  }
  if (plan.auditCreate) {
    console.log(`      + audit row: source=${plan.auditCreate.source}  oldStatus=${plan.auditCreate.oldStatus}  newStatus=${plan.auditCreate.newStatus}  sourceEventId=${plan.auditCreate.sourceEventId}`);
  }

  if (!COMMIT) {
    return { status: 'dry_run' as const };
  }

  // Apply
  try {
    await prisma.$transaction(async (tx) => {
      if (plan.leadUpdate) {
        await tx.lead.update({ where: { id: entry.leadId }, data: plan.leadUpdate });
      }
      if (plan.tcUpdate && tc) {
        await tx.threadContext.update({ where: { id: tc.id }, data: plan.tcUpdate });
      }
      if (plan.enrollmentUpdate && enr) {
        await tx.followUpEnrollment.update({ where: { id: enr.id }, data: plan.enrollmentUpdate });
      }
      if (plan.auditCreate) {
        // Dedup: if a prior revert audit row exists with the same sourceEventId,
        // skip the audit insert (lead update already idempotent on re-run).
        const existing = await tx.leadStatusAuditLog.findFirst({
          where: { leadId: entry.leadId, sourceEventId: plan.auditCreate.sourceEventId },
        });
        if (!existing) {
          await tx.leadStatusAuditLog.create({ data: plan.auditCreate as any });
        }
      }
    });
    console.log(`  ✓ Applied`);
    return { status: 'applied' as const };
  } catch (err: any) {
    console.error(`  ✗ FAILED: ${err.message ?? err}`);
    return { status: 'failed' as const };
  }
}

function diffLineLog(label: string, before: any, after: any) {
  const fmt = (v: any) => v === null ? 'null' : v === undefined ? '(unset)' : v instanceof Date ? v.toISOString().slice(0, 16) : String(v);
  const b = fmt(before);
  const a = fmt(after);
  if (b === a) {
    console.log(`      ${label.padEnd(36)} ${b}    (no change)`);
  } else {
    console.log(`      ${label.padEnd(36)} ${b}  →  ${a}`);
  }
}

async function main(): Promise<void> {
  console.log(`Mode: ${COMMIT ? 'COMMIT' : 'DRY-RUN'}`);
  console.log(`Approve list: ${resolved}`);
  console.log(`  Approver:    ${approval.approver}`);
  console.log(`  ApprovedAt:  ${approval.approvedAt}`);
  console.log(`  Description: ${approval.description}`);
  console.log(`  Entries:     ${approval.entries.length}`);

  const counts: Record<string, number> = {
    applied: 0,
    failed: 0,
    noop: 0,
    missing: 0,
    dry_run: 0,
  };

  for (let i = 0; i < approval.entries.length; i++) {
    const result = await processEntry(approval.entries[i], i, approval.entries.length);
    counts[result.status]++;
  }

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`Summary:`);
  for (const [k, v] of Object.entries(counts)) {
    if (v > 0) console.log(`  ${k.padEnd(12)} ${v}`);
  }
  if (!COMMIT) {
    console.log(`\nDry-run complete. Re-run with --commit to apply.`);
  }
}

main()
  .catch(async (err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
