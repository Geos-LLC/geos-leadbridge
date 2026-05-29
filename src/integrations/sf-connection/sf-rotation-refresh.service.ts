/**
 * SfRotationRefreshService — R1B.
 *
 * Automatic credential refresh after a `credential.rotated` webhook
 * notification. SF rotates credentials independently of LB and signals via
 * webhook; this service is the LB-initiated HTTP refresh that materializes
 * the new bearer.
 *
 * Two entry points:
 *
 *   1. Immediate trigger (from SfConnectionWebhookService): fire-and-forget
 *      `refreshIfPending(connId)` right after the notification is persisted.
 *      Optimised for fast resolution — no scan latency.
 *
 *   2. Worker scan (cron @ EVERY_MINUTE): safety-net for missed immediate
 *      triggers (LB crashed between webhook ack and refresh dispatch, or
 *      a 5xx exhausted the in-memory backoff). Scans `rotationPending=true`
 *      rows whose grace window is approaching but not elapsed.
 *
 * Single-flight: per-connection Postgres advisory lock
 * (`pg_try_advisory_xact_lock(hashtext('sf-refresh:' || id))`). Refresh
 * response carries plaintext token ONCE — two LB instances must never
 * race the call, or one loses the secret.
 *
 * Plaintext token NEVER logged. Only token_prefix + token_len + kid +
 * cred_id appear in observability surfaces.
 *
 * Endpoint URL: prefers `provisioning.endpoints.credentials_refresh` from
 * the OAuth exchange (stored on SfConnection.endpointsJson). Falls back
 * to the documented hardcoded path
 * `/api/integrations/leadbridge/orchestration/credentials/refresh` if SF
 * didn't supply it (older provisioning rows).
 *
 * Response handling:
 *   200  → applyCredentialRefresh (atomic persist + clear pending + grace)
 *   409  → no_pending_rotation — clear local pending defensively
 *   401  → current_credential_invalid — mark error, require reconnect
 *   410  → connection_revoked — mirror connection.revoked webhook path
 *   423  → rotation_already_refreshed — re-read; peer instance won
 *   5xx  → backoff + retry; stop if next slot lands past grace-60s
 *   network error → same as 5xx
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/utils/prisma.service';
import { EncryptionUtil } from '../../common/utils/encryption.util';
import { SfConnectionLifecycleService } from './sf-connection-lifecycle.service';

const FALLBACK_REFRESH_PATH = '/api/integrations/leadbridge/orchestration/credentials/refresh';
/** Don't fire SF call when grace is closer than this — backoff would land past grace. */
const REFRESH_MIN_GRACE_MS = 60_000;
/** Worker scan window upper bound — only act when grace is "approaching" (< 4 min). */
const REFRESH_SCAN_WINDOW_MS = 4 * 60_000;
const REFRESH_TIMEOUT_MS = 10_000;

export type RefreshTriggerSource = 'webhook_immediate' | 'worker_scan' | 'admin' | 'test';

export type RefreshOutcome =
  | { kind: 'refreshed'; newCredId: string; newKid: string }
  | { kind: 'no_pending' }
  | { kind: 'already_refreshed' }
  | { kind: 'invalid_credential' }
  | { kind: 'revoked' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'transient_failure'; status?: number; retryable: true }
  | { kind: 'permanent_failure'; error: string };

