#!/usr/bin/env node
/**
 * LB-side status parity report for tenant 2 / Spotless canary. Read-only.
 *
 * Required env: DATABASE_URL (DIRECT_URL form, port 5432).
 */
const { PrismaClient } = require('../../generated/prisma');

const LB_USER = process.env.LB_USER || 'c3d14499-dec1-42c3-a36c-713cb09842c6';
const SF_TENANT = process.env.SF_TENANT || '2';
const LB_EMAIL = process.env.LB_EMAIL || 'info@spotless.homes';

// LB canonical pipeline (see src/leads/canonical-status.ts comment in schema)
const LB_TERMINALS = new Set(['lost', 'cancelled', 'no_show', 'archived', 'completed']);

// SF→LB outcome mapping (from src/booking-orchestrator/booking-runtime.ts vocab).
// Used to flag unsupported sfJobOutcome values surfaced from SF events.
const KNOWN_SF_OUTCOMES = new Set([
  'pending', 'in_progress', 'scheduled', 'rescheduled', 'cancelled', 'completed',
]);

(async () => {
  const p = new PrismaClient();

  // ─── 1. Connection block ──────────────────────────────────────────
  console.log('═══ 1. CONNECTION STATUS (sfTenantId=' + SF_TENANT + ') ═══');
  const conns = await p.sfConnection.findMany({
    where: { OR: [{ sfTenantId: SF_TENANT }, { userId: LB_USER }] },
    select: {
      id: true, userId: true, sfTenantId: true, status: true, isActive: true,
      inboundSubscriptionId: true, signatureKeyId: true, orchestrationTokenKid: true,
      tokenPrefix: true, tokenIssuedAt: true, tokenExpiresAt: true,
      previousOrchestrationToken: true, previousTokenExpiresAt: true,
      rotationPending: true, pendingRotationKid: true,
      disconnectInitiator: true, disconnectedAt: true,
      lastErrorAt: true, lastErrorMessage: true,
      connectedAt: true, updatedAt: true,
    },
  });
  for (const c of conns) {
    console.log('  conn=' + c.id);
    console.log('    userId=' + c.userId + ' sfTenantId=' + c.sfTenantId);
    console.log('    status=' + c.status + ' isActive=' + c.isActive);
    console.log('    signatureKeyId=' + c.signatureKeyId + ' orchestrationTokenKid=' + c.orchestrationTokenKid);
    console.log('    tokenPrefix=' + c.tokenPrefix + ' tokenIssuedAt=' + c.tokenIssuedAt?.toISOString());
    console.log('    tokenExpiresAt=' + (c.tokenExpiresAt?.toISOString() || '<none>'));
    console.log('    previousToken=' + (c.previousOrchestrationToken ? '<present, expires=' + c.previousTokenExpiresAt?.toISOString() + '>' : '<none>'));
    console.log('    rotationPending=' + c.rotationPending + ' pendingKid=' + (c.pendingRotationKid || '<none>'));
    console.log('    disconnectInitiator=' + (c.disconnectInitiator || '<none>') + ' disconnectedAt=' + (c.disconnectedAt?.toISOString() || '<none>'));
    console.log('    lastError=' + (c.lastErrorMessage || '<none>'));
    console.log('    inboundSubscriptionId=' + c.inboundSubscriptionId);

    if (c.inboundSubscriptionId) {
      const sub = await p.crmWebhookSubscription.findUnique({
        where: { id: c.inboundSubscriptionId },
        select: { id: true, isActive: true, direction: true, events: true, webhookUrl: true, updatedAt: true },
      });
      console.log('    SUBSCRIPTION:');
      console.log('      id=' + sub?.id + ' isActive=' + sub?.isActive + ' direction=' + sub?.direction);
      console.log('      events=' + JSON.stringify(sub?.events));
      console.log('      webhookUrl=' + sub?.webhookUrl);
    }
  }

  console.log('');
  console.log('  Last connection.connected event:');
  const cc = await p.sfInboundEvent.findFirst({
    where: { userId: LB_USER, eventType: 'connection.connected' },
    orderBy: { receivedAt: 'desc' },
    select: { eventId: true, status: true, result: true, receivedAt: true, processingError: true },
  });
  console.log('    ' + (cc
    ? ('eid=' + cc.eventId + ' status=' + cc.status + ' result=' + (cc.result || '-') + ' at=' + cc.receivedAt.toISOString() + (cc.processingError ? ' ERR=' + cc.processingError.slice(0, 100) : ''))
    : '<none>'));

  // ─── 2. Lead/conversation/runtime statuses ─────────────────────────
  console.log('');
  console.log('═══ 2. LEAD / CONVERSATION / RUNTIME ═══');
  const leads = await p.lead.findMany({
    where: {
      userId: LB_USER,
      OR: [
        { sfJobId: { not: null } },
        { status: { notIn: Array.from(LB_TERMINALS) } },
      ],
    },
    select: {
      id: true, customerName: true, platform: true, status: true,
      sfJobId: true, sfJobMappedAt: true, sfJobOutcome: true, sfJobOutcomeAt: true, sfLastEventAt: true,
      statusSource: true, statusUpdatedAt: true,
      threadId: true,
      createdAt: true, updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  });
  console.log('  total leads in scope: ' + leads.length);

  const mismatchRows = [];
  const staleRows = [];
  const unsupportedOutcomes = [];
  const duplicateSfJobs = new Map();

  for (const lead of leads) {
    // Detect duplicate sfJobId mappings (two LB leads pointing at the same SF job).
    if (lead.sfJobId) {
      if (!duplicateSfJobs.has(lead.sfJobId)) duplicateSfJobs.set(lead.sfJobId, []);
      duplicateSfJobs.get(lead.sfJobId).push(lead.id);
    }

    let runtime = null;
    if (lead.threadId) {
      const tcs = await p.threadContext.findMany({
        where: { conversationId: lead.threadId },
        select: {
          conversationState: true, conversationStateAt: true,
          aiStatus: true, aiStatusAt: true,
          bookingState: true, bookingStateAt: true,
          bookingRequestedAt: true,
          handoffRequestedAt: true, handoffResolvedAt: true,
        },
      });
      runtime = tcs[0] || null;
    }

    // Mismatch detection: LB status vs SF-mirrored outcome.
    // Considered a mismatch if SF says terminal (completed/cancelled) but
    // LB is still in an active pipeline state, OR vice versa.
    let mismatch = 'no';
    let mismatchDetail = '';
    if (lead.sfJobOutcome) {
      const lbTerminal = LB_TERMINALS.has(lead.status);
      const sfTerminal = ['completed', 'cancelled'].includes(lead.sfJobOutcome);
      if (sfTerminal && !lbTerminal) {
        mismatch = 'yes';
        mismatchDetail = 'SF=' + lead.sfJobOutcome + ' (terminal) but LB=' + lead.status + ' (active)';
        mismatchRows.push({ leadId: lead.id, ...{ lb: lead.status, sf: lead.sfJobOutcome } });
      } else if (lbTerminal && !sfTerminal && lead.sfJobOutcome !== 'pending') {
        mismatch = 'yes';
        mismatchDetail = 'LB=' + lead.status + ' (terminal) but SF=' + lead.sfJobOutcome + ' (active)';
        mismatchRows.push({ leadId: lead.id, ...{ lb: lead.status, sf: lead.sfJobOutcome } });
      }
      if (!KNOWN_SF_OUTCOMES.has(lead.sfJobOutcome)) {
        unsupportedOutcomes.push({ leadId: lead.id, outcome: lead.sfJobOutcome });
      }
    }

    // Stale: SF-linked lead whose sfLastEventAt is >7d old AND not terminal in either system.
    if (lead.sfJobId && !LB_TERMINALS.has(lead.status)) {
      const lastEvtMs = lead.sfLastEventAt?.getTime() || 0;
      const sevenDaysAgo = Date.now() - 7 * 86400 * 1000;
      if (!lastEvtMs || lastEvtMs < sevenDaysAgo) {
        staleRows.push({
          leadId: lead.id,
          lbStatus: lead.status,
          sfJobOutcome: lead.sfJobOutcome,
          sfLastEventAt: lead.sfLastEventAt?.toISOString() || '<never>',
          ageDays: lastEvtMs ? Math.round((Date.now() - lastEvtMs) / 86400000) : 'N/A',
        });
      }
    }

    console.log('  ─ lead=' + lead.id);
    console.log('      customer=' + (lead.customerName || '<noname>') + ' platform=' + lead.platform);
    console.log('      LB status=' + lead.status + ' (source=' + (lead.statusSource || '<none>') + ', at=' + (lead.statusUpdatedAt?.toISOString() || '<never>') + ')');
    console.log('      SF link: sfJobId=' + (lead.sfJobId || '<unlinked>') + ' mappedAt=' + (lead.sfJobMappedAt?.toISOString() || '<n/a>'));
    console.log('      SF outcome: ' + (lead.sfJobOutcome || '<none>') + (lead.sfJobOutcomeAt ? ' (at=' + lead.sfJobOutcomeAt.toISOString() + ')' : ''));
    console.log('      SF lastEventAt=' + (lead.sfLastEventAt?.toISOString() || '<never>'));
    if (runtime) {
      console.log('      runtime: conversationState=' + (runtime.conversationState || '<unset>') + ' aiStatus=' + (runtime.aiStatus || '<unset>'));
      console.log('               bookingState=' + (runtime.bookingState || '<unset>') + ' bookingRequestedAt=' + (runtime.bookingRequestedAt?.toISOString() || '<never>'));
      console.log('               handoffRequestedAt=' + (runtime.handoffRequestedAt?.toISOString() || '<never>') + ' resolvedAt=' + (runtime.handoffResolvedAt?.toISOString() || '<never>'));
    } else {
      console.log('      runtime: <no ThreadContext for threadId=' + (lead.threadId || '<no thread>') + '>');
    }
    console.log('      MISMATCH? ' + mismatch + (mismatchDetail ? ' (' + mismatchDetail + ')' : ''));
  }

  // ─── 3. Diagnostics: stale / unsupported / duplicates / disconnected / rejected ──
  console.log('');
  console.log('═══ 3. DIAGNOSTICS ═══');

  console.log('  ─ Stale statuses (SF-linked, non-terminal, >7d since last SF event):');
  if (staleRows.length === 0) console.log('    <none>');
  else staleRows.forEach(s => console.log('    lead=' + s.leadId + ' LB=' + s.lbStatus + ' SF=' + (s.sfJobOutcome || '<none>') + ' lastEvt=' + s.sfLastEventAt + ' (' + s.ageDays + 'd)'));

  console.log('');
  console.log('  ─ Unsupported sfJobOutcome values:');
  if (unsupportedOutcomes.length === 0) console.log('    <none>');
  else unsupportedOutcomes.forEach(u => console.log('    lead=' + u.leadId + ' outcome=' + u.outcome));

  console.log('');
  console.log('  ─ Duplicate sfJobId mappings (1 SF job linked from >1 LB lead):');
  let anyDup = false;
  for (const [sfJobId, leadIds] of duplicateSfJobs) {
    if (leadIds.length > 1) {
      console.log('    sfJobId=' + sfJobId + ' → leads=' + JSON.stringify(leadIds));
      anyDup = true;
    }
  }
  if (!anyDup) console.log('    <none>');

  console.log('');
  console.log('  ─ Missing SF link (active LB lead created post-canary, sfJobId=null):');
  // "post-canary" = createdAt >= connect time 15:47Z today
  const connectAt = new Date('2026-05-30T15:47:00Z');
  const missingLink = leads.filter(l => !l.sfJobId && l.createdAt >= connectAt && !LB_TERMINALS.has(l.status));
  if (missingLink.length === 0) console.log('    <none>');
  else missingLink.forEach(l => console.log('    lead=' + l.id + ' platform=' + l.platform + ' status=' + l.status + ' created=' + l.createdAt.toISOString()));

  console.log('');
  console.log('  ─ Old disconnected sf_connection rows for user (status=disconnected/revoked or isActive=false):');
  const dead = conns.filter(c => !c.isActive || c.status === 'disconnected' || c.status === 'revoked');
  if (dead.length === 0) console.log('    <none>');
  else dead.forEach(c => console.log('    conn=' + c.id + ' status=' + c.status + ' sfTenantId=' + c.sfTenantId + ' disconnectedAt=' + (c.disconnectedAt?.toISOString() || '<n/a>')));

  console.log('');
  console.log('  ─ Recent sf_inbound_events for user — rejected / noop / deferred / error:');
  const bad = await p.sfInboundEvent.findMany({
    where: {
      userId: LB_USER,
      status: { in: ['noop', 'deferred', 'stale', 'unmapped_status', 'unauthorized'] },
    },
    orderBy: { receivedAt: 'desc' },
    take: 15,
    select: { eventId: true, eventType: true, status: true, result: true, receivedAt: true, processingError: true },
  });
  if (bad.length === 0) console.log('    <none>');
  else bad.forEach(e => console.log('    ' + e.receivedAt.toISOString() + ' ' + e.eventType + ' status=' + e.status + ' result=' + (e.result || '-') + ' eid=' + e.eventId + (e.processingError ? ' ERR=' + e.processingError.slice(0, 80) : '')));

  await p.$disconnect();
})().catch((e) => { console.error('ERR:', e.message); console.error(e.stack); process.exit(1); });
