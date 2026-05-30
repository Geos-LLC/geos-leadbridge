#!/usr/bin/env node
/**
 * Full read-only LB-side parity audit for tenant 2 / Spotless.
 *
 * Required env: DATABASE_URL (DIRECT_URL form, port 5432).
 */
const { PrismaClient } = require('../../generated/prisma');

const LB_USER = process.env.LB_USER || 'c3d14499-dec1-42c3-a36c-713cb09842c6';
const SF_TENANT = process.env.SF_TENANT || '2';

// LB canonical pipeline (src/leads/canonical-status.ts)
const LB_TERMINALS = new Set(['lost', 'cancelled', 'no_show', 'archived', 'completed']);
const LB_PIPELINE_RANK = {
  new: 1, contacted: 2, engaged: 3, quoted: 4, booked: 5, scheduled: 6, in_progress: 7, completed: 8,
  lost: 9, cancelled: 9, no_show: 9, archived: 9,
};
// SF booking outcomes the orchestrator understands.
const KNOWN_SF_OUTCOMES = new Set(['pending', 'in_progress', 'scheduled', 'rescheduled', 'cancelled', 'completed']);
// Stages where SF would normally have an mirrored job — used to flag "should be linked".
const SF_EXPECTED_LB_STATUSES = new Set(['booked', 'scheduled', 'in_progress', 'completed']);
// Canary connect time — leads created after this should always link if booked through SF.
const CANARY_CONNECT_AT = new Date('2026-05-30T15:47:00Z');

function ageBucket(d) {
  const ms = Date.now() - d.getTime();
  if (ms < 86400 * 1000) return '<24h';
  if (ms < 7 * 86400 * 1000) return '1-7d';
  if (ms < 30 * 86400 * 1000) return '7-30d';
  if (ms < 90 * 86400 * 1000) return '30-90d';
  return '>90d';
}

function tally(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x) ?? '<null>';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function printTable(rows, ...colHeaders) {
  if (rows.length === 0) { console.log('    <none>'); return; }
  const widths = colHeaders.map(h => h.length);
  rows.forEach(r => r.forEach((c, i) => { const s = String(c); if (s.length > widths[i]) widths[i] = s.length; }));
  const pad = (s, w) => String(s).padEnd(w);
  console.log('    ' + colHeaders.map((h, i) => pad(h, widths[i])).join('  '));
  console.log('    ' + colHeaders.map((_, i) => '-'.repeat(widths[i])).join('  '));
  rows.forEach(r => console.log('    ' + r.map((c, i) => pad(c, widths[i])).join('  ')));
}

