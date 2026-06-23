/* eslint-disable */
// Side-by-side config diff: every tenant vs the working references.
// Read-only.

const { PrismaClient } = require('../generated/prisma');
const p = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });

const REF = ['info@spotless.homes', 'lavandacleaningsd@gmail.com'];

async function getTenantSnapshot(userId) {
  const u = await p.user.findUnique({
    where: { id: userId },
    select: {
      email:true, businessPhone:true, sigcoreBusinessId:true,
      timezone:true, businessHoursEnabled:true,
      aiConversationEnabled:true, hasOwnNumber:true,
      trialEndedAt:true, subscriptionTier:true, subscriptionStatus:true,
      createdAt:true,
    },
  });
  const accounts = await p.savedAccount.findMany({ where:{ userId, archivedAt:null }, select:{ id:true, platform:true, businessName:true } });
  const accountIds = accounts.map(a => a.id);
  const ns = await p.notificationSettings.findMany({ where:{ savedAccountId: { in: accountIds } } });
  const ccs = await p.callConnectSettings.findMany({ where:{ savedAccountId: { in: accountIds } } });
  const tpns = await p.tenantPhoneNumber.findMany({ where:{ userId }, select:{ phoneNumber:true, savedAccountId:true, status:true } });

  // Per NS: rule list
  const rules = {};
  for (const n of ns) {
    const r = await p.notificationRule.findMany({ where:{ notificationSettingsId: n.id }, select:{ name:true, triggerType:true, enabled:true, sendToCustomer:true } });
    rules[n.savedAccountId] = r;
  }

  // Activity in last 14d
  const since = new Date(Date.now() - 14*24*3600*1000);
  const [leads, ccSessions, notifSent] = await Promise.all([
    p.lead.count({ where:{ userId, createdAt: { gte: since } } }),
    p.leadCallConnect.count({ where:{ lead:{ userId }, createdAt: { gte: since } } }),
    ns.length ? p.notificationLog.count({ where:{ notificationSettingsId: { in: ns.map(x=>x.id) }, status:'delivered', createdAt: { gte: since } } }) : 0,
  ]);

  return { user: u, accounts, ns, ccs, tpns, rules, metrics: { leads, ccSessions, notifSent } };
}

function rowFor(snap) {
  const enabledCC = snap.ccs.filter(c => c.enabled).length;
  const ccWithPhone = snap.ccs.filter(c => c.agentPhoneE164).length;
  const ccTotal = snap.ccs.length;
  const nsTotal = snap.ns.length;
  const nsEnabled = snap.ns.filter(n => n.enabled).length;
  const nsWithDest = snap.ns.filter(n => n.destinationPhone).length;
  const nsWithSigcoreKey = snap.ns.filter(n => n.sigcoreApiKey).length;
  const nsWithInboundHook = snap.ns.filter(n => n.inboundSmsWebhookId).length;
  const nsCustomerTexting = snap.ns.filter(n => n.customerTextingEnabled).length;
  const tpnActive = snap.tpns.filter(t => t.status === 'ACTIVE').length;
  // Rules
  let totalRules = 0, enabledRules = 0;
  for (const k of Object.keys(snap.rules)) {
    totalRules += snap.rules[k].length;
    enabledRules += snap.rules[k].filter(r => r.enabled).length;
  }
  return {
    email: snap.user.email,
    accts: snap.accounts.length,
    businessPhone: snap.user.businessPhone ? '✓' : '—',
    bizHrs: snap.user.businessHoursEnabled ? '✓' : '—',
    aiConv: snap.user.aiConversationEnabled ? '✓' : '—',
    tpnActive: tpnActive,
    ns: `${nsEnabled}/${nsTotal}`,
    nsDest: `${nsWithDest}/${nsTotal}`,
    nsKey: `${nsWithSigcoreKey}/${nsTotal}`,
    nsInHook: `${nsWithInboundHook}/${nsTotal}`,
    nsTexting: `${nsCustomerTexting}/${nsTotal}`,
    cc: `${enabledCC}/${ccTotal}`,
    ccPhone: `${ccWithPhone}/${ccTotal}`,
    rules: `${enabledRules}/${totalRules}`,
    rulesPerAcct: snap.accounts.length ? (totalRules / snap.accounts.length).toFixed(1) : '—',
    leads14d: snap.metrics.leads,
    notif14d: snap.metrics.notifSent,
    cc14d: snap.metrics.ccSessions,
    trialEnded: snap.user.trialEndedAt ? '✓' : '—',
  };
}

function fmtRow(r) {
  return [
    r.email.padEnd(38),
    String(r.accts).padStart(3),
    r.businessPhone.padStart(3),
    r.bizHrs.padStart(3),
    r.aiConv.padStart(3),
    String(r.tpnActive).padStart(3),
    r.ns.padStart(5),
    r.nsDest.padStart(5),
    r.nsKey.padStart(5),
    r.nsInHook.padStart(6),
    r.nsTexting.padStart(6),
    r.cc.padStart(5),
    r.ccPhone.padStart(5),
    r.rules.padStart(6),
    String(r.leads14d).padStart(5),
    String(r.notif14d).padStart(6),
    String(r.cc14d).padStart(4),
    r.trialEnded.padStart(4),
  ].join(' │ ');
}

(async () => {
  const users = await p.user.findMany({
    where: { savedAccounts: { some: { archivedAt: null } } },
    select: { id:true, email:true },
    orderBy: { createdAt: 'desc' },
  });

  const all = [];
  for (const u of users) {
    const snap = await getTenantSnapshot(u.id);
    all.push(rowFor(snap));
  }

  // Column header
  const header = [
    'EMAIL'.padEnd(38),
    'AC'.padStart(3),
    'BP'.padStart(3),
    'BH'.padStart(3),
    'AI'.padStart(3),
    'TPN'.padStart(3),
    ' NS  ',
    'DEST '.padStart(5),
    ' KEY '.padStart(5),
    'INHOOK',
    'TEXTNG',
    ' CC  '.padStart(5),
    'PHONE'.padStart(5),
    'RULES '.padStart(6),
    'LD14d',
    'NOT14d',
    'CC14',
    'TRLE',
  ].join(' │ ');
  console.log('\n' + header);
  console.log('─'.repeat(header.length));

  const refs = all.filter(r => REF.includes(r.email));
  const others = all.filter(r => !REF.includes(r.email));
  for (const r of refs) console.log('★ ' + fmtRow(r));
  console.log('─'.repeat(header.length));
  for (const r of others) console.log('  ' + fmtRow(r));

  console.log('\nLegend:');
  console.log('  AC=SavedAccount count   BP=User.businessPhone set   BH=businessHoursEnabled   AI=aiConversationEnabled');
  console.log('  TPN=active TenantPhoneNumber count');
  console.log('  NS=NotificationSettings (enabled/total)   DEST=destinationPhone set   KEY=sigcoreApiKey set   INHOOK=inboundSmsWebhookId set   TEXTNG=customerTextingEnabled');
  console.log('  CC=CallConnectSettings (enabled/total)   PHONE=agentPhoneE164 set');
  console.log('  RULES=NotificationRules (enabled/total)   LD14d=leads in 14d   NOT14d=notifications sent in 14d   CC14=CC sessions in 14d   TRLE=trialEnded');
})().then(()=>p.$disconnect()).catch(e=>{console.error(e);p.$disconnect();});