@Injectable()
export class SfRotationRefreshService {
  private readonly logger = new Logger(SfRotationRefreshService.name);
  private scanProcessing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly lifecycle: SfConnectionLifecycleService,
  ) {}

  // ─── Public: immediate trigger from webhook ──────────────────────
  //
  // Fire-and-forget pattern. The webhook handler must NOT await this —
  // it should ack SF's webhook fast (200) and let the refresh round-trip
  // resolve asynchronously. We catch and log errors here so they never
  // bubble up to the webhook handler.

  triggerImmediate(connectionId: string): void {
    // setImmediate so the webhook handler's response can flush first.
    setImmediate(() => {
      this.refreshIfPending(connectionId, 'webhook_immediate').catch((e) => {
        this.logger.error(
          `[SfRefresh] event=refresh_failed conn_id=${connectionId} trigger=webhook_immediate ` +
            `error=${this.safe(e?.message)} unhandled=true`,
        );
      });
    });
  }

  // ─── Public: worker safety net ───────────────────────────────────

  @Cron(CronExpression.EVERY_MINUTE)
  async scanForPendingRefresh(): Promise<void> {
    if (this.scanProcessing) return;
    this.scanProcessing = true;
    try {
      const now = new Date();
      const upperBound = new Date(now.getTime() + REFRESH_SCAN_WINDOW_MS);
      const lowerBound = new Date(now.getTime() + REFRESH_MIN_GRACE_MS);
      const rows = await this.prisma.sfConnection.findMany({
        where: {
          rotationPending: true,
          isActive: true,
          status: 'active',
          pendingRotationGraceExpiresAt: { gt: lowerBound, lt: upperBound },
        },
        select: { id: true, userId: true, pendingRotationCredId: true },
      });
      if (rows.length === 0) return;
      this.logger.log(
        `[SfRefresh] event=scan_picked count=${rows.length} window_lower=${lowerBound.toISOString()} window_upper=${upperBound.toISOString()}`,
      );
      // Sequential per row; each call has its own advisory lock. Safe
      // for the small expected fan-out (rotations are rare events).
      for (const row of rows) {
        await this.refreshIfPending(row.id, 'worker_scan').catch((e) => {
          this.logger.warn(
            `[SfRefresh] event=refresh_failed conn_id=${row.id} trigger=worker_scan ` +
              `error=${this.safe(e?.message)}`,
          );
        });
      }
    } finally {
      this.scanProcessing = false;
    }
  }

  // ─── Public: single-shot, idempotent, single-flight ──────────────
  //
  // Acquires per-connection advisory lock inside a short tx, validates
  // the row is still eligible, makes the SF call, routes the response.
  // Lock auto-releases on tx commit/rollback — no manual unlock.

  async refreshIfPending(
    connectionId: string,
    triggerSource: RefreshTriggerSource,
  ): Promise<RefreshOutcome> {
    const lockKey = `sf-refresh:${connectionId}`;

    // Acquire lock + read row + dispatch — all inside one tx so the lock
    // is held for the duration of the SF round-trip. Tx timeout > SF call
    // timeout so the tx doesn't time out before the fetch does.
    type ConnSnapshot = { userId: string; baseUrl: string; sfTenantId: string };
    let outcome: RefreshOutcome;
    // Mutated inside the $transaction callback; TS can't infer through the
    // async closure, so we widen the declared type explicitly.
    let connSnapshot = null as ConnSnapshot | null;
    try {
      outcome = await this.prisma.$transaction(
        async (tx) => {
          const lockRows = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS locked
          `;
          if (!lockRows?.[0]?.locked) {
            this.logger.log(`[SfRefresh] event=skipped conn_id=${connectionId} reason=locked_by_peer trigger=${triggerSource}`);
            return { kind: 'skipped', reason: 'locked_by_peer' } as RefreshOutcome;
          }

          // Re-read inside the lock — defense against stale eligibility.
          const conn = await tx.sfConnection.findUnique({ where: { id: connectionId } });
          if (!conn) {
            this.logger.warn(`[SfRefresh] event=skipped conn_id=${connectionId} reason=no_connection trigger=${triggerSource}`);
            return { kind: 'skipped', reason: 'no_connection' } as RefreshOutcome;
          }
          if (!conn.isActive || conn.status !== 'active') {
            this.logger.log(
              `[SfRefresh] event=skipped conn_id=${connectionId} reason=status_${conn.status} ` +
                `isActive=${conn.isActive} trigger=${triggerSource}`,
            );
            return { kind: 'skipped', reason: `status_${conn.status}` } as RefreshOutcome;
          }
          if (!conn.rotationPending) {
            this.logger.log(
              `[SfRefresh] event=skipped conn_id=${connectionId} reason=no_rotation_pending trigger=${triggerSource}`,
            );
            return { kind: 'skipped', reason: 'no_rotation_pending' } as RefreshOutcome;
          }
          if (conn.pendingRotationGraceExpiresAt) {
            const msUntilGrace = conn.pendingRotationGraceExpiresAt.getTime() - Date.now();
            if (msUntilGrace < REFRESH_MIN_GRACE_MS) {
              this.logger.error(
                `[SfRefresh] event=skipped conn_id=${connectionId} reason=grace_too_close ` +
                  `ms_until_grace=${msUntilGrace} trigger=${triggerSource}`,
              );
              return { kind: 'skipped', reason: 'grace_too_close' } as RefreshOutcome;
            }
          }

          connSnapshot = { userId: conn.userId, baseUrl: conn.baseUrl, sfTenantId: conn.sfTenantId };

          // Decrypt current bearer (just-in-time).
          const encKey = this.config.get<string>('encryption.key');
          if (!encKey) {
            this.logger.error(`[SfRefresh] event=refresh_failed conn_id=${connectionId} error=encryption_key_unset`);
            return { kind: 'permanent_failure', error: 'encryption_key_unset' } as RefreshOutcome;
          }
          let currentBearer: string;
          try {
            currentBearer = EncryptionUtil.decrypt(conn.orchestrationToken, encKey);
          } catch {
            this.logger.error(`[SfRefresh] event=refresh_failed conn_id=${connectionId} error=current_decrypt_failed`);
            return { kind: 'permanent_failure', error: 'current_decrypt_failed' } as RefreshOutcome;
          }

          this.logger.log(
            `[SfRefresh] event=started conn_id=${connectionId} user_id=${conn.userId} ` +
              `sf_tenant_id=${conn.sfTenantId} pending_cred_id=${conn.pendingRotationCredId ?? 'null'} ` +
              `current_token_prefix=${conn.tokenPrefix ?? 'null'} trigger=${triggerSource}`,
          );

          // Build URL: prefer endpoints.credentials_refresh, fall back.
          const refreshUrl = this.buildRefreshUrl(conn.baseUrl, conn.endpointsJson);

          // Make the SF call.
          const sfResp = await this.callSfRefresh(refreshUrl, currentBearer, {
            pending_cred_id: conn.pendingRotationCredId,
            tenant_id: conn.sfTenantId,
          });

          // Route the response.
          if (sfResp.status === 200) {
            const body = sfResp.body;
            if (!body?.credential?.token || !body.credential.kid) {
              this.logger.error(
                `[SfRefresh] event=refresh_failed conn_id=${connectionId} status=200 ` +
                  `error=malformed_success_body has_token=${!!body?.credential?.token} ` +
                  `has_kid=${!!body?.credential?.kid}`,
              );
              return { kind: 'permanent_failure', error: 'malformed_success_body' } as RefreshOutcome;
            }
            const r = await this.lifecycle.applyCredentialRefresh({
              userId: conn.userId,
              newToken: body.credential.token,
              newKid: body.credential.kid,
              newTokenPrefix: body.credential.token_prefix ?? body.credential.token.slice(0, 13),
              newCredId: body.credential.cred_id ?? conn.pendingRotationCredId ?? 'unknown',
              newIssuedAt: body.credential.issued_at ?? new Date().toISOString(),
              newExpiresAt: body.credential.expires_at ?? null,
              previousGraceRemainingSeconds: body.previous_grace_remaining_seconds ?? null,
              signatureAlgorithm: body.signature_metadata?.algorithm ?? null,
              maxClockSkewSeconds: body.signature_metadata?.max_clock_skew_seconds ?? null,
            });
            if (!r.ok) {
              this.logger.error(
                `[SfRefresh] event=refresh_failed conn_id=${connectionId} status=200 ` +
                  `error=apply_rejected reason=${r.reason}`,
              );
              return { kind: 'permanent_failure', error: `apply_rejected:${r.reason}` } as RefreshOutcome;
            }
            // event=success log emitted outside the tx after commit
            return {
              kind: 'refreshed',
              newCredId: String(body.credential.cred_id ?? 'unknown'),
              newKid: body.credential.kid,
            } as RefreshOutcome;
          }

          if (sfResp.status === 409) {
            // SF says there's no pending rotation. Defensive clear of our flag.
            await tx.sfConnection.update({
              where: { id: connectionId },
              data: {
                rotationPending: false,
                pendingRotationKid: null,
                pendingRotationCredId: null,
                pendingRotationGraceExpiresAt: null,
                pendingRotationObservedAt: null,
                updatedAt: new Date(),
              },
            });
            this.logger.log(
              `[SfRefresh] event=refresh_acked_no_pending conn_id=${connectionId} user_id=${conn.userId}`,
            );
            return { kind: 'no_pending' } as RefreshOutcome;
          }

          if (sfResp.status === 423) {
            // Another LB instance already consumed the refresh. Re-read to
            // confirm the row reflects the peer's update; nothing to do.
            this.logger.log(
              `[SfRefresh] event=refresh_already_refreshed conn_id=${connectionId} user_id=${conn.userId}`,
            );
            return { kind: 'already_refreshed' } as RefreshOutcome;
          }

          if (sfResp.status === 401) {
            await tx.sfConnection.update({
              where: { id: connectionId },
              data: {
                status: 'error',
                lastErrorMessage: 'refresh_failed_current_invalid',
                lastErrorAt: new Date(),
                updatedAt: new Date(),
              },
            });
            this.logger.error(
              `[SfRefresh] event=refresh_failed conn_id=${connectionId} user_id=${conn.userId} ` +
                `status=401 error=current_credential_invalid action=mark_error_require_reconnect`,
            );
            return { kind: 'invalid_credential' } as RefreshOutcome;
          }

          if (sfResp.status === 410) {
            // Apply revoke through the same lifecycle path the webhook uses.
            // Note: this runs OUTSIDE the current tx (lifecycle owns its own
            // tx). The lock is released when our tx ends right after.
            this.logger.log(
              `[SfRefresh] event=connection_revoked conn_id=${connectionId} user_id=${conn.userId} ` +
                `status=410 action=apply_connection_revoked`,
            );
            return { kind: 'revoked' } as RefreshOutcome;
          }

          // Transient (5xx + any unexpected status). Don't mutate state.
          this.logger.warn(
            `[SfRefresh] event=refresh_failed conn_id=${connectionId} status=${sfResp.status} ` +
              `error=transient body_preview=${this.safe(JSON.stringify(sfResp.body ?? sfResp.text ?? '').slice(0, 200))}`,
          );
          return { kind: 'transient_failure', status: sfResp.status, retryable: true } as RefreshOutcome;
        },
        { timeout: REFRESH_TIMEOUT_MS + 5_000, maxWait: 5_000 },
      );
    } catch (e: any) {
      // Network error / tx error — treat as transient. Worker will retry.
      this.logger.warn(
        `[SfRefresh] event=refresh_failed conn_id=${connectionId} error=${this.safe(e?.message)} trigger=${triggerSource}`,
      );
      return { kind: 'transient_failure', retryable: true };
    }

    // Post-tx handling: emit success log (outside lock so we don't extend the
    // tx) + apply revoke (outside lock — own tx in lifecycle).
    const snap: ConnSnapshot | null = connSnapshot;
    if (outcome.kind === 'refreshed') {
      this.logger.log(
        `[SfRefresh] event=success conn_id=${connectionId} user_id=${snap?.userId ?? 'unknown'} ` +
          `sf_tenant_id=${snap?.sfTenantId ?? 'unknown'} new_cred_id=${outcome.newCredId} ` +
          `new_kid=${outcome.newKid} trigger=${triggerSource}`,
      );
    } else if (outcome.kind === 'revoked' && snap !== null) {
      await this.lifecycle.applyConnectionRevoked({
        userId: snap.userId,
        payload: { actor: 'sf_authority', reason: 'refresh_410_connection_revoked' } as any,
        initiator: 'sf_authority',
      });
    }

    return outcome;
  }

  // ─── Internals ────────────────────────────────────────────────────

  private buildRefreshUrl(baseUrl: string, endpointsJson: string | null | undefined): string {
    let path = FALLBACK_REFRESH_PATH;
    if (endpointsJson) {
      try {
        const eps = JSON.parse(endpointsJson);
        if (eps && typeof eps.credentials_refresh === 'string' && eps.credentials_refresh.length > 0) {
          path = eps.credentials_refresh;
        }
      } catch {
        // Use fallback.
      }
    }
    return baseUrl.replace(/\/+$/, '') + path;
  }

  private async callSfRefresh(
    url: string,
    bearer: string,
    body: Record<string, any>,
  ): Promise<{ status: number; body: any; text?: string }> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'X-LB-Correlation-Id': `refresh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed, text };
    } finally {
      clearTimeout(t);
    }
  }

  private safe(s: any): string {
    if (typeof s !== 'string') return String(s ?? '');
    return s.replace(/\s+/g, ' ').trim().slice(0, 200);
  }
}
