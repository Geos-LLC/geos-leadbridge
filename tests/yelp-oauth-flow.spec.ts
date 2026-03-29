/**
 * Yelp OAuth Flow Test
 * Tests the full reconnect flow: LeadBridge → Yelp logout → login → consent → callback
 * Run with: npx playwright test tests/yelp-oauth-flow.spec.ts --headed
 */

import { test, expect } from '@playwright/test';

const PROD_URL = 'https://www.leadbridge360.com';
const API_URL = 'https://thumbtack-bridge-production.up.railway.app/api';
const YELP_EMAIL = 'spotlesshomestampa@gmail.com';
const YELP_PASSWORD = 'SpotlessHomes2025!8';

// Generate JWT for API calls
function getJwt(): string {
  const jwt = require('jsonwebtoken');
  return jwt.sign(
    { sub: 'c3d14499-dec1-42c3-a36c-713cb09842c6', email: 'info@spotless.homes' },
    'ab8970cda0673938447af748aac9a762804b8a73a6262be2f13b56a549a8beb1',
    { expiresIn: '1h' },
  );
}

test.use({
  viewport: { width: 1280, height: 900 },
  actionTimeout: 30000,
});

test('Yelp OAuth flow - trace every redirect step', async ({ page, request }) => {
  // Track all navigations
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      console.log(`[NAV] → ${frame.url()}`);
    }
  });

  const token = getJwt();

  // Step 1: Get the OAuth URL from backend API
  console.log('\n=== STEP 1: Get OAuth URL from backend ===');
  const authRes = await request.get(`${API_URL}/v1/yelp/auth/url`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(authRes.ok()).toBeTruthy();
  const { url: oauthUrl } = await authRes.json();
  console.log(`[INFO] Backend returned: ${oauthUrl.substring(0, 150)}...`);
  console.log(`[INFO] Starts with logout: ${oauthUrl.startsWith('https://biz.yelp.com/logout')}`);

  // Parse what the return_url will be
  const urlObj = new URL(oauthUrl);
  const returnUrl = urlObj.searchParams.get('return_url') || oauthUrl.split('return_url=')[1];
  console.log(`[INFO] return_url param: ${returnUrl?.substring(0, 100)}...`);

  // Step 2: Navigate to the OAuth URL (simulating what the frontend does)
  console.log('\n=== STEP 2: Navigate to Yelp logout URL ===');
  await page.goto(oauthUrl, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});

  const afterLogoutUrl = page.url();
  console.log(`[INFO] After logout redirect: ${afterLogoutUrl}`);
  await page.screenshot({ path: 'test-results/yelp-oauth-01-after-logout.png' });

  // Check: are we on login, consent, or somewhere else?
  const isLogin = afterLogoutUrl.includes('/login') || afterLogoutUrl.includes('/signup');
  const isConsent = afterLogoutUrl.includes('/oauth2/authorize') || afterLogoutUrl.includes('consent');
  const isYelpHome = afterLogoutUrl.includes('biz.yelp.com/home');

  console.log(`[CHECK] isLogin=${isLogin} isConsent=${isConsent} isYelpHome=${isYelpHome}`);

  if (isLogin) {
    console.log('[OK] On login page — correct behavior!');

    // Step 3: Check what the login page's return_url is
    console.log('\n=== STEP 3: Check login page return_url ===');
    const loginPageUrl = new URL(afterLogoutUrl);
    const loginReturnUrl = loginPageUrl.searchParams.get('return_url');
    console.log(`[INFO] Login page return_url: ${loginReturnUrl}`);
    console.log(`[INFO] Contains oauth2/authorize: ${loginReturnUrl?.includes('oauth2/authorize')}`);

    // Step 4: Fill in Yelp login
    console.log('\n=== STEP 4: Fill Yelp login ===');
    // Wait for form to be ready
    await page.waitForSelector('input[type="email"], input[name="email"], #email', { timeout: 10000 }).catch(() => {});

    const emailInput = page.locator('input[type="email"], input[name="email"], #email').first();
    const passwordInput = page.locator('input[type="password"], input[name="password"], #password').first();

    if (await emailInput.isVisible()) {
      await emailInput.fill(YELP_EMAIL);
      await passwordInput.fill(YELP_PASSWORD);
      await page.screenshot({ path: 'test-results/yelp-oauth-02-login-filled.png' });

      // Submit
      const loginBtn = page.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in"), input[type="submit"]').first();
      console.log(`[INFO] Login button text: "${await loginBtn.textContent().catch(() => 'N/A')}"`);
      await loginBtn.click();
      console.log('[INFO] Clicked login, waiting for redirect...');

      // Wait for navigation after login
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(3000); // extra settle time

      const afterLoginUrl = page.url();
      console.log(`[NAV] After login: ${afterLoginUrl}`);
      await page.screenshot({ path: 'test-results/yelp-oauth-03-after-login.png' });

      // Where did we end up?
      if (afterLoginUrl.includes('/oauth2/authorize') || afterLoginUrl.includes('consent')) {
        console.log('[OK] On consent page — flow is working!');
        await handleConsentAndCallback(page);
      } else if (afterLoginUrl.includes('leadbridge') || afterLoginUrl.includes('thumbtack-bridge')) {
        console.log('[OK] Already redirected back to LeadBridge!');
      } else if (afterLoginUrl.includes('biz.yelp.com/home')) {
        console.log('[FAIL] Landed on Yelp business home — return_url was lost after login');
        console.log('[DEBUG] The login page did not forward to the OAuth authorize URL');
      } else {
        console.log(`[INFO] Unexpected page after login: ${afterLoginUrl}`);
        // Check page content
        const bodyText = await page.locator('body').textContent().catch(() => '');
        console.log(`[DEBUG] Page text (first 300 chars): ${bodyText.substring(0, 300)}`);
      }
    } else {
      console.log('[WARN] No email input found on login page');
      // Maybe it's a different login form?
      const allInputs = page.locator('input');
      const inputCount = await allInputs.count();
      console.log(`[DEBUG] Found ${inputCount} input elements on page`);
      for (let i = 0; i < Math.min(inputCount, 8); i++) {
        const type = await allInputs.nth(i).getAttribute('type').catch(() => '?');
        const name = await allInputs.nth(i).getAttribute('name').catch(() => '?');
        const id = await allInputs.nth(i).getAttribute('id').catch(() => '?');
        console.log(`  Input ${i}: type=${type} name=${name} id=${id}`);
      }
      await page.screenshot({ path: 'test-results/yelp-oauth-02-login-form-debug.png' });
    }

  } else if (isConsent) {
    console.log('[WARN] Skipped login — went straight to consent (session not cleared)');
    await handleConsentAndCallback(page);

  } else {
    console.log(`[FAIL] Unexpected page: ${afterLogoutUrl}`);
    const bodyText = await page.locator('body').textContent().catch(() => '');
    console.log(`[DEBUG] Page text: ${bodyText.substring(0, 500)}`);
  }

  // Final screenshot
  await page.screenshot({ path: 'test-results/yelp-oauth-99-final.png' });
  console.log(`\n=== FINAL: ${page.url()} ===`);
});

