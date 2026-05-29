/**
 * SF Provisioning contracts — SF→LB server-to-server flow (2026-05-29).
 *
 * The SF Communication Hub email/password flow uses these endpoints
 * instead of a browser OAuth redirect:
 *
 *   1. SF POST /v1/integrations/sf/verify-credentials
 *        → LB validates email/password
 *        → LB returns link_token (5-min TTL, single-use, signed JWT)
 *
 *   2. SF POST /v1/integrations/sf/provision
 *        → SF presents link_token + the full provisioning payload
 *          (SF-minted credential, endpoints, signature metadata, events)
 *        → LB validates the link_token, claims the nonce (race-safe),
 *          calls the existing lifecycle writer
 *        → LB returns the sf_connection id + LB-generated webhook secret
 *          (one-time response; SF stores it on their side)
 *
 * Both endpoints are HMAC-signed using SF_LB_PROVISIONING_SHARED_SECRET
 * (separate from the per-connection webhook signing secret).
 */

// ─── verify-credentials ──────────────────────────────────────────────

export interface SfVerifyCredentialsRequest {
  email: string;
  password: string;
}

export type SfVerifyCredentialsResponse =
  | {
      ok: true;
      lb_user_id: string;
      lb_user_email: string;
      lb_user_display_name: string | null;
      /**
       * Short-lived JWT, 5-min TTL, single-use. Payload:
       *   { lb_user_id, purpose: 'sf_provisioning_link', nonce, iat, exp }
       * Signed with LB's JWT_SECRET.
       */
      link_token: string;
    }
  | {
      ok: false;
      error:
        | 'invalid_credentials'
        | 'rate_limited'
        | 'missing_fields'
        | 'no_password_set'
        | 'config_error';
    };

// ─── provision ──────────────────────────────────────────────────────

/** SF-issued credential block — same shape as the OAuth-exchange variant. */
export interface SfProvisioningCredential {
  token: string;
  token_prefix: string;
  kid: string;
  scope: string;
  issued_at: string;
  expires_at: string | null;
  cred_id: number | string;
}

/** Five named SF endpoint paths the orchestration client calls. */
export interface SfProvisioningEndpoints {
  availability: string;
  booking_request: string;
  booking_cancel: string;
  handoff: string;
  disconnect: string;
  credentials_refresh?: string;
}

export interface SfProvisioningSignatureMetadata {
  algorithm: 'hmac-sha256-hex';
  max_clock_skew_seconds: number;
  /** Optional — SF may pin the kid here for sanity-check. */
  kid?: string;
}

export interface SfProvisioningTenantBlock {
  sf_tenant_id: number;
  sf_workspace_id: number | string;
  sf_base_url: string;
  source_instance: string;
  api_region: string | null;
  sf_tenant_name: string | null;
}

export interface SfProvisionRequest {
  link_token: string;
  provisioning: {
    tenant: SfProvisioningTenantBlock;
    credential: SfProvisioningCredential;
    endpoints: SfProvisioningEndpoints;
    signature_metadata: SfProvisioningSignatureMetadata;
    event_types: string[];
  };
}

export type SfProvisionResponse =
  | {
      ok: true;
      connection_id: string;
      sf_tenant_id: number;
      lb_user_id: string;
      webhook: {
        url: string;
        /**
         * LB-generated, 32-byte base64 webhook signing secret. One-time
         * response — SF stores this and uses it to sign future inbound
         * webhooks. LB does not return it on any subsequent call.
         */
        secret: string;
      };
    }
  | {
      ok: false;
      error:
        | 'link_token_invalid'
        | 'link_token_expired'
        | 'link_token_already_consumed'
        | 'lb_user_already_connected_elsewhere'
        | 'invalid_provisioning_payload'
        | 'config_error'
        | 'lifecycle_rejected';
      detail?: string;
    };
