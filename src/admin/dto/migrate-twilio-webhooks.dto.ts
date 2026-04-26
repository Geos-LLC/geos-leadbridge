import { IsOptional, IsBoolean, IsIn, Matches, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class MigrateTwilioWebhooksDto {
  /**
   * Single-tenant canary. When omitted, the migration runs against every
   * eligible tenant (NotificationSettings rows with savedAccountId +
   * sigcoreTenantId set, and at least one ACTIVE TenantPhoneNumber).
   *
   * Strict UUID v4 validation — typo'd canary calls fail fast at 400 instead
   * of silently 404'ing on Sigcore.
   */
  @IsOptional()
  @Matches(UUID_V4_REGEX, {
    message: 'tenantId must be a UUID v4',
  })
  tenantId?: string;

  /**
   * When true, the endpoint computes target URLs and eligibility but never
   * calls Sigcore. Use this before any live run to confirm the target set.
   */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean = false;

  /**
   * 'v2' (default): write the tenant-scoped Sigcore route to Twilio
   *                 (https://<sigcore-base>/api/webhooks/twilio/sms/lb/<tenantId>).
   * 'v1':           rollback to the legacy multiplexed route
   *                 (https://<sigcore-base>/api/webhooks/twilio/sms).
   */
  @IsOptional()
  @IsIn(['v1', 'v2'])
  targetVersion?: 'v1' | 'v2' = 'v2';

  /**
   * Pause between sequential per-tenant calls in the batch path. Default 500ms
   * gives Sigcore breathing room without making the 12-tenant fleet take long
   * to migrate. Bounded to avoid degenerate values.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60_000)
  delayMs?: number = 500;
}
