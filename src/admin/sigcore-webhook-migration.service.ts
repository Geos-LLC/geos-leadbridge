import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/utils/prisma.service';
import { MigrateTwilioWebhooksDto } from './dto/migrate-twilio-webhooks.dto';

export interface PerTenantResult {
  savedAccountId: string;
  sigcoreTenantId: string | null;
  phoneNumber: string | null;
  targetUrl: string | null;
  /** 'ok' | 'failed' | 'skipped' for live runs. Always 'dry_run' or 'skipped' when dryRun=true. */
  result: 'ok' | 'failed' | 'skipped' | 'dry_run';
  /** HTTP status from Sigcore (live runs only). */
  sigcoreStatus?: number;
  /** First 200 chars of Sigcore's response body (live runs only). */
  sigcoreResponseBodyPreview?: string;
  /** Reason this tenant was skipped (e.g. missing_sigcore_tenant_id, no_active_phone_number). */
  skipReason?: string;
  /** Error message when result === 'failed'. */
  errorMessage?: string;
  /** Wall-clock duration of the Sigcore call in milliseconds (live runs only). */
  durationMs?: number;
  /**
   * Description of the call we would issue (dry-run only). Lets operators
   * verify the target URL + endpoint before flipping dryRun off.
   */
  wouldCall?: string;
}

export interface MigrateTwilioWebhooksResult {
  dryRun: boolean;
  targetVersion: 'v1' | 'v2';
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
    /** Present only on dry-run results. Counts tenants that would have been called. */
    wouldMigrate?: number;
    wouldSkip?: number;
  };
  tenants: PerTenantResult[];
}

@Injectable()
export class SigcoreWebhookMigrationService {
  private readonly logger = new Logger(SigcoreWebhookMigrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Strip a trailing `/api` from the configured Sigcore URL so we can
   * predictably reconstruct paths like `${base}/api/...`. Mirrors
   * admin-phone-pool.service.ts so both callers behave the same way.
   */
  private resolveSigcoreBase(): string {
    const rawUrl =
      this.configService.get<string>('SIGCORE_CALL_CONNECT_URL') ||
      this.configService.get<string>('SIGCORE_API_URL') ||
      'https://sigcore-production.up.railway.app/api';
    return rawUrl.replace(/\/api\/?$/, '');
  }

  /**
   * Build the smsUrl Twilio should POST to for an inbound SMS. v2 is the
   * tenant-scoped route Sigcore added; v1 is the legacy multiplexed route
   * we're migrating away from.
   */
  buildTargetUrl(targetVersion: 'v1' | 'v2', sigcoreTenantId: string): string {
    const base = this.resolveSigcoreBase();
    if (targetVersion === 'v2') {
      return `${base}/api/webhooks/twilio/sms/lb/${sigcoreTenantId}`;
    }
    return `${base}/api/webhooks/twilio/sms`;
  }

  async migrate(dto: MigrateTwilioWebhooksDto): Promise<MigrateTwilioWebhooksResult> {
    const targetVersion = dto.targetVersion ?? 'v2';
    const dryRun = dto.dryRun ?? false;
    const delayMs = dto.delayMs ?? 500;

    const eligible = await this.collectTenants(dto.tenantId);

    if (dryRun) {
      return this.runDryRun(eligible, targetVersion);
    }

    const platformKey = this.configService.get<string>('SIGCORE_API_KEY');
    if (!platformKey) {
      throw new Error('SIGCORE_API_KEY is not configured');
    }

    const sigcoreBase = this.resolveSigcoreBase();
    const tenants: PerTenantResult[] = [];

    for (let i = 0; i < eligible.length; i++) {
      const t = eligible[i];

      if (!t.sigcoreTenantId) {
        tenants.push({
          savedAccountId: t.savedAccountId,
          sigcoreTenantId: null,
          phoneNumber: t.phoneNumber,
          targetUrl: null,
          result: 'skipped',
          skipReason: 'missing_sigcore_tenant_id',
        });
        continue;
      }
      if (!t.phoneNumber) {
        tenants.push({
          savedAccountId: t.savedAccountId,
          sigcoreTenantId: t.sigcoreTenantId,
          phoneNumber: null,
          targetUrl: null,
          result: 'skipped',
          skipReason: 'no_active_phone_number',
        });
        continue;
      }

      const targetUrl = this.buildTargetUrl(targetVersion, t.sigcoreTenantId);
      const endpoint = `${sigcoreBase}/api/tenants/${t.sigcoreTenantId}/phone-numbers/set-webhook-url`;
      const startedAt = Date.now();

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': platformKey,
          },
          body: JSON.stringify({ smsUrl: targetUrl, smsMethod: 'POST' }),
        });
        const durationMs = Date.now() - startedAt;
        const bodyText = await response.text().catch(() => '');
        const bodyPreview = bodyText.length > 200 ? bodyText.substring(0, 200) + '…' : bodyText;

