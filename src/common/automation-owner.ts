import { Logger } from '@nestjs/common';

/**
 * Returns true when this LeadBridge instance is the designated owner of the
 * automation send path: outbound AI/template replies queued via
 * PendingAutomatedMessage, and the on-boot timer rehydration that follows
 * those rows from previous runs.
 *
 * Why this exists alongside WEBHOOK_PROCESSING_OWNER: the webhook guard
 * already keeps staging from *creating* new PendingAutomatedMessage rows,
 * but staging shares the production database. When staging restarts (any
 * deploy), restorePendingMessages() reads back the rows production created
 * and schedules its own setTimeout for each. Both timers then fire around
 * the same wall-clock instant — the customer gets the message twice.
 *
 * Production: AUTOMATION_OWNER=true  (owns the send path)
 * Staging:    AUTOMATION_OWNER=false (defaults to false when unset)
 *
 * Distinct from WEBHOOK_PROCESSING_OWNER because the staging-side mobile
 * preview deliberately makes API calls (e.g. the Generate button POSTs to
 * /v1/ai/preview-with-context, which is read-only and unaffected). We
 * never want staging to *send* on behalf of a tenant, regardless of how
 * the row got there.
 */
export function isAutomationOwner(): boolean {
  return process.env.AUTOMATION_OWNER === 'true';
}

export function logSkippedAutomation(
  logger: Logger,
  source: string,
  context: Record<string, unknown> = {},
): void {
  logger.warn(`[automation-owner] not owner — skipping ${source} ${JSON.stringify(context)}`);
}
