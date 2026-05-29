#!/usr/bin/env node
/**
 * Self-contained smoke test for the new SF→LB provisioning endpoints.
 *
 *   Required env: DATABASE_URL, SHARED_SECRET, SYNTH_PWD
 *
 * Steps:
 *   1. verify-credentials with correct password → 200 + link_token
 *   2. verify-credentials with bad password → 401
 *   3. provision with the link_token + full payload → 200 + webhook secret + sf_connection row
 *   4. provision again with same link_token → 409 link_token_already_consumed
 *   5. DB row inspection
 *   6. Bad HMAC → 401
 *   7. Cleanup the synthetic row + nonces so the smoke is rerunnable
 */
const crypto = require('crypto');
const { PrismaClient } = require('../../generated/prisma');

const HOST = 'https://thumbtack-bridge-staging.up.railway.app';
const SHARED = process.env.SHARED_SECRET;
const PWD = process.env.SYNTH_PWD;
const EMAIL = 'sf-prov-smoke-test@staging.local';

if (!SHARED || !PWD) {
  console.error('SHARED_SECRET and SYNTH_PWD must be set');
  process.exit(1);
}

function signedHeaders(rawBody) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac('sha256', SHARED).update(ts + '.' + rawBody).digest('hex');
  return {
    'X-SF-Timestamp': ts,
    'X-SF-Signature': sig,
    'Content-Type': 'application/json',
  };
}

