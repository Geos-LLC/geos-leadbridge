/* eslint-disable */
// Backfill:
// 1. NotificationSettings where userId IS NULL → set from SavedAccount.userId
// 2. NotificationSettings where destinationPhone IS NULL → set from User.businessPhone
//    (only for rows where strategy='owner' implicitly, i.e. wherever the owner's phone exists)
// 3. CallConnectSettings missing for any SavedAccount → seed defaults pre-filled with User.businessPhone
//    (uses same logic as the post-fix seedOrInheritCallConnectSettings first-account branch)
//
// DRY_RUN=1 in env to preview only.

const { PrismaClient } = require('../generated/prisma');
const crypto = require('crypto');
const p = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });

const DRY_RUN = process.env.DRY_RUN === '1';
const tag = DRY_RUN ? '[DRY-RUN]' : '[APPLY]';

(async () => {
  console.log(`${tag} Starting backfill at ${new Date().toISOString()}\n`);

  // ─── 1. NS.userId backfill ─────────────────────────────────────────────────
  const nsNullUser = await p.notificationSettings.findMany({ where: { userId: null } });
  console.log(`1. NS rows with userId=NULL: ${nsNullUser.length}`);
  let nsUserUpdated = 0;
  for (const n of nsNullUser) {
    const sa = await p.savedAccount.findUnique({ where: { id: n.savedAccountId }, select: { userId:true, businessName:true, platform:true } });
    if (!sa?.userId) { console.log(`   SKIP id=${n.id} (no SavedAccount.userId)`); continue; }
    console.log(`   • [${sa.platform}] ${sa.businessName} → set userId=${sa.userId}`);
    if (!DRY_RUN) {
      await p.notificationSettings.update({ where: { id: n.id }, data: { userId: sa.userId } });
    }
    nsUserUpdated++;
  }
  console.log(`   Updated: ${nsUserUpdated}\n`);

  // ─── 2. NS.destinationPhone backfill ───────────────────────────────────────
  const nsNullDest = await p.notificationSettings.findMany({ where: { destinationPhone: null } });
  console.log(`2. NS rows with destinationPhone=NULL: ${nsNullDest.length}`);
  let nsDestUpdated = 0;
  for (const n of nsNullDest) {
    // Need userId — either from row (if step 1 just set it) or from SavedAccount
    let userId = n.userId;
    if (!userId) {
      const sa = await p.savedAccount.findUnique({ where: { id: n.savedAccountId }, select: { userId:true } });
      userId = sa?.userId;
    }
    if (!userId) { console.log(`   SKIP id=${n.id} (no userId resolvable)`); continue; }
    const u = await p.user.findUnique({ where: { id: userId }, select: { businessPhone:true, email:true } });
    if (!u?.businessPhone) { console.log(`   SKIP id=${n.id} (${u?.email} has no businessPhone)`); continue; }
    const sa = await p.savedAccount.findUnique({ where: { id: n.savedAccountId }, select: { businessName:true, platform:true } });
    console.log(`   • ${u.email} | [${sa?.platform}] ${sa?.businessName} → set destinationPhone=${u.businessPhone}`);
    if (!DRY_RUN) {
      await p.notificationSettings.update({ where: { id: n.id }, data: { destinationPhone: u.businessPhone } });
    }
    nsDestUpdated++;
  }
  console.log(`   Updated: ${nsDestUpdated}\n`);

  // ─── 3. CC seed for SavedAccounts that have none ───────────────────────────
  // Mirror seedOrInheritCallConnectSettings first-account-defaults branch.
  const accountsMissingCC = await p.savedAccount.findMany({
    where: { archivedAt: null, callConnectSettings: { is: null } },
    select: { id:true, userId:true, platform:true, businessName:true },
  });
  console.log(`3. SavedAccounts missing CC: ${accountsMissingCC.length}`);
  let ccCreated = 0;
  for (const a of accountsMissingCC) {
    const u = await p.user.findUnique({ where: { id: a.userId }, select: { email:true, businessPhone:true } });
    if (!u) { console.log(`   SKIP ${a.id} (no User)`); continue; }
    console.log(`   • ${u.email} | [${a.platform}] ${a.businessName} → create CC (enabled=false, agentPhone=${u.businessPhone||'null'})`);
    if (!DRY_RUN) {
      await p.callConnectSettings.create({
        data: {
          savedAccountId: a.id,
          userId: a.userId,
          enabled: false,
          mode: 'AGENT_FIRST',
          agentStrategy: 'owner',
          agentPhoneE164: u.businessPhone || null,
          maxAgentAttempts: 2,
          agentAcceptDigits: '0123456789*#',
          agentWhisperMessage:
            'You have a new lead for {category}. Customer name: {customerName}. Press any key to connect with the customer.',
          leadGreetingMessage:
            'Hi {customerName}! Thanks for your inquiry about {category}. We\'re connecting you with a specialist right now. Please hold for just a moment.',
          leadVoicemailEnabled: false,
          sigcoreWebhookSecret: crypto.randomBytes(32).toString('hex'),
        },
      });
    }
    ccCreated++;
  }
  console.log(`   Created: ${ccCreated}\n`);

  console.log(`${tag} Backfill summary:`);
  console.log(`   NS userId set:         ${nsUserUpdated}`);
  console.log(`   NS destPhone set:      ${nsDestUpdated}`);
  console.log(`   CC rows created:       ${ccCreated}`);
})().then(()=>p.$disconnect()).catch(e=>{console.error(e);p.$disconnect();});