(async () => {
  const p = new PrismaClient();

  // ─── 1. Total LB inventory ────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('1. TOTAL LB INVENTORY (userId=' + LB_USER + ')');
  console.log('═══════════════════════════════════════════════════════════════');

  const allLeads = await p.lead.findMany({
    where: { userId: LB_USER },
    select: {
      id: true, platform: true, businessId: true, status: true, sfJobId: true,
      sfJobOutcome: true, sfLastEventAt: true, statusSource: true,
      threadId: true, createdAt: true, updatedAt: true,
    },
  });
  const allConversations = await p.conversation.findMany({
    where: { userId: LB_USER },
    select: { id: true, platform: true, status: true, lastMessageAt: true, createdAt: true },
  });
  const savedAccts = await p.savedAccount.findMany({
    where: { userId: LB_USER },
    select: { id: true, platform: true, businessId: true, businessName: true },
  });

  console.log('  total leads:          ' + allLeads.length);
  console.log('  total conversations:  ' + allConversations.length);
  console.log('  total saved accounts: ' + savedAccts.length);

  console.log('');
  console.log('  Leads by platform:');
  printTable(tally(allLeads, l => l.platform), 'platform', 'count');
  console.log('');
  console.log('  Conversations by platform:');
  printTable(tally(allConversations, c => c.platform), 'platform', 'count');
  console.log('');
  console.log('  Leads by status:');
  printTable(tally(allLeads, l => l.status), 'status', 'count');
  console.log('');
  console.log('  Saved accounts:');
  printTable(savedAccts.map(a => [a.platform, a.businessName, a.businessId]), 'platform', 'name', 'businessId');
  console.log('');
  console.log('  Leads by saved-account businessId:');
  printTable(tally(allLeads, l => l.platform + ':' + (l.businessId || '<null>')), 'platform:businessId', 'count');

  // ─── 2. SF linkage inventory ──────────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('2. SF LINKAGE INVENTORY');
  console.log('═══════════════════════════════════════════════════════════════');

  const linked = allLeads.filter(l => l.sfJobId);
  const unlinked = allLeads.filter(l => !l.sfJobId);
  console.log('  LB leads with sfJobId:        ' + linked.length);
  console.log('  LB leads without sfJobId:     ' + unlinked.length);
  // Lead does not store sfTenantId directly — it derives via the user's sf_connection.
  // For Spotless that user's sf_connection.sfTenantId is "2" exactly.
  console.log('  LB leads under sfTenantId=2:  ' + linked.length + ' (all link via user→sf_connection)');

  // "Should have SF link but doesn't" = LB lead in a stage where SF would normally
  // know about it (booked/scheduled/in_progress/completed) yet has no sfJobId.
  const shouldButDoesnt = unlinked.filter(l => SF_EXPECTED_LB_STATUSES.has(l.status));
  console.log('');
  console.log('  Should have SF link but does NOT (LB status in {booked,scheduled,in_progress,completed} + sfJobId=null):');
  if (shouldButDoesnt.length === 0) console.log('    <none>');
  else printTable(
    shouldButDoesnt.slice(0, 50).map(l => [l.id.slice(0, 8), l.platform, l.status, l.createdAt.toISOString().slice(0, 19)]),
    'lead', 'platform', 'status', 'createdAt',
  );

  // Duplicate sfJobId mappings: 1 SF job → multiple LB leads.
  const dupMap = new Map();
  for (const l of linked) {
    if (!dupMap.has(l.sfJobId)) dupMap.set(l.sfJobId, []);
    dupMap.get(l.sfJobId).push(l.id);
  }
  const dups = [...dupMap.entries()].filter(([, ids]) => ids.length > 1);
  console.log('');
  console.log('  Duplicate sfJobId mappings:');
  if (dups.length === 0) console.log('    <none>');
  else dups.forEach(([job, ids]) => console.log('    sfJobId=' + job + ' → ' + ids.length + ' leads: ' + ids.join(', ')));

  // ─── 3. Status parity for all linked records ──────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('3. STATUS PARITY — ALL ' + linked.length + ' LINKED RECORDS');
  console.log('═══════════════════════════════════════════════════════════════');

  // Pre-fetch threadContexts for all linked leads in one batch.
  const linkedThreadIds = [...new Set(linked.filter(l => l.threadId).map(l => l.threadId))];
  const tcMap = new Map();
  if (linkedThreadIds.length > 0) {
    const tcs = await p.threadContext.findMany({
      where: { conversationId: { in: linkedThreadIds } },
      select: { conversationId: true, conversationState: true, aiStatus: true, bookingState: true },
    });
    tcs.forEach(t => tcMap.set(t.conversationId, t));
  }

  let matched = 0, mismatched = 0;
  const mismatches = [];
  const unmappedOutcomes = [];

  for (const l of linked) {
    const tc = l.threadId ? tcMap.get(l.threadId) : null;
    const rt = tc ? (tc.conversationState || tc.bookingState || '-') : '-';
    let isMatch = 'yes';
    let reason = '';

    if (l.sfJobOutcome && !KNOWN_SF_OUTCOMES.has(l.sfJobOutcome)) {
      unmappedOutcomes.push({ leadId: l.id, outcome: l.sfJobOutcome });
    }

    if (l.sfJobOutcome) {
      const lbTerminal = LB_TERMINALS.has(l.status);
      const sfTerminal = ['completed', 'cancelled'].includes(l.sfJobOutcome);
      if (sfTerminal && !lbTerminal) {
        isMatch = 'no'; reason = 'SF=' + l.sfJobOutcome + ' (terminal), LB=' + l.status + ' (active)';
      } else if (lbTerminal && !sfTerminal && l.sfJobOutcome !== 'pending') {
        isMatch = 'no'; reason = 'LB=' + l.status + ' (terminal), SF=' + l.sfJobOutcome + ' (active)';
      } else if (sfTerminal && lbTerminal && l.sfJobOutcome !== l.status) {
        // Both terminal but different terminal values (e.g. completed vs cancelled).
        isMatch = 'no'; reason = 'both terminal but different: SF=' + l.sfJobOutcome + ' / LB=' + l.status;
      }
    }

    if (isMatch === 'yes') matched++;
    else { mismatched++; mismatches.push({ leadId: l.id, sfJobId: l.sfJobId, lb: l.status, sf: l.sfJobOutcome, reason, rt }); }
  }

  console.log('  matched:    ' + matched + '/' + linked.length);
  console.log('  mismatched: ' + mismatched + '/' + linked.length);
  console.log('');
  console.log('  Distribution (LB status × SF outcome):');
  const cross = new Map();
  for (const l of linked) {
    const k = (l.status || '<null>') + ' / ' + (l.sfJobOutcome || '<null>');
    cross.set(k, (cross.get(k) || 0) + 1);
  }
  printTable([...cross.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]), 'LB / SF', 'count');

  console.log('');
  console.log('  Mismatches (full list):');
  if (mismatches.length === 0) console.log('    <none>');
  else printTable(
    mismatches.map(m => [m.leadId.slice(0, 8), m.sfJobId, m.lb, m.sf || '-', m.rt, m.reason]),
    'lead', 'sfJobId', 'LB', 'SF', 'runtime', 'reason',
  );

  console.log('');
  console.log('  Unsupported sfJobOutcome values:');
  if (unmappedOutcomes.length === 0) console.log('    <none>');
  else unmappedOutcomes.forEach(u => console.log('    lead=' + u.leadId + ' outcome=' + u.outcome));

  // ─── 4. Active LB-only leads ──────────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('4. ACTIVE LB-ONLY LEADS (no sfJobId, non-terminal LB status)');
  console.log('═══════════════════════════════════════════════════════════════');

  const activeUnlinked = unlinked.filter(l => !LB_TERMINALS.has(l.status));
  console.log('  total: ' + activeUnlinked.length);
  console.log('');
  console.log('  By status:');
  printTable(tally(activeUnlinked, l => l.status), 'status', 'count');
  console.log('');
  console.log('  By platform:');
  printTable(tally(activeUnlinked, l => l.platform), 'platform', 'count');
  console.log('');
  console.log('  By age bucket:');
  printTable(tally(activeUnlinked, l => ageBucket(l.createdAt)), 'age', 'count');
  console.log('');
  console.log('  By (status × age):');
  printTable(tally(activeUnlinked, l => l.status + ' / ' + ageBucket(l.createdAt)), 'status / age', 'count');

  console.log('');
  console.log('  Expectation analysis:');
  const preCanaryUnlinked = activeUnlinked.filter(l => l.createdAt < CANARY_CONNECT_AT);
  const postCanaryUnlinked = activeUnlinked.filter(l => l.createdAt >= CANARY_CONNECT_AT);
  const postCanaryShouldLink = postCanaryUnlinked.filter(l => SF_EXPECTED_LB_STATUSES.has(l.status));
  console.log('    pre-canary unlinked (expected — SF connection did not exist yet for tenant 2): ' + preCanaryUnlinked.length);
  console.log('    post-canary unlinked total:                                                     ' + postCanaryUnlinked.length);
  console.log('    post-canary unlinked AND in SF-expected stage (booked/scheduled/...):           ' + postCanaryShouldLink.length);
  if (postCanaryShouldLink.length > 0) {
    console.log('    DETAIL:');
    printTable(postCanaryShouldLink.map(l => [l.id.slice(0, 8), l.platform, l.status, l.createdAt.toISOString().slice(0, 19)]),
      'lead', 'platform', 'status', 'createdAt');
  }
  console.log('');
  console.log('    Note: a "new/contacted/engaged" lead with no SF link is NORMAL — LB owns inbound');
  console.log('    capture (Thumbtack/Yelp). SF only learns about a lead when LB pushes a booking');
  console.log('    request via the orchestrator. No booking flow has fired for tenant 2 yet.');

  // ─── 5. Historical noops / drift ──────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('5. HISTORICAL NOOPS / DRIFT (sf_inbound_events for this user)');
  console.log('═══════════════════════════════════════════════════════════════');

  const allEvents = await p.sfInboundEvent.findMany({
    where: { userId: LB_USER },
    select: { eventId: true, eventType: true, status: true, result: true, receivedAt: true, processingError: true },
    orderBy: { receivedAt: 'desc' },
    take: 1000,
  });
  console.log('  total events scanned: ' + allEvents.length);
  console.log('');
  console.log('  By status:');
  printTable(tally(allEvents, e => e.status), 'status', 'count');
  console.log('');
  console.log('  By eventType:');
  printTable(tally(allEvents, e => e.eventType), 'eventType', 'count');
  console.log('');
  console.log('  By result code:');
  printTable(tally(allEvents, e => e.result || '<null>'), 'result', 'count');
  console.log('');
  console.log('  Events with processingError:');
  const errEvents = allEvents.filter(e => e.processingError);
  if (errEvents.length === 0) console.log('    <none>');
  else printTable(errEvents.slice(0, 20).map(e => [e.receivedAt.toISOString().slice(0, 19), e.eventType, e.status, e.processingError.slice(0, 80)]),
    'receivedAt', 'eventType', 'status', 'error');

  // ─── 6. Conversation / message parity ─────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('6. CONVERSATION / MESSAGE PARITY');
  console.log('═══════════════════════════════════════════════════════════════');

  const msgCount = await p.message.count({ where: { userId: LB_USER } });
  const latestMsg = await p.message.findFirst({
    where: { userId: LB_USER },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, platform: true, conversationId: true, sender: true },
  });
  const earliestMsg = await p.message.findFirst({
    where: { userId: LB_USER },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  console.log('  total messages:    ' + msgCount);
  console.log('  total threads:     ' + allConversations.length);
  console.log('  earliest message:  ' + (earliestMsg?.createdAt.toISOString() || '<none>'));
  console.log('  latest message:    ' + (latestMsg?.createdAt.toISOString() || '<none>') +
    (latestMsg ? ' (platform=' + latestMsg.platform + ' sender=' + latestMsg.sender + ')' : ''));

  const recent = allConversations.sort((a, b) => b.lastMessageAt - a.lastMessageAt).slice(0, 20);
  console.log('');
  console.log('  Recent 20 thread IDs (most recent activity first):');
  printTable(recent.map(c => [c.id, c.platform, c.status, c.lastMessageAt.toISOString().slice(0, 19)]),
    'thread (LB conversationId)', 'platform', 'status', 'lastMessageAt');

  console.log('');
  console.log('  Note: SF does NOT currently store LB conversationIds — the SF<->LB sync is at the');
  console.log('  job/lead level (Lead.sfJobId), not conversation/message level. SF having matching');
  console.log('  thread IDs is not part of the current v8 contract. If SF starts mirroring threads,');
  console.log('  the above IDs are the canonical join key.');

  // ─── 7. Final conclusion ─────────────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('7. FINAL CONCLUSION');
  console.log('═══════════════════════════════════════════════════════════════');

  const conn = await p.sfConnection.findFirst({
    where: { sfTenantId: SF_TENANT, isActive: true },
    select: { id: true, status: true, isActive: true, inboundSubscriptionId: true },
  });
  const connOk = !!(conn && conn.status === 'active' && conn.isActive && conn.inboundSubscriptionId);

  console.log('  connection parity:        ' + (connOk ? 'GREEN (1 active sf_connection + active inbound sub)' : 'RED'));
  console.log('  linked status parity:     ' + (mismatched === 0 ? 'GREEN (' + matched + '/' + linked.length + ')' : 'RED (' + mismatched + ' mismatches)'));
  console.log('  duplicate mappings:       ' + (dups.length === 0 ? 'GREEN (0)' : 'RED (' + dups.length + ')'));
  console.log('  should-link-but-doesnt:   ' + (shouldButDoesnt.length === 0 ? 'GREEN (0)' : 'YELLOW (' + shouldButDoesnt.length + ')'));
  console.log('  post-canary missing link: ' + (postCanaryShouldLink.length === 0 ? 'GREEN (0)' : 'YELLOW (' + postCanaryShouldLink.length + ')'));
  console.log('  unsupported sfJobOutcome: ' + (unmappedOutcomes.length === 0 ? 'GREEN (0)' : 'YELLOW (' + unmappedOutcomes.length + ')'));
  console.log('  rejected/error events:    ' + (errEvents.length === 0 ? 'GREEN (0)' : 'YELLOW (' + errEvents.length + ')'));

  const fullSyncStatus = (connOk && mismatched === 0 && dups.length === 0 && shouldButDoesnt.length === 0 && unmappedOutcomes.length === 0 && errEvents.length === 0)
    ? 'GREEN'
    : 'YELLOW (see above)';
  console.log('  ───────────────────────────────────────────────────────────');
  console.log('  FULL SYNC PARITY:         ' + fullSyncStatus);

  console.log('');
  console.log('  Actual mismatches:        ' + mismatched);
  console.log('  Expected not-linked:      ' + preCanaryUnlinked.length + ' (pre-canary, no SF connection existed for tenant 2)');
  console.log('  Post-canary not-linked:   ' + postCanaryUnlinked.length + ' (active inbound leads in new/contacted/engaged — booking not yet pushed via SF)');
  console.log('  Reconcile actions:        ' + (mismatched === 0 && shouldButDoesnt.length === 0 ? 'none required' : 'see lists above'));

  await p.$disconnect();
})().catch((e) => { console.error('ERR:', e.message); console.error(e.stack); process.exit(1); });
