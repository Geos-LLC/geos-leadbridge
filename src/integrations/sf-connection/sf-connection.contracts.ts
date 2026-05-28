/**
 * SF Connection contracts — Phase 2C PR-C2.1 — canonical SF S4 alignment.
 *
 * Wire shapes for the SF ↔ LB orchestration provisioning loop.
 *
 * Key contract properties (canonical, per SF spec):
 *
 *   - The exchange POST request body is LB-authored: LB generates the
 *     webhook secret + subscription_id and sends them to SF. SF stores
 *     them server-side and responds with `secret_set: true` (does NOT
 *     echo the secret back).
 *
 *   - The exchange response payload is the canonical "what SF agreed
 *     to" record. LB persists every non-secret field; the orchestration
 *     token is encrypted before storage; the LB-generated webhook secret
 *     is encrypted before storage on the LB side too.
 *
 *   - All 7 webhook event types (service_*, connection.*, credential.*)
 *     are delivered to ONE webhook URL — the one LB included in the
 *     exchange request body. LB routes internally by event_type.
 *
 *   - Webhook HMAC is computed over `${X-SF-Timestamp}.${rawBody}` using
 *     the LB-generated shared secret. Header set (locked by SF):
 *       X-SF-Signature   — sha256 HMAC hex
 *       X-SF-Timestamp   — unix seconds, ±300s window
 *       X-SF-Event-Id    — dedup key (authoritative over body event_id)
 *       X-SF-Event-Type  — convenience copy of body event_type
 *       X-SF-Tenant-Id   — sf_tenant_id of the tenant the event is for
 *       X-SF-Kid         — SF signing key id (cross-check vs stored)
 */

// ─── Tenant block (nested inside provisioning) ──────────────────────

export interface SfProvisioningTenant {
  /** Authoritative SF tenant id — INTEGER on the wire. LB stores as string. */
  sf_tenant_id: number;
  sf_tenant_name: string | null;
  /** Distinct from tenant id; SF's workspace concept. */
  sf_workspace_id: number;
  sf_base_url: string;
  /** SF deployment instance, e.g. "sf-staging". */
  source_instance: string;
  /** SF region label, e.g. "us-east-1". Nullable. */
  api_region: string | null;
}

// ─── Endpoints map (paths relative to sf_base_url) ──────────────────

export interface SfProvisioningEndpoints {
  availability: string;
  booking_request: string;
  booking_cancel: string;
  handoff: string;
  disconnect: string;
}

// ─── Credential block (nested) ──────────────────────────────────────

export interface SfProvisioningCredential {
  /** Opaque bearer token, ~262 chars, starts with "sfo_v1.". Treat as
   *  opaque — never log past `token_prefix`. */
  token: string;
  /** 13-char safe-to-log prefix, e.g. "sfo_v1.eyJ2Ij". */
  token_prefix: string;
  kid: string;
  /** SF locks to literal 'lb_orchestration'. */
  scope: 'lb_orchestration' | string;
  issued_at: string;   // ISO-8601
  expires_at: string;  // ISO-8601
}

// ─── Signature metadata (locked, validated at handshake) ────────────

export interface SfSignatureMetadata {
  algorithm: 'hmac-sha256-hex' | string;
  body_canonical_form?: string;
  headers: {
    signature: string;   // 'X-SF-Signature'
    timestamp: string;   // 'X-SF-Timestamp'
    event_id: string;    // 'X-SF-Event-Id'
    event_type: string;  // 'X-SF-Event-Type'
    tenant_id: string;   // 'X-SF-Tenant-Id'
    kid: string;         // 'X-SF-Kid'
  };
  max_clock_skew_seconds: 300 | number;
}

// ─── Webhook block (SF-echoed; secret NEVER echoed) ─────────────────

export interface SfProvisioningWebhook {
  /** The URL LB sent — SF echoes it verbatim. */
  url: string;
  /** ISO-8601 — when SF stored the webhook on its side. */
  set_at: string;
  /** Acknowledgment that SF stored a secret. Literal `true` only. */
  secret_set: true;
  /** LB-generated correlation id; SF echoes. */
  subscription_id: string | null;
  /** LB-generated state ref; SF echoes. */
  state_ref: string | null;
}

// ─── Top-level provisioning + wrapper ──────────────────────────────

export interface SfProvisioningPayload {
  /** Locked to literal '1'. */
  version: '1' | string;
  tenant: SfProvisioningTenant;
  endpoints: SfProvisioningEndpoints;
  credential: SfProvisioningCredential;
  /** All 7 event types in one list. */
  event_types: string[];
  signature_metadata: SfSignatureMetadata;
  webhook: SfProvisioningWebhook;
}

/** The full response body SF returns from POST /oauth/exchange. */
export interface SfExchangeResponse {
  connected: true;
  provisioning: SfProvisioningPayload;
}

/** Body LB sends to SF in the exchange POST. The webhook block is
 *  LB-authored — SF stores the secret server-side and echoes back
 *  only `secret_set: true`. */
