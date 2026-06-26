/**
 * One-shot: enroll leads that flipped to status=lost with lostReason=hired_someone
 * but never got a `customer_hired_competitor` FollowUpEnrollment because of the
 * automation.service.ts placement bug.
 *
 * Bug (fixed in same commit):
 *   The hired-competitor enrollment lived inside the AI Conversation block in
 *   handleCustomerReply, after the `fuReEnrollDelay` pause guard and after
 *   the AI Conversation availability gates. Any of these silently suppressed
 *   the enrollment even when `aiHiredCompetitorReengage=true`:
 *     - a manual pro reply within the pause window (Spotless Homes Tampa /
 *       Kala Ronshausen 2026-06-26 — the canonical case)
 *     - aiConversationMode='when_dispatcher_unavailable' during business hours
 *     - aiConversationEnabled=false at the user level
 *   Status correctly flipped to lost (separate code path), but no enrollment
 *   was scheduled.
 *
 * Scope: every SavedAccount where followUpSettingsJson has
 *   "aiHiredCompetitorReengage":true. Leads outside this set never expected
 *   re-engagement and are untouched.
 *
 * Schedule: nextStepDueAt = max(now + 30min + jitter, lostAt + accountDelay).
 *   Leads lost MORE than `accountDelay` days ago are skipped — their window
 *   has already passed and sending a "How did your cleaning service work
 *   out?" message N days late reads as random.
 *
 * Filters mirror the live enroll path:
 *   - SF-linked customers (sfJobId / sfCustomerId / syncStatus='linked') skipped
 *   - Conversations that already have an active enrollment skipped (partial
 *     unique index on (conversation_id) WHERE status='active' is the hard
 *     guarantee; the pre-check just avoids a noisy ON CONFLICT)
 *
 * Usage:
 *   npx ts-node scripts/backfill-hired-competitor-enrollments.ts            # dry-run
 *   npx ts-node scripts/backfill-hired-competitor-enrollments.ts --apply    # writes
 *   npx ts-node scripts/backfill-hired-competitor-enrollments.ts --account=<id>  # one account
 */

import { PrismaClient } from '../generated/prisma';
import { parseDuration } from '../src/common/utils/parse-duration';
import { ensureCustomerReplyPresets } from '../src/follow-up-engine/follow-up-seed';

const APPLY = process.argv.includes('--apply');
const ACCOUNT_FILTER = process.argv.find(a => a.startsWith('--account='))?.split('=')[1];

const prisma = new PrismaClient();

// Defaults match the seed: 3 weeks delay, auto_send mode.
const DEFAULT_HIRED_DELAY = '3 weeks';
const SCHEDULE_FLOOR_MIN = 30;
const SCHEDULE_JITTER_MAX_MIN = 30;

type AccountRow = {
  id: string;
  userId: string;
  platform: string;
  businessId: string;
  businessName: string | null;
  followUpSettingsJson: string | null;
  followUpActiveHoursStart: string | null;
  followUpActiveHoursEnd: string | null;
  followUpTimezone: string | null;
};

async function getReEngageAccounts(): Promise<AccountRow[]> {
  const all = await prisma.savedAccount.findMany({
    where: ACCOUNT_FILTER ? { id: ACCOUNT_FILTER } : {},
    select: {
      id: true,
      userId: true,
      platform: true,
      businessId: true,
      businessName: true,
      followUpSettingsJson: true,
      followUpActiveHoursStart: true,
      followUpActiveHoursEnd: true,
      followUpTimezone: true,
    },
  });
  return all.filter(a => {
    if (!a.followUpSettingsJson) return false;
    try {
      const s = JSON.parse(a.followUpSettingsJson);
      return s.aiHiredCompetitorReengage === true;
    } catch {
      return false;
    }
  });
}

