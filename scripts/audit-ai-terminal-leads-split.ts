// Read-only split of bucket A from audit-ai-terminal-leads.ts into two
// sub-buckets, per the 2026-06-17 operator request:
//
//   A1 safe_restore
//     - booked → engaged with no dispatcher/customer booking confirmation
//     - opt_out → engaged with no opt-out language
//     - completed/wrap-up/thanks/ok → engaged
//     - lostReason NOT 'hired_someone'
//     - reengageAt NOT set
//     - no classifier_hired_elsewhere stoppedReason
//
//   A2 hired_someone_needs_review
//     - lostReason='hired_someone' OR
//     - reengageAt set OR
//     - stoppedReason contains 'hired_elsewhere'
//
// For A2 it emits a per-lead table with last 5 messages + a flag for any
// phrase that allegedly means hired-elsewhere + a recommendation.
//
// ZERO writes. Run anytime.
import { PrismaClient } from '../generated/prisma';

const prisma = new PrismaClient();

const FORBIDDEN = ['booked', 'in_progress', 'completed', 'cancelled', 'no_show', 'archived'];
const HIRE_ELSE_PHRASES = /\b(hired? (?:someone|another|else|a different)|chose (?:someone|another)|went with (?:someone|another)|going with (?:another|someone)|already (?:cleaned|hired|booked)|found (?:someone|another)|use a different)\b/i;
const FORM_PAYLOAD = /^job requested\b|^hi there, please respond with a price|how often do you want|how many bedrooms are|automatic message:/i;

interface Lead {
  id: string;
  customerName: string;
  platform: string;
  status: string;
  lostReason: string | null;
  reengageAt: Date | null;
  threadId: string;
  tenant_email: string;
}

