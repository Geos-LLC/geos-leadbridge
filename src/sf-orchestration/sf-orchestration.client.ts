/**
 * SF Orchestration HTTP client — Phase 2B PR-B1.
 *
 * Outbound calls from LB to SF's four orchestration endpoints. Strictly
 * plumbing: this client is callable-but-uncalled in PR-B1 (no runtime
 * code invokes it). PR-B2 will wire it into the booking orchestrator
 * behind the BOOKING_ORCHESTRATION_ENABLED_USER_IDS feature flag.
 *
 * Contract surface (see ./sf-orchestration.contracts.ts):
 *   getAvailability    → GET  /api/integrations/leadbridge/orchestration/availability
 *   submitBookingRequest → POST /api/integrations/leadbridge/orchestration/booking-request
 *   submitBookingCancel  → POST /api/integrations/leadbridge/orchestration/booking-cancel
 *   submitHandoff      → POST /api/integrations/leadbridge/orchestration/handoff
 *
 * Behavior contract:
 *   - Auth: Bearer SF_ORCHESTRATION_API_KEY
 *   - Base URL: SF_ORCHESTRATION_BASE_URL (no trailing slash)
 *   - Per-attempt timeout: SF_ORCHESTRATION_TIMEOUT_MS, default 10_000
 *   - Max attempts: SF_ORCHESTRATION_MAX_ATTEMPTS, default 3
 *   - Backoff: exponential with jitter (250ms, 500ms, 1000ms ± 50ms)
 *   - Retries ONLY on: network errors, timeouts, 5xx. Never on 4xx.
 *   - Same Idempotency-Key on every retry of a single logical operation
 *   - Correlation-Id is fresh per attempt (so each line in Loki is unique)
 *   - Never throws — always returns OrchestrationResult<T>
 *
 * Logging contract: every attempt emits one structured line via NestJS
 *   Logger (which Loki ingests):
 *     [SfOrchestration] event=attempt|retry|success|failure
 *       endpoint=X user_id=Y correlation_id=Z idempotency_key=K
 *       attempt=N status_code=S latency_ms=L error_code=C result=R
 *   No customer PII / message body / phone / email is ever logged.
 *
 * Tenant isolation: every method takes userId for logging + metrics
 *   bucketing. The HTTP request itself is scoped on the SF side via
 *   sigcoreBusinessId in the request body / query — LB does not pick
 *   the tenant for SF.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';

import {
  type AvailabilityRequest,
  type AvailabilityResponse,
  type BookingCancelRequest,
  type BookingCancelResponse,
  type BookingRequestRequest,
  type BookingRequestResponse,
  type HandoffRequest,
  type HandoffResponse,
  type OrchestrationEndpoint,
  type OrchestrationErrorCode,
  type OrchestrationFailure,
  type OrchestrationResult,
  type OrchestrationSuccess,
} from './sf-orchestration.contracts';
import { OrchestrationMetricsService } from './orchestration-metrics.service';
import { SfConnectionResolver } from './sf-connection-resolver.service';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
/** Backoff base ms — actual sleep is base * 2^(attempt-1) ± jitter. */
const BACKOFF_BASE_MS = 250;
const BACKOFF_JITTER_MS = 50;

interface DoRequestOptions {
  endpoint: OrchestrationEndpoint;
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | undefined | null>;
  body?: unknown;
  userId: string;
  idempotencyKey: string;
}

@Injectable()
export class SfOrchestrationClient {
  private readonly logger = new Logger(SfOrchestrationClient.name);

  constructor(
    private readonly config: ConfigService,
    private readonly metrics: OrchestrationMetricsService,
    private readonly resolver: SfConnectionResolver,
  ) {}

  // ─── Public API — one method per endpoint ──────────────────────────────

