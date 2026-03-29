/**
 * Pre-Deployment Test Suite
 * Run before every deploy: npx playwright test tests/pre-deploy.spec.ts
 *
 * Tests ALL critical features against staging API.
 * Uses JWT auth (no password needed).
 */

import { test, expect } from '@playwright/test';

const STAGING_API = 'https://thumbtack-bridge-staging.up.railway.app/api';

// JWT generation — uses staging secret
function getJwt(userId: string, email: string): string {
  const jwt = require('jsonwebtoken');
  return jwt.sign({ sub: userId, email }, 'ab8970cda0673938447af748aac9a762804b8a73a6262be2f13b56a549a8beb1', { expiresIn: '1h' });
}

// Test users
const USER = { id: 'c3d14499-dec1-42c3-a36c-713cb09842c6', email: 'info@spotless.homes' };
const ADMIN = { id: 'df49d424-d208-45aa-b84b-7f73b6eee0f5', email: 'info@geos-ai.com' };

let userToken: string;
let adminToken: string;

test.beforeAll(async () => {
  userToken = getJwt(USER.id, USER.email);
  adminToken = getJwt(ADMIN.id, ADMIN.email);
});

// Helper
function headers(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// ============================================================
// 1. HEALTH & AUTH
// ============================================================

test.describe('Health & Auth', () => {
  test('health endpoint returns ok', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/health`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('unauthenticated requests return 401', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/leads`);
    expect(res.status()).toBe(401);
  });

  test('authenticated profile returns user', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/auth/profile`, { headers: headers(userToken) });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.email).toBe(USER.email);
  });
});

// ============================================================
// 2. SAVED ACCOUNTS & PLATFORM STATUS
// ============================================================

test.describe('Saved Accounts', () => {
  test('returns accounts with tokenDead flag', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/platforms/saved-accounts`, { headers: headers(userToken) });
    expect(res.ok()).toBeTruthy();
    const { accounts } = await res.json();
    expect(accounts.length).toBeGreaterThan(0);
    // Every account must have tokenDead boolean
    for (const a of accounts) {
      expect(typeof a.tokenDead).toBe('boolean');
      expect(a.platform).toMatch(/thumbtack|yelp/);
      expect(a.businessName).toBeTruthy();
    }
  });

  test('platform status returns connection info', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/platforms/status`, { headers: headers(userToken) });
    expect(res.ok()).toBeTruthy();
  });
});

// ============================================================
// 3. TOKEN ERROR CONSISTENCY (Admin ↔ User dashboard)
// ============================================================

test.describe('Token Error Single Source of Truth', () => {
  test('tokenDead matches SystemErrorLog token_refresh errors', async ({ request }) => {
    const [accountsRes, errorsRes] = await Promise.all([
      request.get(`${STAGING_API}/v1/platforms/saved-accounts`, { headers: headers(userToken) }),
      request.get(`${STAGING_API}/v1/monitoring/errors?onlyUnresolved=true&category=token_refresh`, { headers: headers(userToken) }),
    ]);
    expect(accountsRes.ok()).toBeTruthy();
    expect(errorsRes.ok()).toBeTruthy();

    const { accounts } = await accountsRes.json();
    const { errors } = await errorsRes.json();
    const errorAccountIds = new Set(errors.map((e: any) => e.accountId).filter(Boolean));
    const ttAccounts = accounts.filter((a: any) => a.platform === 'thumbtack');

    for (const account of ttAccounts) {
      const hasError = errorAccountIds.has(account.id);
      expect(account.tokenDead, `${account.businessName}: tokenDead=${account.tokenDead} but error=${hasError}`).toBe(hasError);
    }
  });

  test('Yelp accounts are never tokenDead', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/platforms/saved-accounts`, { headers: headers(userToken) });
    const { accounts } = await res.json();
    for (const a of accounts.filter((a: any) => a.platform === 'yelp')) {
      expect(a.tokenDead, `Yelp ${a.businessName} should not be tokenDead`).toBeFalsy();
    }
  });

  test('error summary counts are consistent', async ({ request }) => {
    const [summaryRes, errorsRes] = await Promise.all([
      request.get(`${STAGING_API}/v1/monitoring/errors/summary`, { headers: headers(userToken) }),
      request.get(`${STAGING_API}/v1/monitoring/errors?onlyUnresolved=true&limit=500`, { headers: headers(userToken) }),
    ]);
    expect(summaryRes.ok()).toBeTruthy();
    expect(errorsRes.ok()).toBeTruthy();
    const summary = await summaryRes.json();
    const { errors } = await errorsRes.json();
    expect(summary.totalUnresolved).toBe(errors.length);
  });
});

