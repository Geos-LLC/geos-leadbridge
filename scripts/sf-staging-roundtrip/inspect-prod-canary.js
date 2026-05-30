#!/usr/bin/env node
/**
 * Read-only inspection of LB prod state for the tenant-2 Spotless canary.
 *
 * Required env: DATABASE_URL (DIRECT_URL form, port 5432).
 */
const { PrismaClient } = require('../../generated/prisma');

const SF_TENANT = process.env.SF_TENANT || '2';
const LB_USER = process.env.LB_USER || 'c3d14499-dec1-42c3-a36c-713cb09842c6';
const LB_EMAIL = process.env.LB_EMAIL || 'info@spotless.homes';

(async () => {
  const p = new PrismaClient();

  console.log('=== LB user lookup by email ===');
  const userByEmail = await p.user.findUnique({
    where: { email: LB_EMAIL },
    select: { id: true, email: true, name: true },
  });
  console.log(userByEmail || '<NOT FOUND>');
  console.log('  matches expected id? ' + (userByEmail?.id === LB_USER));

  console.log('');
  console.log('=== sf_connections WHERE sfTenantId=' + SF_TENANT + ' (sees all duplicates) ===');
  const tenantRows = await p.sfConnection.findMany({
    where: { sfTenantId: SF_TENANT },
    select: {
      id: true, userId: true, sfTenantId: true, status: true, isActive: true,
      inboundSubscriptionId: true, signatureKeyId: true, orchestrationTokenKid: true,
      tokenPrefix: true, connectedAt: true, updatedAt: true,
    },
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
      tokenPrefix: true, connectedAt: true, updatedAt: true,
    },
  });
  console.log(JSON.stringify(userRows, null, 2));

  console.log('');
  console.log('=== Webhook handler call: findFirst({sfTenantId:' + SF_TENANT + ', isActive:true}) ===');
  const activeHit = await p.sfConnection.findFirst({
    where: { sfTenantId: SF_TENANT, isActive: true },
    orderBy: { updatedAt: 'desc' },
  });
  console.log(activeHit
    ? { id: activeHit.id, userId: activeHit.userId, status: activeHit.status, isActive: activeHit.isActive, inboundSubscriptionId: activeHit.inboundSubscriptionId }
    : '<NONE — fallback would search any row>');

  console.log('');
  console.log('=== Linked subscription per row ===');
  for (const row of tenantRows) {
    if (!row.inboundSubscriptionId) {
      console.log('  conn=' + row.id + ' sub=<none>');
      continue;
    }
    const sub = await p.crmWebhookSubscription.findUnique({
      where: { id: row.inboundSubscriptionId },
      select: { id: true, userId: true, isActive: true, webhookUrl: true, direction: true, events: true, updatedAt: true },
    });
    console.log('  conn=' + row.id);
    console.log('    sub=' + (sub ? JSON.stringify(sub) : '<MISSING>'));
  }

  console.log('');
  console.log('=== Recent sf_inbound_events for userId=' + LB_USER + ' (last 20) ===');
  try {
    const events = await p.sfInboundEvent.findMany({
      where: { userId: LB_USER },
      orderBy: { receivedAt: 'desc' },
      take: 20,
      select: { eventId: true, eventType: true, status: true, result: true, receivedAt: true, sfJobId: true, processingError: true },
    });
    if (events.length === 0) console.log('  <none>');
    else events.forEach(e => console.log('  ' + e.receivedAt.toISOString() + ' ' + e.eventType + ' status=' + e.status + ' result=' + (e.result || '-') + ' eid=' + e.eventId + (e.processingError ? ' ERR=' + e.processingError.slice(0, 80) : '')));
  } catch (e) {
    console.log('  (sfInboundEvent lookup failed: ' + e.message.slice(0, 120) + ')');
  }

  console.log('');
  console.log('=== sf_provisioning_link_consumed for user (recent nonces) ===');
  try {
    const consumed = await p.sfProvisioningLinkConsumed.findMany({
      where: { userId: LB_USER },
      orderBy: { consumedAt: 'desc' },
      take: 10,
      select: { nonce: true, consumedAt: true, expiresAt: true },
    });
    if (consumed.length === 0) console.log('  <none>');
    else consumed.forEach(c => console.log('  consumed_at=' + c.consumedAt.toISOString() + ' nonce=' + c.nonce.slice(0, 8) + '… expires=' + c.expiresAt.toISOString()));
  } catch (e) {
    console.log('  (linkConsumed lookup failed: ' + e.message.slice(0, 100) + ')');
  }

  await p.$disconnect();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
