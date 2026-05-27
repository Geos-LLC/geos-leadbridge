jest.mock('axios', () => ({
  request: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const axios = require('axios');

import { ConfigService } from '@nestjs/config';
import { OrchestrationMetricsService } from './orchestration-metrics.service';
import { SfOrchestrationClient } from './sf-orchestration.client';
import type { SfConnectionResolver, ResolvedSfCredentials } from './sf-connection-resolver.service';

function buildConfig(env: Record<string, string | undefined>): ConfigService {
  return {
    get: ((key: string, def?: any) => {
      const v = env[key];
      return v === undefined ? def : v;
    }) as any,
  } as ConfigService;
}

/**
 * PR-C1: the client no longer reads env directly — it consults a
 * resolver. This stub mimics the resolver's enabled/disabled return
 * shape so the existing happy-path + retry + error-code assertions
 * remain meaningful without bringing in real Prisma.
 */
function buildResolver(opts: {
  enabled?: boolean;
  source?: 'connection' | 'env_canary' | 'none';
  baseUrl?: string;
  token?: string;
  usedPreviousToken?: boolean;
} = {}): SfConnectionResolver {
  return {
    resolveForUser: jest.fn(async (): Promise<ResolvedSfCredentials> =>
      opts.enabled === false
        ? { enabled: false, source: 'none', disabledReason: 'test_disabled' }
        : {
            enabled: true,
            source: opts.source ?? 'env_canary',
            baseUrl: opts.baseUrl ?? 'https://sf.example.com',
            orchestrationToken: opts.token ?? 'test-api-key-xyz',
            usedPreviousToken: opts.usedPreviousToken ?? false,
          },
    ),
    isEnabledForUser: jest.fn(async () => opts.enabled !== false),
  } as unknown as SfConnectionResolver;
}

const BASE_ENV = {
  SF_ORCHESTRATION_TIMEOUT_MS: '5000',
  SF_ORCHESTRATION_MAX_ATTEMPTS: '3',
};

describe('SfOrchestrationClient', () => {
  let client: SfOrchestrationClient;
  let metrics: OrchestrationMetricsService;

  beforeEach(() => {
    axios.request.mockReset();
    metrics = new OrchestrationMetricsService();
    client = new SfOrchestrationClient(buildConfig(BASE_ENV), metrics, buildResolver());
  });

  describe('getAvailability — happy path', () => {
    it('returns ok=true with slots + bumps metrics + emits Bearer auth + Idempotency-Key + Correlation-Id', async () => {
      axios.request.mockResolvedValue({
        status: 200,
        data: { slots: [{ slotId: 's1', start: 't1', end: 't2' }], cachedForSeconds: 30 },
      });

      const result = await client.getAvailability(
        {
          userId: 'user-A',
          sigcoreBusinessId: 'biz-1',
          serviceType: 'standard',
        },
        'idem-key-001',
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.status).toBe(200);
      expect(result.data.slots.length).toBe(1);
      expect(result.idempotencyKey).toBe('idem-key-001');
      expect(result.correlationId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(result.attemptCount).toBe(1);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);

      // Headers assertion
      const call = axios.request.mock.calls[0][0];
      expect(call.method).toBe('GET');
      expect(call.url).toBe(
        'https://sf.example.com/api/integrations/leadbridge/orchestration/availability',
      );
      expect(call.headers.Authorization).toBe('Bearer test-api-key-xyz');
      expect(call.headers['Idempotency-Key']).toBe('idem-key-001');
      expect(call.headers['X-Correlation-Id']).toMatch(/^[0-9a-f-]{36}$/i);
      expect(call.headers['X-LB-User-Id']).toBe('user-A');
      expect(call.timeout).toBe(5000);
      // Query — undefined/null filtered
      expect(call.params).toEqual({ sigcoreBusinessId: 'biz-1', serviceType: 'standard' });

      // Metrics
      const snap = metrics.getCountersForUser('user-A');
      expect(snap.attempts.availability).toBe(1);
      expect(snap.successes.availability).toBe(1);
      expect(snap.failures.availability).toBe(0);
      expect(snap.retries.availability).toBe(0);
      expect(snap.lastLatencyMs.availability).toBeGreaterThanOrEqual(0);
    });
  });

  describe('submitBookingRequest — 409 slot_taken (terminal, no retry)', () => {
    it('returns ok=false with code=slot_taken and does NOT retry', async () => {
      axios.request.mockResolvedValue({
        status: 409,
        data: { error: 'slot_taken' },
      });

      const result = await client.submitBookingRequest(
        {
          userId: 'user-A',
          sigcoreBusinessId: 'biz-1',
          leadId: 'lead-1',
          externalRequestId: 'ext-1',
          slotId: 's1',
          customerContact: { name: 'X' },
          serviceType: 'standard',
        },
        'idem-key-br-001',
      );

      expect(axios.request).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('slot_taken');
      expect(result.status).toBe(409);
      expect(result.attemptCount).toBe(1);

      const snap = metrics.getCountersForUser('user-A');
      expect(snap.failures.booking_request).toBe(1);
      expect(snap.failuresByCode.slot_taken).toBe(1);
      expect(snap.retries.booking_request).toBe(0);
    });
  });

  describe('410 slot_token_expired (terminal, no retry)', () => {
    it('classifies as slot_token_expired', async () => {
      axios.request.mockResolvedValue({
        status: 410,
        data: { error: 'slot_token_expired' },
      });

      const result = await client.submitBookingRequest(
        {
          userId: 'user-A',
          sigcoreBusinessId: 'biz-1',
          leadId: 'lead-1',
          externalRequestId: 'ext-1',
          slotId: 's1',
          customerContact: {},
          serviceType: 'standard',
        },
        'idem-key',
      );

      expect(axios.request).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('slot_token_expired');
    });
  });

  describe('422 validation_failed (terminal, no retry)', () => {
    it('classifies as validation_failed with body forwarded', async () => {
      axios.request.mockResolvedValue({
        status: 422,
        data: { error: 'validation_failed', details: { field: 'postcode' } },
      });

      const result = await client.submitBookingRequest(
        {
          userId: 'user-A',
          sigcoreBusinessId: 'biz-1',
          leadId: 'lead-1',
          externalRequestId: 'ext-1',
          slotId: 's1',
          customerContact: {},
          serviceType: 'standard',
        },
        'idem-key',
      );

      expect(axios.request).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('validation_failed');
      expect((result.body as any).details.field).toBe('postcode');
    });
  });

  describe('403 orchestration_disabled (graceful fallback signal)', () => {
    it('returns ok=false code=orchestration_disabled without retry', async () => {
      axios.request.mockResolvedValue({
        status: 403,
        data: { error: 'orchestration_disabled' },
      });

      const result = await client.getAvailability(
        {
          userId: 'user-A',
          sigcoreBusinessId: 'biz-1',
          serviceType: 'standard',
        },
        'idem',
      );

      expect(axios.request).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('orchestration_disabled');
    });

    it('generic 403 (no body.error) ALSO maps to orchestration_disabled (safe default)', async () => {
      axios.request.mockResolvedValue({ status: 403, data: { error: 'forbidden' } });
      const result = await client.getAvailability(
        { userId: 'user-A', sigcoreBusinessId: 'biz-1', serviceType: 'standard' },
        'idem',
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('orchestration_disabled');
    });
  });

  describe('5xx retries with backoff and same Idempotency-Key across attempts', () => {
    it('retries on 503 and eventually succeeds, reusing Idempotency-Key', async () => {
      axios.request
        .mockResolvedValueOnce({ status: 503, data: { error: 'unavailable' } })
        .mockResolvedValueOnce({ status: 503, data: { error: 'unavailable' } })
        .mockResolvedValueOnce({
          status: 200,
          data: { slots: [], cachedForSeconds: 0 },
        });

      const result = await client.getAvailability(
        { userId: 'user-A', sigcoreBusinessId: 'biz-1', serviceType: 'standard' },
        'idem-same-key',
      );

      expect(axios.request).toHaveBeenCalledTimes(3);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.attemptCount).toBe(3);

      // Idempotency-Key must be identical across all attempts
      for (let i = 0; i < 3; i++) {
        expect(axios.request.mock.calls[i][0].headers['Idempotency-Key']).toBe('idem-same-key');
      }
      // But Correlation-Id MUST differ per attempt
      const corrIds = axios.request.mock.calls.map(
        (c: any) => c[0].headers['X-Correlation-Id'],
      );
      expect(new Set(corrIds).size).toBe(3);

      const snap = metrics.getCountersForUser('user-A');
      expect(snap.retries.availability).toBe(2); // 2 retries before success
      expect(snap.successes.availability).toBe(1);
      expect(snap.failures.availability).toBe(0);
    }, 10000);

    it('gives up after max attempts and returns server_error', async () => {
      axios.request.mockResolvedValue({ status: 500, data: 'oops' });

      const result = await client.getAvailability(
        { userId: 'user-A', sigcoreBusinessId: 'biz-1', serviceType: 'standard' },
        'idem',
      );

      expect(axios.request).toHaveBeenCalledTimes(3);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('server_error');
      expect(result.attemptCount).toBe(3);

      const snap = metrics.getCountersForUser('user-A');
      expect(snap.retries.availability).toBe(2);
      expect(snap.failures.availability).toBe(1);
      expect(snap.failuresByCode.server_error).toBe(1);
    }, 10000);
  });

  describe('Network error / timeout retries', () => {
    it('classifies ECONNABORTED as timeout and retries', async () => {
      const timeoutErr: any = new Error('timeout of 5000ms exceeded');
      timeoutErr.code = 'ECONNABORTED';
      axios.request
        .mockRejectedValueOnce(timeoutErr)
        .mockResolvedValueOnce({ status: 200, data: { slots: [], cachedForSeconds: 0 } });

      const result = await client.getAvailability(
        { userId: 'user-A', sigcoreBusinessId: 'biz-1', serviceType: 'standard' },
        'idem',
      );

      expect(axios.request).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(true);
    }, 10000);

    it('classifies generic Error as network_error and exhausts retries', async () => {
      axios.request.mockRejectedValue(new Error('socket hang up'));

      const result = await client.getAvailability(
        { userId: 'user-A', sigcoreBusinessId: 'biz-1', serviceType: 'standard' },
        'idem',
      );

      expect(axios.request).toHaveBeenCalledTimes(3);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('network_error');

      const snap = metrics.getCountersForUser('user-A');
      expect(snap.failuresByCode.network_error).toBe(1);
    }, 10000);
  });

  describe('Resolver-disabled (safe degradation, no HTTP call)', () => {
    it('returns ok=false code=orchestration_disabled when resolver says disabled', async () => {
      const c = new SfOrchestrationClient(
        buildConfig(BASE_ENV),
        metrics,
        buildResolver({ enabled: false }),
      );
      const result = await c.getAvailability(
        { userId: 'user-A', sigcoreBusinessId: 'biz-1', serviceType: 'standard' },
        'idem',
      );
      expect(axios.request).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('orchestration_disabled');
    });

    it('uses resolver-supplied baseUrl + token, not env (covers DB-path tenants)', async () => {
      const c = new SfOrchestrationClient(
        buildConfig(BASE_ENV),
        metrics,
        buildResolver({
          source: 'connection',
          baseUrl: 'https://tenant-specific.sf',
          token: 'TENANT-TOKEN-DB',
        }),
      );
      axios.request.mockResolvedValue({ status: 200, data: { slots: [], cachedForSeconds: 0 } });
      await c.getAvailability(
        { userId: 'user-A', sigcoreBusinessId: 'biz-1', serviceType: 'standard' },
        'idem',
      );
      const call = axios.request.mock.calls[0][0];
      expect(call.url).toBe(
        'https://tenant-specific.sf/api/integrations/leadbridge/orchestration/availability',
      );
      expect(call.headers.Authorization).toBe('Bearer TENANT-TOKEN-DB');
    });
  });

  describe('submitBookingCancel + submitHandoff happy paths', () => {
    it('booking-cancel POSTs to the right URL with the right body shape', async () => {
      axios.request.mockResolvedValue({
        status: 200,
        data: { sfJobId: 'sf-1', canonicalStatus: 'cancelled' },
      });

      const result = await client.submitBookingCancel(
        {
          userId: 'user-A',
          sigcoreBusinessId: 'biz-1',
          sfJobId: 'sf-1',
          leadId: 'lead-1',
          reason: 'customer changed mind',
        },
        'idem-c',
      );

      const call = axios.request.mock.calls[0][0];
      expect(call.method).toBe('POST');
      expect(call.url).toBe(
        'https://sf.example.com/api/integrations/leadbridge/orchestration/booking-cancel',
      );
      expect(call.data).toEqual({
        sigcoreBusinessId: 'biz-1',
        sfJobId: 'sf-1',
        leadId: 'lead-1',
        reason: 'customer changed mind',
      });
      expect(result.ok).toBe(true);
    });

    it('handoff POSTs to the right URL', async () => {
      axios.request.mockResolvedValue({
        status: 200,
        data: { accepted: true, handoffId: 'h-1' },
      });

      const result = await client.submitHandoff(
        {
          userId: 'user-A',
          sigcoreBusinessId: 'biz-1',
          leadId: 'lead-1',
          reason: 'validation_failed:postcode_outside_service_area',
        },
        'idem-h',
      );

      const call = axios.request.mock.calls[0][0];
      expect(call.url).toBe(
        'https://sf.example.com/api/integrations/leadbridge/orchestration/handoff',
      );
      expect(result.ok).toBe(true);
    });
  });

  describe('safety: no PII in logs', () => {
    it('does not pass customerContact through to log fields', async () => {
      // We don't inspect log output directly here — the contract is that
      // logRuntimeWrite-style emitters never receive PII fields. The
      // simplest behavioral check: a successful call doesn't leak
      // customerContact into the OrchestrationResult.
      axios.request.mockResolvedValue({
        status: 200,
        data: { sfJobId: 'sf-1', canonicalStatus: 'scheduled', scheduledFor: 't' },
      });
      const result = await client.submitBookingRequest(
        {
          userId: 'user-A',
          sigcoreBusinessId: 'biz-1',
          leadId: 'lead-1',
          externalRequestId: 'ext-1',
          slotId: 's1',
          customerContact: { name: 'Customer X', phone: '+15555550100' },
          serviceType: 'standard',
        },
        'idem',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Only SF's response data should be in `data` — no echo of the
      // request body (which contained PII).
      expect(JSON.stringify(result.data)).not.toContain('+15555550100');
      expect(JSON.stringify(result.data)).not.toContain('Customer X');
    });
  });
});