  // ─── Endpoint paths ───────────────────────────────────────────────
  // Fallback / hardcoded paths used when the resolver doesn't return an
  // endpoints map (env_canary path, or older connection rows). When the
  // connection row carries SF-supplied endpoints, those win — see
  // doRequest where we read `resolved.endpoints?.[name]`.
  private static readonly DEFAULT_PATHS = {
    availability:    '/api/integrations/leadbridge/orchestration/availability',
    booking_request: '/api/integrations/leadbridge/orchestration/booking-request',
    booking_cancel:  '/api/integrations/leadbridge/orchestration/booking-cancel',
    handoff:         '/api/integrations/leadbridge/orchestration/handoff',
  } as const;

  async getAvailability(
    req: AvailabilityRequest,
    idempotencyKey: string,
  ): Promise<OrchestrationResult<AvailabilityResponse>> {
    // Wire shape uses snake_case (`requested_at`, `duration_minutes`); SF rejects
    // the camelCase aliases we used pre-fix with `400 "requested_at is required"`.
    // Response normalization happens after doRequest — SF returns `candidate_slots[]`
    // with snake_case per-slot keys, which we translate to LB's TimeSlot shape.
    const raw = await this.doRequest<any>({
      endpoint: 'availability',
      method: 'GET',
      path: SfOrchestrationClient.DEFAULT_PATHS.availability,
      query: {
        sigcoreBusinessId: req.sigcoreBusinessId,
        leadId: req.leadId ?? undefined,
        serviceType: req.serviceType,
        requested_at: req.requestedAt,
        duration_minutes: req.durationMinutes ?? undefined,
        postcode: req.postcode ?? undefined,
      },
      userId: req.userId,
      idempotencyKey,
    });
    if (!raw.ok) return raw as OrchestrationResult<AvailabilityResponse>;
    return {
      ...raw,
      data: SfOrchestrationClient.normalizeAvailabilityWire(raw.data),
    };
  }

  /**
   * Map SF's wire response (`candidate_slots[]` with snake_case slot keys) to
   * LB's AvailabilityResponse contract. Tolerant of missing optional fields;
   * caller treats `candidateSlots.length === 0` as no_availability.
   *
   * SF currently does NOT return a per-slot `slot_id` — the `slot_token` is
   * the only stable handle. We mirror `slot_token` into `slotId` so the rest
   * of the orchestrator (idempotency-key derivation, offer-set persistence)
   * has a non-null identifier. Until SF adds a real `slot_id`, the token IS
   * the id.
   */
  private static normalizeAvailabilityWire(wire: any): AvailabilityResponse {
    const rawSlots = Array.isArray(wire?.candidate_slots) ? wire.candidate_slots : [];
    const candidateSlots = rawSlots
      .filter((s: any) => s && typeof s.start === 'string' && typeof s.end === 'string')
      .map((s: any) => ({
        slotId: s.slot_id ?? s.slot_token ?? `${s.start}|${s.end}`,
        slotToken: s.slot_token ?? null,
        start: s.start,
        end: s.end,
        cleanerId: s.cleaner_id ?? null,
        providerCost: typeof s.provider_cost === 'number' ? s.provider_cost : null,
      }));
    const sw = wire?.search_window;
    const searchWindow =
      sw && typeof sw.start === 'string' && typeof sw.end === 'string'
        ? { start: sw.start, end: sw.end }
        : null;
    return {
      candidateSlots,
      searchWindow,
      durationMinutes:
        typeof wire?.duration_minutes === 'number' ? wire.duration_minutes : null,
      cachedForSeconds:
        typeof wire?.cached_for_seconds === 'number' ? wire.cached_for_seconds : 0,
    };
  }

  async submitBookingRequest(
    req: BookingRequestRequest,
    idempotencyKey: string,
  ): Promise<OrchestrationResult<BookingRequestResponse>> {
    return this.doRequest<BookingRequestResponse>({
      endpoint: 'booking_request',
      method: 'POST',
      path: SfOrchestrationClient.DEFAULT_PATHS.booking_request,
      body: {
        sigcoreBusinessId: req.sigcoreBusinessId,
        leadId: req.leadId,
        externalRequestId: req.externalRequestId,
        slotId: req.slotId,
        slotToken: req.slotToken ?? null,
        customerContact: req.customerContact,
        serviceType: req.serviceType,
        durationMinutes: req.durationMinutes ?? null,
        notes: req.notes ?? null,
      },
      userId: req.userId,
      idempotencyKey,
    });
  }

