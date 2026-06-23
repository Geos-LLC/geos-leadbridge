/* eslint-disable */
// Recovery: provision a missing NotificationSettings row for a SavedAccount.
//
// Use when an account has no NS row at all (pre-2026-06-23 onboarding before
// the autoProvisionSigcore fix). For accounts where the NS row exists but is
// missing destinationPhone / userId, use _backfill-ns-userid-and-cc.js instead.
//
// What it does:
//   1. Calls Sigcore POST /tenants/provision with externalTenantId=savedAccountId
//   2. Creates the NS row with sigcoreApiKey/tenantId/workspaceId + userId
//      + destinationPhone (from User.businessPhone) + enabled=true
//   3. Clones NotificationRules from a sibling SavedAccount (same user) if one
//      exists. If not, leaves the new NS rule-less — owner can wire rules
//      from the Settings UI.
//
// Required env: DIRECT_URL, SIGCORE_API_URL, SIGCORE_API_KEY
// Required arg: SAVED_ACCOUNT_ID=<uuid>
// Optional:     SIBLING_SAVED_ACCOUNT_ID=<uuid>   (override the rule-source pick)
//               DRY_RUN=1                          (preview without writes)

const { PrismaClient } = require('../generated/prisma');
const p = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });

const DRY_RUN = process.env.DRY_RUN === '1';
const SAVED_ACCOUNT_ID = process.env.SAVED_ACCOUNT_ID;
const SIBLING_OVERRIDE = process.env.SIBLING_SAVED_ACCOUNT_ID;

if (!SAVED_ACCOUNT_ID) {
  console.error('Usage: SAVED_ACCOUNT_ID=<uuid> node scripts/_provision-account-ns.js');
  process.exit(2);
}

(async () => {
  const account = await p.savedAccount.findUnique({
    where: { id: SAVED_ACCOUNT_ID },
    include: { user: { select: { id:true, email:true, businessPhone:true } } },
  });
  if (!account) throw new Error(`SavedAccount ${SAVED_ACCOUNT_ID} not found`);
  console.log('Target account:', `[${account.platform}] ${account.businessName} (user=${account.user.email})`);

  const existingNS = await p.notificationSettings.findUnique({ where: { savedAccountId: SAVED_ACCOUNT_ID } });
  if (existingNS) {
    console.log('NS already exists — bailing (use _backfill-ns-userid-and-cc.js for field-level fixes).');
    console.log('  id:', existingNS.id, '| sigcoreApiKey:', existingNS.sigcoreApiKey ? 'SET' : 'NULL', '| destinationPhone:', existingNS.destinationPhone);
    return;
  }

  // Find a sibling SavedAccount with existing rules to clone from
  let siblingNS = null;
  if (SIBLING_OVERRIDE) {
    siblingNS = await p.notificationSettings.findUnique({ where: { savedAccountId: SIBLING_OVERRIDE } });
    if (!siblingNS) throw new Error(`Override sibling ${SIBLING_OVERRIDE} has no NS`);
  } else {
    const siblings = await p.savedAccount.findMany({
      where: { userId: account.userId, id: { not: SAVED_ACCOUNT_ID }, archivedAt: null },
      include: { notificationSettings: true },
      orderBy: { lastUsedAt: 'desc' },
    });
    const candidate = siblings.find(s => s.notificationSettings?.sigcoreApiKey);
    if (candidate) {
      siblingNS = candidate.notificationSettings;
      console.log('Will clone rules from sibling:', `[${candidate.platform}] ${candidate.businessName}`);
    } else {
      console.log('No sibling with NS rules found — new NS will be created without rules.');
    }
  }

  const siblingRules = siblingNS
    ? await p.notificationRule.findMany({ where: { notificationSettingsId: siblingNS.id }, orderBy: { createdAt: 'asc' } })
    : [];
  console.log(`Sibling rule count: ${siblingRules.length}`);

  const sigcoreUrl = process.env.SIGCORE_API_URL;
  const platformKey = process.env.SIGCORE_API_KEY;
  if (!sigcoreUrl || !platformKey) throw new Error('SIGCORE_API_URL or SIGCORE_API_KEY missing from env');

  if (DRY_RUN) {
    console.log('\n[DRY-RUN] Would POST to', sigcoreUrl + '/tenants/provision');
    console.log('  externalTenantId:', SAVED_ACCOUNT_ID);
    console.log('  displayName:', `${account.businessName} (${account.platform})`);
    console.log('[DRY-RUN] Would create NS + clone ' + siblingRules.length + ' rules');
    return;
  }

  // 1. Sigcore tenant provision
  console.log('\nProvisioning Sigcore tenant…');
  const provResp = await fetch(`${sigcoreUrl}/tenants/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': platformKey },
    body: JSON.stringify({ externalTenantId: SAVED_ACCOUNT_ID, displayName: `${account.businessName} (${account.platform})` }),
  });
  if (!provResp.ok) {
    const text = await provResp.text();
    throw new Error(`Sigcore provision failed (${provResp.status}): ${text}`);
  }
  const { data: sigData } = await provResp.json();
  console.log('Sigcore tenantId:', sigData.tenantId);

  // 2. Create NS
  const ns = await p.notificationSettings.create({
    data: {
      savedAccountId: SAVED_ACCOUNT_ID,
      userId: account.userId,
      enabled: true,
      destinationPhone: account.user.businessPhone,
      customerTextingEnabled: siblingNS?.customerTextingEnabled ?? true,
      requirePhone: siblingNS?.requirePhone ?? true,
      template: siblingNS?.template,
      quietHoursStart: siblingNS?.quietHoursStart,
      quietHoursEnd: siblingNS?.quietHoursEnd,
      quietHoursTimezone: siblingNS?.quietHoursTimezone,
      sigcoreApiKey: sigData.apiKey,
      sigcoreTenantId: sigData.tenantId,
      sigcoreWorkspaceId: sigData.tenantId,
      sigcoreProvisionedAt: new Date(),
    },
  });
  console.log('Created NS:', ns.id);

  // 3. Clone rules
  for (const r of siblingRules) {
    await p.notificationRule.create({
      data: {
        notificationSettingsId: ns.id,
        name: r.name,
        triggerType: r.triggerType,
        replyTriggerMode: r.replyTriggerMode,
        fromPhone: r.fromPhone,
        toPhone: r.toPhone,
        sendToCustomer: r.sendToCustomer,
        template: r.template,
        templateId: r.templateId,
        delayMinutes: r.delayMinutes,
        stopOnCustomerReply: r.stopOnCustomerReply,
        stopOnLeadClosed: r.stopOnLeadClosed,
        stopOnOptOut: r.stopOnOptOut,
        enabled: r.enabled,
      },
    });
    console.log(`Cloned rule: "${r.name}"`);
  }

  console.log('\nNOTE: inboundSmsWebhookId is still null. Register it with:');
  console.log(`  SAVED_ACCOUNT_ID=${SAVED_ACCOUNT_ID} node scripts/_register-inbound-sms-webhook.js`);
})().then(()=>p.$disconnect()).catch(e=>{console.error('ERROR:', e.message); p.$disconnect(); process.exit(1);});
