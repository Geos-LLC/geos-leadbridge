import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { MigrateTwilioWebhooksDto } from './dto/migrate-twilio-webhooks.dto';
import { SigcoreWebhookMigrationService } from './sigcore-webhook-migration.service';

@Controller('v1/admin/sigcore')
@UseGuards(JwtAuthGuard, AdminGuard)
export class SigcoreWebhookMigrationController {
  constructor(
    private readonly migrationService: SigcoreWebhookMigrationService,
  ) {}

  /**
   * Migrate Twilio webhooks for ACTIVE TenantPhoneNumbers from the legacy
   * multiplexed Sigcore route (`/api/webhooks/twilio/sms`) to the
   * tenant-scoped route (`/api/webhooks/twilio/sms/lb/<tenantId>`).
   *
   * Issues one POST per tenant to Sigcore's `set-webhook-url` endpoint using
   * the platform-scoped `SIGCORE_API_KEY`. Continues on per-tenant failure;
   * the response always returns 200 with a per-tenant report so partial
   * success isn't masked by a 5xx.
   *
   * Use `dryRun: true` to confirm targets before any Sigcore call. Use
   * `targetVersion: "v1"` to roll back.
   */
  @Post('migrate-twilio-webhooks')
  async migrateTwilioWebhooks(@Body() dto: MigrateTwilioWebhooksDto) {
    const result = await this.migrationService.migrate(dto);
    return { success: true, data: result };
  }
}
