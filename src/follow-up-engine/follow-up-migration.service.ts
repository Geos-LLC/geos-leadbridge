/**
 * Follow-Up Migration Service
 *
 * Maps existing AutomationRule follow-ups (isFollowUp=true) into new model.
 * Non-destructive: old rules are disabled, not deleted.
 * Phase 1: stub. Phase 4: full migration.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';

@Injectable()
export class FollowUpMigrationService {
  private readonly logger = new Logger(FollowUpMigrationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Migrate existing AutomationRule follow-ups to SequenceTemplate model.
   * Phase 1: stub — logs what would be migrated.
   * Phase 4: full migration with backward compatibility.
   */
  async migrateExistingFollowUps(): Promise<{ migrated: number; skipped: number }> {
    const existingRules = await this.prisma.automationRule.findMany({
      where: { isFollowUp: true },
      include: {
        savedAccount: { select: { platform: true } },
        template: { select: { content: true } },
      },
    });

    this.logger.log(`[Migration] Found ${existingRules.length} existing follow-up rules to migrate`);

    // Phase 1: log only, don't mutate
    for (const rule of existingRules) {
      this.logger.log(
        `[Migration] Would migrate: "${rule.name}" (${rule.savedAccount?.platform || 'unknown'}) ` +
        `delay=${rule.delayMinutes}m useAi=${rule.useAi} enabled=${rule.enabled}`
      );
    }

    return { migrated: 0, skipped: existingRules.length };
  }
}
