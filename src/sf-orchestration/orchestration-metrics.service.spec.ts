import { OrchestrationMetricsService } from './orchestration-metrics.service';
import { ORCHESTRATION_ENDPOINTS, ORCHESTRATION_ERROR_CODES } from './sf-orchestration.contracts';

describe('OrchestrationMetricsService', () => {
  let svc: OrchestrationMetricsService;

  beforeEach(() => {
    svc = new OrchestrationMetricsService();
  });

  describe('getCountersForUser — fresh tenant', () => {
    it('returns an all-zero snapshot for a tenant with no activity', () => {
      const snap = svc.getCountersForUser('user-fresh');
      for (const ep of ORCHESTRATION_ENDPOINTS) {
        expect(snap.attempts[ep]).toBe(0);
        expect(snap.successes[ep]).toBe(0);
        expect(snap.failures[ep]).toBe(0);
        expect(snap.retries[ep]).toBe(0);
        expect(snap.lastLatencyMs[ep]).toBeNull();
      }
      for (const code of ORCHESTRATION_ERROR_CODES) {
        expect(snap.failuresByCode[code]).toBe(0);
      }
    });

    it('returns a fresh snapshot (safe to mutate)', () => {
      const a = svc.getCountersForUser('user-A');
      a.attempts.availability = 999;
      const b = svc.getCountersForUser('user-A');
      expect(b.attempts.availability).toBe(0);
    });
  });

  describe('recordAttempt + recordSuccess', () => {
    it('increments attempts and successes per endpoint', () => {
      svc.recordAttempt('user-A', 'availability');
      svc.recordAttempt('user-A', 'availability');
      svc.recordSuccess('user-A', 'availability', 123);

      const snap = svc.getCountersForUser('user-A');
      expect(snap.attempts.availability).toBe(2);
      expect(snap.successes.availability).toBe(1);
      expect(snap.lastLatencyMs.availability).toBe(123);
    });
  });

  describe('recordFailure', () => {
    it('increments failure count + failuresByCode + records latency', () => {
      svc.recordFailure('user-A', 'booking_request', 'slot_taken', 87);

      const snap = svc.getCountersForUser('user-A');
      expect(snap.failures.booking_request).toBe(1);
      expect(snap.failuresByCode.slot_taken).toBe(1);
      expect(snap.lastLatencyMs.booking_request).toBe(87);
    });

    it('accumulates failuresByCode across endpoints', () => {
      svc.recordFailure('user-A', 'booking_request', 'slot_taken', 50);
      svc.recordFailure('user-A', 'booking_cancel', 'slot_taken', 60);
      const snap = svc.getCountersForUser('user-A');
      expect(snap.failuresByCode.slot_taken).toBe(2);
    });
  });

  describe('recordRetry', () => {
    it('increments per-endpoint retry count', () => {
      svc.recordRetry('user-A', 'availability');
      svc.recordRetry('user-A', 'availability');
      svc.recordRetry('user-A', 'booking_request');
      const snap = svc.getCountersForUser('user-A');
      expect(snap.retries.availability).toBe(2);
      expect(snap.retries.booking_request).toBe(1);
    });
  });

  describe('tenant isolation', () => {
    it('writes for tenant A never affect tenant B counters', () => {
      svc.recordAttempt('user-A', 'availability');
      svc.recordSuccess('user-A', 'availability', 100);
      svc.recordFailure('user-A', 'booking_request', 'slot_taken', 50);

      const a = svc.getCountersForUser('user-A');
      const b = svc.getCountersForUser('user-B');

      expect(a.attempts.availability).toBe(1);
      expect(b.attempts.availability).toBe(0);
      expect(b.successes.availability).toBe(0);
      expect(b.failures.booking_request).toBe(0);
      expect(b.failuresByCode.slot_taken).toBe(0);
    });
  });

  describe('reset', () => {
    it('clears one tenant when given a userId', () => {
      svc.recordAttempt('user-A', 'availability');
      svc.recordAttempt('user-B', 'availability');
      svc.reset('user-A');
      expect(svc.getCountersForUser('user-A').attempts.availability).toBe(0);
      expect(svc.getCountersForUser('user-B').attempts.availability).toBe(1);
    });

    it('clears all tenants when called with no args', () => {
      svc.recordAttempt('user-A', 'availability');
      svc.recordAttempt('user-B', 'availability');
      svc.reset();
      expect(svc.getCountersForUser('user-A').attempts.availability).toBe(0);
      expect(svc.getCountersForUser('user-B').attempts.availability).toBe(0);
    });
  });

  describe('safety: ignores empty userId', () => {
    it.each(['', null, undefined])('record* with userId=%s is a no-op', (v) => {
      svc.recordAttempt(v as any, 'availability');
      svc.recordSuccess(v as any, 'availability', 100);
      svc.recordFailure(v as any, 'availability', 'unknown', 100);
      svc.recordRetry(v as any, 'availability');
      // No exception. Internal map should still be empty.
      const snap = svc.getCountersForUser('any-tenant');
      expect(snap.attempts.availability).toBe(0);
    });
  });
});
