/**
 * Booking orchestration feature flag — Phase 2B PR-B1.
 *
 * Gate on env CSV `BOOKING_ORCHESTRATION_ENABLED_USER_IDS`. Tenant-scoped,
 * canary-friendly, zero schema dependency, instant rollback by removing
 * the userId from the CSV.
 *
 * Unlike `SF_STATUS_WINS_USER_IDS`, this flag has **no global escape
 * hatch** — an empty CSV means "nobody". This avoids the risk of an
 * accidental global enable during rollback.
 *
 * PR-B1 is callable-but-uncalled: nothing in the runtime asks this flag
 * yet. PR-B2 wires it into the orchestrator entry point.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class OrchestrationFeatureFlag {
  private readonly logger = new Logger(OrchestrationFeatureFlag.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * True iff `userId` is present in the CSV. Empty/unset env → always false.
   * Whitespace and empty entries are tolerated:
   *   "abc, ,def,"  → ["abc","def"]
   */
  isEnabledForUser(userId: string | null | undefined): boolean {
    if (!userId) return false;
    return this.getEnabledUserIds().includes(userId);
  }

  /**
   * Parsed list of enabled userIds. Exposed for observability + tests.
   * Returns a fresh array on every call — safe to mutate.
   */
  getEnabledUserIds(): string[] {
    const csv = this.config.get<string>('BOOKING_ORCHESTRATION_ENABLED_USER_IDS', '') ?? '';
    return csv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * Count of enabled tenants — surfaced on the runtime summary endpoint so
   * an operator can confirm dark-launch state ("0 tenants enabled" pre-canary).
   */
  getEnabledTenantCount(): number {
    return this.getEnabledUserIds().length;
  }
}
