/**
 * B3 — Heal Donna + Devi partial-state Yelp leads.
 *
 * Both leads currently exhibit the Donna-RCA fingerprint:
 *   status='new', lostReason='hired_someone', statusUpdatedAt frozen pre-fix.
 *
 * The Yelp upsert update-branch (Fix B, commit 3793a29) had been silently
 * reverting their canonical status before the fix shipped. The lostReason was
 * preserved from an earlier writeStatus call, so the row is half-terminal
 * (lost-reason set, status not). Fix B prevents NEW corruption but cannot
 * heal historical rows — they need an explicit writeStatus call to complete
 * the transition.
 *
 * Usage:
 *   DATABASE_URL=$DIRECT_URL APPLY=true npx ts-node scripts/b3-heal-donna-devi.ts
 *
 * Default is dry-run (no DB writes). Pass APPLY=true to mutate.
 *
 * Idempotency: sourceEventId="b3_heal_2026_05_09_<leadId>" is unique per lead;
 * re-running this script will hit the writeStatus dedup guard and no-op.
 *
 * Safety:
 *   - Targets ONLY two specific lead IDs hard-coded below.
 *   - Confirms current status is non-terminal AND lostReason='hired_someone'
 *     before issuing any write — refuses to operate if state diverges.
 *   - sfJobId must be null (SF-linked leads have SF authority).
 *   - Single transaction per lead via writeStatus.
 *
 * Reversal: revert both audit rows + reset status='new' + lostReason='hired_someone'
 * if any unexpected side effect emerges. Use the audit log id from the result.
 */

import { PrismaClient } from '../generated/prisma';
import { LeadStatusService } from '../src/leads/lead-status.service';

const TARGETS = [
  { id: '82f759ee-4242-4bd1-a21e-e3b5ee440698', name: 'Donna Bower' },
  { id: '498bc563-df60-4831-a17a-cec610223f3e', name: 'Devi D.' },
];

const APPLY = (process.env.APPLY ?? 'false').toLowerCase() === 'true';

(async () => {
  const prisma = new PrismaClient();
  const config = { get: (k: string) => process.env[k] } as any;
  const events = { emit: () => {} } as any;
  const leadStatusService = new LeadStatusService(prisma as any, events, config);

  console.log(`\n=== B3 — Heal Donna + Devi partial-state ===`);
  console.log(`Mode: ${APPLY ? 'APPLY (writes)' : 'DRY-RUN (read-only)'}`);
  console.log();

  const now = new Date();

  for (const t of TARGETS) {
    const lead = await prisma.lead.findUnique({
      where: { id: t.id },
      select: { id: true, customerName: true, status: true, lostReason: true, sfJobId: true, statusUpdatedAt: true, reengageAt: true },
    });
    if (!lead) {
      console.log(`✗ ${t.name} (${t.id}) — NOT FOUND, skipping`);
      continue;
    }

    // Pre-condition checks — refuse to operate if current state diverges from
    // the Donna-fingerprint (status non-terminal + lostReason='hired_someone').
    const TERMINAL = new Set(['lost', 'booked', 'completed', 'archived', 'hired', 'cancelled', 'done', 'scheduled']);
    if (TERMINAL.has(lead.status)) {
      console.log(`⊝ ${t.name} (${t.id.slice(0, 8)}) — already terminal (status=${lead.status}); skipping`);
      continue;
    }
    if (lead.lostReason !== 'hired_someone') {
      console.log(`✗ ${t.name} (${t.id.slice(0, 8)}) — lostReason mismatch (got="${lead.lostReason}", expected="hired_someone"); REFUSING to heal`);
      continue;
    }
    if (lead.sfJobId) {
      console.log(`⊝ ${t.name} (${t.id.slice(0, 8)}) — SF-linked (sfJobId=${lead.sfJobId}); skipping (SF authority)`);
      continue;
    }

    console.log(`→ ${t.name} (${t.id.slice(0, 8)}): pre-state status=${lead.status} lostReason=${lead.lostReason} statusUpdatedAt=${lead.statusUpdatedAt?.toISOString()}`);

    if (!APPLY) {
      console.log(`  (dry-run) would call writeStatus(newStatus='lost', lostReason='hired_someone', sourceEventId='b3_heal_2026_05_09_${t.id}')`);
      continue;
    }

    try {
      const result = await leadStatusService.writeStatus({
        leadId: t.id,
        source: 'lb_automation',
        sourceEventId: `b3_heal_2026_05_09_${t.id}`,
        actorType: 'system',
        actorName: 'b3-heal-donna-devi',
        newStatus: 'lost',
        lostReason: 'hired_someone',
        reason: 'b3_heal_donna_devi',
        // Reuse the existing 21-day reengage window already on these rows.
        // writeStatus only sets reengageAt when explicitly passed; without this
        // the existing column value would be cleared because the old status
        // was 'new' (transition INTO lost sets it from input only).
        reengageAt: lead.reengageAt ?? new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000),
        metadata: {
          heal_run_at: now.toISOString(),
          rca_reference: 'donna_rca_2026_05_08',
          fix_reference: 'fix_b_commit_3793a29',
        },
      });

      if (result.applied) {
        console.log(`  ✓ healed → status=${result.status} auditLogId=${result.auditLogId}`);
      } else {
        console.log(`  ⊝ skipped — skipReason=${result.skipReason || 'unknown'}`);
      }
    } catch (err: any) {
      console.log(`  ✗ ERROR — ${err.message}`);
    }
  }

  // Post-state confirmation
  console.log();
  console.log(`=== Post-state confirmation (read-only) ===`);
  for (const t of TARGETS) {
    const lead = await prisma.lead.findUnique({
      where: { id: t.id },
      select: { status: true, lostReason: true, statusUpdatedAt: true },
    });
    if (lead) {
      console.log(`  ${t.name}: status=${lead.status} lostReason=${lead.lostReason} statusUpdatedAt=${lead.statusUpdatedAt?.toISOString()}`);
    }
  }

  await prisma.$disconnect();
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