        if (response.ok) {
          this.logger.log(
            `[migrate-twilio-webhooks] ${targetVersion} tenant=${t.sigcoreTenantId} phone=${t.phoneNumber} status=${response.status} durationMs=${durationMs}`,
          );
          tenants.push({
            savedAccountId: t.savedAccountId,
            sigcoreTenantId: t.sigcoreTenantId,
            phoneNumber: t.phoneNumber,
            targetUrl,
            result: 'ok',
            sigcoreStatus: response.status,
            sigcoreResponseBodyPreview: bodyPreview,
            durationMs,
          });
        } else {
          this.logger.warn(
            `[migrate-twilio-webhooks] FAILED tenant=${t.sigcoreTenantId} phone=${t.phoneNumber} status=${response.status} body=${bodyPreview}`,
          );
          tenants.push({
            savedAccountId: t.savedAccountId,
            sigcoreTenantId: t.sigcoreTenantId,
            phoneNumber: t.phoneNumber,
            targetUrl,
            result: 'failed',
            sigcoreStatus: response.status,
            sigcoreResponseBodyPreview: bodyPreview,
            errorMessage: `Sigcore set-webhook-url returned ${response.status}`,
            durationMs,
          });
        }
      } catch (err: any) {
        const durationMs = Date.now() - startedAt;
        this.logger.warn(
          `[migrate-twilio-webhooks] ERROR tenant=${t.sigcoreTenantId} phone=${t.phoneNumber} err=${err.message}`,
        );
        tenants.push({
          savedAccountId: t.savedAccountId,
          sigcoreTenantId: t.sigcoreTenantId,
          phoneNumber: t.phoneNumber,
          targetUrl,
          result: 'failed',
          errorMessage: err.message ?? String(err),
          durationMs,
        });
      }

      // Pause before next tenant. Skip the wait after the last one.
      if (delayMs > 0 && i < eligible.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    const succeeded = tenants.filter((t) => t.result === 'ok').length;
    const failed = tenants.filter((t) => t.result === 'failed').length;
    const skipped = tenants.filter((t) => t.result === 'skipped').length;

    return {
      dryRun: false,
      targetVersion,
      summary: { total: tenants.length, succeeded, failed, skipped },
      tenants,
    };
  }

  /**
   * Resolve the set of tenants the migration should touch. Filters to
   * NotificationSettings rows that are account-scoped, then joins each one
   * to its savedAccount's most recently purchased ACTIVE TenantPhoneNumber.
   * Single-tenant runs filter by sigcoreTenantId.
   */
  private async collectTenants(filterTenantId?: string): Promise<
    Array<{
      savedAccountId: string;
      sigcoreTenantId: string | null;
      phoneNumber: string | null;
    }>
  > {
    const ns = await this.prisma.notificationSettings.findMany({
      where: {
        savedAccountId: { not: null },
        ...(filterTenantId ? { sigcoreTenantId: filterTenantId } : {}),
      },
      select: { savedAccountId: true, sigcoreTenantId: true },
    });

    if (ns.length === 0) return [];

    const savedAccountIds = ns
      .map((row) => row.savedAccountId)
      .filter((id): id is string => !!id);

    const phones = await this.prisma.tenantPhoneNumber.findMany({
      where: { savedAccountId: { in: savedAccountIds }, status: 'ACTIVE' },
      select: { savedAccountId: true, phoneNumber: true, purchasedAt: true },
      orderBy: { purchasedAt: 'desc' },
    });

    // Pick the most recently purchased ACTIVE phone per savedAccount.
    const phoneByAccount = new Map<string, string>();
    for (const p of phones) {
      if (!p.savedAccountId) continue;
      if (!phoneByAccount.has(p.savedAccountId)) {
        phoneByAccount.set(p.savedAccountId, p.phoneNumber);
      }
    }

    return ns.map((row) => ({
      savedAccountId: row.savedAccountId as string,
      sigcoreTenantId: row.sigcoreTenantId,
      phoneNumber: row.savedAccountId
        ? phoneByAccount.get(row.savedAccountId) ?? null
        : null,
    }));
  }

  private runDryRun(
    eligible: Array<{
      savedAccountId: string;
      sigcoreTenantId: string | null;
      phoneNumber: string | null;
    }>,
    targetVersion: 'v1' | 'v2',
  ): MigrateTwilioWebhooksResult {
    const sigcoreBase = this.resolveSigcoreBase();
    const tenants: PerTenantResult[] = eligible.map((t) => {
      if (!t.sigcoreTenantId) {
        return {
          savedAccountId: t.savedAccountId,
          sigcoreTenantId: null,
          phoneNumber: t.phoneNumber,
          targetUrl: null,
          result: 'skipped',
          skipReason: 'missing_sigcore_tenant_id',
        };
      }
      if (!t.phoneNumber) {
        return {
          savedAccountId: t.savedAccountId,
          sigcoreTenantId: t.sigcoreTenantId,
          phoneNumber: null,
          targetUrl: null,
          result: 'skipped',
          skipReason: 'no_active_phone_number',
        };
      }
      const targetUrl = this.buildTargetUrl(targetVersion, t.sigcoreTenantId);
      const endpoint = `${sigcoreBase}/api/tenants/${t.sigcoreTenantId}/phone-numbers/set-webhook-url`;
      return {
        savedAccountId: t.savedAccountId,
        sigcoreTenantId: t.sigcoreTenantId,
        phoneNumber: t.phoneNumber,
        targetUrl,
        result: 'dry_run',
        wouldCall: `POST ${endpoint}`,
      };
    });

    const wouldMigrate = tenants.filter((t) => t.result === 'dry_run').length;
    const wouldSkip = tenants.filter((t) => t.result === 'skipped').length;

    return {
      dryRun: true,
      targetVersion,
      summary: { total: tenants.length, succeeded: 0, failed: 0, skipped: wouldSkip, wouldMigrate, wouldSkip },
      tenants,
    };
  }
}
