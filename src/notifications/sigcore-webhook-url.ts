import { ConfigService } from '@nestjs/config';

/**
 * Resolves the public base URL Sigcore should call when sending us webhook
 * events (delivery status, inbound SMS, call-connect, etc.).
 *
 * Why this exists: the codebase historically read `APP_BASE_URL` for both the
 * frontend (Vercel) and the backend (Railway). When `APP_BASE_URL` pointed at
 * the Vercel frontend, manually-registered Sigcore subscriptions silently
 * failed with HTTP 405 because Vercel's SPA rewrite turns `/api/*` into the
 * SPA shell, not an API handler. Webhooks are a backend concern — they must
 * resolve to the Railway API host, never the frontend.
 *
 * Resolution order:
 *   1. BACKEND_PUBLIC_URL — preferred, explicit
 *   2. APP_BASE_URL       — only if it isn't a known frontend host
 *   3. RAILWAY_PUBLIC_DOMAIN — Railway sets this on every service; we add https://
 *
 * If none of the above resolves to a usable backend URL, throws.
 */

const FRONTEND_HOST_BLOCKLIST = [
  'leadbridge360.com',
  'www.leadbridge360.com',
];

export class SigcoreWebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigcoreWebhookUrlError';
  }
}

export function isFrontendHost(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).host.toLowerCase();
    return FRONTEND_HOST_BLOCKLIST.includes(host);
  } catch {
    return false;
  }
}

/**
 * Returns the base URL (no trailing slash) that Sigcore webhooks should be
 * registered against. Throws SigcoreWebhookUrlError if the resolved URL would
 * be a frontend host.
 */
export function resolveSigcoreCallbackBaseUrl(config: ConfigService): string {
  const candidates: { source: string; value: string | null | undefined }[] = [
    { source: 'BACKEND_PUBLIC_URL', value: config.get<string>('BACKEND_PUBLIC_URL') },
    { source: 'APP_BASE_URL', value: config.get<string>('APP_BASE_URL') },
  ];

  // Railway always exposes the service's own public hostname here.
  const railwayDomain = config.get<string>('RAILWAY_PUBLIC_DOMAIN');
  if (railwayDomain) {
    candidates.push({ source: 'RAILWAY_PUBLIC_DOMAIN', value: `https://${railwayDomain}` });
  }

  for (const candidate of candidates) {
    if (!candidate.value) continue;
    const trimmed = candidate.value.trim().replace(/\/$/, '');
    if (!trimmed) continue;
    if (isFrontendHost(trimmed)) {
      // Skip frontend hosts and continue down the chain. The throw below will
      // fire only if every candidate is invalid.
      continue;
    }
    return trimmed;
  }

  throw new SigcoreWebhookUrlError(
    'No valid backend public URL configured for Sigcore webhooks. ' +
      'Set BACKEND_PUBLIC_URL (preferred) or APP_BASE_URL to the Railway API host. ' +
      `Frontend hosts (${FRONTEND_HOST_BLOCKLIST.join(', ')}) are rejected because they ` +
      'serve the SPA shell at /api/* and cannot receive webhook callbacks.',
  );
}

/**
 * Build the full delivery-status webhook URL.
 */
export function buildDeliveryStatusWebhookUrl(config: ConfigService): string {
  return `${resolveSigcoreCallbackBaseUrl(config)}/api/webhooks/sigcore/delivery-status`;
}

/**
 * Build the full inbound-SMS webhook URL for a saved account.
 */
export function buildInboundSmsWebhookUrl(config: ConfigService, savedAccountId: string): string {
  return `${resolveSigcoreCallbackBaseUrl(config)}/api/webhooks/sigcore/inbound-sms?accountId=${savedAccountId}`;
}

/**
 * Build the full call-connect webhook URL for a saved account.
 */
export function buildCallConnectWebhookUrl(config: ConfigService, savedAccountId: string): string {
  return `${resolveSigcoreCallbackBaseUrl(config)}/api/webhooks/sigcore/call-connect?accountId=${savedAccountId}`;
}
