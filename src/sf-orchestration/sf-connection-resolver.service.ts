/**
 * SfConnectionResolver — Phase 2C PR-C1.
 *
 * Single source of truth for "is SF orchestration enabled for this
 * tenant, and if so what are the credentials". Consulted on every
 * outbound call by SfOrchestrationClient and on every gate check by
 * OrchestrationFeatureFlag.isEnabledForUser.
 *
 * Resolution ladder (first match wins):
 *
 *   1. DB connection   — `SfConnection` row exists, isActive=true,
 *                        status ∈ {active, rotating}, current token
 *                        decryptable. Source = 'connection'.
 *                        On status='rotating' with current decrypt
 *                        failure, falls back to the previous token
 *                        (still valid on SF side during the 5-min
 *                        grace window). After previousTokenExpiresAt,
 *                        the previous token is lazy-cleared on read.
 *
 *   2. Env canary       — userId is in BOOKING_ORCHESTRATION_ENABLED_USER_IDS
 *                        AND SF_ORCHESTRATION_BASE_URL + SF_ORCHESTRATION_API_KEY
 *                        are both set. Source = 'env_canary'.
 *
 *   3. None             — orchestration disabled for this user.
 *                        Source = 'none'.
 *
 * Dark-launch property: with zero `sf_connections` rows AND every env
 * unset (current prod state), every resolveForUser returns enabled=false.
 * Bit-identical to PR-B2 dark-launch.
 *
 * No caching, read-through. The findUnique on a unique index is cheap;
 * lazy grace-window cleanup runs in the same query path so no cron
 * dependency.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/utils/prisma.service';
import { EncryptionUtil } from '../common/utils/encryption.util';

export type ResolutionSource = 'connection' | 'env_canary' | 'none';

export interface ResolvedSfEndpoints {
  availability: string;
  booking_request: string;
  booking_cancel: string;
  handoff: string;
  disconnect: string;
}

export interface ResolvedSfCredentials {
  enabled: boolean;
  source: ResolutionSource;
  /** Present when enabled=true. */
  baseUrl?: string;
  /** Already-decrypted bearer token. LB never parses claims. */
  orchestrationToken?: string;
  /** SF-side tenant id — logged for correlation, never used for security. */
  sfTenantId?: string;
  /** True when the resolver used the previous (pre-rotation) token as fallback. */
  usedPreviousToken?: boolean;
  /**
   * SF-supplied endpoint paths (PR-C2.1). When source='connection',
   * decoded from sf_connections.endpointsJson; when source='env_canary',
   * undefined (client falls back to hardcoded). Paths are relative to
   * baseUrl; client concatenates.
   */
  endpoints?: ResolvedSfEndpoints;
  /**
   * When the resolver returned `enabled=false`, this carries the reason
   * for log dashboards. One of: 'no_connection_or_canary' | 'connection_inactive'
   * | 'connection_decrypt_failed' | 'env_partial' | 'no_userid'.
   */
  disabledReason?: string;
  /**
   * R1 — true when SF has notified LB of a credential rotation but the
   * new token has not yet been refreshed via re-handshake. The current
   * (pre-rotation) token is still valid for outbound calls until
   * `rotationGraceExpiresAt`. Callers can use this signal to schedule
   * a refresh or display a status banner.
   */
  rotationPending?: boolean;
  /** When the prior token stops working (per SF's grace declaration). */
  rotationGraceExpiresAt?: Date;
  /** SF's new credential id (informational; bearer is still the old one). */
  pendingRotationCredId?: string;
}