  async submitBookingCancel(
    req: BookingCancelRequest,
    idempotencyKey: string,
  ): Promise<OrchestrationResult<BookingCancelResponse>> {
    return this.doRequest<BookingCancelResponse>({
      endpoint: 'booking_cancel',
      method: 'POST',
      path: SfOrchestrationClient.DEFAULT_PATHS.booking_cancel,
      body: {
        sigcoreBusinessId: req.sigcoreBusinessId,
        sfJobId: req.sfJobId,
        leadId: req.leadId,
        reason: req.reason ?? null,
      },
      userId: req.userId,
      idempotencyKey,
    });
  }

  async submitHandoff(
    req: HandoffRequest,
    idempotencyKey: string,
  ): Promise<OrchestrationResult<HandoffResponse>> {
    return this.doRequest<HandoffResponse>({
      endpoint: 'handoff',
      method: 'POST',
      path: SfOrchestrationClient.DEFAULT_PATHS.handoff,
      body: {
        sigcoreBusinessId: req.sigcoreBusinessId,
        leadId: req.leadId,
        reason: req.reason,
        conversationContext: req.conversationContext ?? null,
      },
      userId: req.userId,
      idempotencyKey,
    });
  }

  // ─── Internal request loop ─────────────────────────────────────────────

  private async doRequest<T>(opts: DoRequestOptions): Promise<OrchestrationResult<T>> {
    // Phase 2C: credentials resolved per-call via SfConnectionResolver.
    // Ladder: per-tenant SfConnection row → env canary → none. When
    // disabled, return orchestration_disabled without making any HTTP
    // call (matches the previous PR-B1 "missing config" safety property).
    const resolved = await this.resolver.resolveForUser(opts.userId);
    if (!resolved.enabled || !resolved.baseUrl || !resolved.orchestrationToken) {
      const failure: OrchestrationFailure = {
        ok: false,
        code: 'orchestration_disabled',
        status: null,
        body: null,
        message: `resolver returned disabled (reason=${resolved.disabledReason ?? 'unknown'})`,
        correlationId: randomUUID(),
        idempotencyKey: opts.idempotencyKey,
        attemptCount: 0,
        latencyMs: 0,
      };
      this.logger.warn(
        `[SfOrchestration] event=skipped endpoint=${opts.endpoint} user_id=${opts.userId}` +
          ` reason=resolver_disabled source=${resolved.source} disabled_reason=${resolved.disabledReason ?? 'null'}`,
      );
      return failure;
    }
    const baseUrl = resolved.baseUrl;
    const apiKey = resolved.orchestrationToken;
    // Prefer SF-supplied endpoint path when the resolver returned one
    // (connection-source). Falls back to the hardcoded default otherwise.
    const path = resolved.endpoints?.[opts.endpoint] ?? opts.path;
    opts.path = path;

    const timeoutMs = this.parseIntEnv('SF_ORCHESTRATION_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    const maxAttempts = this.parseIntEnv(
      'SF_ORCHESTRATION_MAX_ATTEMPTS',
      DEFAULT_MAX_ATTEMPTS,
    );

    // require at call site (not top-level) — matches CrmWebhookService pattern.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const axios = require('axios');

    const url = baseUrl.replace(/\/$/, '') + opts.path;
    const params = opts.query
      ? Object.fromEntries(
          Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null),
        )
      : undefined;

    const start = Date.now();
    this.metrics.recordAttempt(opts.userId, opts.endpoint);

