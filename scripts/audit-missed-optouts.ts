/**
 * Audit + backfill — replay the IntentClassifierService against every
 * non-terminal lead's most recent customer message. Reports (and optionally
 * applies) status flips for leads where the classifier is highly confident
 * the customer signaled opt_out / hired_elsewhere / completed / agreed.
 *
 * Why: phrase lists missed cases like Lynn ("Please lose my information"),
 * Donna ("It's already done, thank you"), and many others over the last
 * months. Those leads are still status=engaged/contacted and the follow-up
 * engine keeps firing on them. The follow-up classifier gate (a7f6dcd) now
 * stops new follow-ups going forward, but historical leads that already had
 * their terminal-intent message land before the gate deployed are still
 * sitting in non-terminal status. This script heals them.
 *
 * MODES:
 *   DEFAULT (read-only)  — print findings, write CSV. No DB writes.
 *   APPLY=true           — flip lead.status to lost/booked via writeStatus.
 *                          Idempotent: sourceEventId per (leadId, intent)
 *                          dedups re-runs.
 *
 * Apply mode skips:
 *   - SF-linked leads (sfJobId != null) — SF is status authority for those.
 *   - 'deferring' intent — that's a pause, not a loss. Not a status flip.
 *   - leads already in a terminal status (no-downgrade guard handles, but we
 *     skip explicitly so the summary count is honest).
 *
 * Usage:
 *   # Dry-run (default)
 *   DATABASE_URL=$DIRECT_URL OPENAI_API_KEY=sk-... npx ts-node scripts/audit-missed-optouts.ts
 *
 *   # Apply
 *   DATABASE_URL=$DIRECT_URL OPENAI_API_KEY=sk-... APPLY=true \
 *     npx ts-node scripts/audit-missed-optouts.ts
 *
 * Optional env:
 *   AUDIT_LIMIT=500              — cap how many leads to scan (default 200)
 *   AUDIT_MIN_CONFIDENCE=0.85    — apply/report threshold (default 0.85)
 *   AUDIT_OUT=audit-results.csv  — output CSV path (default: stdout-only)
 *
 * Exit codes:
 *   0 — finished
 *   1 — fatal error (DB unreachable, OPENAI_API_KEY missing, etc.)
 */

import * as fs from 'fs';
import { PrismaClient } from '../generated/prisma';
import { IntentClassifierService, IntentClassification, CustomerIntent } from '../src/ai/intent-classifier.service';
import { LeadStatusService } from '../src/leads/lead-status.service';

const NON_TERMINAL_STATUSES = ['new', 'contacted', 'engaged', 'quoted'];
const TERMINAL_INTENTS = new Set(['opt_out', 'hired_elsewhere', 'completed', 'agreed', 'deferring']);

interface LeadRow {
  id: string;
  customerName: string | null;
  status: string;
  category: string | null;
  threadId: string | null;
  platform: string | null;
  createdAt: Date;
  sfJobId: string | null;
}

interface ClassifyRow {
  leadId: string;
  customerName: string;
  platform: string;
  currentStatus: string;
  category: string;
  lastMessageAt: string;
  lastMessage: string;
  intent: string;
  confidence: number;
  reason: string;
  fromLlm: boolean;
}

