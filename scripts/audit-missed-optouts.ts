/**
 * Dry-run audit — replay the new IntentClassifierService against every
 * non-terminal lead's most recent customer message, report which leads would
 * have been flipped to opt_out / hired_elsewhere / completed / agreed /
 * deferring at high confidence.
 *
 * Why: phrase lists missed cases like Lynn ("Please lose my information"),
 * Donna ("It's already done, thank you"), and many others over the last
 * months. Those leads are still in status=engaged/contacted and the follow-up
 * engine keeps firing on them. This script identifies the historical misses
 * so the operator can decide what to backfill.
 *
 * Read-only — no DB writes. Outputs a CSV + a summary to stdout.
 *
 * Usage:
 *   DATABASE_URL=$DIRECT_URL OPENAI_API_KEY=sk-... npx ts-node scripts/audit-missed-optouts.ts
 *
 * Optional env:
 *   AUDIT_LIMIT=500            — cap how many leads to scan (default 200)
 *   AUDIT_MIN_CONFIDENCE=0.85  — only report classifications at/above this confidence (default 0.85)
 *   AUDIT_OUT=audit-results.csv — output CSV path (default: stdout-only)
 *
 * Exit codes:
 *   0 — finished
 *   1 — fatal error (DB unreachable, OPENAI_API_KEY missing, etc.)
 */

import * as fs from 'fs';
import { PrismaClient } from '../generated/prisma';
import { IntentClassifierService, IntentClassification } from '../src/ai/intent-classifier.service';

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

  const prisma = new PrismaClient();
  const config = { get: (k: string) => process.env[k] } as any;
  const classifier = new IntentClassifierService(config);

  console.log(`\n=== Audit: missed opt-outs / completed / hired_elsewhere / deferring ===`);
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
  } else {
    console.log(`\nNo findings above ${minConfidence} confidence. Nothing to backfill at this threshold.`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
