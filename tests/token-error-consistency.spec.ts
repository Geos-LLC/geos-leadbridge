/**
 * Token Error Consistency Tests
 *
 * Verifies that admin dashboard (SystemErrorLog) and user dashboard (tokenDead flag)
 * agree on which accounts have token errors. Both should use SystemErrorLog as the
 * single source of truth.
 *
 * Key invariant: an account's tokenDead flag is true IFF there exists an unresolved
 * SystemErrorLog entry with category='token_refresh' and matching accountId.
 *
 * Auth: Set TEST_JWT_TOKEN env var, or TEST_PASSWORD + TEST_EMAIL for login-based auth.
 */

import { test, expect } from '@playwright/test';

const STAGING_API = 'https://thumbtack-bridge-staging.up.railway.app/api';

let authToken: string;

test.beforeAll(async ({ request }) => {
  // Prefer pre-generated JWT token (e.g., from CI/CD or local dev)
  if (process.env.TEST_JWT_TOKEN) {
    authToken = process.env.TEST_JWT_TOKEN;
    return;
  }

  // Fallback: login with email/password
  const email = process.env.TEST_EMAIL || 'info@spotless.homes';
  const password = process.env.TEST_PASSWORD || '';
  if (!password) return; // tests will skip

  const res = await request.post(`${STAGING_API}/auth/login`, {
    data: { email, password },
  });
  if (res.ok()) {
    const body = await res.json();
    authToken = body.token;
  }
});

test.describe('Token Error Single Source of Truth', () => {

  test('saved-accounts tokenDead matches SystemErrorLog token_refresh errors', async ({ request }) => {
    test.skip(!authToken, 'No auth token — set TEST_JWT_TOKEN or TEST_PASSWORD env var');

    // Fetch both data sources in parallel
    const [accountsRes, errorsRes] = await Promise.all([
      request.get(`${STAGING_API}/v1/platforms/saved-accounts`, {
        headers: { Authorization: `Bearer ${authToken}` },
      }),
      request.get(`${STAGING_API}/v1/monitoring/errors?onlyUnresolved=true&category=token_refresh`, {
        headers: { Authorization: `Bearer ${authToken}` },
      }),
    ]);

    expect(accountsRes.ok()).toBeTruthy();
    expect(errorsRes.ok()).toBeTruthy();

    const { accounts } = await accountsRes.json();
    const { errors } = await errorsRes.json();

    // Build set of account IDs with unresolved token_refresh errors
    const errorAccountIds = new Set<string>(
      errors.map((e: any) => e.accountId).filter(Boolean),
    );

    // Check every TT account: tokenDead should be true IFF it has an error entry
    const ttAccounts = accounts.filter((a: any) => a.platform === 'thumbtack');
    expect(ttAccounts.length).toBeGreaterThan(0);

    for (const account of ttAccounts) {
      const hasError = errorAccountIds.has(account.id);
      expect(
        account.tokenDead,
        `Account "${account.businessName}" (${account.id}): tokenDead=${account.tokenDead} but SystemErrorLog has ${hasError ? 'an' : 'no'} unresolved token_refresh error`,
      ).toBe(hasError);
    }
  });

  test('accounts without token_refresh errors are NOT marked tokenDead', async ({ request }) => {
    test.skip(!authToken, 'No auth token — set TEST_JWT_TOKEN or TEST_PASSWORD env var');

    const res = await request.get(`${STAGING_API}/v1/platforms/saved-accounts`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.ok()).toBeTruthy();

    const { accounts } = await res.json();
    const ttAccounts = accounts.filter((a: any) => a.platform === 'thumbtack');

    // Get error summary to know total unresolved token_refresh errors
    const summaryRes = await request.get(`${STAGING_API}/v1/monitoring/errors/summary`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(summaryRes.ok()).toBeTruthy();
    const summary = await summaryRes.json();
    const tokenRefreshErrors = summary.byCategory?.token_refresh || 0;

    // The number of tokenDead accounts should not exceed the number of error entries
    const deadCount = ttAccounts.filter((a: any) => a.tokenDead).length;
    expect(
      deadCount,
      `${deadCount} accounts marked tokenDead but only ${tokenRefreshErrors} unresolved token_refresh errors exist`,
    ).toBeLessThanOrEqual(tokenRefreshErrors);
  });

  test('Yelp accounts are never marked tokenDead', async ({ request }) => {
    test.skip(!authToken, 'No auth token — set TEST_JWT_TOKEN or TEST_PASSWORD env var');

    const res = await request.get(`${STAGING_API}/v1/platforms/saved-accounts`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.ok()).toBeTruthy();

    const { accounts } = await res.json();
    const yelpAccounts = accounts.filter((a: any) => a.platform === 'yelp');

    for (const account of yelpAccounts) {
      expect(account.tokenDead, `Yelp account "${account.businessName}" should not be tokenDead`).toBeFalsy();
    }
  });

  test('health endpoint agrees with tokenDead for each TT account', async ({ request }) => {
    test.skip(!authToken, 'No auth token — set TEST_JWT_TOKEN or TEST_PASSWORD env var');

    const accountsRes = await request.get(`${STAGING_API}/v1/platforms/saved-accounts`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(accountsRes.ok()).toBeTruthy();
    const { accounts } = await accountsRes.json();

    const ttAccounts = accounts.filter((a: any) => a.platform === 'thumbtack');

    // For accounts NOT marked tokenDead AND with a webhookId, health should be healthy
    for (const account of ttAccounts) {
      if (account.tokenDead || !account.webhookId) continue;

      const healthRes = await request.get(`${STAGING_API}/v1/thumbtack/saved-accounts/${account.id}/health`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      expect(healthRes.ok()).toBeTruthy();
      const health = await healthRes.json();

      // A connected, non-dead-token account should show healthy=true
      expect(
        health.healthy,
        `Account "${account.businessName}" has webhookId and no token error but health reports unhealthy: ${JSON.stringify(health.issues)}`,
      ).toBe(true);
    }
  });

  test('error summary byCategory counts are consistent', async ({ request }) => {
    test.skip(!authToken, 'No auth token — set TEST_JWT_TOKEN or TEST_PASSWORD env var');

    const [summaryRes, errorsRes] = await Promise.all([
      request.get(`${STAGING_API}/v1/monitoring/errors/summary`, {
        headers: { Authorization: `Bearer ${authToken}` },
      }),
      request.get(`${STAGING_API}/v1/monitoring/errors?onlyUnresolved=true&limit=500`, {
        headers: { Authorization: `Bearer ${authToken}` },
      }),
    ]);

    expect(summaryRes.ok()).toBeTruthy();
    expect(errorsRes.ok()).toBeTruthy();

    const summary = await summaryRes.json();
    const { errors } = await errorsRes.json();

    // totalUnresolved should match the actual count of unresolved errors
    expect(summary.totalUnresolved).toBe(errors.length);

    // byCategory counts should sum to totalUnresolved
    const categorySum = Object.values(summary.byCategory).reduce((sum: number, count: any) => sum + count, 0);
    expect(categorySum).toBe(summary.totalUnresolved);
  });
});
