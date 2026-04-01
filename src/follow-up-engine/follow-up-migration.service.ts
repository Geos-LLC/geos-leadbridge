/**
 * Follow-Up Migration Service
 *
 * Maps existing AutomationRule follow-ups (isFollowUp=true) into new SequenceTemplate model.
 * Non-destructive: old rules are disabled, not deleted.
 * Preserves: active hours, timezone, delay, AI/template mode, prompt template.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';

@Injectable()
export class FollowUpMigrationService {
  private readonly logger = new Logger(FollowUpMigrationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Migrate existing AutomationRule follow-ups to SequenceTemplate model.
   * Each old rule becomes a single-step sequence template.
   * Old rules are disabled but NOT deleted (backward compat).
   */
  async migrateExistingFollowUps(): Promise<{ migrated: number; skipped: number }> {
    const existingRules = await this.prisma.automationRule.findMany({
      where: { isFollowUp: true, enabled: true },
      include: {
        savedAccount: { select: { platform: true, userId: true } },
        template: { select: { id: true, content: true } },
        promptTemplate: { select: { id: true } },
      },
    });

    this.logger.log(`[Migration] Found ${existingRules.length} active follow-up rules to migrate`);

    let migrated = 0;
    let skipped = 0;

    for (const rule of existingRules) {
      const platform = rule.savedAccount?.platform || 'yelp';
      const userId = rule.savedAccount?.userId || rule.userId;

      // Check if already migrated (template with same name exists)
      const existing = await this.prisma.followUpSequenceTemplate.findFirst({
        where: { userId, name: { startsWith: `Migrated: ${rule.name}` } },
      });
      if (existing) {
        this.logger.log(`[Migration] Skipping "${rule.name}" — already migrated`);
        skipped++;
        continue;
      }

      // Create single-step sequence template preserving all settings
      await this.prisma.followUpSequenceTemplate.create({
        data: {
          userId,
          platform,
          name: `Migrated: ${rule.name}`,
          triggerState: 'no_reply_after_initial',
          mode: 'auto_send', // Existing behavior was auto-send
          generationMode: rule.useAi ? 'ai' : 'template',
          promptTemplateId: rule.promptTemplateId,
          preset: null,
          isDefault: false,
          activeHoursStart: rule.activeHoursStart,
          activeHoursEnd: rule.activeHoursEnd,
          activeHoursTimezone: rule.activeHoursTimezone || 'America/New_York',
          stepsJson: {
            schemaVersion: 1,
            steps: [{
              stepOrder: 0,
              delayMinutes: rule.delayMinutes || 30,
              objective: 'follow_up',
              messageTemplate: rule.template?.content || null,
            }],
          },
          schemaVersion: 1,
          enabled: true,
        },
      });

      // Disable old rule (preserve, don't delete)
      await this.prisma.automationRule.update({
        where: { id: rule.id },
        data: { enabled: false },
      });

      this.logger.log(`[Migration] Migrated "${rule.name}" → SequenceTemplate (${platform}, ${rule.delayMinutes}m, ${rule.useAi ? 'AI' : 'template'})`);
      migrated++;
    }

    this.logger.log(`[Migration] Complete: ${migrated} migrated, ${skipped} skipped`);
    return { migrated, skipped };
  }
}