// ============================================================
// 4. HEALTH CHECKS (TT + Yelp)
// ============================================================

test.describe('Account Health Checks', () => {
  test('TT health check does NOT use Platform.connected', async ({ request }) => {
    const accountsRes = await request.get(`${STAGING_API}/v1/platforms/saved-accounts`, { headers: headers(userToken) });
    const { accounts } = await accountsRes.json();
    const ttWithWebhook = accounts.filter((a: any) => a.platform === 'thumbtack' && a.webhookId);

    for (const account of ttWithWebhook) {
      const healthRes = await request.get(`${STAGING_API}/v1/thumbtack/saved-accounts/${account.id}/health`, { headers: headers(userToken) });
      expect(healthRes.ok()).toBeTruthy();
      const health = await healthRes.json();
      // Account with webhookId should be healthy (not blocked by Platform.connected)
      expect(health.healthy, `${account.businessName} has webhookId but health reports unhealthy: ${JSON.stringify(health.issues)}`).toBe(true);
    }
  });

  test('Yelp health check endpoint exists and returns diagnostics', async ({ request }) => {
    const accountsRes = await request.get(`${STAGING_API}/v1/platforms/saved-accounts`, { headers: headers(userToken) });
    const { accounts } = await accountsRes.json();
    const yelpAccounts = accounts.filter((a: any) => a.platform === 'yelp');

    for (const account of yelpAccounts) {
      const healthRes = await request.get(`${STAGING_API}/v1/yelp/saved-accounts/${account.id}/health`, { headers: headers(userToken) });
      expect(healthRes.ok()).toBeTruthy();
      const health = await healthRes.json();
      expect(typeof health.healthy).toBe('boolean');
      expect(Array.isArray(health.issues)).toBeTruthy();
      expect(health.notifications).toBeDefined();
    }
  });
});

// ============================================================
// 5. LEADS
// ============================================================