export interface SfExchangeRequest {
  client_id: string;
  client_secret: string;
  code: string;
  redirect_uri: string;
  webhook: {
    url: string;
    /** Base64-encoded ≥32 random bytes. LB generates fresh per handshake. */
    secret: string;
    subscription_id?: string;
    state_ref?: string;
  };
}

/** SF's documented error responses to /oauth/exchange — LB switch-routes
 *  by `error` string. Captured here so the parser is locked. */
export type SfExchangeErrorBody =
  | { error: 'invalid_request'; error_description?: string }
  | { error: 'invalid_client'; error_description?: string }
  | { error: 'invalid_webhook'; error_description?: string }
  | { error: 'webhook_url_not_https'; error_description?: string }
  | { error: 'webhook_url_unparseable'; error_description?: string }
  | { error: 'webhook_host_not_allowed'; error_description?: string }
  | { error: 'webhook_secret_too_short'; error_description?: string }
  | { error: 'webhook_secret_too_long'; error_description?: string }
  | { error: 'webhook_secret_missing'; error_description?: string }
  | { error: 'webhook_secret_unparseable'; error_description?: string }
  | { error: 'redirect_uri_mismatch'; error_description?: string }
  | { error: 'invalid_client_for_code'; error_description?: string }
  | { error: 'code_expired'; error_description?: string }
  | { error: 'invalid_code'; error_description?: string }
  | { error: 'communication_settings_not_found'; error_description?: string }
  // 409 — code replay; LB should re-look-up by prior_credential_id
  | { error: 'code_already_used'; prior_credential_id: number | null }
  // 409 — tenant already has active credential
  | { error: 'already_connected'; error_description?: string }
  | { error: 'service_unavailable'; error_description?: string }
  | { error: 'signing_key_not_configured'; error_description?: string };

// ─── OAuth flow types (LB-authored) ─────────────────────────────────

export interface OAuthStartResult {
  redirectUrl: string;
  pendingConnectionId: string;
  state: string;
}

export interface OAuthCallbackQuery {
  code?: string;
  state?: string;
  /** SF echoes these in the redirect. Tolerated but informational. */
  sf_tenant_id?: string;
  sf_tenant_name?: string;
  sf_base_url?: string;
  error?: string;
  error_description?: string;
}

// ─── Webhook event envelopes (all 7 types) ─────────────────────────

export type SfWebhookEventType =
  // Service lifecycle (was PR-B2 / orchestration-event)
  | 'service_scheduled'
  | 'service_rescheduled'
  | 'service_cancelled'
  | 'service_completed'
  // Connection lifecycle
  | 'connection.connected'
  | 'credential.rotated'
  | 'connection.revoked';

export const SF_WEBHOOK_EVENT_TYPES: readonly SfWebhookEventType[] = [
  'service_scheduled',
  'service_rescheduled',
  'service_cancelled',
  'service_completed',
  'connection.connected',
  'credential.rotated',
  'connection.revoked',
] as const;

export interface SfWebhookEnvelope<TPayload> {
  event_id: string;
  event_type: SfWebhookEventType;
  occurred_at: string;
  /** Always present — matches X-SF-Tenant-Id header. */
  sf_tenant_id: number;
  payload: TPayload;
}

// Payloads per event_type
export interface SfConnectionConnectedPayload {
  provisioning: SfProvisioningPayload;
}

export interface SfCredentialRotatedPayload {
  new_credential: {
    token: string;
    token_prefix: string;
    kid: string;
    issued_at: string;
    expires_at: string;
  };
  /** SF guarantees the previous token is accepted for this many seconds. */
  grace_period_seconds: number;
}

export interface SfConnectionRevokedPayload {
  reason?: string;
  detail?: string | null;
}

/** Service-event payloads — shape from PR-B2's SfInboundEventService,
 *  re-used here under the consolidated webhook endpoint. */
export interface SfServiceEventPayload {
  sf_job_id: string;
  channel?: string;
  external_request_id?: string;
  scheduled_for?: string;
  rescheduled_slot?: {
    slotId: string;
    slotToken?: string;
    start: string;
    end: string;
    cleanerId?: string;
  };
  reason?: string;
}

// ─── Disconnect ─────────────────────────────────────────────────────

export interface SfDisconnectRequest {
  initiator: 'lb_user' | 'lb_admin';
  reason?: string;
}

export interface SfDisconnectResponse {
  success: boolean;
  remote_revoked: boolean;
  status: 'disconnected' | 'revoked';
}

// ─── Webhook ingest outcome ─────────────────────────────────────────

export interface OrchestrationWebhookOutcome {
  httpStatus: number;
  result:
    | 'accepted'
    | 'idempotent_replay'
    | 'unauthorized'
    | 'validation_failed'
    | 'replay_rejected'
    | 'tenant_not_found'
    | 'noop'
    | 'exception';
  eventId: string;
  eventType?: string;
  sfTenantId?: number | null;
  error?: string;
}