async function main(): Promise<void> {
  const leads = await prisma.$queryRawUnsafe<Lead[]>(`
    SELECT l.id, l."customerName", l.platform, l.status,
           l."lostReason", l."reengageAt", l."threadId",
           u.email AS tenant_email
    FROM leads l
    JOIN users u ON u.id = l."userId"
    WHERE l."statusSource" = 'lb_automation'
      AND (l.status = ANY($1::text[]) OR l.status = 'lost')
    ORDER BY u.email, l."statusUpdatedAt" DESC
  `, FORBIDDEN);

  const a1: Lead[] = [];
  const a2: Lead[] = [];
  const skipped: Lead[] = []; // Buckets B/C/D/E we don't touch in this split

  for (const lead of leads) {
    // Look up the enrollment to check stoppedReason
    const enrollment = await prisma.followUpEnrollment.findFirst({
      where: { conversationId: lead.threadId },
      orderBy: { createdAt: 'desc' },
      select: { stoppedReason: true },
    });
    const stoppedReason = enrollment?.stoppedReason ?? '';

    // Quick determination of bucket B/C/D — skip them here.
    // (Same logic as audit-ai-terminal-leads.ts; condensed.)
    if (lead.status === 'lost' && lead.lostReason === 'opt_out') {
      // Need to peek at conversation to know if it's bucket C (kept) vs A1.
      const msgs = await prisma.message.findMany({
        where: { conversationId: lead.threadId, sender: 'customer' },
        orderBy: { sentAt: 'asc' },
        select: { content: true },
      });
      const concat = msgs
        .filter((m) => !FORM_PAYLOAD.test((m.content ?? '').trim()))
        .map((m) => m.content ?? '')
        .join('\n');
      if (/\b(stop messaging|stop texting|unsubscribe|remove me|delete (?:my account|all appointments|account)|no longer pursuing|don'?t contact|not interested)\b/i.test(concat)) {
        skipped.push(lead);
        continue;
      }
      // Bucket A — opt_out without opt-out language. A1.
      a1.push(lead);
      continue;
    }

    if (lead.status === 'booked') {
      // Bucket B test: dispatcher manual confirmation.
      const lastProManual = await prisma.message.findFirst({
        where: { conversationId: lead.threadId, sender: 'pro', senderType: 'manual' },
        orderBy: { sentAt: 'desc' },
        select: { content: true },
      });
      if (
        lastProManual &&
        /\b(scheduled (?:you|for)|booked (?:you|it)|confirmed (?:for|on)|see you (?:on|at)|all set for|appointment (?:is confirmed|set))\b/i.test(lastProManual.content ?? '')
      ) {
        skipped.push(lead);
        continue;
      }
      // Bucket A1 (booked is not hired_someone). Regardless of stoppedReason.
      a1.push(lead);
      continue;
    }

    // Remaining: lost + lostReason != 'opt_out'. The big group: lostReason='hired_someone'.
    const isHiredSomeone =
      lead.lostReason === 'hired_someone' ||
      lead.reengageAt !== null ||
      stoppedReason.includes('hired_elsewhere');
    if (isHiredSomeone) {
      a2.push(lead);
      continue;
    }

    // Lost with some other lostReason (manual/no_response/null) — A1.
    a1.push(lead);
  }

  console.log(`\n=== A1 safe_restore: ${a1.length} leads ===\n`);
  for (const l of a1) {
    console.log(`  ${l.id}  ${l.tenant_email.padEnd(40)}  ${l.platform.padEnd(9)}  ${l.status.padEnd(7)}  ${(l.lostReason ?? '').padEnd(14)}  ${l.customerName}`);
  }

  console.log(`\n=== A2 hired_someone_needs_review: ${a2.length} leads ===\n`);
  for (const l of a2) {
    // Last 5 messages
    const msgs = await prisma.message.findMany({
      where: { conversationId: l.threadId },
      orderBy: { sentAt: 'desc' },
      take: 5,
      select: { sender: true, senderType: true, content: true, sentAt: true },
    });
    const last5 = msgs.reverse();

    // Concatenated real customer messages for phrase search
    const custConcat = last5
      .filter((m) => m.sender === 'customer' && !FORM_PAYLOAD.test((m.content ?? '').trim()))
      .map((m) => m.content ?? '')
      .join(' \n ');
    const phraseMatch = custConcat.match(HIRE_ELSE_PHRASES);

    // Also check across ALL customer messages, not just last 5
    const allCust = await prisma.message.findMany({
      where: { conversationId: l.threadId, sender: 'customer' },
      orderBy: { sentAt: 'asc' },
      select: { content: true },
    });
    const allCustConcat = allCust
      .filter((m) => !FORM_PAYLOAD.test((m.content ?? '').trim()))
      .map((m) => m.content ?? '')
      .join(' \n ');
    const allPhraseMatch = allCustConcat.match(HIRE_ELSE_PHRASES);
    const phrase = phraseMatch?.[0] ?? allPhraseMatch?.[0] ?? null;
    const realCustCount = allCust.filter((m) => !FORM_PAYLOAD.test((m.content ?? '').trim())).length;

    // Recommendation
    let rec: 'revert' | 'keep_hired_elsewhere_reengage' | 'manual_review';
    if (phrase) {
      rec = 'keep_hired_elsewhere_reengage';
    } else if (realCustCount === 0) {
      // No real customer message at all — pure hallucination, revert
      rec = 'revert';
    } else {
      // Real messages but no hire-elsewhere phrase — operator must read
      rec = 'manual_review';
    }

    console.log(`\n  ─── ${l.id}  (${l.tenant_email} · ${l.platform})`);
    console.log(`      Customer:           ${l.customerName}`);
    console.log(`      lostReason:         ${l.lostReason ?? 'null'}    reengageAt: ${l.reengageAt ? l.reengageAt.toISOString().slice(0, 10) : 'null'}`);
    console.log(`      Allegedly-hire phrase: ${phrase ? `"${phrase}"` : '(NONE FOUND)'}`);
    console.log(`      Real customer messages total: ${realCustCount}`);
    console.log(`      Last 5 messages:`);
    for (const m of last5) {
      const who = (m.sender === 'customer' ? 'CUST' : (m.senderType === 'manual' ? 'PRO ' : 'AI  ')).padEnd(5);
      const ts = m.sentAt ? m.sentAt.toISOString().slice(0, 16).replace('T', ' ') : '----------------';
      const body = (m.content ?? '').replace(/\s+/g, ' ').slice(0, 160);
      console.log(`        ${ts}  ${who} ${body}`);
    }
    console.log(`      → RECOMMENDATION: ${rec}`);
  }

  console.log(`\n\n=== Summary ===`);
  console.log(`  A1 safe_restore               ${a1.length}`);
  console.log(`  A2 hired_someone_needs_review ${a2.length}`);
  console.log(`  Other (B/C/D/E unchanged)     ${skipped.length}`);
  console.log(`  Total candidates              ${leads.length}`);
}

main()
  .catch(async (err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