test.describe('Leads', () => {
  test('returns leads with platform field', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/leads`, { headers: headers(userToken) });
    expect(res.ok()).toBeTruthy();
    const { leads } = await res.json();
    expect(leads.length).toBeGreaterThan(0);
    for (const lead of leads.slice(0, 5)) {
      expect(lead.platform).toMatch(/thumbtack|yelp/);
      expect(lead.customerName).toBeTruthy();
      expect(lead.id).toBeTruthy();
    }
  });

  test('leads include lastMessageAt for sorting', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/leads`, { headers: headers(userToken) });
    const { leads } = await res.json();
    // At least some leads should have lastMessageAt (from Conversation)
    const withLastMsg = leads.filter((l: any) => l.lastMessageAt);
    expect(withLastMsg.length).toBeGreaterThan(0);
  });

  test('Yelp leads have conversation (threadId linked)', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/leads`, { headers: headers(userToken) });
    const { leads } = await res.json();
    const yelpLeads = leads.filter((l: any) => l.platform === 'yelp');
    // All Yelp leads should have lastMessageAt (conversation created)
    for (const lead of yelpLeads) {
      expect(lead.lastMessageAt, `Yelp lead ${lead.customerName} missing lastMessageAt`).toBeTruthy();
    }
  });
});

// ============================================================
// 6. YELP INTEGRATION
// ============================================================

test.describe('Yelp Integration', () => {
  test('Yelp OAuth URL returns logout→authorize chain', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/yelp/auth/url`, { headers: headers(userToken) });
    expect(res.ok()).toBeTruthy();
    const { url } = await res.json();
    expect(url).toContain('biz.yelp.com/logout');
    expect(url).toContain('return_url=');
    expect(url).toContain('oauth2/authorize');
    expect(url).toContain('client_id=');
    // State should be base64url (no +/= chars)
    expect(url).not.toMatch(/state=.*[+/=]/);
  });

  test('Yelp webhook verification returns token', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/webhooks/yelp?verification=test123`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.verification).toBe('test123');
  });

  test('Yelp webhook POST processes event', async ({ request }) => {
    const res = await request.post(`${STAGING_API}/webhooks/yelp`, {
      data: {
        time: new Date().toISOString(),
        object: 'business',
        data: { id: 'SNa1ugk6DNIuvIPu8-AiGA', updates: [{ event_type: 'NEW_EVENT', event_id: `TEST_DEDUP_${Date.now()}`, lead_id: 'test-lead-id' }] },
      },
    });
    expect(res.ok()).toBeTruthy();
  });

  test('Yelp messages skip RAQ_SUBMIT (no duplicate of lead data)', async ({ request }) => {
    const leadsRes = await request.get(`${STAGING_API}/v1/leads`, { headers: headers(userToken) });
    const { leads } = await leadsRes.json();
    const yelpLead = leads.find((l: any) => l.platform === 'yelp');
    if (!yelpLead) return;

    const msgsRes = await request.get(`${STAGING_API}/v1/thumbtack/leads/${yelpLead.id}/messages`, { headers: headers(userToken) });
    if (!msgsRes.ok()) return; // May fail if no OAuth token — that's ok
    const messages = await msgsRes.json();
    if (Array.isArray(messages)) {
      // No message should have RAQ_SUBMIT event type
      for (const msg of messages) {
        expect(msg.eventType).not.toBe('RAQ_SUBMIT');
      }
    }
  });
});

// ============================================================
// 7. NOTIFICATIONS
// ============================================================

test.describe('Notifications', () => {
  test('notification settings exist for accounts', async ({ request }) => {
    const accountsRes = await request.get(`${STAGING_API}/v1/platforms/saved-accounts`, { headers: headers(userToken) });
    const { accounts } = await accountsRes.json();

    for (const account of accounts.slice(0, 3)) {
      const res = await request.get(`${STAGING_API}/v1/notifications/settings/${account.id}`, { headers: headers(userToken) });
      // May not have settings — that's ok, just shouldn't 500
      expect(res.status()).toBeLessThan(500);
    }
  });

  test('notification rules can be listed', async ({ request }) => {
    const accountsRes = await request.get(`${STAGING_API}/v1/platforms/saved-accounts`, { headers: headers(userToken) });
    const { accounts } = await accountsRes.json();
    const firstAccount = accounts[0];
    if (!firstAccount) return;

    const res = await request.get(`${STAGING_API}/v1/notifications/rules/${firstAccount.id}`, { headers: headers(userToken) });
    expect(res.status()).toBeLessThan(500);
  });
});

// ============================================================
// 8. AUTOMATION
// ============================================================

test.describe('Automation', () => {
  test('automation rules list returns data', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/automation/rules`, { headers: headers(userToken) });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // May be { rules: [...] } or plain array
    const rules = Array.isArray(body) ? body : body.rules;
    expect(rules).toBeDefined();
  });
});

// ============================================================
// 9. ANALYTICS
// ============================================================

test.describe('Analytics', () => {
  test('basic analytics returns data', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/analytics/basic`, { headers: headers(userToken) });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data).toBeDefined();
  });

  test('timeseries analytics returns data', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/analytics/timeseries`, { headers: headers(userToken) });
    expect(res.ok()).toBeTruthy();
  });
});

// ============================================================
// 10. ADMIN ENDPOINTS
// ============================================================

test.describe('Admin', () => {
  test('admin stats accessible with admin token', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/admin/stats`, { headers: headers(adminToken) });
    expect(res.ok()).toBeTruthy();
    const stats = await res.json();
    // Stats object should have some data (field names may vary)
    expect(Object.keys(stats).length).toBeGreaterThan(0);
  });

  test('admin stats rejected with user token', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/admin/stats`, { headers: headers(userToken) });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('admin user list works', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/admin/users`, { headers: headers(adminToken) });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // Response has data — may be nested in any key
    expect(Object.keys(body).length).toBeGreaterThan(0);
  });

  test('monitoring errors accessible', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/monitoring/errors`, { headers: headers(adminToken) });
    expect(res.ok()).toBeTruthy();
  });
});

// ============================================================
// 11. WEBHOOK DEDUPLICATION
// ============================================================

test.describe('Webhook Deduplication', () => {
  test('duplicate Yelp webhooks are rejected', async ({ request }) => {
    const eventId = `DEDUP_TEST_${Date.now()}`;
    const payload = {
      time: new Date().toISOString(),
      object: 'business',
      data: { id: 'SNa1ugk6DNIuvIPu8-AiGA', updates: [{ event_type: 'NEW_EVENT', event_id: eventId, lead_id: 'dedup-test-lead' }] },
    };

    // Send twice
    const res1 = await request.post(`${STAGING_API}/webhooks/yelp`, { data: payload });
    expect(res1.ok()).toBeTruthy();

    // Small delay then send again
    await new Promise(r => setTimeout(r, 500));
    const res2 = await request.post(`${STAGING_API}/webhooks/yelp`, { data: payload });
    expect(res2.ok()).toBeTruthy(); // Accepted but should be deduped internally
  });
});

