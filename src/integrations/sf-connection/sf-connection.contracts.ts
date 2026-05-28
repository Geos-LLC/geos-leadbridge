/**
 * SF Connection contracts — Phase 2C PR-C2.
 *
 * Typed shapes for the S4 provisioning payload SF returns at exchange
 * time, and for the three connection-lifecycle webhook events SF pushes
 * to LB:
 *
 *   1. connection.connected   — initial provisioning (also delivered
 *                               during the OAuth exchange response)
 *   2. credential.rotated     — SF rotated the token; new token + 5-min grace
 *   3. connection.revoked     — SF authority revoked the connection
 *
 * All inbound webhook payloads share a top-level envelope:
 *   { event_id, event_type, occurred_at, sf_tenant_id, payload }
 *
 * Headers (every inbound):
 *   X-SF-Event-Id      — dedup key (== payload.event_id; double-checked)
 *   X-SF-Signature     — HMAC-SHA256(timestamp.rawBody) using
 *                        CrmWebhookSubscription.secret (issued at
 *                        exchange time, stored encrypted-at-rest by
 *                        LB and shared with SF only once)
 *   X-SF-Timestamp     — unix seconds; ±300s skew window
 *   X-SF-Subscription-Id — bridges to LB's CrmWebhookSubscription row
 *   X-SF-Signature-Kid — (optional) SF signing key id; if present we
 *                        match against sf_connections.signatureKeyId
 */

// ─── OAuth exchange response (SF → LB at /sf/callback exchange) ─────

/**
 * Full S4 provisioning payload SF returns from the token-exchange call.
 * LB persists every non-secret field directly onto SfConnection; the
 * token and webhook secret are encrypted before storage.
 */
export interface SfProvisioningPayload {
  // SF tenant identity (authoritative)
  sf_tenant_id: string;
  sf_tenant_name?: string | null;
  sf_base_url: string;
  source_instance?: string | null;
  api_region?: string | null;

  // Orchestration credentials (LB-stored encrypted)
  orchestration_token: string;          // bearer; begins with "sfo_v1..."
  orchestration_token_kid?: string | null;
  orchestration_token_scope?: string | null;
  token_issued_at: string;              // ISO-8601
  token_expires_at?: string | null;     // ISO-8601 (null = non-expiring)

  // Inbound webhook (SF → LB) plumbing
  webhook_subscription_id: string;       // SF-issued; matches X-SF-Subscription-Id
  webhook_signing_secret: string;        // LB stores encrypted; SF holds the only other copy
  webhook_signature_key_id?: string | null;
  webhook_events: string[];              // e.g. ["connection.connected", "credential.rotated", ...]
}

// ─── OAuth start (LB → SF redirect) ─────────────────────────────────

export interface OAuthStartResult {
  /** Where LB redirects the user. */
  redirectUrl: string;
  /** The pending SfConnection row id, surfaced for support diagnostics. */
  pendingConnectionId: string;
  /** State token (single-use, 15-min TTL) — also embedded in redirectUrl. */
  state: string;
}

// ─── OAuth callback (SF → LB redirect query params) ────────────────

export interface OAuthCallbackQuery {
  /** Authorization code SF returns; LB exchanges this at the SF token endpoint. */
  code?: string;
  /** Echoed state token from the start redirect. */
  state?: string;
  /** OAuth error code SF returns when user denies / something fails. */
  error?: string;
  error_description?: string;
}

// ─── Inbound connection-lifecycle webhook events ───────────────────

export type SfConnectionEventType =
  | 'connection.connected'
  | 'credential.rotated'
  | 'connection.revoked';

export interface SfConnectionWebhookEnvelope<TPayload> {
  event_id: string;            // unique per event; SF generates
  event_type: SfConnectionEventType;
  occurred_at: string;          // ISO-8601
  sf_tenant_id: string;
  payload: TPayload;
}

export interface SfConnectionConnectedPayload {
  /** Same shape as the OAuth exchange response — SF re-delivers as
   *  the canonical "connection is active" event so LB doesn't need
   *  to maintain dual sources of truth. */
  provisioning: SfProvisioningPayload;
}

export interface SfCredentialRotatedPayload {
  new_orchestration_token: string;
  new_orchestration_token_kid?: string | null;
  new_token_issued_at: string;
  new_token_expires_at?: string | null;
  // SF guarantees a 5-min grace window during which the previous token
  // remains valid on SF side. LB stores it as previousOrchestrationToken.
  grace_period_seconds: number;
}

export interface SfConnectionRevokedPayload {
  /** SF-declared reason: 'tenant_disconnect' | 'admin_revoke' | 'security_event' | other. */
  reason?: string;
  /** Optional free-form context for the LB audit log. */
  detail?: string | null;
}

// ─── Disconnect (LB → SF) ──────────────────────────────────────────

export interface SfDisconnectRequest {
  initiator: 'lb_user' | 'lb_admin';
  reason?: string;
}

export interface SfDisconnectResponse {
  success: boolean;
  /** Whether SF acknowledged the revoke (best-effort; LB still completes locally). */
  remote_revoked: boolean;
  /** Local status after the operation. */
  status: 'disconnected' | 'revoked';
}

// ─── Webhook ingest outcome (controller → caller) ──────────────────

export interface ConnectionWebhookOutcome {
  httpStatus: number;
  result:
    | 'accepted'
    | 'duplicate'
    | 'unauthorized'
    | 'validation_failed'
    | 'replay_rejected'
    | 'tenant_not_found'
    | 'noop'
    | 'exception';
  eventId: string;
  sfTenantId?: string | null;
  error?: string;
}

export const SF_CONNECTION_EVENT_TYPES: readonly SfConnectionEventType[] = [
  'connection.connected',
  'credential.rotated',
  'connection.revoked',
] as const;
