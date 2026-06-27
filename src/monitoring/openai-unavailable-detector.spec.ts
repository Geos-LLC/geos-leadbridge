/**
 * Tests for the OpenAI unavailability regex used by captureError to
 * decide whether a captured error should feed the burst counter.
 *
 * captureError already routes 401 → openai_auth_failure and 429 quota
 * → openai_quota_exceeded as single-shot dev alerts (covered by the
 * existing auth/quota regex helpers). isOpenAiUnavailable picks up the
 * "something else is wrong with OpenAI" bucket: 5xx, network errors,
 * timeouts — anything that points at an OpenAI-side outage rather than
 * a tenant misconfiguration.
 *
 * We exercise it via captureError so we don't poke at private methods
 * with `as any` — observable behavior is what matters. The verification
 * point is "did recordPlatformFailure get called with openai_unavailable
 * exactly once for this message".
 */

import { MonitoringService } from './monitoring.service';

function buildSvc() {
  // Same minimal stubbing approach as platform-burst-detector.spec.ts.
  // Prisma is stubbed because captureError writes a SystemErrorLog row;
  // we replace the create/findFirst calls with no-ops so the test stays
  // pure and the OpenAI regex is the only thing we're observing.
  const prismaStub: any = {
    $transaction: jest.fn().mockImplementation(async (fn: any) => fn({
      systemErrorLog: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
    })),
    systemErrorLog: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const svc = new MonitoringService(prismaStub, { get: () => undefined } as any);
  const recordSpy = jest.spyOn(svc, 'recordPlatformFailure');
  const notifySpy = jest.spyOn(svc, 'notifyDevAlert').mockResolvedValue();
  return { svc, recordSpy, notifySpy };
}

async function fire(svc: MonitoringService, message: string) {
  await svc.captureError({ category: 'automation', message });
}

describe('isOpenAiUnavailable detection (via captureError)', () => {
  describe('matches (records burst)', () => {
    const samples = [
      '500 Internal Server Error',
      '502 Bad Gateway',
      '503 Service Unavailable',
      '504 Gateway Timeout',
      'Status code 503',
      'Status: 502',
      'HTTP 500 from upstream',
      'server_error: temporary issue',
      'service_unavailable',
      'getaddrinfo ENOTFOUND api.openai.com',
      'connect ETIMEDOUT 104.18.0.0:443',
      'request to https://api.openai.com timed out',
      'connection reset by peer',
      'socket hang up while reading response',
      'AbortError: Request timed out after 60s',
    ];
    for (const msg of samples) {
      it(`matches: "${msg.slice(0, 60)}"`, async () => {
        const { svc, recordSpy } = buildSvc();
        await fire(svc, msg);
        expect(recordSpy).toHaveBeenCalledWith('openai_unavailable');
      });
    }
  });

  describe('does NOT match (no burst recording)', () => {
    const samples = [
      // Auth path — handled by the existing openai_auth_failure single-shot.
      '401 incorrect API key provided',
      'invalid_api_key',
      // Quota path — handled by openai_quota_exceeded single-shot.
      'You exceeded your current quota',
      'insufficient_quota',
      // Rate limit (transient, recoverable) — should not page ops.
      'Rate limit reached for gpt-4o-mini in organization org-xxxx',
      // Tenant-side errors that aren't OpenAI's fault.
      'Yelp lead archived by customer',
      'THUMBTACK_WRONG_SCOPE: lead belongs to a different account',
      'failed to enrich lead: customer phone missing',
      // Empty / no message.
      '',
    ];
    for (const msg of samples) {
      it(`does not match: "${msg.slice(0, 60)}"`, async () => {
        const { svc, recordSpy } = buildSvc();
        await fire(svc, msg);
        expect(recordSpy).not.toHaveBeenCalledWith('openai_unavailable');
      });
    }
  });

  describe('routing priority', () => {
    it('auth and quota errors go through the single-shot path, not the burst', async () => {
      const { svc, recordSpy, notifySpy } = buildSvc();
      await fire(svc, '401 incorrect API key');
      await fire(svc, 'You exceeded your current quota');
      expect(recordSpy).not.toHaveBeenCalledWith('openai_unavailable');
      // notifyDevAlert was called for the two single-shot alerts.
      expect(notifySpy).toHaveBeenCalled();
    });
  });
});