(async () => {
  const p = new PrismaClient();

  console.log('=== Step 1: POST /verify-credentials (correct password) ===');
  const body1 = JSON.stringify({ email: EMAIL, password: PWD });
  const r1 = await fetch(HOST + '/api/v1/integrations/sf/verify-credentials', {
    method: 'POST',
    headers: signedHeaders(body1),
    body: body1,
  });
  const j1 = await r1.json();
  console.log('  status: ' + r1.status);
  console.log('  ok: ' + j1.ok);
  console.log('  lb_user_id: ' + (j1.lb_user_id || '<none>'));
  console.log('  lb_user_email: ' + (j1.lb_user_email || '<none>'));
  console.log('  lb_user_display_name: ' + (j1.lb_user_display_name || '<none>'));
  console.log('  link_token len: ' + (j1.link_token ? j1.link_token.length : 0));
  if (!j1.ok || !j1.link_token) {
    console.log('FAIL Step 1: error=' + j1.error);
    process.exit(1);
  }
  const link_token = j1.link_token;

  console.log('');
  console.log('=== Step 2: POST /verify-credentials (BAD password — expect 401) ===');
  const body2 = JSON.stringify({ email: EMAIL, password: 'wrong-password' });
  const r2 = await fetch(HOST + '/api/v1/integrations/sf/verify-credentials', {
    method: 'POST',
    headers: signedHeaders(body2),
    body: body2,
  });
  const j2 = await r2.json();
  console.log('  status: ' + r2.status + ' (expect 401)');
  console.log('  ok: ' + j2.ok + ' error: ' + j2.error);
  if (r2.status !== 401 || j2.error !== 'invalid_credentials') {
    console.log('FAIL Step 2');
    process.exit(1);
  }

  console.log('');
  console.log('=== Step 3: POST /provision (with link_token + full payload) ===');
  const provisioning = {
    tenant: {
      sf_tenant_id: 999998,
      sf_workspace_id: 999998,
      sf_base_url: 'https://service-flow-backend-staging-303f.up.railway.app',
      source_instance: 'sf-staging',
      api_region: null,
      sf_tenant_name: 'SF Provisioning Smoke Test',
    },
    credential: {
      token: 'sfo_v1.SMOKE_TEST_BEARER_AAAA_BBBB_CCCC_DDDD_EEEE_FFFF_GGGG',
      token_prefix: 'sfo_v1.SMOKE',
      kid: 'sf_orch_smoke_2026_05',
      scope: 'lb_orchestration',
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 90 * 86400 * 1000).toISOString(),
      cred_id: 9999,
    },
    endpoints: {
      availability: '/api/integrations/leadbridge/orchestration/availability',
      booking_request: '/api/integrations/leadbridge/orchestration/booking-request',
      booking_cancel: '/api/integrations/leadbridge/orchestration/booking-cancel',
      handoff: '/api/integrations/leadbridge/orchestration/handoff',
      disconnect: '/api/integrations/leadbridge/disconnect',
      credentials_refresh: '/api/integrations/leadbridge/orchestration/credentials/refresh',
    },
    signature_metadata: { algorithm: 'hmac-sha256-hex', max_clock_skew_seconds: 300 },
    event_types: [
      'service_scheduled',
      'service_rescheduled',
      'service_cancelled',
      'service_completed',
      'connection.connected',
      'credential.rotated',
      'connection.revoked',
    ],
  };
  const body3 = JSON.stringify({ link_token, provisioning });
  const r3 = await fetch(HOST + '/api/v1/integrations/sf/provision', {
    method: 'POST',
    headers: signedHeaders(body3),
    body: body3,
  });
  const j3 = await r3.json();
  console.log('  status: ' + r3.status);
  console.log('  ok: ' + j3.ok);
  console.log('  connection_id: ' + (j3.connection_id || '<none>'));
  console.log('  sf_tenant_id: ' + (j3.sf_tenant_id || '<none>'));
  console.log('  lb_user_id: ' + (j3.lb_user_id || '<none>'));
  console.log('  webhook.url: ' + (j3.webhook && j3.webhook.url));
  console.log('  webhook.secret_len: ' + (j3.webhook && j3.webhook.secret ? j3.webhook.secret.length : 0));
  if (!j3.ok) {
    console.log('FAIL Step 3: error=' + j3.error + ' detail=' + j3.detail);
    process.exit(1);
  }

  console.log('');
  console.log('=== Step 4: POST /provision AGAIN with same link_token (expect 409) ===');
  const r4 = await fetch(HOST + '/api/v1/integrations/sf/provision', {
    method: 'POST',
    headers: signedHeaders(body3),
    body: body3,
  });
  const j4 = await r4.json();
  console.log('  status: ' + r4.status + ' (expect 409)');
  console.log('  error: ' + j4.error + ' (expect link_token_already_consumed)');
  if (r4.status !== 409 || j4.error !== 'link_token_already_consumed') {
    console.log('FAIL Step 4');
    process.exit(1);
  }

  console.log('');
  console.log('=== Step 5: sf_connection row inspection ===');
  const conn = await p.sfConnection.findFirst({ where: { userId: j3.lb_user_id } });
  console.log('  id matches response: ' + (conn.id === j3.connection_id));
  console.log('  status: ' + conn.status + ' (expect active)');
  console.log('  isActive: ' + conn.isActive);
  console.log('  sfTenantId: ' + conn.sfTenantId);
  console.log('  sfTenantName: ' + conn.sfTenantName);
  console.log('  signatureKeyId: ' + conn.signatureKeyId);
  console.log('  orchestrationTokenKid: ' + conn.orchestrationTokenKid);
  console.log('  tokenPrefix: ' + conn.tokenPrefix);
  console.log('  tokenLastRotationSource: ' + conn.tokenLastRotationSource);
  const eps = JSON.parse(conn.endpointsJson);
  console.log('  endpoints.credentials_refresh: ' + eps.credentials_refresh);
  console.log('  subscription linked: ' + !!conn.inboundSubscriptionId);

  console.log('');
  console.log('=== Step 6: Bad HMAC signature (expect 401) ===');
  const r6 = await fetch(HOST + '/api/v1/integrations/sf/verify-credentials', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SF-Timestamp': String(Math.floor(Date.now() / 1000)),
      'X-SF-Signature': 'a'.repeat(64),
    },
    body: body1,
  });
  console.log('  status: ' + r6.status + ' (expect 401)');
  console.log('  body: ' + (await r6.text()).slice(0, 200));

  console.log('');
  console.log('=== Step 7: cleanup ===');
  await p.sfConnection.deleteMany({ where: { userId: j3.lb_user_id } });
  await p.sfProvisioningLinkConsumed.deleteMany({ where: { userId: j3.lb_user_id } });
  console.log('  deleted synthetic sf_connection + consumed link nonces');

  await p.$disconnect();
  console.log('');
  console.log('ALL STEPS PASSED');
})().catch((e) => {
  console.error('ERR:', e.message);
  process.exit(1);
});
