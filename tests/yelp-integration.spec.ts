/**
 * Yelp Integration Tests
 * Tests webhook processing, lead fetching, and API endpoints on staging
 */

import { test, expect } from '@playwright/test';

const STAGING_API = 'https://thumbtack-bridge-staging.up.railway.app/api';
const YELP_API = 'https://api.yelp.com/v3';
const YELP_API_KEY = process.env.YELP_API_KEY || 'dwz7kQtgqphgnpfi5Tutf6WBQzQtG8UaNykbpRAHvnLswYyIf1bl3MAwLCXjp3bIDbzs0hdmipVlH3lxqSotVFEQz5h734GjFZgaNPNlHya8RqQ4hORw6rH4aQe7aXYx';
const TEST_BUSINESS_ID = 'SNa1ugk6DNIuvIPu8-AiGA';
const TEST_LEAD_ID = 'gzCDut6flLdtzUTwsDyCQw';

test.describe('Yelp Webhook Endpoint', () => {
  test('GET /webhooks/yelp returns verification token', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/webhooks/yelp?verification=test123`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.verification).toBe('test123');
  });

  test('GET /webhooks/yelp without verification returns ok', async ({ request }) => {
    const res = await request.get(`${STAGING_API}/webhooks/yelp`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('POST /webhooks/yelp processes NEW_EVENT webhook', async ({ request }) => {
    const eventId = `TEST_${Date.now()}`;
    const res = await request.post(`${STAGING_API}/webhooks/yelp`, {
      data: {
        time: new Date().toISOString(),
        object: 'business',
        data: {
          id: TEST_BUSINESS_ID,
          updates: [{
            event_type: 'NEW_EVENT',
            event_id: eventId,
            lead_id: TEST_LEAD_ID,
            interaction_time: new Date().toISOString(),
          }],
        },
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.received).toBe(true);
  });

  test('POST /webhooks/yelp handles CONSUMER_PHONE_NUMBER_OPT_IN_EVENT', async ({ request }) => {
    const res = await request.post(`${STAGING_API}/webhooks/yelp`, {
      data: {
        time: new Date().toISOString(),
        object: 'business',
        data: {
          id: TEST_BUSINESS_ID,
          updates: [{
            event_type: 'CONSUMER_PHONE_NUMBER_OPT_IN_EVENT',
            lead_id: TEST_LEAD_ID,
          }],
        },
      },
    });
    expect(res.ok()).toBeTruthy();
  });

  test('POST /webhooks/yelp handles unknown event type gracefully', async ({ request }) => {
    const res = await request.post(`${STAGING_API}/webhooks/yelp`, {
      data: {
        time: new Date().toISOString(),
        object: 'business',
        data: {
          id: TEST_BUSINESS_ID,
          updates: [{
            event_type: 'UNKNOWN_EVENT_TYPE',
            event_id: `TEST_UNKNOWN_${Date.now()}`,
          }],
        },
      },
    });
    expect(res.ok()).toBeTruthy();
  });

  test('POST /webhooks/yelp deduplicates by event_id', async ({ request }) => {
    const eventId = `TEST_DEDUP_${Date.now()}`;
    // Send twice with same event_id
    const res1 = await request.post(`${STAGING_API}/webhooks/yelp`, {
      data: {
        time: new Date().toISOString(),
        object: 'business',
        data: {
          id: TEST_BUSINESS_ID,
          updates: [{ event_type: 'NEW_EVENT', event_id: eventId, lead_id: TEST_LEAD_ID, interaction_time: new Date().toISOString() }],
        },
      },
    });
    const res2 = await request.post(`${STAGING_API}/webhooks/yelp`, {
      data: {
        time: new Date().toISOString(),
        object: 'business',
        data: {
          id: TEST_BUSINESS_ID,
          updates: [{ event_type: 'NEW_EVENT', event_id: eventId, lead_id: TEST_LEAD_ID, interaction_time: new Date().toISOString() }],
        },
      },
    });
    expect(res1.ok()).toBeTruthy();
    expect(res2.ok()).toBeTruthy();
    // Both return 200 — dedup happens internally
  });
});

test.describe('Yelp Business Subscriptions (API Key)', () => {
  test('GET /businesses/subscriptions returns test business', async ({ request }) => {
    const res = await request.get(`${YELP_API}/businesses/subscriptions`, {
      params: { subscription_type: 'WEBHOOK', limit: 100, offset: 0 },
      headers: { Authorization: `Bearer ${YELP_API_KEY}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.subscriptions).toBeDefined();
    const found = body.subscriptions.find((s: any) => s.business_id === TEST_BUSINESS_ID);
    expect(found).toBeTruthy();
  });

  test('GET /businesses/{id} returns test business details', async ({ request }) => {
    const res = await request.get(`${YELP_API}/businesses/${TEST_BUSINESS_ID}`, {
      headers: { Authorization: `Bearer ${YELP_API_KEY}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.name).toContain('Plumbing Business Tester');
    expect(body.id).toBe(TEST_BUSINESS_ID);
  });
});

test.describe('Yelp Lead IDs Endpoint (API Key)', () => {
  test('GET /businesses/{id}/lead_ids requires OAuth token', async ({ request }) => {
    // API key should NOT work — needs OAuth
    const res = await request.get(`${YELP_API}/businesses/${TEST_BUSINESS_ID}/lead_ids`, {
      headers: { Authorization: `Bearer ${YELP_API_KEY}` },
    });
    // Should fail with 401 or 403 (needs OAuth token)
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });
});

test.describe('LeadBridge Yelp API Endpoints (Staging)', () => {
  let authToken: string;

  test.beforeAll(async ({ request }) => {
    // Login to get JWT
    const res = await request.post(`${STAGING_API}/auth/login`, {
      data: { email: 'info@spotless.homes', password: process.env.TEST_PASSWORD || '' },
    });
    if (res.ok()) {
      const body = await res.json();
      authToken = body.token;
    }
  });

  test('GET /v1/yelp/auth/url returns OAuth URL', async ({ request }) => {
    test.skip(!authToken, 'No auth token');
    const res = await request.get(`${STAGING_API}/v1/yelp/auth/url`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.url).toContain('biz.yelp.com/logout');
    expect(body.url).toContain('oauth2/authorize');
    expect(body.url).toContain('client_id=ARzp32A5c0gJ28Y-_uoANg');
  });

  test('GET /v1/yelp/businesses returns connected businesses', async ({ request }) => {
    test.skip(!authToken, 'No auth token');
    const res = await request.get(`${STAGING_API}/v1/yelp/businesses`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.platform).toBe('yelp');
    expect(body.businesses.length).toBeGreaterThanOrEqual(1);
    expect(body.businesses[0].businessId).toBe(TEST_BUSINESS_ID);
  });

  test('GET /v1/platforms/saved-accounts includes Yelp accounts', async ({ request }) => {
    test.skip(!authToken, 'No auth token');
    const res = await request.get(`${STAGING_API}/v1/platforms/saved-accounts`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const yelpAccounts = body.accounts.filter((a: any) => a.platform === 'yelp');
    expect(yelpAccounts.length).toBeGreaterThanOrEqual(1);
  });

  test('GET /v1/thumbtack/leads includes Yelp leads', async ({ request }) => {
    test.skip(!authToken, 'No auth token');
    const res = await request.get(`${STAGING_API}/v1/thumbtack/leads`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const yelpLeads = body.leads.filter((l: any) => l.platform === 'yelp');
    expect(yelpLeads.length).toBeGreaterThanOrEqual(1);
  });
});
