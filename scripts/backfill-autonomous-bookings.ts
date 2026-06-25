/**
 * Backfill — run AppointmentDetectorService against historical TT
 * dispatcher messages so leads that were confirmed before the live flag
 * went up still get their lifecycle stamped (booked + scheduledFor metadata).
 *
 * Symmetric to the runtime path in webhooks.service.ts:
 *   1. Find outbound dispatcher messages (sender=pro, senderType=manual)
 *      on Thumbtack threads from the last N days. Only the LATEST such
 *      message per lead is examined — earlier "first reminder" messages
 *      are redundant once the latest message is processed.
 *   2. Skip leads in autonomous-terminal states (completed, cancelled,
 *      lost, no_show, archived) — those are owned by upstream signals.
 *   3. Skip users with an active sf_connection — SF owns lifecycle there
 *      and the same write-time guard would block us anyway.
 *   4. Resolve account timezone (SavedAccount.timezoneOverride → User.timezone
 *      → 'America/New_York') and feed it into AppointmentDetectorService.detect.
 *   5. When confirmed, call LeadStatusService.writeStatus with reason=
 *      'dispatcher_confirmed' and metadata.appointmentAt — the runtime
 *      guards (canonical validation, sf_connection re-check, reschedule
 *      semantics) apply identically.
 *
 * Modes:
 *   DRY_RUN=true   — print would_book / no_confirm summary, no writes (default)
 *   DRY_RUN=false  — execute the writes
 *
 * Optional filters:
 *   LOOKBACK_DAYS=<n>  — message age window (default 60)
 *   USER_ID=<id>       — only one user (canary)
 *   LIMIT=<n>          — cap candidate count after filtering
 *
 * Usage (from Leadbridge/):
 *   DATABASE_URL=$DIRECT_URL DRY_RUN=true  npx ts-node scripts/backfill-autonomous-bookings.ts
 *   DATABASE_URL=$DIRECT_URL DRY_RUN=false npx ts-node scripts/backfill-autonomous-bookings.ts
 */

/* eslint-disable no-console */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/utils/prisma.service';
import { AppointmentDetectorService } from '../src/leads/appointment-detector.service';
import { LeadStatusService } from '../src/leads/lead-status.service';

const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const LOOKBACK_DAYS = process.env.LOOKBACK_DAYS ? parseInt(process.env.LOOKBACK_DAYS, 10) : 60;
const USER_ID = process.env.USER_ID || undefined;
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : undefined;

const TERMINAL_STATUSES = ['completed', 'cancelled', 'lost', 'no_show', 'archived'];

