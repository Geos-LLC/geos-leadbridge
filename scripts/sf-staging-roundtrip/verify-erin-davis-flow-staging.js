#!/usr/bin/env node
/**
 * Erin-Davis-shape validation against the staging deployment.
 *
 *   1. Set up synthetic User + Lead mirroring Erin's situation
 *      (status='scheduled', sfJobId=null, syncStatus=null,
 *       customerPhone present, externalRequestId present)
 *   2. POST HMAC-signed match result to the receiver:
 *        { confidence: 'exact', match_basis: 'externalRequestId',
 *          sf_status: 'completed' }
 *      Expect: linked + status_updated, Lead.sfJobId set,
 *              Lead.status flipped from scheduled → completed.
 *   3. POST a SECOND match result with a DIFFERENT sf_job_id.
 *      Expect: conflict; original sfJobId preserved.
 *   4. POST a confidence='low' result for a fresh synthetic lead.
 *      Expect: needs_review; sfJobId stays null.
 *   5. Cleanup synthetic data.
 *
 * Required env:
 *   DATABASE_URL  staging DIRECT_URL (port 5432)
 *   SHARED        SF_LB_PROVISIONING_SHARED_SECRET
 */
const crypto = require('crypto');
const { PrismaClient } = require('../../generated/prisma');

const HOST = process.env.STAGING_HOST || 'https://thumbtack-bridge-staging.up.railway.app';
const SHARED = process.env.SHARED;
if (!SHARED) { console.error('SHARED env required (SF_LB_PROVISIONING_SHARED_SECRET)'); process.exit(1); }

const RUN = crypto.randomBytes(6).toString('hex');

function sign(ts, body) {
  return crypto.createHmac('sha256', SHARED).update(`${ts}.${body}`).digest('hex');
}
async function postReceiver(rows) {
  const body = JSON.stringify({ rows });
  const ts = String(Math.floor(Date.now() / 1000));
  const r = await fetch(`${HOST}/api/v1/integrations/sf/link-leads-bulk`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SF-LB-Timestamp': ts,
      'X-SF-LB-Signature': sign(ts, body),
    },
    body,
  });
  return { status: r.status, body: await r.json() };
}