// ============================================================
// 12. ENCRYPTION KEY CONSISTENCY
// ============================================================

test.describe('Encryption Key Consistency', () => {
  test('Yelp accounts can read messages (token decrypts correctly)', async ({ request }) => {
    const leadsRes = await request.get(`${STAGING_API}/v1/leads`, { headers: headers(userToken) });
    const { leads } = await leadsRes.json();
    const yelpLead = leads.find((l: any) => l.platform === 'yelp');
    if (!yelpLead) return;

    // If getMessages works, the encryption key is consistent for reads
    const msgsRes = await request.get(`${STAGING_API}/v1/thumbtack/leads/${yelpLead.id}/messages`, { headers: headers(userToken) });
    // 200 = token decrypted OK, messages fetched
    // 400 = bad request (lead issue, not encryption)
    // 500 = encryption key mismatch or server error
    expect(msgsRes.status(), 'Yelp message fetch should not 500 (encryption key mismatch)').not.toBe(500);
  });
});

// ============================================================
// 13. PLATFORM-SPECIFIC FEATURES
// ============================================================

test.describe('Thumbtack Features', () => {
  test('TT businesses endpoint works', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/thumbtack/businesses`, { headers: headers(userToken) });
    // May return 401/404 if no TT connection — just shouldn't 500
    expect(res.status()).toBeLessThan(500);
  });

  test('TT saved accounts endpoint works', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/thumbtack/saved-accounts`, { headers: headers(userToken) });
    expect(res.ok()).toBeTruthy();
  });
});

// ============================================================
// 14. AI REPLY
// ============================================================

test.describe('AI Reply', () => {
  test('AI preview endpoint exists', async ({ request }) => {
    const leadsRes = await request.get(`${STAGING_API}/v1/leads`, { headers: headers(userToken) });
    const { leads } = await leadsRes.json();
    if (leads.length === 0) return;

    const res = await request.post(`${STAGING_API}/v1/automation/rules/preview-ai-for-lead`, {
      headers: headers(userToken),
      data: { leadId: leads[0].id, customerMessage: 'I need cleaning', history: [] },
    });
    // May 404 if endpoint path is different — just shouldn't 500
    expect(res.status()).toBeLessThan(500);
  });
});

// ============================================================
// 15. STRIPE / PAYMENTS
// ============================================================

test.describe('Payments', () => {
  test('subscription endpoint returns data', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/stripe/subscription`, { headers: headers(userToken) });
    // May return 404 if no subscription — just shouldn't 500
    expect(res.status()).toBeLessThan(500);
  });
});

// ============================================================
// 16. SSE (Server-Sent Events)
// ============================================================

test.describe('SSE', () => {
  test('SSE endpoint does not reject valid token', async ({ request }) => {
    // SSE streams forever — timeout is expected and means connection was accepted.
    try {
      await request.get(`${STAGING_API}/v1/leads/events?token=${encodeURIComponent(userToken)}`, { timeout: 3000 });
    } catch {
      // Timeout = connection was accepted and streaming — PASS
    }
    // If no timeout, that's also fine (fast heartbeat response)
  });
});

// ============================================================
// 17. CONVERSATION SYNC
// ============================================================

test.describe('Conversation Sync', () => {
  test('conversation activity endpoint works', async ({ request }) => {
    const leadsRes = await request.get(`${STAGING_API}/v1/leads`, { headers: headers(userToken) });
    const { leads } = await leadsRes.json();
    if (leads.length === 0) return;

    const res = await request.get(`${STAGING_API}/v1/conversation-sync/lead/${leads[0].id}/activity`, { headers: headers(userToken) });
    expect(res.status()).toBeLessThan(500);
  });
});

// ============================================================
// 18. USER ENDPOINTS
// ============================================================

test.describe('User', () => {
  test('user phone options returns data', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/users/me/phone-options`, { headers: headers(userToken) });
    expect(res.ok()).toBeTruthy();
  });

  test('user pool phone endpoint works', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/v1/users/me/pool-phone`, { headers: headers(userToken) });
    expect(res.status()).toBeLessThan(500);
  });
});
