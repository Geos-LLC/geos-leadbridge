/**
 * SfProvisioningService — SF→LB server-to-server flow.
 *
 * Implements the two endpoints SF's Communication Hub uses to attach a
 * LeadBridge account WITHOUT a browser OAuth dance:
 *
 *   verifyCredentials(email, password) → { lb_user_id, link_token }
 *   provision(link_token, provisioning) → { connection_id, webhook_secret }
 *
 * Both endpoints are HMAC-authenticated by the controller before calling
 * this service. The service trusts the HMAC layer and focuses on:
 *
 *   - Verifying the LB password (bcrypt) without leaking it to logs
 *   - Issuing single-use link tokens (5-min TTL, JWT-signed)
 *   - Per-email rate limiting (defense vs brute-force)
 *   - Atomically claiming a link_token nonce + invoking the existing
 *     lifecycle writer to persist the sf_connection
 *   - Returning the LB-generated webhook secret one time
 *
 * Plaintext password NEVER logged. Plaintext orchestration token NEVER
 * logged (lifecycle writer handles encryption). The link_token IS logged
 * (it's short-lived + single-use; not a long-term secret).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import { PrismaService } from '../../common/utils/prisma.service';
import { EncryptionUtil } from '../../common/utils/encryption.util';
import { SfConnectionLifecycleService } from './sf-connection-lifecycle.service';
import type {
  SfProvisionRequest,
  SfProvisionResponse,
  SfVerifyCredentialsRequest,
  SfVerifyCredentialsResponse,
} from './sf-provisioning.contracts';
import type { SfProvisioningPayload } from './sf-connection.contracts';

const LINK_TOKEN_TTL_SECONDS = 5 * 60;
const LINK_TOKEN_PURPOSE = 'sf_provisioning_link';
const WEBHOOK_SECRET_BYTES = 32;

interface LinkTokenPayload {
  sub: string;            // lb_user_id (so it fits JwtAuthGuard payload shape too)
  lb_user_id: string;
  purpose: typeof LINK_TOKEN_PURPOSE;
  nonce: string;
  iat: number;
  exp: number;
}

@Injectable()
export class SfProvisioningService {
  private readonly logger = new Logger(SfProvisioningService.name);

  // ─── per-email rate limit, in-memory ──────────────────────────────
  //
  // 5 attempts per minute per email; 50 per hour. Resets sliding window.
  // Multi-instance LB would drift here (per-process counters), but the
  // canary single-tenant case is fine. Production scale can be moved to
  // a distributed limiter later.
  private readonly rateMinute = new Map<string, { count: number; resetAt: number }>();
  private readonly rateHour = new Map<string, { count: number; resetAt: number }>();
  private static readonly RATE_PER_MINUTE = 5;
  private static readonly RATE_PER_HOUR = 50;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly lifecycle: SfConnectionLifecycleService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════
  // verifyCredentials
  // ═══════════════════════════════════════════════════════════════════

  async verifyCredentials(req: SfVerifyCredentialsRequest): Promise<SfVerifyCredentialsResponse> {
    const email = String(req.email ?? '').trim().toLowerCase();
    const password = String(req.password ?? '');

    if (!email || !password) {
      this.logger.warn('[SfProvisioning] event=verify_missing_fields');
      return { ok: false, error: 'missing_fields' };
    }

    // Rate limit BEFORE bcrypt to avoid CPU amplification on brute-force.
    if (!this.checkRate(email)) {
      this.logger.warn(`[SfProvisioning] event=verify_rate_limited email_hash=${this.emailHash(email)}`);
      return { ok: false, error: 'rate_limited' };
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, name: true, password: true },
    });

    // Generic "invalid_credentials" for missing user OR missing password OR
    // bad password — prevents email enumeration. The same 401-shaped
    // response covers both branches.
    if (!user) {
      this.logger.log(`[SfProvisioning] event=verify_user_not_found email_hash=${this.emailHash(email)}`);
      return { ok: false, error: 'invalid_credentials' };
    }
    if (!user.password) {
      this.logger.warn(
        `[SfProvisioning] event=verify_no_password_set user_id=${user.id} email_hash=${this.emailHash(email)}`,
      );
      return { ok: false, error: 'invalid_credentials' };
    }

    const matches = await EncryptionUtil.comparePassword(password, user.password);
    if (!matches) {
      this.logger.log(`[SfProvisioning] event=verify_password_mismatch user_id=${user.id}`);
      return { ok: false, error: 'invalid_credentials' };
    }

    // Mint link_token: 5-min TTL, single-use (nonce enforced on provision).
    const nonce = crypto.randomBytes(16).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    const payload: LinkTokenPayload = {
      sub: user.id,
      lb_user_id: user.id,
      purpose: LINK_TOKEN_PURPOSE,
      nonce,
      iat: now,
      exp: now + LINK_TOKEN_TTL_SECONDS,
    };
    // Don't pass `expiresIn` — the payload already carries `exp`, and
    // jsonwebtoken refuses to be told twice. Our explicit `exp` wins.
    const link_token = this.jwt.sign(payload);

    this.logger.log(
      `[SfProvisioning] event=verify_success user_id=${user.id} nonce=${nonce.slice(0, 8)}… ` +
        `link_token_len=${link_token.length}`,
    );

    return {
      ok: true,
      lb_user_id: user.id,
      lb_user_email: user.email,
      lb_user_display_name: user.name ?? null,
      link_token,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // provision
  // ═══════════════════════════════════════════════════════════════════

  async provision(req: SfProvisionRequest): Promise<SfProvisionResponse> {
    // 1. Decode + verify the link_token. JwtService.verify throws on
    //    bad signature OR expired exp.
    let claims: LinkTokenPayload;
    try {
      claims = this.jwt.verify<LinkTokenPayload>(req.link_token);
    } catch (e: any) {
      const msg = String(e?.name ?? e?.message ?? '');
      this.logger.warn(`[SfProvisioning] event=provision_link_token_invalid err=${this.safe(msg)}`);
      if (msg.toLowerCase().includes('expired')) {
        return { ok: false, error: 'link_token_expired' };
      }
      return { ok: false, error: 'link_token_invalid' };
    }
    if (claims.purpose !== LINK_TOKEN_PURPOSE || !claims.lb_user_id || !claims.nonce) {
      this.logger.warn(`[SfProvisioning] event=provision_link_token_bad_payload`);
      return { ok: false, error: 'link_token_invalid' };
    }

    // 2. Validate the provisioning payload shape. We re-use the canonical
    //    SF S4 contract from PR-C2.1.
    const provisioning = req.provisioning;
    const shapeError = this.validateProvisioningShape(provisioning);
    if (shapeError) {
      this.logger.warn(`[SfProvisioning] event=provision_invalid_payload reason=${shapeError}`);
      return { ok: false, error: 'invalid_provisioning_payload', detail: shapeError };
    }

    // 3. Cross-tenant guard: one SF tenant per LB user. If the LB user
    //    already has an active connection to a DIFFERENT SF tenant,
    //    reject. Re-provisioning the SAME (lb_user, sf_tenant) pair is
    //    allowed and idempotent (lifecycle writer handles the update).
    const existing = await this.prisma.sfConnection.findUnique({
      where: { userId: claims.lb_user_id },
      select: { sfTenantId: true, status: true, isActive: true },
    });
    if (
      existing &&
      existing.isActive &&
      (existing.status === 'active' || existing.status === 'rotating') &&
      existing.sfTenantId !== String(provisioning.tenant.sf_tenant_id)
    ) {
      this.logger.warn(
        `[SfProvisioning] event=provision_lb_user_connected_elsewhere user_id=${claims.lb_user_id} ` +
          `current_sf_tenant=${existing.sfTenantId} new_sf_tenant=${provisioning.tenant.sf_tenant_id}`,
      );
      return {
        ok: false,
        error: 'lb_user_already_connected_elsewhere',
        detail: `current_sf_tenant=${existing.sfTenantId}`,
      };
    }

    // 4. Claim the nonce. Unique-constraint on `nonce` makes this race-safe:
    //    two concurrent provisions with the same link_token, one wins the
    //    insert, the other gets P2002 and we map it to "already_consumed".
    try {
      await this.prisma.sfProvisioningLinkConsumed.create({
        data: {
          nonce: claims.nonce,
          userId: claims.lb_user_id,
          expiresAt: new Date(claims.exp * 1000),
        },
      });
    } catch (e: any) {
      const code = e?.code;
      if (code === 'P2002') {
        this.logger.warn(
          `[SfProvisioning] event=provision_link_token_already_consumed user_id=${claims.lb_user_id} ` +
            `nonce=${claims.nonce.slice(0, 8)}…`,
        );
        return { ok: false, error: 'link_token_already_consumed' };
      }
      this.logger.error(`[SfProvisioning] event=provision_nonce_claim_failed err=${this.safe(e?.message)}`);
      return { ok: false, error: 'config_error', detail: 'nonce_claim_failed' };
    }

    // 5. Generate the webhook signing secret + URL. Webhook URL is
    //    fixed for prod LB; LB generates the secret (canonical pattern
    //    — secrets never travel webhook channel).
    const webhookSecretPlaintext = crypto.randomBytes(WEBHOOK_SECRET_BYTES).toString('base64');
    const webhookUrl = this.buildWebhookUrl();
    const subscriptionId = `lb_sub_sfp_${claims.nonce.slice(0, 12)}_${Date.now()}`;

    // 6. Synthesize the SfProvisioningPayload that lifecycle expects.
    //    The SF-initiated path doesn't carry version/webhook blocks from
    //    SF — LB owns those (webhook URL + secret are LB-generated). We
    //    fill them in with the values we just minted so the existing
    //    writer can persist + log them uniformly.
    const nowIso = new Date().toISOString();
    const fullProvisioning: SfProvisioningPayload = {
      version: '1',
      tenant: provisioning.tenant as any,
      endpoints: provisioning.endpoints as any,
      credential: provisioning.credential as any,
      event_types: provisioning.event_types as any,
      signature_metadata: {
        algorithm: provisioning.signature_metadata.algorithm,
        max_clock_skew_seconds: provisioning.signature_metadata.max_clock_skew_seconds,
        headers: {
          signature:  'X-SF-Signature',
          timestamp:  'X-SF-Timestamp',
          event_id:   'X-SF-Event-Id',
          event_type: 'X-SF-Event-Type',
          tenant_id:  'X-SF-Tenant-Id',
          kid:        'X-SF-Kid',
        },
      },
      webhook: {
        url: webhookUrl,
        set_at: nowIso,
        secret_set: true,
        subscription_id: subscriptionId,
        state_ref: `sf_initiated_${claims.lb_user_id.slice(0, 8)}`,
      },
    };

    // Hand the persistence to the existing lifecycle writer. The
    // server-to-server flow is closer in spirit to oauth_exchange (LB
    // receives the credential atomically) so `source: 'oauth_exchange'`
    // tags the resulting tokenLastRotationSource='handshake' the same
    // way an OAuth callback would.
    const lifecycleInput = {
      userId: claims.lb_user_id,
      connectionId: crypto.randomUUID(),
      provisioning: fullProvisioning,
      webhookSecretPlaintext,
      webhookUrl,
      webhookSubscriptionId: subscriptionId,
      webhookStateRef: fullProvisioning.webhook.state_ref!,
      source: 'oauth_exchange' as const,
    };

    const r = await this.lifecycle.applyConnectionConnected(lifecycleInput);
    if (!r.ok) {
      this.logger.error(
        `[SfProvisioning] event=provision_lifecycle_rejected user_id=${claims.lb_user_id} ` +
          `reason=${r.reason ?? 'unknown'}`,
      );
      return { ok: false, error: 'lifecycle_rejected', detail: r.reason ?? undefined };
    }

    this.logger.log(
      `[SfProvisioning] event=provision_success user_id=${claims.lb_user_id} ` +
        `sf_tenant_id=${provisioning.tenant.sf_tenant_id} connection_id=${r.connectionId} ` +
        `webhook_secret_len=${webhookSecretPlaintext.length} kid=${provisioning.credential.kid} ` +
        `cred_id=${provisioning.credential.cred_id} noop=${r.noop ?? false}`,
    );

    return {
      ok: true,
      connection_id: r.connectionId!,
      sf_tenant_id: Number(provisioning.tenant.sf_tenant_id),
      lb_user_id: claims.lb_user_id,
      webhook: { url: webhookUrl, secret: webhookSecretPlaintext },
    };
  }

  // ─── helpers ──────────────────────────────────────────────────────

  /**
   * Sliding-window per-email rate limiter. In-memory; resets per process.
   * Sufficient for the canary; production scale would move to a distributed
   * limiter (Redis / database row counter).
   */
  private checkRate(email: string): boolean {
    const now = Date.now();
    const m = this.rateMinute.get(email);
    const h = this.rateHour.get(email);
    if (m && m.resetAt > now) {
      if (m.count >= SfProvisioningService.RATE_PER_MINUTE) return false;
      m.count++;
    } else {
      this.rateMinute.set(email, { count: 1, resetAt: now + 60_000 });
    }
    if (h && h.resetAt > now) {
      if (h.count >= SfProvisioningService.RATE_PER_HOUR) return false;
      h.count++;
    } else {
      this.rateHour.set(email, { count: 1, resetAt: now + 3_600_000 });
    }
    return true;
  }

  /** sha256 fingerprint of email for non-PII logging. */
  private emailHash(email: string): string {
    return crypto.createHash('sha256').update(email).digest('hex').slice(0, 12);
  }

  /**
   * Validate the inbound provisioning payload matches the canonical SF S4
   * shape. Mirrors the OAuth-exchange validator (lib expects the same
   * nested envelope).
   */
  private validateProvisioningShape(p: any): string | null {
    if (!p || typeof p !== 'object') return 'no_provisioning';
    if (!p.tenant || typeof p.tenant !== 'object') return 'no_tenant';
    if (typeof p.tenant.sf_tenant_id !== 'number') return 'bad_sf_tenant_id';
    if (typeof p.tenant.sf_base_url !== 'string' || !p.tenant.sf_base_url.startsWith('http')) {
      return 'bad_sf_base_url';
    }
    if (!p.credential || typeof p.credential !== 'object') return 'no_credential';
    if (typeof p.credential.token !== 'string' || p.credential.token.length === 0) return 'no_token';
    if (typeof p.credential.kid !== 'string') return 'no_kid';
    if (typeof p.credential.issued_at !== 'string') return 'no_issued_at';
    if (!p.endpoints || typeof p.endpoints !== 'object') return 'no_endpoints';
    if (typeof p.endpoints.availability !== 'string') return 'no_availability_endpoint';
    if (!p.signature_metadata || typeof p.signature_metadata !== 'object') return 'no_signature_metadata';
    if (p.signature_metadata.algorithm !== 'hmac-sha256-hex') return 'unsupported_algorithm';
    if (typeof p.signature_metadata.max_clock_skew_seconds !== 'number') return 'bad_skew_seconds';
    if (!Array.isArray(p.event_types)) return 'no_event_types';
    return null;
  }

  /**
   * Build the LB orchestration-webhook URL. Per-environment via env var
   * fallback chain: explicit env > derived from request host > hardcoded
   * prod URL (last resort).
   */
  private buildWebhookUrl(): string {
    const fromEnv = this.config.get<string>('SF_ORCHESTRATION_WEBHOOK_URL', '') ?? '';
    if (fromEnv) return fromEnv;
    // Hardcoded fallback uses the canonical prod LB host. Staging callers
    // should set SF_ORCHESTRATION_WEBHOOK_URL on staging Railway.
    return 'https://thumbtack-bridge-production.up.railway.app/api/v1/integrations/sf/orchestration-webhook';
  }

  private safe(s: any): string {
    if (typeof s !== 'string') return String(s ?? '');
    return s.replace(/\s+/g, ' ').trim().slice(0, 200);
  }
}