    let lastFailure: OrchestrationFailure | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const correlationId = randomUUID();
      const attemptStart = Date.now();
      this.logger.log(
        `[SfOrchestration] event=attempt endpoint=${opts.endpoint} user_id=${opts.userId}` +
          ` correlation_id=${correlationId} idempotency_key=${opts.idempotencyKey}` +
          ` attempt=${attempt} max_attempts=${maxAttempts} source=${resolved.source}` +
          (resolved.usedPreviousToken ? ' used_previous_token=true' : ''),
      );

      let response: any;
      let errorObj: any;
      try {
        response = await axios.request({
          url,
          method: opts.method,
          params,
          data: opts.body,
          timeout: timeoutMs,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'X-Correlation-Id': correlationId,
            'Idempotency-Key': opts.idempotencyKey,
            'X-LB-User-Id': opts.userId,
          },
          // Treat ANY non-2xx as a non-throwing response so we can route on status.
          validateStatus: () => true,
        });
      } catch (e: any) {
        errorObj = e;
      }
      const attemptLatency = Date.now() - attemptStart;

      // ─── Network / timeout error ──────────────────────────────────────
      if (errorObj) {
        const isTimeout =
          errorObj?.code === 'ECONNABORTED' ||
          errorObj?.code === 'ETIMEDOUT' ||
          /timeout/i.test(errorObj?.message ?? '');
        const code: OrchestrationErrorCode = isTimeout ? 'timeout' : 'network_error';
        this.logger.warn(
          `[SfOrchestration] event=failure endpoint=${opts.endpoint} user_id=${opts.userId}` +
            ` correlation_id=${correlationId} idempotency_key=${opts.idempotencyKey}` +
            ` attempt=${attempt} status_code=null latency_ms=${attemptLatency}` +
            ` error_code=${code} message=${this.safeMsg(errorObj?.message)}`,
        );
        lastFailure = {
          ok: false,
          code,
          status: null,
          body: null,
          message: this.safeMsg(errorObj?.message),
          correlationId,
          idempotencyKey: opts.idempotencyKey,
          attemptCount: attempt,
          latencyMs: Date.now() - start,
        };
        // Retryable
        if (attempt < maxAttempts) {
          this.metrics.recordRetry(opts.userId, opts.endpoint);
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        this.metrics.recordFailure(opts.userId, opts.endpoint, code, lastFailure.latencyMs);
        return lastFailure;
      }

      const status: number = response.status;
      const data: any = response.data;

      // ─── Success ──────────────────────────────────────────────────────
      if (status >= 200 && status < 300) {
        const totalLatency = Date.now() - start;
        this.logger.log(
          `[SfOrchestration] event=success endpoint=${opts.endpoint} user_id=${opts.userId}` +
            ` correlation_id=${correlationId} idempotency_key=${opts.idempotencyKey}` +
            ` attempt=${attempt} status_code=${status} latency_ms=${attemptLatency}` +
            ` total_latency_ms=${totalLatency}`,
        );
        this.metrics.recordSuccess(opts.userId, opts.endpoint, totalLatency);
        const success: OrchestrationSuccess<T> = {
          ok: true,
          status,
          data: data as T,
          correlationId,
          idempotencyKey: opts.idempotencyKey,
          attemptCount: attempt,
          latencyMs: totalLatency,
        };
        return success;
      }

      // ─── Terminal client error (4xx) — do NOT retry ───────────────────
      const code = this.classifyHttpStatus(status, data);
      const totalLatency = Date.now() - start;
      this.logger.warn(
        `[SfOrchestration] event=failure endpoint=${opts.endpoint} user_id=${opts.userId}` +
          ` correlation_id=${correlationId} idempotency_key=${opts.idempotencyKey}` +
          ` attempt=${attempt} status_code=${status} latency_ms=${attemptLatency}` +
          ` total_latency_ms=${totalLatency} error_code=${code}`,
      );
      if (status >= 400 && status < 500) {
        lastFailure = {
          ok: false,
          code,
          status,
          body: data ?? null,
          message: this.extractMessage(data) ?? `HTTP ${status}`,
          correlationId,
          idempotencyKey: opts.idempotencyKey,
          attemptCount: attempt,
          latencyMs: totalLatency,
        };
        this.metrics.recordFailure(opts.userId, opts.endpoint, code, totalLatency);
        return lastFailure;
      }

      // ─── Server error (5xx) — retry with backoff ──────────────────────
      lastFailure = {
        ok: false,
        code,
        status,
        body: data ?? null,
        message: this.extractMessage(data) ?? `HTTP ${status}`,
        correlationId,
        idempotencyKey: opts.idempotencyKey,
        attemptCount: attempt,
        latencyMs: totalLatency,
      };
      if (attempt < maxAttempts) {
        this.metrics.recordRetry(opts.userId, opts.endpoint);
        await this.sleep(this.backoffMs(attempt));
        continue;
      }
      this.metrics.recordFailure(opts.userId, opts.endpoint, code, totalLatency);
      return lastFailure;
    }

    // Unreachable in practice (loop always returns on terminal outcome or
    // exhausted retries) — kept for tsc's exhaustiveness check.
    return (
      lastFailure ?? {
        ok: false,
        code: 'unknown',
        status: null,
        body: null,
        message: 'request loop exited without resolution',
        correlationId: randomUUID(),
        idempotencyKey: opts.idempotencyKey,
        attemptCount: maxAttempts,
        latencyMs: Date.now() - start,
      }
    );
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /** Map status + body to a stable OrchestrationErrorCode. */
  private classifyHttpStatus(status: number, body: any): OrchestrationErrorCode {
    // 4xx — most have body.error tags from SF that we trust verbatim.
    const bodyError = typeof body?.error === 'string' ? body.error : null;
    if (status === 403) {
      if (bodyError === 'orchestration_disabled') return 'orchestration_disabled';
      // Generic 403 — treat as orchestration_disabled so PR-B2 routes to
      // handoff fallback by default. (SF should be specific; if it's not,
      // the safe interpretation is "feature off for this caller".)
      return 'orchestration_disabled';
    }
    if (status === 404) return 'not_found';
    if (status === 409) {
      if (bodyError === 'slot_taken') return 'slot_taken';
      return 'slot_taken';
    }
    if (status === 410) {
      if (bodyError === 'slot_token_expired') return 'slot_token_expired';
      return 'slot_token_expired';
    }
    if (status === 422) {
      if (bodyError === 'validation_failed') return 'validation_failed';
      return 'validation_failed';
    }
    if (status >= 500) return 'server_error';
    return 'unknown';
  }

  /** Backoff in ms for attempt N (1-indexed). 250, 500, 1000 ± 50. */
  private backoffMs(attempt: number): number {
    const base = BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt - 1));
    const jitter = Math.floor(Math.random() * (BACKOFF_JITTER_MS * 2 + 1)) - BACKOFF_JITTER_MS;
    return Math.max(0, base + jitter);
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Best-effort message extraction. Never returns raw bodies. */
  private extractMessage(body: any): string | null {
    if (!body) return null;
    if (typeof body === 'string') return this.safeMsg(body);
    if (typeof body.message === 'string') return this.safeMsg(body.message);
    if (typeof body.error === 'string') return this.safeMsg(body.error);
    return null;
  }

  /** Trim long strings + strip newlines so log lines stay greppable. */
  private safeMsg(s: any): string {
    if (typeof s !== 'string') return String(s ?? '');
    const oneLine = s.replace(/\s+/g, ' ').trim();
    return oneLine.length > 200 ? oneLine.slice(0, 200) + '…' : oneLine;
  }

  private parseIntEnv(name: string, defaultValue: number): number {
    const raw = this.config.get<string>(name);
    if (raw == null) return defaultValue;
    const n = parseInt(String(raw), 10);
    return Number.isFinite(n) && n > 0 ? n : defaultValue;
  }
}
