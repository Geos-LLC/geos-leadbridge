#!/usr/bin/env node
/**
 * Cross-tenant audit of LB leads that are unsynced to SF, for every user
 * with an active sf_connection. Read-only.
 *
 * Required env: DATABASE_URL (DIRECT_URL form, port 5432).
 */
const { PrismaClient } = require('../../generated/prisma');

const NON_TERMINAL = new Set(['new', 'contacted', 'engaged', 'quoted', 'booked', 'scheduled', 'in_progress']);
const TARGET_STATUSES = new Set(['new', 'contacted', 'engaged', 'scheduled', 'booked', 'lost']); // user's spec
const STALE_DAYS = 14;

function tally(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x) ?? '<null>';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function ageDays(d) {
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

(async () => {
  const p = new PrismaClient();

  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('LB ↔ SF SYNC-GAP AUDIT (all users with active sf_connection)');
  console.log('═══════════════════════════════════════════════════════════════════════');

  const conns = await p.sfConnection.findMany({
    where: { isActive: true, status: 'active' },
    select: { id: true, userId: true, sfTenantId: true, sfTenantName: true, connectedAt: true,
      user: { select: { email: true, name: true } } },
  });
  console.log('Active SF connections: ' + conns.length);
  console.log('');

  const summary = {
    totalActiveConns: conns.length,
    totalLeads: 0,
    totalLinked: 0,
    totalUnsynced: 0,
    totalUnsyncedInTargetStatus: 0,
    totalStaleScheduled: 0,
    totalUnsyncedWithPhone: 0,
    erinDavisFound: null,
  };

  for (const conn of conns) {
    console.log('───────────────────────────────────────────────────────────────────────');
    console.log('SF tenant=' + conn.sfTenantId + ' (' + (conn.sfTenantName || '?') + ')');
    console.log('LB user=' + conn.userId + ' email=' + (conn.user?.email || '?') + ' name=' + (conn.user?.name || '?'));
    console.log('Connected at: ' + conn.connectedAt.toISOString());

    const leads = await p.lead.findMany({
      where: { userId: conn.userId },
      select: {
        id: true, customerName: true, customerPhone: true, customerEmail: true,
        platform: true, businessId: true, externalRequestId: true,
        status: true, sfJobId: true, syncedToCrm: true,
        statusSource: true, statusUpdatedAt: true,
        sfLastEventAt: true, sfJobOutcome: true,
        createdAt: true,
      },
    });
    summary.totalLeads += leads.length;

    const linked = leads.filter((l) => l.sfJobId != null);
    const unsynced = leads.filter((l) => !l.syncedToCrm || l.sfJobId == null);
    const unsyncedInTarget = unsynced.filter((l) => TARGET_STATUSES.has(l.status));
    const staleScheduled = unsynced.filter((l) => l.status === 'scheduled' &&
      l.statusUpdatedAt && ageDays(l.statusUpdatedAt) >= STALE_DAYS);
    const unsyncedWithPhone = unsynced.filter((l) => l.customerPhone && l.customerPhone.length >= 7);
    const unsyncedNoPhoneNoEmail = unsynced.filter((l) => !l.customerPhone && !l.customerEmail);

    summary.totalLinked += linked.length;
    summary.totalUnsynced += unsynced.length;
    summary.totalUnsyncedInTargetStatus += unsyncedInTarget.length;
    summary.totalStaleScheduled += staleScheduled.length;
    summary.totalUnsyncedWithPhone += unsyncedWithPhone.length;

    console.log('  leads:               ' + leads.length);
    console.log('  linked (sfJobId set): ' + linked.length);
    console.log('  unsynced total:      ' + unsynced.length);
    console.log('  unsynced in target status (new/contacted/engaged/scheduled/booked/lost): ' + unsyncedInTarget.length);
    console.log('  stale "scheduled" (≥' + STALE_DAYS + 'd since last update): ' + staleScheduled.length);
    console.log('  unsynced w/ phone (possible match key): ' + unsyncedWithPhone.length);
    console.log('  unsynced w/ NO phone AND NO email (low match confidence): ' + unsyncedNoPhoneNoEmail.length);
    console.log('  status breakdown of unsynced:');
    tally(unsynced, (l) => l.status).slice(0, 15).forEach(([k, v]) => console.log('    ' + k + ': ' + v));

    // Capture Erin Davis if she belongs to this tenant.
    const erin = leads.find((l) => l.id.startsWith('65d7a387'));
    if (erin) {
      summary.erinDavisFound = {
        sfTenant: conn.sfTenantId,
        userId: conn.userId,
        leadId: erin.id,
        customer: erin.customerName,
        phone: erin.customerPhone,
        platform: erin.platform,
        externalRequestId: erin.externalRequestId,
        status: erin.status,
        sfJobId: erin.sfJobId,
        syncedToCrm: erin.syncedToCrm,
        statusUpdatedAtAge: erin.statusUpdatedAt ? ageDays(erin.statusUpdatedAt) + 'd' : 'never',
      };
    }

    // Sample 5 stale-scheduled unsynced examples.
    if (staleScheduled.length > 0) {
      console.log('  stale-scheduled examples (≤5):');
      staleScheduled.slice(0, 5).forEach((l) => console.log('    ' + l.id.slice(0, 8) + ' ' + (l.customerName||'?') + ' phone=' + (l.customerPhone||'-') + ' last_status_at=' + l.statusUpdatedAt?.toISOString().slice(0,10) + ' (' + ageDays(l.statusUpdatedAt) + 'd ago)'));
    }
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('CROSS-TENANT TOTALS');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  active SF connections:                  ' + summary.totalActiveConns);
  console.log('  total leads (across all SF tenants):    ' + summary.totalLeads);
  console.log('  total linked to SF (sfJobId != null):   ' + summary.totalLinked);
  console.log('  total unsynced:                         ' + summary.totalUnsynced + '  (' + (summary.totalLeads > 0 ? Math.round(100*summary.totalUnsynced/summary.totalLeads) : 0) + '%)');
  console.log('  unsynced in target statuses:            ' + summary.totalUnsyncedInTargetStatus);
  console.log('  stale "scheduled" leads (≥' + STALE_DAYS + 'd):       ' + summary.totalStaleScheduled);
  console.log('  unsynced WITH phone (likely SF-matchable): ' + summary.totalUnsyncedWithPhone);

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('ERIN DAVIS CHECK');
  console.log('═══════════════════════════════════════════════════════════════════════');
  if (summary.erinDavisFound) {
    console.log(JSON.stringify(summary.erinDavisFound, null, 2));
    console.log('');
    console.log('  Match-key availability:');
    console.log('    - phone:              ' + (summary.erinDavisFound.phone || '<none>') + ' → ' + (summary.erinDavisFound.phone ? 'CAN match SF customer by phone' : 'no match key'));
    console.log('    - externalRequestId:  ' + summary.erinDavisFound.externalRequestId + ' → if SF has stored Thumbtack externalRequestId on its job, exact match');
    console.log('    - name + platform:    "' + summary.erinDavisFound.customer + '" / ' + summary.erinDavisFound.platform);
  } else {
    console.log('  <Erin Davis lead 65d7a387 not found under any active SF-connected user>');
  }

  await p.$disconnect();
})().catch((e) => { console.error('ERR:', e.message); console.error(e.stack); process.exit(1); });
