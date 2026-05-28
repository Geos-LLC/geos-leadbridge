/**
 * SF S4 staging round-trip harness — Phase 2C.
 *
 * Driver script for the joint LB ↔ SF staging round-trip test. Each
 * subcommand is idempotent + safe to re-run + read-only against the
 * shared Supabase DB unless explicitly invoking an LB endpoint.
 *
 * STAGING ONLY. This script must never be pointed at production
 * Railway URLs or production env. The hardcoded host
 * `thumbtack-bridge-staging.up.railway.app` is the only LB target.
 * SF staging is `service-flow-backend-staging-303f.up.railway.app`.
 * Both are asserted before any outbound call.
 *
 * Usage:
 *   node scripts/sf-staging-roundtrip/harness.js <subcommand>
 *
 * Subcommands:
 *   precheck                — pre-test state (env set, 0 connection rows, endpoints respond)
 *   mint-sf-jwt             — pull SF_STAGING_JWT_SECRET + print short-lived JWT for tenant 99999
 *   postcheck <userId>      — verify sf_connections row + linked subscription after handshake
 *   resolver-check <userId> — verify resolver returns source=connection for the test user
 *   test-outbound <userId>  — call SF /availability with the stored token; verify SF accepts
 *   loki-verify             — scan post-handshake Loki for plaintext token/secret leaks
 *   summary                 — overall state dump
 *
 * Required env / secrets (pulled from AWS bag `geos-dashboard-tokens`):
 *   - SF_OAUTH_LB_STAGING_CLIENT_SECRET   (already present)
 *   - SF_STAGING_JWT_SECRET               (asked of SF agent; not yet present)
 *   - RAILWAY_TOKEN                       (already present)
 *   - GRAFANA_SA_TOKEN                    (already present)
 *
 * Locally required:
 *   - DATABASE_URL or DIRECT_URL pointing at the shared Supabase DB
 *     (pulled from Railway prod env vars by the script when needed)
 */

const crypto = require('crypto');
const { spawnSync } = require('child_process');

// ─── Constants (asserted on every outbound call) ─────────────────────

const LB_STAGING_HOST = 'thumbtack-bridge-staging.up.railway.app';
const SF_STAGING_HOST = 'service-flow-backend-staging-303f.up.railway.app';
const LB_STAGING_BASE = `https://${LB_STAGING_HOST}`;
const SF_STAGING_BASE = `https://${SF_STAGING_HOST}`;

const TEST_TENANT_SF_USER_ID = 99999;
const TEST_TENANT_EMAIL = 'sf-orch-test-tenant@staging.local';

const SF_AVAILABILITY_PATH = '/api/integrations/leadbridge/orchestration/availability';

// Default JWT TTL — short-lived per user guidance
const DEFAULT_JWT_TTL_SECONDS = 30 * 60;

// ─── Tiny inline HMAC-SHA256 JWT (no external dep) ──────────────────

function base64url(buf) {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJwtHS256(payload, secret, ttlSec) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    ...payload,
    iat: now,
    exp: now + ttlSec,
  };
  const h = base64url(Buffer.from(JSON.stringify(header)));
  const p = base64url(Buffer.from(JSON.stringify(claims)));
  const sig = base64url(crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${sig}`;
}

// ─── Secrets bag access ─────────────────────────────────────────────

function fetchSecretsBag() {
  // Use spawnSync with argv form to dodge shell quoting differences on Windows
  // (cmd.exe and PowerShell handle single-quoted --query differently).
  const result = spawnSync(
    'aws',
    [
      'secretsmanager', 'get-secret-value',
      '--secret-id', 'geos-dashboard-tokens',
      '--region', 'us-east-1',
      '--query', 'SecretString',
      '--output', 'text',
    ],
    { encoding: 'utf8', shell: process.platform === 'win32' },
  );
  if (result.status !== 0) {
    throw new Error(`aws secretsmanager failed: ${result.stderr || result.stdout}`);
  }
  const clean = result.stdout.replace(/^﻿/, '').trim();
  return JSON.parse(clean);
}

function getRequiredSecret(name) {
  const bag = fetchSecretsBag();
  const v = bag[name];
  if (!v) throw new Error(`Required secret missing from bag: ${name}`);
  return v;
}

// ─── Railway env access ─────────────────────────────────────────────

const PROJECT_ID = 'af5d4f09-6bb6-49c6-ae0c-cf72fda35c88';
const STAGING_ENV_ID = 'f0fdb387-3a97-49cb-9c1c-dd2fe38cf513';
const PROD_ENV_ID = '69d744fa-6fc4-48b3-83c9-4aac67a6081a';
const SERVICE_ID = 'd59d2d4c-816a-4639-9687-8e0ec7b487cf';

async function fetchRailwayEnv(envId) {
  if (envId === PROD_ENV_ID) throw new Error('REFUSED: prod env not in scope');
  const RAILWAY_TOKEN = getRequiredSecret('RAILWAY_TOKEN');
  const res = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RAILWAY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query { variables(projectId: "${PROJECT_ID}", environmentId: "${envId}", serviceId: "${SERVICE_ID}") }`,
    }),
  });
  const j = await res.json();
  return j.data?.variables || {};
}