function csvEscape(s: string | null | undefined): string {
  if (s == null) return '';
  const v = String(s);
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY not set — classifier needs it');
    process.exit(1);
  }

  const limit = parseInt(process.env.AUDIT_LIMIT || '200', 10);
  const minConfidence = parseFloat(process.env.AUDIT_MIN_CONFIDENCE || '0.85');
  const outPath = process.env.AUDIT_OUT;
  const applyMode = (process.env.APPLY ?? 'false').toLowerCase() === 'true';

  const prisma = new PrismaClient();
  const config = { get: (k: string) => process.env[k] } as any;
  const classifier = new IntentClassifierService(config);

  // LeadStatusService needs an event emitter — backfill emits no events,
  // pass a stub. Same pattern as backfill-canonical-status.ts.
  const events = { emit: () => {} } as any;
  const leadStatusService = applyMode
    ? new LeadStatusService(prisma as any, events, config)
    : null;

  console.log(`\n=== Audit: missed opt-outs / completed / hired_elsewhere / deferring ===`);
  console.log(`Mode: ${applyMode ? 'APPLY (writes lead.status)' : 'DRY-RUN (read-only)'}`);
  console.log(`Limit: ${limit}  Min-confidence: ${minConfidence}`);
  console.log(`Scanning leads with status in (${NON_TERMINAL_STATUSES.join(', ')})\n`);

  const leads: LeadRow[] = await prisma.lead.findMany({
    where: { status: { in: NON_TERMINAL_STATUSES } },
    select: {
      id: true,
      customerName: true,
      status: true,
      category: true,
      threadId: true,
      platform: true,
      createdAt: true,
      sfJobId: true,
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  console.log(`Found ${leads.length} candidate leads. Classifying last customer message…\n`);

  const findings: ClassifyRow[] = [];
  const intentCounts: Record<string, number> = {};
  let scanned = 0;
  let skipped_no_thread = 0;
  let skipped_no_customer_msg = 0;
  let llm_failures = 0;

  for (const lead of leads) {
    scanned++;
    if (!lead.threadId) {
      skipped_no_thread++;
      continue;
    }

    const lastCustomerMsg = await prisma.message.findFirst({
      where: { conversationId: lead.threadId, sender: 'customer' },
      orderBy: { createdAt: 'desc' },
      select: { content: true, createdAt: true },
    });
    if (!lastCustomerMsg || !lastCustomerMsg.content) {
      skipped_no_customer_msg++;
      continue;
    }

    const recent = await prisma.message.findMany({
      where: { conversationId: lead.threadId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { sender: true, content: true },
    });
    const recentHistory = recent.reverse().map((m) => ({
      role: (m.sender === 'customer' ? 'customer' : 'pro') as 'customer' | 'pro',
      content: m.content || '',
    }));

    const result: IntentClassification = await classifier.classify({
      message: lastCustomerMsg.content,
      recentHistory,
      leadStatus: lead.status,
      leadCategory: lead.category ?? undefined,
    });

    if (!result.fromLlm) llm_failures++;
    intentCounts[result.intent] = (intentCounts[result.intent] || 0) + 1;

    if (result.fromLlm
        && TERMINAL_INTENTS.has(result.intent)
        && result.confidence >= minConfidence) {
      findings.push({
        leadId: lead.id,
        customerName: lead.customerName || '',
        platform: lead.platform || '',
        currentStatus: lead.status,
        category: lead.category || '',
        lastMessageAt: lastCustomerMsg.createdAt.toISOString(),
        lastMessage: lastCustomerMsg.content,
        intent: result.intent,
        confidence: result.confidence,
        reason: result.reason,
        fromLlm: result.fromLlm,
      });
    }

    if (scanned % 25 === 0) {
      console.log(`  ${scanned}/${leads.length} scanned, ${findings.length} findings so far…`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Scanned: ${scanned}`);
  console.log(`  Skipped (no thread):          ${skipped_no_thread}`);
  console.log(`  Skipped (no customer msg):    ${skipped_no_customer_msg}`);
  console.log(`  LLM failures:                 ${llm_failures}`);
  console.log(`  Findings (≥${minConfidence} conf): ${findings.length}\n`);

  console.log(`Intent distribution (all classified):`);
  for (const [intent, n] of Object.entries(intentCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${intent.padEnd(20)} ${n}`);
  }

  if (findings.length > 0) {
    const byIntent: Record<string, number> = {};
    for (const f of findings) byIntent[f.intent] = (byIntent[f.intent] || 0) + 1;
    console.log(`\nFindings by intent (≥${minConfidence}):`);
    for (const [intent, n] of Object.entries(byIntent).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${intent.padEnd(20)} ${n}`);
    }

    console.log(`\nTop 10 findings:`);
    for (const f of findings.slice(0, 10)) {
      const truncated = f.lastMessage.length > 80 ? f.lastMessage.slice(0, 79) + '…' : f.lastMessage;
      console.log(`  [${f.intent} ${f.confidence.toFixed(2)}] ${f.customerName || f.leadId} (${f.currentStatus}): "${truncated}"`);
    }

    if (outPath) {
      const header = ['leadId', 'customerName', 'platform', 'currentStatus', 'category', 'lastMessageAt', 'lastMessage', 'intent', 'confidence', 'reason'];
      const rows = [header.join(',')];
      for (const f of findings) {
        rows.push([
          csvEscape(f.leadId),
          csvEscape(f.customerName),
          csvEscape(f.platform),
          csvEscape(f.currentStatus),
          csvEscape(f.category),
          csvEscape(f.lastMessageAt),
          csvEscape(f.lastMessage),
          csvEscape(f.intent),
          f.confidence.toFixed(3),
          csvEscape(f.reason),
        ].join(','));
      }
      fs.writeFileSync(outPath, rows.join('\n') + '\n', 'utf-8');
      console.log(`\nWrote ${findings.length} rows to ${outPath}`);
    }

    // ── APPLY mode ────────────────────────────────────────────────────────
    // Flip lead.status using the same intent→status mapping as the live gate
    // (see follow-up-scheduler.service.ts classifyAndMaybeStop). Idempotent
    // sourceEventId per (leadId, intent) — re-runs no-op via writeStatus dedup.
    if (applyMode && leadStatusService) {
      console.log(`\n=== APPLY ===`);
      // Re-fetch the SF-link state for each finding so the most current data
      // governs the skip — the leads array snapshot was taken earlier.
      const leadById = new Map<string, LeadRow>(leads.map((l: LeadRow) => [l.id, l]));

      let applied = 0;
      let skippedDeferring = 0;
      let skippedSfLinked = 0;
      let skippedAlreadyTerminal = 0;
      let skippedDuplicate = 0;
      let writeErrors = 0;
      const now = new Date();

      for (const f of findings) {
        const intent = f.intent as CustomerIntent;
        const lead = leadById.get(f.leadId);

        // Deferring is a pause, not lost — do not flip status.
        if (intent === 'deferring') {
          skippedDeferring++;
          continue;
        }
        // SF-linked leads are SF authority — do not touch.
        if (lead?.sfJobId) {
          skippedSfLinked++;
          continue;
        }

        const sourceEventId = `backfill_classifier_${f.leadId}_${intent}`;
        const baseInput = {
          leadId: f.leadId,
          source: 'lb_automation' as const,
          sourceEventId,
          actorType: 'system' as const,
          actorName: 'classifier-backfill',
          metadata: {
            classifier_intent: intent,
            classifier_confidence: f.confidence,
            classifier_reason: f.reason,
            backfill_run_at: now.toISOString(),
          },
        };

        try {
          let result;
          if (intent === 'agreed') {
            result = await leadStatusService.writeStatus({
              ...baseInput,
              newStatus: 'booked',
              reason: 'backfill_classifier_agreed',
            });
          } else {
            // opt_out / hired_elsewhere / completed → lost
            const lostReason = intent === 'opt_out' ? 'opt_out' : 'hired_someone';
            const reengageAt = intent === 'opt_out'
              ? null
              : new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000);
            result = await leadStatusService.writeStatus({
              ...baseInput,
              newStatus: 'lost',
              lostReason,
              reason: `backfill_classifier_${intent}`,
              reengageAt,
            });
          }

          if (result.applied) {
            applied++;
            console.log(`  ✓ ${f.leadId} ${f.customerName || ''} → ${result.status} (intent=${intent} conf=${f.confidence.toFixed(2)})`);
          } else if (result.skipReason === 'duplicate') {
            skippedDuplicate++;
          } else if (result.skipReason === 'hard_terminal' || result.skipReason === 'no_change') {
            skippedAlreadyTerminal++;
          } else {
            console.log(`  ⊝ ${f.leadId} skipped — ${result.skipReason || 'unknown'}`);
          }
        } catch (err: any) {
          writeErrors++;
          console.error(`  ✗ ${f.leadId} write failed: ${err.message}`);
        }
      }

      console.log(`\nApplied: ${applied}`);
      console.log(`  Skipped (deferring — pause not loss):   ${skippedDeferring}`);
      console.log(`  Skipped (SF-linked):                    ${skippedSfLinked}`);
      console.log(`  Skipped (already terminal / no change): ${skippedAlreadyTerminal}`);
      console.log(`  Skipped (idempotent re-run):            ${skippedDuplicate}`);
      if (writeErrors > 0) console.log(`  Write errors:                           ${writeErrors}`);
    } else {
      console.log(`\n(read-only — re-run with APPLY=true to flip lead.status for the findings above)`);
    }
  } else {
    console.log(`\nNo findings above ${minConfidence} confidence. Nothing to backfill at this threshold.`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
