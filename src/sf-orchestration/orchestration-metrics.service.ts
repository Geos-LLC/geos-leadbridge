/**
 * In-process orchestration metrics — Phase 2B PR-B1.
 *
 * Tenant-scoped counters incremented by SfOrchestrationClient on every
 * call. Surfaced read-only via the runtime summary endpoint so an
 * operator can verify dark-launch state ("0 attempts everywhere") and
 * later canary progress.
 *
 * Trade-offs by design:
 *   - In-process Map → counters reset on every Railway deploy. Acceptable
 *     because the authoritative observability layer is structured logs
 *     in Loki (see SfOrchestrationClient). Counters are a convenience
 *     surface, not a system of record.
 *   - Per-instance only → staging + prod don't aggregate. The summary
 *     endpoint hits whichever instance the request lands on. Fine for
 *     debug; if cross-instance roll-ups are needed, build them on Loki.
 *   - No external metric system dependency (Prometheus, StatsD) — keeps
 *     PR-B1 deploy footprint minimal.
 *
 * Tenant isolation: every method takes userId and only touches that
 * tenant's bucket. `getCountersForUser` returns a fresh object — callers
 * cannot mutate internal state.
 */

import { Injectable } from '@nestjs/common';
import {
  ORCHESTRATION_ENDPOINTS,
  ORCHESTRATION_ERROR_CODES,
  type OrchestrationEndpoint,
  type OrchestrationErrorCode,
} from './sf-orchestration.contracts';

export interface OrchestrationCountersSnapshot {
  attempts: Record<OrchestrationEndpoint, number>;
  successes: Record<OrchestrationEndpoint, number>;
  failures: Record<OrchestrationEndpoint, number>;
  retries: Record<OrchestrationEndpoint, number>;
  failuresByCode: Record<OrchestrationErrorCode, number>;
  /** Most recent observed latency per endpoint (ms). Null if no calls yet. */
  lastLatencyMs: Record<OrchestrationEndpoint, number | null>;
}

interface InternalCounters {
  attempts: Record<string, number>;
  successes: Record<string, number>;
  failures: Record<string, number>;
  retries: Record<string, number>;
  failuresByCode: Record<string, number>;
  lastLatencyMs: Record<string, number | null>;
}

function emptyCounters(): InternalCounters {
  const zeroByEndpoint = (): Record<string, number> => {
    const r: Record<string, number> = {};
    for (const ep of ORCHESTRATION_ENDPOINTS) r[ep] = 0;
    return r;
  };
  const nullByEndpoint = (): Record<string, number | null> => {
    const r: Record<string, number | null> = {};
    for (const ep of ORCHESTRATION_ENDPOINTS) r[ep] = null;
    return r;
  };
  const zeroByCode = (): Record<string, number> => {
    const r: Record<string, number> = {};
    for (const c of ORCHESTRATION_ERROR_CODES) r[c] = 0;
    return r;
  };
  return {
    attempts: zeroByEndpoint(),
    successes: zeroByEndpoint(),
    failures: zeroByEndpoint(),
    retries: zeroByEndpoint(),
    failuresByCode: zeroByCode(),
    lastLatencyMs: nullByEndpoint(),
  };
}

@Injectable()
export class OrchestrationMetricsService {
  private readonly buckets = new Map<string, InternalCounters>();

  private getOrCreate(userId: string): InternalCounters {
    let b = this.buckets.get(userId);
    if (!b) {
      b = emptyCounters();
      this.buckets.set(userId, b);
    }
    return b;
  }

  recordAttempt(userId: string, endpoint: OrchestrationEndpoint): void {
    if (!userId) return;
    this.getOrCreate(userId).attempts[endpoint] += 1;
  }

  recordRetry(userId: string, endpoint: OrchestrationEndpoint): void {
    if (!userId) return;
    this.getOrCreate(userId).retries[endpoint] += 1;
  }

  recordSuccess(
    userId: string,
    endpoint: OrchestrationEndpoint,
    latencyMs: number,
  ): void {
    if (!userId) return;
    const b = this.getOrCreate(userId);
    b.successes[endpoint] += 1;
    b.lastLatencyMs[endpoint] = latencyMs;
  }

  recordFailure(
    userId: string,
    endpoint: OrchestrationEndpoint,
    code: OrchestrationErrorCode,
    latencyMs: number,
  ): void {
    if (!userId) return;
    const b = this.getOrCreate(userId);
    b.failures[endpoint] += 1;
    b.failuresByCode[code] = (b.failuresByCode[code] ?? 0) + 1;
    b.lastLatencyMs[endpoint] = latencyMs;
  }

  /**
   * Return a frozen snapshot of one tenant's counters. Returns an
   * all-zero snapshot if the tenant has no recorded activity — never
   * returns undefined, so the summary endpoint can render a consistent
   * shape on a fresh deploy.
   */
  getCountersForUser(userId: string): OrchestrationCountersSnapshot {
    const b = this.buckets.get(userId) ?? emptyCounters();
    return {
      attempts: { ...b.attempts } as Record<OrchestrationEndpoint, number>,
      successes: { ...b.successes } as Record<OrchestrationEndpoint, number>,
      failures: { ...b.failures } as Record<OrchestrationEndpoint, number>,
      retries: { ...b.retries } as Record<OrchestrationEndpoint, number>,
      failuresByCode: { ...b.failuresByCode } as Record<OrchestrationErrorCode, number>,
      lastLatencyMs: { ...b.lastLatencyMs } as Record<OrchestrationEndpoint, number | null>,
    };
  }

  /** For tests — wipe a specific tenant or everything. */
  reset(userId?: string): void {
    if (userId) this.buckets.delete(userId);
    else this.buckets.clear();
  }
}
