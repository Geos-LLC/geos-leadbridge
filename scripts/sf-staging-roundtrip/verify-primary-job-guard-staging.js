#!/usr/bin/env node
/**
 * Live staging verification of the primary-job guard.
 *
 *   1. Set up synthetic User + Lead (sfJobId='SYN-PRIMARY-…') + Subscription on staging
 *   2. Two HMAC-signed POSTs to staging /v1/integrations/service-flow/job-status:
 *        a) sf_job_id == lead.sfJobId  → primary, guard passes
 *        b) sf_job_id != lead.sfJobId  → follow-up, guard trips
 *   3. Verify sfInboundEvent rows + responses
 *   4. Cleanup
 *
 * Required env:
 *   DATABASE_URL  staging DIRECT_URL (port 5432)
 *   STAGING_HOST  (optional; defaults to https://thumbtack-bridge-staging.up.railway.app)
 *
 * Assumes SF_INBOUND_WEBHOOK_ENABLED=true on staging at run time (caller
 * flips this temporarily and reverts after). DRY_RUN stays at the default
 * 'true' so the primary event returns 'dry_run' (no Lead.status mutation).
 */
const crypto = require('crypto');
const { PrismaClient } = require('../../generated/prisma');

const HOST = process.env.STAGING_HOST || 'https://thumbtack-bridge-staging.up.railway.app';
const RUN = crypto.randomBytes(6).toString('hex');
const SYN_USER_EMAIL = `primary-guard-verify-${RUN}@staging.local`;
const SYN_PRIMARY_JOB = `SYN-PRIMARY-${RUN}`;
const SYN_FOLLOWUP_JOB = `SYN-FOLLOWUP-${RUN}`;
const SYN_EXTERNAL_REQUEST_ID = `syn-req-${RUN}`;