function parseHiredDelayMinutes(json: string | null): number {
  if (!json) return parseDuration(DEFAULT_HIRED_DELAY, 21 * 24 * 60);
  try {
    const s = JSON.parse(json);
    return parseDuration(s.aiHiredCompetitorDelay || DEFAULT_HIRED_DELAY, 21 * 24 * 60);
  } catch {
    return parseDuration(DEFAULT_HIRED_DELAY, 21 * 24 * 60);
  }
}

type Candidate = {
  leadId: string;
  threadId: string;
  customerName: string | null;
  lostAt: Date;
  nextStepDueAt: Date;
};

async function findCandidates(account: AccountRow, delayMin: number): Promise<Candidate[]> {
  const cutoff = new Date(Date.now() - delayMin * 60_000);

  // 1) All leads for this account in the lost+hired_someone state with a thread.
  //    SF-link skip + active-enrollment skip happens in the next pass so the
  //    counts in the dry-run output reflect each filter's effect.
  const rawLeads = await prisma.lead.findMany({
    where: {
      userId: account.userId,
      businessId: account.businessId,
      platform: account.platform,
      status: 'lost',
      lostReason: 'hired_someone',
      threadId: { not: null },
    },
    select: {
      id: true,
      threadId: true,
      customerName: true,
      sfJobId: true,
      sfCustomerId: true,
      syncStatus: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' },
  });

  const candidates: Candidate[] = [];
  for (const lead of rawLeads) {
    if (lead.sfJobId || lead.sfCustomerId || lead.syncStatus === 'linked') continue;
    if (!lead.threadId) continue;

    // 2) lostAt — REQUIRED to come from an lb_automation classifier write.
    //    This is the precise blast-radius limiter: the bug being backfilled
    //    only suppressed enrollment on the classifier path; platform-sync
    //    closures (Yelp "Not hired" / "Closed" sweeps) never enrolled even
    //    pre-bug, and most pre-2026-06-20 Yelp lost+hired_someone rows are
    //    actually stale platform sweeps masquerading as customer signals
    //    (see yelp-status-map.ts comment block). Filtering on
    //    source='lb_automation' restricts the backfill to leads where a
    //    customer message classified as hired_elsewhere actually fired
    //    AND the enrollment would have been written but for the pause /
    //    AI Conversation gate. Without this filter the dry-run on
    //    2026-06-26 surfaced 71 Yelp leads in a 2-hour cluster — exactly
    //    the pre-fix Yelp-platform-sweep population.
    const auditRow = await prisma.leadStatusAuditLog.findFirst({
      where: {
        leadId: lead.id,
        newStatus: 'lost',
        reason: 'hired_someone',
        source: 'lb_automation',
      },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    });
    if (!auditRow) continue; // no classifier write → not our bug → skip
    const lostAt = auditRow.occurredAt;

    // 3) Window — skip leads lost more than `delay` ago; their re-engage
    //    window has passed.
    if (lostAt < cutoff) continue;

    // 4) Skip if there's already an active enrollment on the conversation
    //    (regardless of trigger state — the partial unique index forbids
    //    multiple active rows per conversation, so we'd just hit a 23505).
    const existing = await prisma.followUpEnrollment.findFirst({
      where: { conversationId: lead.threadId, status: 'active' },
      select: { id: true, sequenceTemplate: { select: { triggerState: true } } },
    });
    if (existing) continue;

    // 5) Compute nextStepDueAt: max(now + floor + jitter, lostAt + delay)
    const jitterMin = Math.floor(Math.random() * SCHEDULE_JITTER_MAX_MIN);
    const minDue = new Date(Date.now() + (SCHEDULE_FLOOR_MIN + jitterMin) * 60_000);
    const targetDue = new Date(lostAt.getTime() + delayMin * 60_000);
    const nextStepDueAt = targetDue > minDue ? targetDue : minDue;

    candidates.push({
      leadId: lead.id,
      threadId: lead.threadId,
      customerName: lead.customerName,
      lostAt,
      nextStepDueAt,
    });
  }
  return candidates;
}

async function ensureTemplate(account: AccountRow): Promise<{ id: string } | null> {
  await ensureCustomerReplyPresets(
    prisma as any,
    account.userId,
    account.platform,
    account.id,
    account.followUpActiveHoursStart || '09:00',
    account.followUpActiveHoursEnd || '21:00',
    account.followUpTimezone || 'America/New_York',
  );
  const tmpl = await prisma.followUpSequenceTemplate.findFirst({
    where: {
      savedAccountId: account.id,
      platform: account.platform,
      triggerState: 'customer_hired_competitor',
      enabled: true,
    },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    select: { id: true },
  });
  return tmpl;
}

async function enroll(
  account: AccountRow,
  templateId: string,
  candidate: Candidate,
): Promise<'created' | 'duplicate_race' | 'error'> {
  try {
    await prisma.followUpEnrollment.create({
      data: {
        sequenceTemplateId: templateId,
        conversationId: candidate.threadId,
        leadId: candidate.leadId,
        platform: account.platform,
        status: 'active',
        currentStepIndex: 0,
        nextStepDueAt: candidate.nextStepDueAt,
        mode: 'auto_send',
        // followUpMode/short_term defaults from schema apply
      },
    });
    return 'created';
  } catch (err: any) {
    if (err.code === 'P2002' || /unique/i.test(err.message || '')) {
      return 'duplicate_race';
    }
    console.error(`  [error] lead=${candidate.leadId}: ${err.message}`);
    return 'error';
  }
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`);
  if (ACCOUNT_FILTER) console.log(`Filter: account=${ACCOUNT_FILTER}`);

  const accounts = await getReEngageAccounts();
  console.log(`\nFound ${accounts.length} accounts with aiHiredCompetitorReengage=true.`);

  const totals = { accounts: 0, candidates: 0, enrolled: 0, duplicates: 0, errors: 0 };

  for (const account of accounts) {
    const delayMin = parseHiredDelayMinutes(account.followUpSettingsJson);
    const candidates = await findCandidates(account, delayMin);

    if (candidates.length === 0) {
      console.log(`\n[${account.businessName} / ${account.platform} / ${account.id.slice(0, 8)}] delay=${delayMin}m → 0 candidates`);
      continue;
    }

    totals.accounts++;
    totals.candidates += candidates.length;

    console.log(`\n[${account.businessName} / ${account.platform} / ${account.id.slice(0, 8)}] delay=${delayMin}m → ${candidates.length} candidates`);
    for (const c of candidates) {
      const lostAgoH = Math.round((Date.now() - c.lostAt.getTime()) / 3_600_000);
      const dueInH = Math.round((c.nextStepDueAt.getTime() - Date.now()) / 3_600_000);
      console.log(`  - ${c.customerName ?? '(no name)'} lead=${c.leadId.slice(0, 8)} lostAgo=${lostAgoH}h dueIn=${dueInH}h (${c.nextStepDueAt.toISOString()})`);
    }

    if (!APPLY) continue;

    const tmpl = await ensureTemplate(account);
    if (!tmpl) {
      console.log(`  [skip-account] no customer_hired_competitor template available for platform=${account.platform}`);
      continue;
    }
    for (const c of candidates) {
      const result = await enroll(account, tmpl.id, c);
      if (result === 'created') totals.enrolled++;
      else if (result === 'duplicate_race') totals.duplicates++;
      else totals.errors++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Accounts with candidates: ${totals.accounts}`);
  console.log(`Candidates found:         ${totals.candidates}`);
  if (APPLY) {
    console.log(`Enrolled:                 ${totals.enrolled}`);
    console.log(`Duplicates (race):        ${totals.duplicates}`);
    console.log(`Errors:                   ${totals.errors}`);
  } else {
    console.log(`(dry-run — re-run with --apply to write)`);
  }
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
