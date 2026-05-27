/**
 * Booking orchestration feature flag.
 *
 * Phase 2B PR-B1: env CSV `BOOKING_ORCHESTRATION_ENABLED_USER_IDS` was
 *   the only gate. No global escape hatch — empty CSV meant nobody.
 * Phase 2C PR-C1: gate logic moved to SfConnectionResolver. Per-tenant
 *   `SfConnection` rows take priority; env CSV becomes the canary fallback.
 *
 * Public surface:
 *   - isEnabledForUser(userId): Promise<boolean>
 *       Authoritative async gate. Delegates to SfConnectionResolver.
 *       Returns true iff (a) an active SF connection row exists OR
 *       (b) the user is in the env CSV AND env credentials are present.
 *
 *   - isInEnvCsv(userId): boolean
 *       Sync CSV-only check. Used by code paths that need to know
 *       "is this user in the canary list" without consulting the DB
 *       — e.g. the runtime summary endpoint's `enabledTenantCount`
 *       diagnostic field.
 *
 *   - getEnabledUserIds(): string[]
 *   - getEnabledTenantCount(): number
 *       Both unchanged from PR-B1 — operate on the CSV alone.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SfConnectionResolver } from './sf-connection-resolver.service';

@Injectable()
export class OrchestrationFeatureFlag {
  private readonly logger = new Logger(OrchestrationFeatureFlag.name);

  constructor(
    private readonly config: ConfigService,
    private readonly resolver: SfConnectionResolver,
  ) {}

  /**
   * Authoritative gate — true iff the resolver decides the tenant is
   * enabled (DB connection OR env canary). Async because the DB
   * lookup is async; callers in async contexts just `await` it.
   */
  async isEnabledForUser(userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;
    return this.resolver.isEnabledForUser(userId);
  }

  /**
   * Sync CSV-only check. Whitespace and empty entries tolerated:
   *   "abc, ,def,"  → ["abc","def"]
   *
   * Does NOT consult the DB. Use this only when you need the env CSV
   * specifically (e.g. observability "tenants on canary list" count).
   */
  isInEnvCsv(userId: string | null | undefined): boolean {
    if (!userId) return false;
    return this.getEnabledUserIds().includes(userId);
  }

  /** Parsed CSV. Fresh array each call — safe to mutate. */
  getEnabledUserIds(): string[] {
    const csv = this.config.get<string>('BOOKING_ORCHESTRATION_ENABLED_USER_IDS', '') ?? '';
    return csv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * Count of tenants in the env CSV. Surfaced on the runtime summary
   * endpoint so operators can verify dark-launch state. Does NOT include
   * tenants enabled via the connection table — that's a separate count
   * which will surface in a later PR.
   */
  getEnabledTenantCount(): number {
    return this.getEnabledUserIds().length;
  }
}