(async () => {
  const p = new PrismaClient();
  const created = { userId: null, leadIds: [] };
  let allPass = true;
  function check(name, cond, detail = '') {
    console.log('  ' + (cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : ''));
    if (!cond) allPass = false;
  }

  try {
    console.log('=== Setup ===');
    const user = await p.user.create({
      data: { email: `erin-flow-${RUN}@staging.local`, name: `Erin Flow Verify ${RUN}` },
      select: { id: true },
    });
    created.userId = user.id;
    console.log('  user=' + user.id);

    const erinLike = await p.lead.create({
      data: {
        userId: user.id,
        platform: 'thumbtack',
        externalRequestId: `syn-erin-${RUN}`,
        customerName: 'Erin Synthetic',
        customerPhone: '8131234567',
        message: 'erin-davis flow validation',
        rawJson: JSON.stringify({}),
        status: 'scheduled',           // matches Erin's current state
        sfJobId: null,                 // matches Erin
        syncedToCrm: false,
        statusSource: 'platform_sync',
        statusUpdatedAt: new Date('2026-05-06T19:19:21.000Z'),
      },
      select: { id: true, status: true, sfJobId: true, syncStatus: true },
    });
    created.leadIds.push(erinLike.id);
    console.log('  erin-like lead=' + erinLike.id);
    console.log('    status=' + erinLike.status + ' sfJobId=' + erinLike.sfJobId + ' syncStatus=' + erinLike.syncStatus);

    // ── Test 1: receiver, exact-match completed ──
    console.log('');
    console.log('=== Test 1: HIGH-CONFIDENCE LINK + STATUS UPDATE ===');
    const r1 = await postReceiver([{
      lb_lead_id: erinLike.id,
      sf_job_id: 'SF-141929',
      sf_customer_id: 'SFC-SPOTLESS-ERIN',
      confidence: 'exact',
      match_basis: 'externalRequestId',
      sf_status: 'completed',
      occurred_at: new Date().toISOString(),
      reason: 'erin_davis_validation',
    }]);
    console.log('  HTTP=' + r1.status);
    console.log('  body=' + JSON.stringify(r1.body));
    check('HTTP 200', r1.status === 200);
    check('ok=true', r1.body.ok === true);
    check('summary.linked=1', r1.body.summary?.linked === 1);
    check('summary.status_updates_applied=1', r1.body.summary?.status_updates_applied === 1);
    check('row result=linked', r1.body.rows?.[0]?.result === 'linked');
    check('row sync_status=linked', r1.body.rows?.[0]?.sync_status === 'linked');
    check('row new_status=completed', r1.body.rows?.[0]?.new_status === 'completed');

    const after1 = await p.lead.findUnique({ where: { id: erinLike.id } });
    check('DB Lead.status === completed', after1.status === 'completed', 'got ' + after1.status);
    check('DB Lead.sfJobId === SF-141929', after1.sfJobId === 'SF-141929', 'got ' + after1.sfJobId);
    check('DB Lead.sfCustomerId === SFC-SPOTLESS-ERIN', after1.sfCustomerId === 'SFC-SPOTLESS-ERIN', 'got ' + after1.sfCustomerId);
    check('DB Lead.syncStatus === linked', after1.syncStatus === 'linked', 'got ' + after1.syncStatus);
    check('DB Lead.sfLastEventAt set', !!after1.sfLastEventAt);

    // ── Test 2: conflict — second match with different sfJobId ──
    console.log('');
    console.log('=== Test 2: CONFLICT — second match with different sfJobId ===');
    const r2 = await postReceiver([{
      lb_lead_id: erinLike.id,
      sf_job_id: 'SF-DIFFERENT-JOB',
      confidence: 'exact',
      match_basis: 'phone',
      sf_status: 'cancelled',
    }]);
    console.log('  body=' + JSON.stringify(r2.body));
    check('row result=conflict', r2.body.rows?.[0]?.result === 'conflict');
    const after2 = await p.lead.findUnique({ where: { id: erinLike.id } });
    check('Lead.sfJobId still SF-141929 (no overwrite)', after2.sfJobId === 'SF-141929', 'got ' + after2.sfJobId);
    check('Lead.status still completed (no flip)', after2.status === 'completed', 'got ' + after2.status);

    // ── Test 3: low-confidence → needs_review ──
    console.log('');
    console.log('=== Test 3: LOW-CONFIDENCE → needs_review ===');
    const erinLowConf = await p.lead.create({
      data: {
        userId: user.id, platform: 'thumbtack',
        externalRequestId: `syn-erin-low-${RUN}`,
        customerName: 'Erin LowConf', customerPhone: '8131234568',
        message: 'low conf test', rawJson: JSON.stringify({}), status: 'contacted',
      },
      select: { id: true },
    });
    created.leadIds.push(erinLowConf.id);
    const r3 = await postReceiver([{
      lb_lead_id: erinLowConf.id,
      sf_job_id: 'SF-MAYBE',
      confidence: 'low',
      match_basis: 'name_platform',
    }]);
    console.log('  body=' + JSON.stringify(r3.body));
    check('row result=needs_review', r3.body.rows?.[0]?.result === 'needs_review');
    const after3 = await p.lead.findUnique({ where: { id: erinLowConf.id } });
    check('Lead.sfJobId still null (no auto-write at low conf)', after3.sfJobId === null);
    check('Lead.syncStatus=needs_review', after3.syncStatus === 'needs_review');

    // ── Test 4: status downgrade protection ──
    // Try to push completed → scheduled. writeStatus's pipeline-downgrade
    // guard should block; result=linked but status_updated=false.
    console.log('');
    console.log('=== Test 4: STATUS DOWNGRADE PROTECTION (completed → scheduled blocked) ===');
    // Re-use the already-linked lead (after1 is already completed/linked).
    const r4 = await postReceiver([{
      lb_lead_id: erinLike.id,
      sf_job_id: 'SF-141929',          // SAME sfJobId — not a conflict
      confidence: 'exact',
      match_basis: 'externalRequestId',
      sf_status: 'confirmed',          // maps to canonical 'scheduled'
    }]);
    console.log('  body=' + JSON.stringify(r4.body));
    check('row result=linked (idempotent)', r4.body.rows?.[0]?.result === 'linked');
    check('row status_updated=false (downgrade blocked)', r4.body.rows?.[0]?.status_updated === false);
    const after4 = await p.lead.findUnique({ where: { id: erinLike.id } });
    check('Lead.status still completed (downgrade protection held)', after4.status === 'completed', 'got ' + after4.status);

    console.log('');
    console.log('=== OVERALL: ' + (allPass ? 'PASS' : 'FAIL') + ' ===');
    process.exitCode = allPass ? 0 : 1;
  } finally {
    console.log('');
    console.log('=== Cleanup ===');
    for (const id of created.leadIds) {
      try { await p.sfInboundEvent.deleteMany({ where: { leadId: id } }); } catch {}
      try { await p.leadStatusAuditLog.deleteMany({ where: { leadId: id } }); } catch {}
      try { await p.lead.delete({ where: { id } }); console.log('  deleted lead ' + id); } catch (e) { console.log('  lead cleanup err: ' + e.message); }
    }
    if (created.userId) {
      try { await p.user.delete({ where: { id: created.userId } }); console.log('  deleted user ' + created.userId); } catch (e) { console.log('  user cleanup err: ' + e.message); }
    }
    await p.$disconnect();
  }
})().catch((e) => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(2); });
