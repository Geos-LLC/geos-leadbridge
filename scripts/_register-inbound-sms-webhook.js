/* eslint-disable */
// Recovery: register the Sigcore inbound-SMS webhook for a SavedAccount whose
// NS.inboundSmsWebhookId is null. Mirrors notifications.service.ts
// ensureInboundSmsWebhook() but runs as a one-off.
//
// As of 2026-06-23 the autoProvisionSigcore code path calls this automatically
// on every new SavedAccount — so this script is only needed for pre-fix tenants
// (i.e. ones onboarded before that deploy) or for manual recovery.
//
// Required env: DIRECT_URL, SIGCORE_API_URL, and one of BACKEND_PUBLIC_URL /
//               APP_BASE_URL / RAILWAY_PUBLIC_DOMAIN
// Required arg: SAVED_ACCOUNT_ID=<uuid>
// Optional:     DRY_RUN=1

const { PrismaClient } = require('../generated/prisma');
const p = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });

const DRY_RUN = process.env.DRY_RUN === '1';
const YELP_SAVED_ACCOUNT_ID = process.env.SAVED_ACCOUNT_ID;
if (!YELP_SAVED_ACCOUNT_ID) {
  console.error('Usage: SAVED_ACCOUNT_ID=<uuid> node scripts/_register-inbound-sms-webhook.js');
  process.exit(2);
}

(async () => {
  const ns = await p.notificationSettings.findUnique({
    where: { savedAccountId: YELP_SAVED_ACCOUNT_ID },
    select: { id: true, sigcoreApiKey: true, inboundSmsWebhookId: true },
  });
  if (!ns) throw new Error('NS not found for Yelp savedAccount');
  if (!ns.sigcoreApiKey) throw new Error('NS has no sigcoreApiKey — provision first');
  if (ns.inboundSmsWebhookId) {
    console.log('Already registered:', ns.inboundSmsWebhookId);
    return;
  }

  const sigcoreUrl = process.env.SIGCORE_API_URL;
  const backendBase = process.env.BACKEND_PUBLIC_URL || process.env.APP_BASE_URL || ('https://' + process.env.RAILWAY_PUBLIC_DOMAIN);
  if (!sigcoreUrl) throw new Error('SIGCORE_API_URL not set');
  if (!backendBase) throw new Error('No backend base URL resolvable');

  const webhookUrl = `${backendBase.replace(/\/$/,'')}/api/webhooks/sigcore/inbound-sms?accountId=${YELP_SAVED_ACCOUNT_ID}`;
  const endpoint = `${sigcoreUrl}/v1/webhook-subscriptions`;
  console.log('Will register webhook:');
  console.log('  endpoint:', endpoint);
  console.log('  webhookUrl:', webhookUrl);
  console.log('  events:', ['sms.message.received', 'message.inbound']);

  if (DRY_RUN) {
    console.log('\n[DRY-RUN] No call made.');
    return;
  }

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'x-api-key': ns.sigcoreApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'LeadBridge Inbound SMS',
      webhookUrl,
      events: ['sms.message.received', 'message.inbound'],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Sigcore webhook-subscriptions failed (${resp.status}): ${text}`);
  }
  const result = await resp.json();
  const webhookId = result.data?.id || result.id || result.subscriptionId;
  if (!webhookId) {
    console.log('Sigcore response:', JSON.stringify(result));
    throw new Error('No webhookId in response');
  }
  console.log('Registered webhookId:', webhookId);

  await p.notificationSettings.update({
    where: { id: ns.id },
    data: { inboundSmsWebhookId: webhookId },
  });
  console.log('Saved inboundSmsWebhookId on NS', ns.id);
})().then(()=>p.$disconnect()).catch(e=>{console.error('ERROR:', e.message);p.$disconnect();process.exit(1);});
