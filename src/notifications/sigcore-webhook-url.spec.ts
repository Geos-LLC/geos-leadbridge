/**
 * Tests for the Sigcore webhook URL resolver.
 *
 * Covers:
 *  - Resolution priority: BACKEND_PUBLIC_URL > APP_BASE_URL > RAILWAY_PUBLIC_DOMAIN
 *  - Frontend-host guard rejects leadbridge360.com (and falls through to next
 *    candidate rather than failing outright)
 *  - Builders for delivery-status / inbound-sms / call-connect URLs
 *  - Throws SigcoreWebhookUrlError when nothing valid is configured
 */

import {
  buildCallConnectWebhookUrl,
  buildDeliveryStatusWebhookUrl,
  buildInboundSmsWebhookUrl,
  isFrontendHost,
  resolveSigcoreCallbackBaseUrl,
  SigcoreWebhookUrlError,
} from './sigcore-webhook-url';

function configFrom(env: Record<string, string | undefined>): any {
  return {
    get: (key: string) => env[key],
  };
}

describe('sigcore-webhook-url', () => {
  describe('isFrontendHost', () => {
    it('flags www.leadbridge360.com', () => {
      expect(isFrontendHost('https://www.leadbridge360.com/api/foo')).toBe(true);
    });

    it('flags leadbridge360.com (apex)', () => {
      expect(isFrontendHost('https://leadbridge360.com/api/foo')).toBe(true);
    });

    it('does not flag the Railway backend host', () => {
      expect(isFrontendHost('https://thumbtack-bridge-production.up.railway.app/foo')).toBe(false);
    });

    it('returns false for malformed URLs rather than throwing', () => {
      expect(isFrontendHost('not a url')).toBe(false);
    });
  });

  describe('resolveSigcoreCallbackBaseUrl — priority', () => {
    it('prefers BACKEND_PUBLIC_URL when set', () => {
      const cfg = configFrom({
        BACKEND_PUBLIC_URL: 'https://api.example.com',
        APP_BASE_URL: 'https://something-else.com',
        RAILWAY_PUBLIC_DOMAIN: 'should-not-be-used.up.railway.app',
      });
      expect(resolveSigcoreCallbackBaseUrl(cfg)).toBe('https://api.example.com');
    });

    it('falls back to APP_BASE_URL when BACKEND_PUBLIC_URL missing', () => {
      const cfg = configFrom({
        APP_BASE_URL: 'https://thumbtack-bridge-production.up.railway.app',
      });
      expect(resolveSigcoreCallbackBaseUrl(cfg)).toBe(
        'https://thumbtack-bridge-production.up.railway.app',
      );
    });

    it('falls back to RAILWAY_PUBLIC_DOMAIN with https:// prefix', () => {
      const cfg = configFrom({
        RAILWAY_PUBLIC_DOMAIN: 'thumbtack-bridge-production.up.railway.app',
      });
      expect(resolveSigcoreCallbackBaseUrl(cfg)).toBe(
        'https://thumbtack-bridge-production.up.railway.app',
      );
    });

    it('strips a trailing slash from the resolved URL', () => {
      const cfg = configFrom({
        BACKEND_PUBLIC_URL: 'https://api.example.com/',
      });
      expect(resolveSigcoreCallbackBaseUrl(cfg)).toBe('https://api.example.com');
    });
  });

  describe('resolveSigcoreCallbackBaseUrl — frontend-host guard', () => {
    it('skips a frontend host in BACKEND_PUBLIC_URL and falls through', () => {
      // This is the bug we shipped against: someone put the Vercel URL in
      // APP_BASE_URL and every webhook callback 405'd. The guard makes that
      // impossible — it skips the frontend candidate and tries the next one.
      const cfg = configFrom({
        BACKEND_PUBLIC_URL: 'https://www.leadbridge360.com',
        APP_BASE_URL: 'https://thumbtack-bridge-production.up.railway.app',
      });
      expect(resolveSigcoreCallbackBaseUrl(cfg)).toBe(
        'https://thumbtack-bridge-production.up.railway.app',
      );
    });

    it('skips a frontend host in APP_BASE_URL and falls through to RAILWAY_PUBLIC_DOMAIN', () => {
      const cfg = configFrom({
        APP_BASE_URL: 'https://leadbridge360.com',
        RAILWAY_PUBLIC_DOMAIN: 'thumbtack-bridge-production.up.railway.app',
      });
      expect(resolveSigcoreCallbackBaseUrl(cfg)).toBe(
        'https://thumbtack-bridge-production.up.railway.app',
      );
    });

    it('throws SigcoreWebhookUrlError when every candidate is invalid', () => {
      const cfg = configFrom({
        APP_BASE_URL: 'https://www.leadbridge360.com',
        // No BACKEND_PUBLIC_URL, no RAILWAY_PUBLIC_DOMAIN — nothing valid.
      });
      expect(() => resolveSigcoreCallbackBaseUrl(cfg)).toThrow(SigcoreWebhookUrlError);
    });

    it('throws when nothing is configured at all', () => {
      const cfg = configFrom({});
      expect(() => resolveSigcoreCallbackBaseUrl(cfg)).toThrow(SigcoreWebhookUrlError);
    });
  });

  describe('webhook URL builders', () => {
    const cfg = configFrom({
      BACKEND_PUBLIC_URL: 'https://api.example.com',
    });

    it('builds the delivery-status URL', () => {
      expect(buildDeliveryStatusWebhookUrl(cfg)).toBe(
        'https://api.example.com/api/webhooks/sigcore/delivery-status',
      );
    });

    it('builds the inbound-sms URL with accountId query param', () => {
      expect(buildInboundSmsWebhookUrl(cfg, 'acct-123')).toBe(
        'https://api.example.com/api/webhooks/sigcore/inbound-sms?accountId=acct-123',
      );
    });

    it('builds the call-connect URL with accountId query param', () => {
      expect(buildCallConnectWebhookUrl(cfg, 'acct-123')).toBe(
        'https://api.example.com/api/webhooks/sigcore/call-connect?accountId=acct-123',
      );
    });

    it('all builders inherit the frontend-host guard', () => {
      const bad = configFrom({ BACKEND_PUBLIC_URL: 'https://leadbridge360.com' });
      expect(() => buildDeliveryStatusWebhookUrl(bad)).toThrow(SigcoreWebhookUrlError);
      expect(() => buildInboundSmsWebhookUrl(bad, 'acct')).toThrow(SigcoreWebhookUrlError);
      expect(() => buildCallConnectWebhookUrl(bad, 'acct')).toThrow(SigcoreWebhookUrlError);
    });
  });
});