// ─── Prisma access (shared with Supabase prod DB) ──────────────────

let _prisma;
function prisma() {
  if (_prisma) return _prisma;
  // Resolve DIRECT_URL from Railway staging env (since staging shares prod DB,
  // either env's DIRECT_URL works; we read from staging to keep scope clean).
  const url = process.env.DATABASE_URL || process.env.DIRECT_URL;
  if (!url) throw new Error('DATABASE_URL or DIRECT_URL required in current shell');
  const { PrismaClient } = require('../../generated/prisma');
  _prisma = new PrismaClient({ datasources: { db: { url } } });
  return _prisma;
}

// ─── Outbound HTTP (asserts host is staging) ────────────────────────

async function safeFetch(url, init = {}) {
  const u = new URL(url);
  if (u.host !== LB_STAGING_HOST && u.host !== SF_STAGING_HOST) {
    throw new Error(`REFUSED: host ${u.host} is not staging`);
  }
  // Never log Authorization header
  const safeInit = { ...init, headers: { ...(init.headers || {}) } };
  return fetch(url, safeInit);
}

// ═══════════════════════════════════════════════════════════════════════
// Subcommands
// ═══════════════════════════════════════════════════════════════════════

async function cmdPrecheck() {
  console.log('=== precheck ===');
  // 1. Required secrets present in bag
  const bag = fetchSecretsBag();
  const required = ['SF_OAUTH_LB_STAGING_CLIENT_SECRET', 'RAILWAY_TOKEN', 'GRAFANA_SA_TOKEN'];
  const optional = ['SF_STAGING_JWT_SECRET'];
  for (const k of required) {
    console.log(`  [secret] ${k.padEnd(40)} ${bag[k] ? `present (len=${bag[k].length})` : 'MISSING'}`);
  }
  for (const k of optional) {
    console.log(`  [secret] ${k.padEnd(40)} ${bag[k] ? `present (len=${bag[k].length})` : 'PENDING SF (mint-sf-jwt will block until set)'}`);
  }

  // 2. Staging env vars set
  console.log('');
  const env = await fetchRailwayEnv(STAGING_ENV_ID);
  const expectedEnv = [
    'SF_OAUTH_STATE_SECRET', 'SF_OAUTH_CONNECT_URL', 'SF_OAUTH_EXCHANGE_URL',
    'SF_OAUTH_CLIENT_ID', 'SF_OAUTH_CLIENT_SECRET', 'SF_OAUTH_CALLBACK_URL',
  ];
  for (const k of expectedEnv) {
    const v = env[k];
    const show = !v ? 'UNSET' : (/SECRET/i.test(k) ? `SET (len=${v.length})` : `SET (${v.slice(0, 60)})`);
    console.log(`  [staging env] ${k.padEnd(28)} ${show}`);
  }

  // 3. Prod env vars all unset (sanity)
  console.log('');
  const prodEnv = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${getRequiredSecret('RAILWAY_TOKEN')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query { variables(projectId: "${PROJECT_ID}", environmentId: "${PROD_ENV_ID}", serviceId: "${SERVICE_ID}") }`,
    }),
  }).then(r => r.json()).then(j => j.data?.variables || {});
  let prodSet = 0;
  for (const k of expectedEnv) if (prodEnv[k]) prodSet++;
  console.log(`  [prod env] orchestration vars set: ${prodSet} / 10 (must be 0)`);
  if (prodSet > 0) throw new Error('PROD env has orchestration vars set — abort');

  // 4. Endpoint reachability
  console.log('');
  const probes = [
    { name: 'GET /callback', method: 'GET',  path: '/api/v1/integrations/sf/callback', expectStatus: 303 },
    { name: 'POST /orchestration-webhook', method: 'POST', path: '/api/v1/integrations/sf/orchestration-webhook', expectStatus: 401 },
    { name: 'POST /connect/start', method: 'POST', path: '/api/v1/integrations/sf/connect/start', expectStatus: 401 },
    { name: 'POST /disconnect',    method: 'POST', path: '/api/v1/integrations/sf/disconnect',    expectStatus: 401 },
  ];
  for (const p of probes) {
    const r = await safeFetch(`${LB_STAGING_BASE}${p.path}`, { method: p.method, redirect: 'manual', headers: { 'Content-Type': 'application/json' }, body: p.method === 'POST' ? '{}' : undefined });
    const ok = r.status === p.expectStatus;
    console.log(`  [endpoint] ${p.name.padEnd(34)} status=${r.status} ${ok ? '✓' : '✗ expected ' + p.expectStatus}`);
  }

  // 5. DB state — 0 sf_connections rows
  console.log('');
  try {
    const total = await prisma().sfConnection.count();
    const forTestTenant = await prisma().sfConnection.findFirst({ where: { sfTenantId: String(TEST_TENANT_SF_USER_ID) } });
    console.log(`  [db] sf_connections total: ${total}`);
    console.log(`  [db] row for tenant ${TEST_TENANT_SF_USER_ID}: ${forTestTenant ? 'EXISTS (id=' + forTestTenant.id + ', status=' + forTestTenant.status + ')' : 'none'}`);
  } catch (e) {
    console.log(`  [db] skipped — set DATABASE_URL or DIRECT_URL to enable (${e.message.slice(0, 80)})`);
  }
}

async function cmdMintSfJwt() {
  console.log('=== mint-sf-jwt ===');
  let secret;
  try {
    secret = getRequiredSecret('SF_STAGING_JWT_SECRET');
  } catch (e) {
    console.error('BLOCKED: SF_STAGING_JWT_SECRET not in bag yet. Ask SF agent to add it.');
    process.exit(2);
  }
  const ttl = parseInt(process.env.JWT_TTL_SECONDS || String(DEFAULT_JWT_TTL_SECONDS), 10);
  const claims = { userId: TEST_TENANT_SF_USER_ID, email: TEST_TENANT_EMAIL };
  const token = signJwtHS256(claims, secret, ttl);
  console.log(`  tenant_user_id: ${TEST_TENANT_SF_USER_ID}`);
  console.log(`  email:          ${TEST_TENANT_EMAIL}`);
  console.log(`  ttl_seconds:    ${ttl}`);
  console.log(`  expires_at:     ${new Date(Date.now() + ttl * 1000).toISOString()}`);
  console.log(`  jwt_len:        ${token.length}`);
  console.log('');
  console.log('  JWT:');
  console.log(`  ${token}`);
  console.log('');
  console.log('  Use as: Authorization: Bearer <jwt>');
  console.log('  When calling: ' + SF_STAGING_BASE + '/api/integrations/leadbridge/authorize?...');
}

async function cmdPostcheck(userId) {
  console.log('=== postcheck userId=' + userId + ' ===');
  if (!userId) throw new Error('userId arg required');
  const conn = await prisma().sfConnection.findUnique({ where: { userId } });
  if (!conn) {
    console.log('  ✗ no sf_connections row for userId=' + userId);
    process.exit(2);
  }
  // Assertions
  const checks = [];
  checks.push(['status=active', conn.status === 'active']);
  checks.push(['isActive=true', conn.isActive === true]);
  checks.push(['sfTenantId=99999', conn.sfTenantId === String(TEST_TENANT_SF_USER_ID)]);
  checks.push(['sfWorkspaceId set', typeof conn.sfWorkspaceId === 'string' && conn.sfWorkspaceId.length > 0]);
  checks.push(['baseUrl matches SF staging', conn.baseUrl === SF_STAGING_BASE]);
  checks.push(['orchestrationToken encrypted (not plaintext)', conn.orchestrationToken && !conn.orchestrationToken.startsWith('sfo_v1')]);
  checks.push(['tokenPrefix set + starts with sfo_v1', conn.tokenPrefix && conn.tokenPrefix.startsWith('sfo_v1')]);
  checks.push(['orchestrationTokenKid set', !!conn.orchestrationTokenKid]);
  checks.push(['orchestrationTokenScope=lb_orchestration', conn.orchestrationTokenScope === 'lb_orchestration']);
  checks.push(['tokenIssuedAt set', conn.tokenIssuedAt instanceof Date]);
  checks.push(['endpointsJson populated + parses + has 5 keys', (() => {
    try {
      const o = JSON.parse(conn.endpointsJson || '{}');
      return o.availability && o.booking_request && o.booking_cancel && o.handoff && o.disconnect;
    } catch { return false; }
  })()]);
  checks.push(['signatureAlgorithm=hmac-sha256-hex', conn.signatureAlgorithm === 'hmac-sha256-hex']);
  checks.push(['maxClockSkewSeconds=300', conn.maxClockSkewSeconds === 300]);
  checks.push(['signatureKeyId set', !!conn.signatureKeyId]);
  checks.push(['inboundSubscriptionId set', !!conn.inboundSubscriptionId]);

  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  }

  // Subscription linked correctly
  if (conn.inboundSubscriptionId) {
    const sub = await prisma().crmWebhookSubscription.findUnique({ where: { id: conn.inboundSubscriptionId } });
    if (!sub) {
      console.log('  ✗ inboundSubscription FK points at missing row');
    } else {
      console.log(`  ✓ subscription linked: id=${sub.id}, isActive=${sub.isActive}, events=${sub.events.length}`);
      console.log(`    secret encrypted=${sub.secret && !sub.secret.includes('=')} len=${sub.secret?.length}`);
    }
  }

  // No plaintext token in row (defense check)
  const rowJson = JSON.stringify(conn);
  if (rowJson.includes('sfo_v1.eyJ') && !rowJson.includes('sfo_v1.eyJ2Ij'.slice(0, 13))) {
    // Allow prefix; reject full token
    const matches = rowJson.match(/sfo_v1\.[A-Za-z0-9_-]{40,}/g);
    if (matches && matches.length > 0) {
      console.log('  ✗ PLAINTEXT TOKEN FOUND IN ROW — ABORT');
      console.log('    matches: ' + matches.map(m => m.slice(0, 30) + '…').join(', '));
    } else {
      console.log('  ✓ only token_prefix in row, no full plaintext');
    }
  } else {
    console.log('  ✓ no plaintext sfo_v1 token in row');
  }

  console.log('');
  console.log('  Connection summary:');
  console.log('    id:              ' + conn.id);
  console.log('    userId:          ' + conn.userId);
  console.log('    status:          ' + conn.status);
  console.log('    sfTenantId:      ' + conn.sfTenantId);
  console.log('    sfWorkspaceId:   ' + conn.sfWorkspaceId);
  console.log('    tokenPrefix:     ' + conn.tokenPrefix);
  console.log('    token_kid:       ' + conn.orchestrationTokenKid);
  console.log('    connectedAt:     ' + conn.connectedAt?.toISOString());
}

async function cmdResolverCheck(userId) {
  console.log('=== resolver-check userId=' + userId + ' ===');
  if (!userId) throw new Error('userId arg required');
  // Re-implement the resolver's ladder inline so we can run it from a script
  // without booting Nest. Mirrors src/sf-orchestration/sf-connection-resolver.service.ts.
  const conn = await prisma().sfConnection.findUnique({ where: { userId } });
  if (!conn) {
    console.log('  ✗ no row → resolver would return enabled=false source=none');
    return;
  }
  const isUsableStatus = conn.isActive && (conn.status === 'active' || conn.status === 'rotating');
  if (!isUsableStatus) {
    console.log(`  ✗ status=${conn.status} isActive=${conn.isActive} → resolver disabled`);
    return;
  }
  console.log('  ✓ resolver would return: enabled=true source=connection');
  console.log('    sfTenantId=' + conn.sfTenantId);
  console.log('    baseUrl=' + conn.baseUrl);
  console.log('    tokenPrefix=' + conn.tokenPrefix);
  console.log('    endpoints loaded: ' + (conn.endpointsJson ? 'yes' : 'no'));
}

async function cmdTestOutbound(userId) {
  console.log('=== test-outbound userId=' + userId + ' ===');
  if (!userId) throw new Error('userId arg required');
  const { EncryptionUtil } = require('../../dist/common/utils/encryption.util');
  const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY env required (read from Railway staging env first)');

  const conn = await prisma().sfConnection.findUnique({ where: { userId } });
  if (!conn) throw new Error('no connection row');
  if (!conn.orchestrationToken) throw new Error('connection has no token');

  let token;
  try {
    token = EncryptionUtil.decrypt(conn.orchestrationToken, ENCRYPTION_KEY);
  } catch (e) {
    throw new Error(`token decrypt failed: ${e.message}`);
  }
  console.log('  token decrypted, prefix=' + token.slice(0, 13) + ' len=' + token.length);

  // Build a minimal availability call
  const endpoints = JSON.parse(conn.endpointsJson);
  const path = endpoints.availability;
  const url = conn.baseUrl + path + `?sigcoreBusinessId=test&serviceType=test`;
  console.log('  GET ' + url);
  const r = await safeFetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-LB-User-Id': userId,
      'X-Correlation-Id': crypto.randomUUID(),
    },
  });
  console.log('  → status=' + r.status);
  let body;
  try { body = await r.json(); } catch { body = await r.text(); }
  // NEVER log the token
  console.log('  → body: ' + JSON.stringify(body).slice(0, 300));

  if (r.status >= 200 && r.status < 300) {
    console.log('  ✓ SF accepted sfo_v1 token — outbound auth WORKS');
  } else if (r.status === 401) {
    console.log('  ✗ 401 — token rejected by SF');
  } else if (r.status === 403) {
    console.log('  ✗ 403 — orchestration not enabled for tenant on SF side');
  } else {
    console.log(`  ? status=${r.status} — inspect body`);
  }
}

async function cmdLokiVerify() {
  console.log('=== loki-verify ===');
  const GRAFANA_SA_TOKEN = getRequiredSecret('GRAFANA_SA_TOKEN');
  // Wake Grafana
  for (let i = 0; i < 5; i++) {
    const r = await fetch('https://info3d7b.grafana.net/api/org', {
      headers: { Authorization: `Bearer ${GRAFANA_SA_TOKEN}` },
    });
    if (r.status === 200) break;
    await new Promise(s => setTimeout(s, 3000));
  }
  // Query last 30 min for plaintext leak patterns
  const start = (Date.now() - 30 * 60 * 1000) * 1e6;
  const end = Date.now() * 1e6;
  const dangerPatterns = [
    'sfo_v1\\\\.eyJ',           // SF token prefix
    'orchestration_token=',     // raw field name with value
    'webhook_signing_secret=',  // raw field name with value
  ];
  for (const pat of dangerPatterns) {
    const params = new URLSearchParams({
      query: `{service_name="leadbridge-api"} |~ "${pat}"`,
      start: String(start),
      end: String(end),
      limit: '5',
      direction: 'backward',
    });
    const r = await fetch(`https://info3d7b.grafana.net/api/datasources/proxy/7/loki/api/v1/query_range?${params}`, {
      headers: { Authorization: `Bearer ${GRAFANA_SA_TOKEN}` },
    });
    const j = await r.json();
    const count = (j.data?.result || []).reduce((a, s) => a + (s.values?.length || 0), 0);
    console.log(`  ${count === 0 ? '✓' : '✗'} pattern "${pat}": ${count} matches`);
    if (count > 0) {
      for (const stream of j.data.result.slice(0, 1)) {
        for (const [ts, line] of (stream.values || []).slice(0, 1)) {
          console.log(`    [LEAK] ${new Date(ts/1e6).toISOString()} ${line.slice(0, 150)}…`);
        }
      }
    }
  }
}

