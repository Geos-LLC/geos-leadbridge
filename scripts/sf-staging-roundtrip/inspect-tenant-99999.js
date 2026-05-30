#!/usr/bin/env node
/**
 * Inspect LB DB state for SF tenant 99999 + a specific LB user. Read-only.
 * Used to diagnose SF→LB lifecycle-webhook rejections when /provision
 * returned success but the first inbound webhook bounces.
 *
 * Required env: DATABASE_URL (use the DIRECT_URL form, port 5432).
 */
const { PrismaClient } = require('../../generated/prisma');

const SF_TENANT = process.env.SF_TENANT || '99999';
const LB_USER = process.env.LB_USER || 'afa0332d-5f00-4dcb-ba27-f8d92459d877';
const CONN_ID = process.env.CONN_ID || '45073d92-f1af-4ffd-995b-d1d5df10b1e5';

(async () => {
  const p = new PrismaClient();

  console.log('=== sf_connections WHERE sfTenantId=' + SF_TENANT + ' (findFirst-order) ===');
  const tenantRows = await p.sfConnection.findMany({
    where: { sfTenantId: SF_TENANT },
    select: {
      id: true, userId: true, sfTenantId: true, status: true, isActive: true,
      inboundSubscriptionId: true, signatureKeyId: true, orchestrationTokenKid: true,
      connectedAt: true, updatedAt: true,
    },
    orderBy: { connectedAt: 'asc' },
  });
  console.log(JSON.stringify(tenantRows, null, 2));
  console.log('  count=' + tenantRows.length);

  console.log('');
  console.log('=== sf_connections WHERE userId=' + LB_USER + ' ===');
  const userRows = await p.sfConnection.findMany({
    where: { userId: LB_USER },
    select: {
      id: true, userId: true, sfTenantId: true, status: true, isActive: true,
      inboundSubscriptionId: true, signatureKeyId: true, orchestrationTokenKid: true,
      connectedAt: true, updatedAt: true,
    },
  });
  console.log(JSON.stringify(userRows, null, 2));

  console.log('');
  console.log('=== sf_connections WHERE id=' + CONN_ID + ' ===');
  const targetConn = await p.sfConnection.findUnique({ where: { id: CONN_ID } });
  console.log(targetConn ? {
    id: targetConn.id, userId: targetConn.userId, sfTenantId: targetConn.sfTenantId,
    status: targetConn.status, isActive: targetConn.isActive,
    inboundSubscriptionId: targetConn.inboundSubscriptionId,
    signatureKeyId: targetConn.signatureKeyId,
    orchestrationTokenKid: targetConn.orchestrationTokenKid,
    connectedAt: targetConn.connectedAt, updatedAt: targetConn.updatedAt,
  } : '<NOT FOUND>');

  console.log('');
  console.log('=== Webhook handler call: findFirst({where: {sfTenantId: 99999}}) ===');
  const firstHit = await p.sfConnection.findFirst({ where: { sfTenantId: SF_TENANT } });
  if (!firstHit) {
    console.log('  <no row> — webhook would 404 tenant_not_found');
  } else {
    console.log('  picked id=' + firstHit.id);
    console.log('  userId=' + firstHit.userId);
    console.log('  status=' + firstHit.status + ' isActive=' + firstHit.isActive);
    console.log('  inboundSubscriptionId=' + firstHit.inboundSubscriptionId);
    console.log('  >>> matches reported conn_id? ' + (firstHit.id === CONN_ID));
  }

  console.log('');
  console.log('=== Linked subscription state for each tenant row ===');
  for (const row of tenantRows) {
    if (!row.inboundSubscriptionId) {
      console.log('  conn=' + row.id + ' sub=<none>');
      continue;
    }
    const sub = await p.crmWebhookSubscription.findUnique({
      where: { id: row.inboundSubscriptionId },
      select: { id: true, userId: true, isActive: true, webhookUrl: true, direction: true },
    });
    console.log('  conn=' + row.id);
    console.log('    sub=' + (sub ? JSON.stringify(sub) : '<MISSING>'));
  }

  console.log('');
  console.log('=== All CrmWebhookSubscription rows for user (any direction) ===');
  const allSubs = await p.crmWebhookSubscription.findMany({
    where: { userId: LB_USER },
    select: {
      id: true, isActive: true, direction: true, webhookUrl: true,
      events: true, updatedAt: true,
    },
  });
  console.log(JSON.stringify(allSubs, null, 2));

  await p.$disconnect();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