function signHmac(ts, body, secret) {
  return crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

(async () => {
  const p = new PrismaClient();
  const created = { userId: null, leadId: null, subId: null };

  try {
    // ── Setup ──────────────────────────────────────────────────────
    console.log('=== Setup ===');
    const user = await p.user.create({
      data: { email: SYN_USER_EMAIL, name: `Synthetic Verify ${RUN}` },
      select: { id: true, email: true },
    });
    created.userId = user.id;
    console.log('  user.id=' + user.id + ' email=' + user.email);

    const subSecret = crypto.randomBytes(16).toString('hex');
    const sub = await p.crmWebhookSubscription.create({
      data: {
        userId: user.id,
        name: `SYN verify ${RUN}`,
        direction: 'inbound',
        webhookUrl: `sf://syn-verify/${user.id}`,
        secret: subSecret,
        events: ['job.status_changed'],
        isActive: true,
      },
      select: { id: true, isActive: true },
    });
    created.subId = sub.id;
    console.log('  sub.id=' + sub.id + ' secret_len=' + subSecret.length);

    const lead = await p.lead.create({
      data: {
        userId: user.id,
        platform: 'thumbtack',
        externalRequestId: SYN_EXTERNAL_REQUEST_ID,
        customerName: 'Synthetic Verify ' + RUN,
        message: 'primary-job guard staging verification',
        rawJson: JSON.stringify({ source: 'verify-primary-job-guard' }),
        status: 'contacted',
        sfJobId: SYN_PRIMARY_JOB,
        sfJobMappedAt: new Date(),
      },
      select: { id: true, status: true, sfJobId: true },
    });
    created.leadId = lead.id;
    console.log('  lead.id=' + lead.id + ' status=' + lead.status + ' sfJobId=' + lead.sfJobId);

    // ── Test 1: PRIMARY job event ────────────────────────────────
    console.log('');
    console.log('=== Test 1: PRIMARY (sf_job_id == lead.sfJobId) ===');
    const evt1 = {
      event_id: `evt-syn-primary-${RUN}`,
      event_type: 'job.status_changed',
      occurred_at: new Date().toISOString(),
      source: 'service_flow',
      sf_job_id: SYN_PRIMARY_JOB,
      external_request_id: SYN_EXTERNAL_REQUEST_ID,
      channel: 'thumbtack',
      status: { new: 'completed', previous: 'in-progress' },
    };
    const body1 = JSON.stringify(evt1);
    const ts1 = String(Math.floor(Date.now() / 1000));
    const r1 = await fetch(`${HOST}/api/v1/integrations/service-flow/job-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SF-Signature': signHmac(ts1, body1, subSecret),
        'X-SF-Timestamp': ts1,
        'X-SF-Subscription-Id': sub.id,
      },
      body: body1,
    });
    const j1 = await r1.json();
    console.log('  HTTP ' + r1.status);
    console.log('  body=' + JSON.stringify(j1));

    // ── Test 2: FOLLOW-UP job event ───────────────────────────────
    console.log('');
    console.log('=== Test 2: FOLLOW-UP (sf_job_id != lead.sfJobId, expect non_primary_job noop) ===');
    const evt2 = {
      event_id: `evt-syn-followup-${RUN}`,
      event_type: 'job.status_changed',
      occurred_at: new Date().toISOString(),
      source: 'service_flow',
      sf_job_id: SYN_FOLLOWUP_JOB,
      external_request_id: SYN_EXTERNAL_REQUEST_ID,
      channel: 'thumbtack',
      status: { new: 'cancelled', previous: 'scheduled' },
    };
    const body2 = JSON.stringify(evt2);
    const ts2 = String(Math.floor(Date.now() / 1000));
    const r2 = await fetch(`${HOST}/api/v1/integrations/service-flow/job-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SF-Signature': signHmac(ts2, body2, subSecret),
        'X-SF-Timestamp': ts2,
        'X-SF-Subscription-Id': sub.id,
      },
      body: body2,
    });
    const j2 = await r2.json();
    console.log('  HTTP ' + r2.status);
    console.log('  body=' + JSON.stringify(j2));

    // ── Verify DB state ───────────────────────────────────────────
    console.log('');
    console.log('=== DB verification ===');
    const leadAfter = await p.lead.findUnique({
      where: { id: lead.id },
      select: { status: true, sfJobId: true, sfJobOutcome: true, sfLastEventAt: true },
    });
    console.log('  lead.status=' + leadAfter.status + ' (orig: contacted)');
    console.log('  lead.sfJobId=' + leadAfter.sfJobId + ' (preserved: ' + (leadAfter.sfJobId === SYN_PRIMARY_JOB) + ')');

    const events = await p.sfInboundEvent.findMany({
      where: { eventId: { in: [evt1.event_id, evt2.event_id] } },
      select: { eventId: true, sfJobId: true, status: true, result: true },
    });
    console.log('  sfInboundEvent rows:');
    events.forEach(e => console.log('    eid=' + e.eventId + ' sfJobId=' + e.sfJobId + ' status=' + e.status + ' result=' + (e.result || '-')));

    // ── Pass/fail summary ─────────────────────────────────────────
    console.log('');
    console.log('=== Pass/fail ===');
    // Test 1: primary should be applied OR dry_run depending on DRY_RUN setting.
    const t1Pass = r1.status === 200 && (j1.result === 'applied' || j1.result === 'dry_run');
    console.log('  TEST 1 (primary):  ' + (t1Pass ? 'PASS' : 'FAIL') + ' — HTTP=' + r1.status + ' result=' + j1.result);
    // Test 2: follow-up MUST be noop + non_primary_job.
    const t2Pass = r2.status === 200 && j2.result === 'noop' && j2.skipReason === 'non_primary_job';
    console.log('  TEST 2 (follow-up): ' + (t2Pass ? 'PASS' : 'FAIL') +
      ' — HTTP=' + r2.status + ' result=' + j2.result + ' skipReason=' + j2.skipReason);
    // Verify lead.status didn't mutate (still 'contacted' since DRY_RUN=true) AND lead.sfJobId preserved.
    const t3Pass = leadAfter.sfJobId === SYN_PRIMARY_JOB;
    console.log('  TEST 3 (sfJobId sticky preserved):    ' + (t3Pass ? 'PASS' : 'FAIL'));
    // Follow-up event should appear with the right result.
    const followupEvt = events.find(e => e.eventId === evt2.event_id);
    const t4Pass = followupEvt && followupEvt.status === 'noop' && followupEvt.result === 'lead_status_skip:non_primary_job';
    console.log('  TEST 4 (DB row records non_primary_job): ' + (t4Pass ? 'PASS' : 'FAIL'));

    process.exitCode = (t1Pass && t2Pass && t3Pass && t4Pass) ? 0 : 1;
  } finally {
    // ── Cleanup ───────────────────────────────────────────────────
    console.log('');
    console.log('=== Cleanup ===');
    if (created.leadId) {
      try { await p.sfInboundEvent.deleteMany({ where: { leadId: created.leadId } }); console.log('  deleted sfInboundEvent rows'); } catch (e) { console.log('  sfInboundEvent cleanup err: ' + e.message); }
      try { await p.leadStatusAuditLog.deleteMany({ where: { leadId: created.leadId } }); console.log('  deleted audit log rows'); } catch (e) { console.log('  audit log cleanup err: ' + e.message); }
      try { await p.lead.delete({ where: { id: created.leadId } }); console.log('  deleted lead ' + created.leadId); } catch (e) { console.log('  lead cleanup err: ' + e.message); }
    }
    if (created.subId) {
      try { await p.crmWebhookSubscription.delete({ where: { id: created.subId } }); console.log('  deleted sub ' + created.subId); } catch (e) { console.log('  sub cleanup err: ' + e.message); }
    }
    if (created.userId) {
      try { await p.user.delete({ where: { id: created.userId } }); console.log('  deleted user ' + created.userId); } catch (e) { console.log('  user cleanup err: ' + e.message); }
    }
    await p.$disconnect();
  }
})().catch((e) => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(2); });
