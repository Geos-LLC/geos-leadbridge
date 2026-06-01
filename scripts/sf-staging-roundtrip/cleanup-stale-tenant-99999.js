#!/usr/bin/env node
/**
 * Delete the stale inactive sf_connection row for sf_tenant_id=99999 that
 * belongs to LB user df49d424-… (PR-C2.1 canary, pre-SF-initiated flow).
 * The active row for afa0332d-… is left untouched.
 *
 * Required env: DATABASE_URL (DIRECT_URL form, port 5432).
 */
const { PrismaClient } = require('../../generated/prisma');

const STALE_USER = 'df49d424-d208-45aa-b84b-7f73b6eee0f5';
const STALE_CONN = '4746e8e7-7da3-43c0-ae31-25e2140fe97f';
const STALE_SUB = '09163562-22d8-4f7a-bf30-8167f77e9cf0';
const KEEP_USER = 'afa0332d-5f00-4dcb-ba27-f8d92459d877';
const KEEP_CONN = '74133173-2951-4db4-9e0a-9ee2d64df850';

(async () => {
  const p = new PrismaClient();

  console.log('=== Pre-cleanup state ===');
  const before = await p.sfConnection.findMany({
    where: { sfTenantId: '99999' },
    select: { id: true, userId: true, status: true, isActive: true },
  });
  console.log(JSON.stringify(before, null, 2));

  console.log('');
  console.log('=== Safety asserts ===');
  const stale = before.find((r) => r.id === STALE_CONN);
  if (!stale) {
    console.log('FAIL: stale row not found by id; aborting');
    process.exit(1);
  }
  if (stale.userId !== STALE_USER) {
    console.log('FAIL: stale row userId mismatch; aborting');
    process.exit(1);
  }
  if (stale.status !== 'disconnected' || stale.isActive !== false) {
    console.log('FAIL: stale row is not disconnected/inactive; aborting (got status=' + stale.status + ' isActive=' + stale.isActive + ')');
    process.exit(1);
  }
  const keep = before.find((r) => r.id === KEEP_CONN);
  if (!keep || keep.userId !== KEEP_USER || keep.status !== 'active' || !keep.isActive) {
    console.log('FAIL: keep row missing or not active; aborting');
    process.exit(1);
  }
  console.log('OK: stale=' + STALE_CONN + ' (disconnected/inactive), keep=' + KEEP_CONN + ' (active)');

  console.log('');
  console.log('=== Deleting stale row + linked subscription ===');
  await p.$transaction(async (tx) => {
    // Null the FK on the sf_connection first so the sub delete doesn't
    // collide with a referential constraint. (Then delete the row entirely.)
    await tx.sfConnection.update({
      where: { id: STALE_CONN },
      data: { inboundSubscriptionId: null },
    });
    await tx.crmWebhookSubscription.deleteMany({ where: { id: STALE_SUB } });
    await tx.sfConnection.delete({ where: { id: STALE_CONN } });
  });
  console.log('OK: deleted sf_connection=' + STALE_CONN + ' + sub=' + STALE_SUB);

  console.log('');
  console.log('=== Post-cleanup state ===');
  const after = await p.sfConnection.findMany({
    where: { sfTenantId: '99999' },
    select: { id: true, userId: true, status: true, isActive: true, inboundSubscriptionId: true },
  });
  console.log(JSON.stringify(after, null, 2));

  console.log('');
  console.log('=== findFirst({where: {sfTenantId: 99999}}) (the webhook handler call) ===');
  const firstHit = await p.sfConnection.findFirst({ where: { sfTenantId: '99999' } });
  console.log(firstHit
    ? { id: firstHit.id, userId: firstHit.userId, status: firstHit.status, isActive: firstHit.isActive }
    : '<NONE>');

  await p.$disconnect();
  console.log('');
  console.log('DONE');
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