@Injectable()
export class SfConnectionResolver {
  private readonly logger = new Logger(SfConnectionResolver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Async convenience wrapper. The async ladder gate consulted by
   * OrchestrationFeatureFlag.isEnabledForUser.
   */
  async isEnabledForUser(userId: string | null | undefined): Promise<boolean> {
    return (await this.resolveForUser(userId)).enabled;
  }

  async resolveForUser(userId: string | null | undefined): Promise<ResolvedSfCredentials> {
    if (!userId) {
      return { enabled: false, source: 'none', disabledReason: 'no_userid' };
    }

    // ─── 1. DB connection path ───────────────────────────────────────
    const conn = await this.prisma.sfConnection.findUnique({ where: { userId } });
    if (conn) {
      const dbResult = await this.tryResolveFromConnection(conn);
      if (dbResult) return dbResult;
    }

    // ─── 2. Env canary path ──────────────────────────────────────────
    const envResult = this.tryResolveFromEnvCanary(userId);
    if (envResult) return envResult;

    // ─── 3. Disabled ────────────────────────────────────────────────
    return {
      enabled: false,
      source: 'none',
      disabledReason: conn ? 'connection_inactive' : 'no_connection_or_canary',
    };
  }

  // ─── Internals ─────────────────────────────────────────────────────

  /**
   * Try to resolve enabled credentials from an `SfConnection` row.
   * Performs lazy grace-window cleanup. Returns null if the row is not
   * usable (the caller will then try the env-canary path).
   */
  private async tryResolveFromConnection(conn: {
    id: string;
    userId: string;
    isActive: boolean;
    status: string;
    baseUrl: string;
    sfTenantId: string;
    orchestrationToken: string;
    previousOrchestrationToken: string | null;
    previousTokenExpiresAt: Date | null;
    endpointsJson?: string | null;
    rotationPending?: boolean;
    pendingRotationCredId?: string | null;
    pendingRotationGraceExpiresAt?: Date | null;
  }): Promise<ResolvedSfCredentials | null> {
    if (!conn.isActive) return null;
    if (!(conn.status === 'active' || conn.status === 'rotating')) return null;

    // Lazy grace-window cleanup: previousTokenExpiresAt has passed →
    // wipe the previous token + flip status back to 'active'. Single
    // update; no cron required.
    if (
      conn.status === 'rotating' &&
      conn.previousTokenExpiresAt &&
      conn.previousTokenExpiresAt < new Date()
    ) {
      await this.prisma.sfConnection
        .update({
          where: { id: conn.id },
          data: {
            previousOrchestrationToken: null,
            previousTokenExpiresAt: null,
            status: 'active',
          },
        })
        .catch((e) => {
          // Best-effort cleanup. The next resolve call will retry. Don't
          // fail the orchestration call over a cleanup race.
          this.logger.warn(
            `[SfConnectionResolver] grace_cleanup_failed user_id=${conn.userId} ` +
              `conn_id=${conn.id} err=${(e?.message ?? '').slice(0, 200)}`,
          );
        });
      // Refresh local view so we don't hand back stale fields to the caller.
      conn.previousOrchestrationToken = null;
      conn.previousTokenExpiresAt = null;
      conn.status = 'active';
    }

    const encryptionKey = this.config.get<string>('encryption.key') ?? '';
    if (!encryptionKey) {
      // No encryption key configured — can't decrypt anything stored.
      // Fall through to env canary so we don't deadlock the tenant.
      this.logger.error(
        `[SfConnectionResolver] missing_encryption_key user_id=${conn.userId} action=fall_through`,
      );
      return null;
    }

    const endpoints = this.parseEndpoints(conn.endpointsJson);

    // R1: rotation-pending visibility + grace-expiry alerting.
    // The current bearer is still valid; we just surface the pending state
    // and yell loudly when grace is about to elapse so monitoring catches it.
    const rotationSignal = this.checkRotationPending(conn);

    // Try current token first.
    const current = this.tryDecrypt(conn.orchestrationToken, encryptionKey);
    if (current) {
      return {
        enabled: true,
        source: 'connection',
        baseUrl: conn.baseUrl,
        orchestrationToken: current,
        sfTenantId: conn.sfTenantId,
        usedPreviousToken: false,
        endpoints,
        rotationPending: rotationSignal.pending,
        rotationGraceExpiresAt: rotationSignal.graceExpiresAt,
        pendingRotationCredId: rotationSignal.credId,
      };
    }

    // Current decrypt failed. If we're in the rotation grace window and
    // have a previous token, try it as a last-resort fallback. SF still
    // accepts it for the grace duration.
    if (conn.previousOrchestrationToken && conn.previousTokenExpiresAt) {
      const stillValid = conn.previousTokenExpiresAt > new Date();
      if (stillValid) {
        const previous = this.tryDecrypt(conn.previousOrchestrationToken, encryptionKey);
        if (previous) {
          this.logger.warn(
            `[SfConnectionResolver] using_previous_token user_id=${conn.userId} ` +
              `conn_id=${conn.id} reason=current_decrypt_failed`,
          );
          return {
            enabled: true,
            source: 'connection',
            baseUrl: conn.baseUrl,
            orchestrationToken: previous,
            sfTenantId: conn.sfTenantId,
            usedPreviousToken: true,
            endpoints,
          };
        }
      }
    }

    // Both decrypts failed (or no previous). Fall through to env canary.
    this.logger.error(
      `[SfConnectionResolver] decrypt_failed user_id=${conn.userId} ` +
        `conn_id=${conn.id} action=fall_through_to_env`,
    );
    return null;
  }

  /**
   * Try to resolve enabled credentials from the env canary path. Returns
   * null if the userId is not in the CSV or required env vars are missing.
   */
  private tryResolveFromEnvCanary(userId: string): ResolvedSfCredentials | null {
    const csv = this.config.get<string>('BOOKING_ORCHESTRATION_ENABLED_USER_IDS', '') ?? '';
    const enabledUserIds = csv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!enabledUserIds.includes(userId)) return null;

    const baseUrl = this.config.get<string>('SF_ORCHESTRATION_BASE_URL', '') ?? '';
    const apiKey = this.config.get<string>('SF_ORCHESTRATION_API_KEY', '') ?? '';
    if (!baseUrl || !apiKey) {
      // CSV includes the user but the env values are missing — treat as
      // misconfiguration, surface clearly in logs.
      this.logger.warn(
        `[SfConnectionResolver] env_partial user_id=${userId} ` +
          `base_url_set=${!!baseUrl} api_key_set=${!!apiKey}`,
      );
      return null;
    }

    return {
      enabled: true,
      source: 'env_canary',
      baseUrl,
      orchestrationToken: apiKey,
      usedPreviousToken: false,
    };
  }

