/**
 * Per-SavedAccount connection health. Persisted as
 * `SavedAccount.followUpSettingsJson.connectionHealth` (no schema migration —
 * lives inside the existing per-account JSON blob).
 *
 * Replaces the scattered surfaces we accumulated for tracking integration
 * state today (Loki spelunking for associate-phone outcomes, separate Yelp
 * `/health` endpoint, ad-hoc UI banners for "Webhook not registered"). One
 * place to read, one shape to render.
 */

export type SignalStatus = 'ok' | 'warn' | 'fail' | 'unknown';

export interface OAuthTokenSignal {
  status: 'ok' | 'expired' | 'revoked' | 'missing' | 'unknown';
  expiresAt?: string; // ISO
  scopes?: string;    // space-separated scope claim returned by /token
  lastRefreshAt?: string; // ISO
  lastErrorAt?: string;   // ISO
  lastErrorMessage?: string;
}

export interface WebhookSignal {
  status: 'registered' | 'not_registered' | 'failed' | 'unknown';
  webhookId?: string;
  lastCheckedAt?: string; // ISO
  lastErrorMessage?: string;
}

export type AssociatePhoneOutcome =
  | 'registered'
  | 'already_present'
  | 'failed'
  | 'skipped';

export interface AssociatePhonesSignal {
  status: SignalStatus;
  lastSyncedAt: string; // ISO
  owner?: AssociatePhoneOutcome;
  lb?: AssociatePhoneOutcome;
  additional?: Array<{
    phone: string;
    name: string;
    status: AssociatePhoneOutcome;
  }>;
  lastErrorMessage?: string;
}

export interface ConnectionHealth {
  lastCheckedAt: string; // ISO — most recent write of any signal
  signals: {
    oauthToken?: OAuthTokenSignal;
    webhook?: WebhookSignal;
    associatePhones?: AssociatePhonesSignal;
  };
}

/**
 * Computes the overall health summary from individual signals.
 * `fail` if any signal is failed/revoked/missing. `warn` if any is degraded
 * (expired token, partial phone sync). `ok` if all known-and-positive.
 * `unknown` if nothing has been written yet.
 */
export function deriveOverall(health: ConnectionHealth | null): SignalStatus {
  if (!health || !health.signals) return 'unknown';
  const { oauthToken, webhook, associatePhones } = health.signals;

  const oauthFail = oauthToken && ['revoked', 'missing'].includes(oauthToken.status);
  const webhookFail = webhook && webhook.status === 'failed';
  const phonesFail = associatePhones && associatePhones.status === 'fail';
  if (oauthFail || webhookFail || phonesFail) return 'fail';

  const oauthWarn = oauthToken && oauthToken.status === 'expired';
  const webhookWarn = webhook && webhook.status === 'not_registered';
  const phonesWarn = associatePhones && associatePhones.status === 'warn';
  if (oauthWarn || webhookWarn || phonesWarn) return 'warn';

  const anyOk =
    (oauthToken && oauthToken.status === 'ok') ||
    (webhook && webhook.status === 'registered') ||
    (associatePhones && associatePhones.status === 'ok');
  return anyOk ? 'ok' : 'unknown';
}