async function handleConsentAndCallback(page: any) {
  console.log('\n=== Consent Page ===');
  await page.screenshot({ path: 'test-results/yelp-oauth-04-consent.png' });

  // Look for Allow/Authorize button
  const allowBtn = page.locator('button, a, input[type="submit"]').filter({
    hasText: /Allow|Authorize|Grant|Accept|Confirm/i
  }).first();

  if (await allowBtn.isVisible()) {
    console.log(`[INFO] Consent button: "${await allowBtn.textContent()}"`);
    await allowBtn.click();
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    console.log(`[NAV] After consent: ${page.url()}`);
    await page.screenshot({ path: 'test-results/yelp-oauth-05-after-consent.png' });

    if (page.url().includes('leadbridge') || page.url().includes('thumbtack-bridge')) {
      console.log('[SUCCESS] Redirected back to LeadBridge after consent!');
    }
  } else {
    console.log('[WARN] No consent button found — logging all buttons:');
    const buttons = page.locator('button, a[role="button"], input[type="submit"]');
    const count = await buttons.count();
    for (let i = 0; i < Math.min(count, 10); i++) {
      const text = await buttons.nth(i).textContent().catch(() => '');
      const visible = await buttons.nth(i).isVisible().catch(() => false);
      if (visible && text?.trim()) console.log(`  Button: "${text.trim()}"`);
    }
  }
}
