// Read-only review of the 34 A1 leads (booked + lost+opt_out, no
// hired_someone signal involved). Inspects last 5 messages, dispatcher
// booking-confirmation phrases, SF link / platform-native status, and
// emits a per-lead recommendation.
//
// Recommendations (heuristic — operator confirms before any apply):
//   restore_engaged  — AI mis-flipped, no real signal of booked or opt_out
//   restore_booked   — real signal exists (SF job, platform native = Hired/
//                      Scheduled/Done, dispatcher confirmation in thread)
//   keep_as_is       — customer truly opted out (explicit opt-out language)
//   manual_review    — ambiguous; operator must read the thread
//
// ZERO writes. Run anytime.
import { PrismaClient } from '../generated/prisma';

const prisma = new PrismaClient();

const FORBIDDEN = ['booked', 'in_progress', 'completed', 'cancelled', 'no_show', 'archived'];

const OPT_OUT_PHRASES = /\b(stop messaging|stop texting|unsubscribe|remove me|delete (?:my account|all appointments|account)|no longer pursuing|don'?t contact|not interested)\b/i;
const BOOKED_CONFIRM_PHRASES = /\b(scheduled (?:you|for)|booked (?:you|it)|confirmed (?:for|on)|see you (?:on|at)|all set for|appointment (?:is confirmed|set)|see you tomorrow|see you on|all set|booking confirmed)\b/i;
const FORM_PAYLOAD = /^job requested\b|^hi there, please respond with a price|how often do you want|how many bedrooms are|automatic message:/i;

// Platform-native "this is booked/scheduled/done" values
const PLATFORM_BOOKED_VALUES = new Set([
  'hired', 'scheduled', 'job scheduled', 'done', 'job complete', 'completed',
]);

interface Row {
  leadId: string;
  tenant: string;
  customer: string;
  platform: string;
  status: string;
  lostReason: string | null;
  age: string;
  // Signals
  sfLinkSignal: string;
  platformSignal: string;
  dispatcherConfirmPhrase: string | null;
  hasOptOutLang: boolean;
  realCustMsgCount: number;
  last5: Array<{ at: string; who: string; body: string }>;
  recommendation: 'restore_engaged' | 'restore_booked' | 'keep_as_is' | 'manual_review';
  reason: string;
}

(async () => {
  // Pull the SAME query the audit script uses, then narrow to A1 the same
  // way audit-ai-terminal-leads-split.ts does:
  //   - status in FORBIDDEN OR status='lost'
  //   - statusSource = 'lb_automation'
  //   - lostReason !== 'hired_someone'
  //   - reengageAt is null
  //   - enrollment stoppedReason doesn't contain 'hired_elsewhere'
  const leads = await prisma.$queryRawUnsafe<any[]>(`
    SELECT l.id, l."customerName", l.platform, l.status,
           l."statusSource", l."statusUpdatedAt", l."createdAt",
           l."lostReason", l."reengageAt", l."threadId",
           l."sfJobId", l."sfCustomerId", l."syncStatus", l."sfJobOutcome",
           l."thumbtackStatus", l."platformStatus",
           u.email AS tenant_email
    FROM leads l
    JOIN users u ON u.id = l."userId"
    WHERE l."statusSource" = 'lb_automation'
      AND (l.status = ANY($1::text[]) OR l.status = 'lost')
    ORDER BY u.email, l."statusUpdatedAt" DESC
  `, FORBIDDEN);

  const rows: Row[] = [];
  for (const lead of leads) {
    const enr = await prisma.followUpEnrollment.findFirst({
      where: { conversationId: lead.threadId },
      orderBy: { createdAt: 'desc' },
      select: { stoppedReason: true },
    });
    const stoppedReason = enr?.stoppedReason ?? '';

    // A1 filter (mirror split script)
    const isA2 =
      lead.lostReason === 'hired_someone' ||
      lead.reengageAt !== null ||
      stoppedReason.includes('hired_elsewhere');
    if (isA2) continue;

    // Bucket B/C from split — skip those too (Crystal Endless real booking,
    // Patrick C. + Lindsay H. real opt_out)
    if (lead.status === 'lost' && lead.lostReason === 'opt_out') {
      // Check for opt-out language to skip bucket C
      const msgs = await prisma.message.findMany({
        where: { conversationId: lead.threadId, sender: 'customer' },
        orderBy: { sentAt: 'asc' },
        select: { content: true },
      });
      const concat = msgs
        .filter((m) => !FORM_PAYLOAD.test((m.content ?? '').trim()))
        .map((m) => m.content ?? '')
        .join('\n');
      if (OPT_OUT_PHRASES.test(concat)) continue; // bucket C
    }
    if (lead.status === 'booked') {
      // Check for dispatcher confirm to skip bucket B
      const lastProManual = await prisma.message.findFirst({
        where: { conversationId: lead.threadId, sender: 'pro', senderType: 'manual' },
        orderBy: { sentAt: 'desc' },
        select: { content: true },
      });
      if (lastProManual && BOOKED_CONFIRM_PHRASES.test(lastProManual.content ?? '')) {
        continue; // bucket B
      }
    }

    // ── Now we're in A1. Build the review row. ─────────────────────────
    const allMsgs = await prisma.message.findMany({
      where: { conversationId: lead.threadId },
      orderBy: { sentAt: 'asc' },
      select: { sender: true, senderType: true, content: true, sentAt: true },
    });
    const customerMsgs = allMsgs.filter(
      (m) => m.sender === 'customer' && !FORM_PAYLOAD.test((m.content ?? '').trim()),
    );
    const last5 = allMsgs.slice(-5).map((m) => ({
      at: m.sentAt ? m.sentAt.toISOString().slice(0, 16).replace('T', ' ') : '----------------',
      who:
        m.sender === 'customer' ? 'CUST'
        : m.senderType === 'manual' ? 'PRO '
        : 'AI  ',
      body: (m.content ?? '').replace(/\s+/g, ' ').slice(0, 140),
    }));

    // Dispatcher booking confirmation — any pro/manual message in conv
    const proManualMatches = allMsgs
      .filter((m) => m.sender === 'pro' && m.senderType === 'manual')
      .map((m) => m.content ?? '')
      .reverse(); // most recent first
    let dispatcherConfirmPhrase: string | null = null;
    for (const text of proManualMatches) {
      const m = text.match(BOOKED_CONFIRM_PHRASES);
      if (m) { dispatcherConfirmPhrase = m[0]; break; }
    }

    // SF link signal
    const sfLinkParts: string[] = [];
    if (lead.sfJobId) sfLinkParts.push(`sfJobId=${lead.sfJobId}`);
    if (lead.sfCustomerId) sfLinkParts.push(`sfCustomerId=${lead.sfCustomerId}`);
    if (lead.syncStatus) sfLinkParts.push(`syncStatus=${lead.syncStatus}`);
    if (lead.sfJobOutcome) sfLinkParts.push(`sfJobOutcome=${lead.sfJobOutcome}`);
    const sfLinkSignal = sfLinkParts.join(' ') || '(none)';

    // Platform native signal
    const platformParts: string[] = [];
    if (lead.platformStatus) platformParts.push(`platformStatus=${lead.platformStatus}`);
    if (lead.thumbtackStatus) platformParts.push(`thumbtackStatus=${lead.thumbtackStatus}`);
    const platformSignal = platformParts.join(' ') || '(none)';
    const platformIsBooked =
      (lead.platformStatus && PLATFORM_BOOKED_VALUES.has(lead.platformStatus.toLowerCase())) ||
      (lead.thumbtackStatus && PLATFORM_BOOKED_VALUES.has(lead.thumbtackStatus.toLowerCase()));
    const sfIsBooked =
      lead.sfJobId !== null ||
      (lead.sfJobOutcome && ['scheduled', 'in_progress', 'completed'].includes(lead.sfJobOutcome.toLowerCase()));

    const concatCust = customerMsgs.map((m) => m.content ?? '').join('\n');
    const hasOptOutLang = OPT_OUT_PHRASES.test(concatCust);

    // ── Heuristic recommendation ─────────────────────────────────────
    let recommendation: Row['recommendation'];
    let reason: string;
    if (lead.status === 'lost' && lead.lostReason === 'opt_out') {
      if (hasOptOutLang) {
        recommendation = 'keep_as_is';
        reason = 'opt-out language confirmed in customer messages';
      } else if (customerMsgs.length === 0) {
        recommendation = 'restore_engaged';
        reason = 'opt_out set but no real customer messages — AI hallucinated';
      } else {
        recommendation = 'restore_engaged';
        reason = 'opt_out set but no opt-out language in customer messages';
      }
    } else if (lead.status === 'booked') {
      if (sfIsBooked) {
        recommendation = 'restore_booked';
        reason = `real SF signal: ${sfLinkSignal}`;
      } else if (platformIsBooked) {
        recommendation = 'restore_booked';
        reason = `platform-native says booked: ${platformSignal}`;
      } else if (dispatcherConfirmPhrase) {
        recommendation = 'restore_booked';
        reason = `dispatcher confirmed: "${dispatcherConfirmPhrase}"`;
      } else if (customerMsgs.length === 0) {
        recommendation = 'restore_engaged';
        reason = 'booked but no real customer messages — AI hallucinated';
      } else {
        recommendation = 'restore_engaged';
        reason = 'booked but no dispatcher / SF / platform confirmation';
      }
    } else {
      recommendation = 'manual_review';
      reason = `unexpected status combination (status=${lead.status} lostReason=${lead.lostReason ?? 'null'})`;
    }

    const ageDays = Math.floor((Date.now() - new Date(lead.createdAt).getTime()) / (1000 * 60 * 60 * 24));
    rows.push({
      leadId: lead.id,
      tenant: lead.tenant_email,
      customer: lead.customerName,
      platform: lead.platform,
      status: lead.status,
      lostReason: lead.lostReason,
      age: `${ageDays}d`,
      sfLinkSignal,
      platformSignal,
      dispatcherConfirmPhrase,
      hasOptOutLang,
      realCustMsgCount: customerMsgs.length,
      last5,
      recommendation,
      reason,
    });
  }

  // ── Print compact summary table first ──────────────────────────────
  console.log(`\n=== A1 review — ${rows.length} leads ===\n`);
  console.log([
    'leadId'.padEnd(38),
    'tenant'.padEnd(36),
    'customer'.padEnd(22),
    'platf'.padEnd(5),
    'status'.padEnd(10),
    'age'.padEnd(5),
    'cust'.padEnd(4),
    'recommendation'.padEnd(18),
  ].join(' │ '));
  console.log('-'.repeat(160));
  for (const r of rows) {
    console.log([
      r.leadId.padEnd(38),
      r.tenant.slice(0, 36).padEnd(36),
      (r.customer ?? '').slice(0, 22).padEnd(22),
      r.platform.slice(0, 5).padEnd(5),
      `${r.status}${r.lostReason ? '/' + r.lostReason : ''}`.padEnd(10),
      r.age.padEnd(5),
      String(r.realCustMsgCount).padEnd(4),
      r.recommendation.padEnd(18),
    ].join(' │ '));
  }

  // ── Per-tenant + per-recommendation tally ──────────────────────────
  const tally: Record<string, number> = {};
  for (const r of rows) tally[r.recommendation] = (tally[r.recommendation] ?? 0) + 1;
  console.log('\n=== Recommendation tally ===');
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(22)} ${v}`);
  }

  // ── Detailed view for each lead ────────────────────────────────────
  console.log(`\n\n=== A1 detailed view (per lead) ===`);
  for (const r of rows) {
    console.log(`\n─── ${r.leadId}`);
    console.log(`    tenant:    ${r.tenant}`);
    console.log(`    customer:  ${r.customer} (${r.platform}, age ${r.age})`);
    console.log(`    status:    ${r.status}${r.lostReason ? ' / lostReason=' + r.lostReason : ''}`);
    console.log(`    SF link:   ${r.sfLinkSignal}`);
    console.log(`    Platform:  ${r.platformSignal}`);
    console.log(`    Dispatcher booking confirm phrase: ${r.dispatcherConfirmPhrase ? `"${r.dispatcherConfirmPhrase}"` : '(none)'}`);
    console.log(`    Customer opt-out language: ${r.hasOptOutLang ? 'YES' : 'no'}`);
    console.log(`    Real customer messages: ${r.realCustMsgCount}`);
    console.log(`    Last 5 messages:`);
    for (const m of r.last5) {
      console.log(`      ${m.at}  ${m.who}  ${m.body}`);
    }
    console.log(`    → RECOMMENDATION: ${r.recommendation}`);
    console.log(`      Reason: ${r.reason}`);
  }

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