type Counters = {
  candidate_messages: number;
  unique_leads: number;
  skipped_terminal_status: number;
  skipped_sf_connected: number;
  skipped_prefilter: number;
  skipped_no_confirm: number;
  skipped_invalid_appointment: number;
  skipped_low_confidence: number;
  skipped_llm_error: number;
  would_book: number;
  would_complete: number;
  booked: number;
  completed: number;
  write_skipped: number;
  write_failed: number;
};

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const detector = app.get(AppointmentDetectorService);
  const leadStatus = app.get(LeadStatusService);

  const counters: Counters = {
    candidate_messages: 0,
    unique_leads: 0,
    skipped_terminal_status: 0,
    skipped_sf_connected: 0,
    skipped_prefilter: 0,
    skipped_no_confirm: 0,
    skipped_invalid_appointment: 0,
    skipped_low_confidence: 0,
    skipped_llm_error: 0,
    would_book: 0,
    would_complete: 0,
    booked: 0,
    completed: 0,
    write_skipped: 0,
    write_failed: 0,
  };

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  console.log(`[backfill-autonomous-bookings] mode=${DRY_RUN ? 'DRY_RUN' : 'LIVE'} lookback_days=${LOOKBACK_DAYS} cutoff=${cutoff.toISOString()} user_id=${USER_ID ?? 'all'} limit=${LIMIT ?? 'none'}`);

  // Pull all candidate messages in one go. The volume is bounded — TT
  // external pro messages are small per-tenant traffic and we cap by date.
  // Order DESC so we can take "first hit per lead" = latest per lead.
  const messages = await prisma.message.findMany({
    where: {
      platform: 'thumbtack',
      sender: 'pro',
      senderType: 'manual',
      sentAt: { gte: cutoff },
      ...(USER_ID ? { userId: USER_ID } : {}),
    },
    select: {
      id: true,
      userId: true,
      content: true,
      sentAt: true,
      conversationId: true,
    },
    orderBy: { sentAt: 'desc' },
  });
  counters.candidate_messages = messages.length;

  // De-dup to latest message per lead (via conversation→lead lookup).
  // Loading the lead in one batched findMany is cheaper than per-message round trips.
  const conversationIds = Array.from(new Set(messages.map((m) => m.conversationId)));
  const leads = await prisma.lead.findMany({
    where: { threadId: { in: conversationIds } },
    select: {
      id: true,
      userId: true,
      status: true,
      customerName: true,
      businessId: true,
      threadId: true,
      sfJobId: true,
      sfCustomerId: true,
      syncStatus: true,
      platform: true,
    },
  });
  const leadByConversationId = new Map(leads.map((l) => [l.threadId!, l]));

  // Group ALL messages per lead, newest-first. The detector iterates from the
  // newest message and stops at the first confirmation — so when the latest
  // message is an unrelated operational reply ("the dishwasher is full") but
  // the appointment was confirmed in an older message, we still surface it.
  const messagesByLead = new Map<string, Array<{ messageId: string; userId: string; content: string; sentAt: Date; lead: (typeof leads)[number] }>>();
  for (const m of messages) {
    const lead = leadByConversationId.get(m.conversationId);
    if (!lead) continue;
    const arr = messagesByLead.get(lead.id) ?? [];
    arr.push({ messageId: m.id, userId: m.userId, content: m.content, sentAt: m.sentAt, lead });
    messagesByLead.set(lead.id, arr);
  }
  counters.unique_leads = messagesByLead.size;

  // Resolve sf_connection presence per user — one query, indexable.
  const userIds = Array.from(new Set(Array.from(messagesByLead.values()).flat().map((v) => v.userId)));
  const sfConnections = userIds.length > 0
    ? await prisma.sfConnection.findMany({
        where: { userId: { in: userIds }, isActive: true, status: 'active' },
        select: { userId: true },
      })
    : [];
  const sfConnectedUsers = new Set(sfConnections.map((c) => c.userId));

  // Resolve timezone per (userId, businessId) pair. One batched read for users,
  // one per-tenant lookup for SavedAccount overrides.
  const users = userIds.length > 0
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, timezone: true, email: true, name: true } })
    : [];
  const userTzById = new Map(users.map((u) => [u.id, u.timezone ?? null]));
  const userInfoById = new Map(users.map((u) => [u.id, { email: u.email, name: u.name }]));

  const businessIds = Array.from(new Set(Array.from(messagesByLead.values()).flat().map((v) => v.lead.businessId).filter(Boolean))) as string[];
  const accounts = businessIds.length > 0
    ? await prisma.savedAccount.findMany({
        where: { businessId: { in: businessIds }, userId: { in: userIds } },
        select: { userId: true, businessId: true, timezoneOverride: true, businessName: true },
      })
    : [];
  const acctTzByKey = new Map<string, string | null>();
  const acctNameByKey = new Map<string, string | null>();
  for (const a of accounts) {
    acctTzByKey.set(`${a.userId}:${a.businessId}`, a.timezoneOverride ?? null);
    acctNameByKey.set(`${a.userId}:${a.businessId}`, a.businessName ?? null);
  }

  let processed = 0;
  outer: for (const entries of Array.from(messagesByLead.values())) {
    if (LIMIT && processed >= LIMIT) break;
    processed++;

    // All messages for this lead are the same Lead; pull metadata from any.
    const first = entries[0];
    const { lead, userId } = first;

    if (TERMINAL_STATUSES.includes(lead.status)) {
      counters.skipped_terminal_status++;
      continue;
    }
    if (sfConnectedUsers.has(userId)) {
      counters.skipped_sf_connected++;
      continue;
    }

    const tz = (lead.businessId ? acctTzByKey.get(`${userId}:${lead.businessId}`) : null) || userTzById.get(userId) || 'America/New_York';

    // Per-lead detection. Iterate messages newest-first.
    //   - Run BOTH detectors per message; completion signal wins immediately
    //     because "job is done" is a stronger truth than "future appointment".
    //   - If neither matches, fall through to the next-older message.
    //   - Stop at the first match (completion or confirmation).
    type Decision =
      | { kind: 'completed'; signalType: string; confidence: number; reason: string; sentAt: Date }
      | { kind: 'confirmed'; appointmentAt: string; slotMinutes: number | null; confidence: number; reason: string; sentAt: Date };
    let decision: Decision | null = null;
    let leadOutcome: 'prefilter_all' | 'no_confirm' | 'invalid' | 'low_conf' | 'llm_err' = 'prefilter_all';
    for (const entry of entries) {
      // Try the (cheaper) post-job pre-filter first; if it matches we may
      // short-circuit confirmation entirely. Both LLMs are independent calls.
      const pj = await detector.detectPostJobSignal({
        messageText: entry.content,
        messageSentAt: entry.sentAt,
        timezone: tz,
        customerName: lead.customerName ?? undefined,
      });
      if (pj.completed && pj.signalType) {
        decision = { kind: 'completed', signalType: pj.signalType, confidence: pj.confidence, reason: pj.reason, sentAt: entry.sentAt };
        break;
      }
      const cf = await detector.detect({
        messageText: entry.content,
        messageSentAt: entry.sentAt,
        timezone: tz,
        customerName: lead.customerName ?? undefined,
      });
      if (cf.confirmed && cf.appointmentAt) {
        decision = { kind: 'confirmed', appointmentAt: cf.appointmentAt, slotMinutes: cf.slotMinutes, confidence: cf.confidence, reason: cf.reason, sentAt: entry.sentAt };
        break;
      }
      // Track the "worst" miss reason from the appointment detector — the
      // post-job detector's reason is less informative for the summary.
      if (cf.skippedByPrefilter) continue;
      if (cf.reason === 'invalid_appointment_at') leadOutcome = 'invalid';
      else if (cf.reason === 'low_confidence') leadOutcome = 'low_conf';
      else if (cf.reason?.startsWith('llm_error')) leadOutcome = 'llm_err';
      else leadOutcome = 'no_confirm';
    }

    if (!decision) {
      if (leadOutcome === 'prefilter_all') counters.skipped_prefilter++;
      else if (leadOutcome === 'invalid') counters.skipped_invalid_appointment++;
      else if (leadOutcome === 'low_conf') counters.skipped_low_confidence++;
      else if (leadOutcome === 'llm_err') counters.skipped_llm_error++;
      else counters.skipped_no_confirm++;
      continue;
    }

    const userInfo = userInfoById.get(userId) ?? { email: '?', name: null };
    const acctName = lead.businessId ? acctNameByKey.get(`${userId}:${lead.businessId}`) : null;

    if (decision.kind === 'completed') {
      if (DRY_RUN) {
        counters.would_complete++;
        console.log(`[backfill] would_complete lead_id=${lead.id} customer="${lead.customerName ?? '?'}" tenant="${userInfo.email}" tenant_name="${userInfo.name ?? '?'}" account="${acctName ?? '?'}" status=${lead.status} signal_type=${decision.signalType} confidence=${decision.confidence} reason="${decision.reason}"`);
        continue outer;
      }
      try {
        const writeResult = await leadStatus.writeStatus({
          leadId: lead.id,
          newStatus: 'completed',
          source: 'lb_automation',
          reason: 'dispatcher_post_job_signal',
          occurredAt: decision.sentAt,
          metadata: {
            signalType: decision.signalType,
            confidence: decision.confidence,
            detectorReason: decision.reason,
            backfill: true,
          },
        });
        if (writeResult.applied) {
          counters.completed++;
          console.log(`[backfill] completed lead_id=${lead.id} signal_type=${decision.signalType}`);
        } else {
          counters.write_skipped++;
          console.log(`[backfill] write_skipped lead_id=${lead.id} skip_reason=${writeResult.skipReason ?? 'unknown'}`);
        }
      } catch (err: any) {
        counters.write_failed++;
        console.log(`[backfill] write_failed lead_id=${lead.id} err=${err?.message ?? err}`);
      }
      continue outer;
    }

    // decision.kind === 'confirmed'
    if (DRY_RUN) {
      counters.would_book++;
      console.log(`[backfill] would_book lead_id=${lead.id} customer="${lead.customerName ?? '?'}" tenant="${userInfo.email}" tenant_name="${userInfo.name ?? '?'}" account="${acctName ?? '?'}" business_id=${lead.businessId ?? 'null'} status=${lead.status} appointment_at=${decision.appointmentAt} slot_minutes=${decision.slotMinutes ?? 'null'} confidence=${decision.confidence} tz=${tz} reason="${decision.reason}"`);
      continue outer;
    }

    try {
      const writeResult = await leadStatus.writeStatus({
        leadId: lead.id,
        newStatus: 'booked',
        source: 'lb_automation',
        reason: 'dispatcher_confirmed',
        occurredAt: decision.sentAt,
        metadata: {
          appointmentAt: decision.appointmentAt,
          slotMinutes: decision.slotMinutes,
          confidence: decision.confidence,
          detectorReason: decision.reason,
          timezone: tz,
          backfill: true,
        },
      });
      if (writeResult.applied) {
        counters.booked++;
        console.log(`[backfill] booked lead_id=${lead.id} appointment_at=${decision.appointmentAt}`);
      } else {
        counters.write_skipped++;
        console.log(`[backfill] write_skipped lead_id=${lead.id} skip_reason=${writeResult.skipReason ?? 'unknown'}`);
      }
    } catch (err: any) {
      counters.write_failed++;
      console.log(`[backfill] write_failed lead_id=${lead.id} err=${err?.message ?? err}`);
    }
  }

  console.log('---');
  console.log(JSON.stringify(counters, null, 2));
  await app.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
