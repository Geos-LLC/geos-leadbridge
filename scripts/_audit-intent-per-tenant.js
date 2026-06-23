/* eslint-disable */
// Per-tenant intent dump: what they configured = what they intended.
// Read-only.
const { PrismaClient } = require('../generated/prisma');
const p = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });

const TARGETS = [
  'nataliaparanina1990@gmail.com',
  'adanettka@gmail.com',
  'crystalservicepro@gmail.com',
  'fargipro.cleaning@gmail.com',
  'alwaysbestcleaningsolutions@gmail.com',
  'nadja.haltonen@gmail.com',
  // reference for comparison
  'info@spotless.homes',
  'lavandacleaningsd@gmail.com',
];

(async () => {
  for (const email of TARGETS) {
    const u = await p.user.findFirst({ where: { email } });
    if (!u) { console.log(`\n!! ${email} — NOT FOUND\n`); continue; }

    console.log(`\n${'='.repeat(95)}`);
    console.log(`TENANT: ${u.email}`);
    console.log(`${'='.repeat(95)}`);
    console.log(`Subscription: tier=${u.subscriptionTier} status=${u.subscriptionStatus} trialEndedAt=${u.trialEndedAt?.toISOString()?.substring(0,10) || '—'}`);
    console.log(`User-level intents:`);
    console.log(`  aiConversationEnabled = ${u.aiConversationEnabled}`);
    console.log(`  businessHoursEnabled  = ${u.businessHoursEnabled}`);
    console.log(`  quietHoursEnabled     = ${u.quietHoursEnabled}`);
    console.log(`  hasOwnNumber          = ${u.hasOwnNumber}`);
    console.log(`  businessPhone         = ${u.businessPhone || '—'}`);
    console.log(`  timezone              = ${u.timezone || '—'}`);

    // Onboarding answers
    const ob = await p.onboardingProfile.findUnique({ where: { userId: u.id } });
    if (ob) {
      console.log(`\nOnboarding answers:`);
      const keys = ['communicationPreferenceSms','communicationPreferenceCalls','communicationPreferenceEmail','wantsAiReplies','wantsInstantCall','wantsFollowUps','preferredChannel','contactMethod'];
      let any = false;
      for (const k of keys) { if (ob[k] !== undefined && ob[k] !== null) { console.log(`  ${k} = ${JSON.stringify(ob[k])}`); any = true; } }
      // Dump entire profile if no canonical keys
      if (!any) {
        const interesting = Object.entries(ob).filter(([k,v]) => !['id','userId','createdAt','updatedAt'].includes(k) && v !== null && v !== '' && v !== false && (typeof v !== 'object' || (Array.isArray(v) ? v.length : Object.keys(v||{}).length)));
        for (const [k,v] of interesting) {
          const s = typeof v === 'object' ? JSON.stringify(v).substring(0,120) : String(v);
          console.log(`  ${k} = ${s}`);
        }
      }
    } else {
      console.log(`\nOnboarding profile: NONE`);
    }

    const accounts = await p.savedAccount.findMany({ where: { userId: u.id, archivedAt: null }, select: { id:true, platform:true, businessName:true, followUpMode:true, followUpPreset:true, followUpReplyType:true, callDuringBusinessHours:true, firstMsgDuringBusinessHours:true, businessHoursOverride:true, followUpSettingsJson:true } });

    for (const a of accounts) {
      console.log(`\n  ── Account: [${a.platform}] ${a.businessName}`);
      console.log(`     followUpMode=${a.followUpMode} preset=${a.followUpPreset} replyType=${a.followUpReplyType}`);
      console.log(`     callDuringBizHours=${a.callDuringBusinessHours} firstMsgDuringBizHours=${a.firstMsgDuringBusinessHours} bizHoursOverride=${a.businessHoursOverride}`);
      if (a.followUpSettingsJson) {
        try {
          const j = typeof a.followUpSettingsJson === 'string' ? JSON.parse(a.followUpSettingsJson) : a.followUpSettingsJson;
          const stepsCount = Array.isArray(j?.steps) ? j.steps.length : (j?.mode ? '(mode='+j.mode+')' : '(unknown shape)');
          console.log(`     followUpSettingsJson: mode=${j?.mode || '—'} steps=${stepsCount} enabled=${j?.enabled}`);
        } catch (e) { console.log(`     followUpSettingsJson: <unparsable>`); }
      } else {
        console.log(`     followUpSettingsJson: —`);
      }

      const ns = await p.notificationSettings.findUnique({ where: { savedAccountId: a.id } });
      if (!ns) {
        console.log(`     NotificationSettings: MISSING`);
      } else {
        console.log(`     NotificationSettings: enabled=${ns.enabled} destPhone=${ns.destinationPhone||'—'} customerTexting=${ns.customerTextingEnabled} requirePhone=${ns.requirePhone} userId=${ns.userId||'NULL!'}`);
        const rules = await p.notificationRule.findMany({ where: { notificationSettingsId: ns.id }, orderBy: { createdAt: 'asc' } });
        if (!rules.length) { console.log(`     NotificationRules: NONE`); }
        else {
          console.log(`     NotificationRules (${rules.length}):`);
          for (const r of rules) console.log(`       • [${r.enabled?'ON ':'off'}] "${r.name}" → trigger=${r.triggerType} sendToCustomer=${r.sendToCustomer} templateId=${r.templateId||'—'}`);
        }
      }
      const cc = await p.callConnectSettings.findUnique({ where: { savedAccountId: a.id } });
      if (!cc) {
        console.log(`     CallConnectSettings: MISSING`);
      } else {
        console.log(`     CallConnectSettings: enabled=${cc.enabled} mode=${cc.mode} strategy=${cc.agentStrategy} agentPhone=${cc.agentPhoneE164||'—'} botNum=${cc.botNumberE164||'—'} vmEnabled=${cc.leadVoicemailEnabled}`);
      }
    }
    const tpns = await p.tenantPhoneNumber.findMany({ where: { userId: u.id } });
    console.log(`\n  TenantPhoneNumbers (${tpns.length}):`);
    for (const t of tpns) console.log(`    • ${t.phoneNumber} status=${t.status} savedAccountId=${t.savedAccountId||'—(shared)'}`);
  }
})().then(()=>p.$disconnect()).catch(e=>{console.error(e);p.$disconnect();});