async function cmdSummary() {
  console.log('=== summary ===');
  const total = await prisma().sfConnection.count();
  const active = await prisma().sfConnection.count({ where: { status: { in: ['active', 'rotating'] } } });
  const testRow = await prisma().sfConnection.findFirst({ where: { sfTenantId: String(TEST_TENANT_SF_USER_ID) } });
  console.log(`  sf_connections total: ${total}`);
  console.log(`  active/rotating:     ${active}`);
  console.log(`  test tenant 99999:   ${testRow ? `${testRow.status} (userId=${testRow.userId})` : 'no row'}`);
}

// ─── Main ────────────────────────────────────────────────────────────

(async () => {
  const cmd = process.argv[2];
  const arg = process.argv[3];
  try {
    switch (cmd) {
      case 'precheck':       await cmdPrecheck(); break;
      case 'mint-sf-jwt':    await cmdMintSfJwt(); break;
      case 'postcheck':      await cmdPostcheck(arg); break;
      case 'resolver-check': await cmdResolverCheck(arg); break;
      case 'test-outbound':  await cmdTestOutbound(arg); break;
      case 'loki-verify':    await cmdLokiVerify(); break;
      case 'summary':        await cmdSummary(); break;
      default:
        console.log('Usage: node scripts/sf-staging-roundtrip/harness.js <subcommand> [args]');
        console.log('Subcommands: precheck, mint-sf-jwt, postcheck <userId>, resolver-check <userId>, test-outbound <userId>, loki-verify, summary');
        process.exit(1);
    }
  } catch (e) {
    console.error('ERROR: ' + (e.stack || e.message || String(e)));
    process.exit(1);
  } finally {
    if (_prisma) await _prisma.$disconnect();
  }
})();
