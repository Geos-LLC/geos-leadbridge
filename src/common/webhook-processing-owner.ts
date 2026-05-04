import { Logger } from '@nestjs/common';

/**
 * Returns true when this LeadBridge instance is the designated owner of inbound
 * webhook processing. Staging and production share the same external webhook
 * subscriptions (Yelp, Thumbtack, Sigcore) — without this gate both instances
 * race for the advisory lock and the loser silently drops the event after
 * partial work. Only the owner should mutate state in response to inbound
 * webhooks; non-owners must ACK with 200 OK and skip *before* acquiring the
 * lock or writing to the DB.
 *
 * Production: WEBHOOK_PROCESSING_OWNER=true
 * Staging:    WEBHOOK_PROCESSING_OWNER=false (or unset)
 */
export function isWebhookProcessingOwner(): boolean {
  return process.env.WEBHOOK_PROCESSING_OWNER === 'true';
}

/** Standard skip response — 200 OK so platforms don't retry. */
export const NOT_OWNER_SKIP_RESPONSE = { received: true, skipped: true } as const;

/** Single log prefix so a single Loki query catches every skipped inbound webhook. */
export function logSkippedWebhook(
  logger: Logger,
  source: string,
  context: Record<string, unknown> = {},
): void {
  logger.warn(`[webhook-owner] not owner — skipping ${source} ${JSON.stringify(context)}`);
}