  /**
   * Decode endpointsJson from the SfConnection row. Returns undefined on
   * any parse / shape issue — the client will fall back to hardcoded paths.
   */
  private parseEndpoints(json: string | null | undefined): ResolvedSfEndpoints | undefined {
    if (!json) return undefined;
    try {
      const o = JSON.parse(json);
      if (
        o &&
        typeof o.availability === 'string' &&
        typeof o.booking_request === 'string' &&
        typeof o.booking_cancel === 'string' &&
        typeof o.handoff === 'string' &&
        typeof o.disconnect === 'string'
      ) {
        return o as ResolvedSfEndpoints;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * R1 — evaluate the pending rotation state at resolve time. Emits log
   * alerts at three thresholds:
   *   - grace_expiring_soon: < 60s remaining (WARN)
   *   - grace_imminent:      < 10s remaining (ERROR)
   *   - grace_elapsed:       past expiry      (ERROR — outbound calls
   *                                            using the current token may
   *                                            start failing on SF side)
   * Returns the structured signal for the caller.
   */
  private checkRotationPending(conn: {
    id: string;
    userId: string;
    rotationPending?: boolean;
    pendingRotationCredId?: string | null;
    pendingRotationGraceExpiresAt?: Date | null;
  }): { pending: boolean; graceExpiresAt?: Date; credId?: string } {
    if (!conn.rotationPending || !conn.pendingRotationGraceExpiresAt) {
      return { pending: false };
    }
    const graceExpiresAt = conn.pendingRotationGraceExpiresAt;
    const msRemaining = graceExpiresAt.getTime() - Date.now();
    const credId = conn.pendingRotationCredId ?? undefined;
    const baseFields =
      `user_id=${conn.userId} conn_id=${conn.id} pending_cred_id=${credId ?? 'null'} ` +
      `grace_expires_at=${graceExpiresAt.toISOString()} grace_ms_remaining=${msRemaining}`;
    if (msRemaining <= 0) {
      this.logger.error(`[SfConnectionResolver] rotation_grace_elapsed ${baseFields}`);
    } else if (msRemaining < 10_000) {
      this.logger.error(`[SfConnectionResolver] rotation_grace_imminent ${baseFields}`);
    } else if (msRemaining < 60_000) {
      this.logger.warn(`[SfConnectionResolver] rotation_grace_expiring_soon ${baseFields}`);
    }
    return { pending: true, graceExpiresAt, credId };
  }

  private tryDecrypt(encrypted: string, key: string): string | null {
    if (!encrypted) return null;
    try {
      return EncryptionUtil.decrypt(encrypted, key);
    } catch (e: any) {
      // Don't log the encrypted payload — only the failure mode.
      this.logger.warn(
        `[SfConnectionResolver] decrypt_attempt_failed err=${(e?.message ?? '').slice(0, 120)}`,
      );
      return null;
    }
  }
}
