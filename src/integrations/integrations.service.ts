import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../common/utils/prisma.service';
import { BudgetSnapshotDto } from './dto/budget-snapshot.dto';
import { CollectLeadsDto } from './dto/collect-leads.dto';

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Save a budget snapshot with windowing logic.
   * Closes the previous active snapshot and opens a new one.
   */
  async saveBudgetSnapshot(userId: string, dto: BudgetSnapshotDto) {
    const now = new Date();
    const snapshotId = crypto.randomUUID();

    const result = await this.prisma.$transaction(async (tx) => {
      // Close the previous active snapshot (effective_to IS NULL)
      const previous = await tx.thumbtackSettingsSnapshot.findFirst({
        where: {
          userId,
          snapshotType: dto.snapshotType || 'budget',
          effectiveTo: null,
        },
        orderBy: { effectiveFrom: 'desc' },
      });

      let closedPrevious = false;
      if (previous) {
        await tx.thumbtackSettingsSnapshot.update({
          where: { id: previous.id },
          data: { effectiveTo: now },
        });
        closedPrevious = true;
      }

      // Insert the new snapshot
      const snapshot = await tx.thumbtackSettingsSnapshot.create({
        data: {
          id: snapshotId,
          userId,
          savedAccountId: dto.savedAccountId || null,
          provider: dto.provider || 'thumbtack',
          snapshotType: dto.snapshotType || 'budget',
          scopeCategory: dto.scope?.category || null,
          scopeLocation: dto.scope?.location || null,
          weeklyBudget: dto.budget.weekly,
          currency: dto.budget.currency || 'USD',
          capturedAt: new Date(dto.capturedAt),
          receivedAt: now,
          effectiveFrom: now,
          effectiveTo: null,
          source: dto.source || null,
          pageUrl: dto.page?.url || null,
          pageTitle: dto.page?.title || null,
          rawJson: dto as any,
        },
      });

      return { snapshot, closedPrevious };
    });

    this.logger.log(
      `Budget snapshot saved for user ${userId}: $${dto.budget.weekly} (closed previous: ${result.closedPrevious})`,
    );

    return {
      ok: true,
      snapshotId: result.snapshot.id,
      effectiveFrom: result.snapshot.effectiveFrom,
      closedPrevious: result.closedPrevious,
    };
  }

  /**
   * Collect lead IDs from the Chrome extension.
   * Deduplicates by (userId, thumbtackId). Updates existing records if re-sent.
   */
  async collectLeadIds(userId: string, dto: CollectLeadsDto) {
    const batchId = crypto.randomUUID();
    const capturedAt = new Date(dto.capturedAt);
    let newCount = 0;
    let updatedCount = 0;

    for (const thumbtackId of dto.leadIds) {
      const status = dto.leadStatuses?.[thumbtackId] || null;
      const existing = await this.prisma.thumbtackLeadId.findUnique({
        where: { userId_thumbtackId: { userId, thumbtackId } },
      });

      if (existing) {
        // Update: mark as needing refetch (had new activity)
        await this.prisma.thumbtackLeadId.update({
          where: { id: existing.id },
          data: {
            batchId,
            needsRefetch: true,
            lastActivityAt: capturedAt,
            ...(status ? { thumbtackStatus: status } : {}),
            ...(dto.savedAccountId ? { savedAccountId: dto.savedAccountId } : {}),
          },
        });
        updatedCount++;
      } else {
        // New lead ID
        await this.prisma.thumbtackLeadId.create({
          data: {
            userId,
            savedAccountId: dto.savedAccountId || null,
            thumbtackId,
            batchId,
            capturedAt,
            source: dto.source || null,
            pageUrl: dto.page?.url || null,
            pageTitle: dto.page?.title || null,
            thumbtackStatus: status,
          },
        });
        newCount++;
      }
    }

    this.logger.log(
      `Lead IDs collected for user ${userId}: ${dto.leadIds.length} received, ${newCount} new, ${updatedCount} updated`,
    );

    return {
      ok: true,
      batchId,
      totalReceived: dto.leadIds.length,
      newCount,
      updatedCount,
      collectedAt: new Date().toISOString(),
      metadata: dto.metadata || {},
    };
  }

  /**
   * Query collected lead IDs for a user.
   */
  async getLeadIds(
    userId: string,
    filters: { pending?: boolean; refetch?: boolean; savedAccountId?: string; limit?: number },
  ) {
    const where: any = { userId };

    if (filters.pending) {
      where.imported = false;
    }
    if (filters.refetch) {
      where.needsRefetch = true;
    }
    if (filters.savedAccountId) {
      where.savedAccountId = filters.savedAccountId;
    }

    const leads = await this.prisma.thumbtackLeadId.findMany({
      where,
      orderBy: { collectedAt: 'desc' },
      ...(filters.limit ? { take: filters.limit } : {}),
    });

    return {
      ok: true,
      leads: leads.map((l) => ({
        id: l.id,
        thumbtackId: l.thumbtackId,
        savedAccountId: l.savedAccountId,
        batchId: l.batchId,
        capturedAt: l.capturedAt,
        collectedAt: l.collectedAt,
        source: l.source,
        thumbtackStatus: l.thumbtackStatus,
        imported: l.imported,
        importedAt: l.importedAt,
        needsRefetch: l.needsRefetch,
        lastActivityAt: l.lastActivityAt,
      })),
      total: leads.length,
    };
  }

  /**
   * Mark lead IDs as imported.
   */
  async markLeadsImported(userId: string, thumbtackIds: string[]) {
    const now = new Date();

    const result = await this.prisma.thumbtackLeadId.updateMany({
      where: {
        userId,
        thumbtackId: { in: thumbtackIds },
      },
      data: {
        imported: true,
        importedAt: now,
        needsRefetch: false,
      },
    });

    this.logger.log(
      `Marked ${result.count} leads as imported for user ${userId}`,
    );

    return {
      ok: true,
      markedCount: result.count,
    };
  }

  /**
   * Query budget snapshots for a user.
   */
  async getSnapshots(userId: string, savedAccountId?: string) {
    const where: any = { userId };
    if (savedAccountId) {
      where.savedAccountId = savedAccountId;
    }

    const snapshots = await this.prisma.thumbtackSettingsSnapshot.findMany({
      where,
      orderBy: { effectiveFrom: 'desc' },
    });

    return {
      ok: true,
      snapshots: snapshots.map((s) => ({
        id: s.id,
        savedAccountId: s.savedAccountId,
        snapshotType: s.snapshotType,
        scopeCategory: s.scopeCategory,
        scopeLocation: s.scopeLocation,
        weeklyBudget: s.weeklyBudget,
        currency: s.currency,
        capturedAt: s.capturedAt,
        effectiveFrom: s.effectiveFrom,
        effectiveTo: s.effectiveTo,
        source: s.source,
        active: s.effectiveTo === null,
      })),
      total: snapshots.length,
    };
  }

  /**
   * Delete collected lead IDs. If thumbtackIds provided, delete those; otherwise delete all.
   */
  async deleteLeadIds(userId: string, thumbtackIds?: string[]) {
    const where: any = { userId };
    if (thumbtackIds?.length) {
      where.thumbtackId = { in: thumbtackIds };
    }

    const result = await this.prisma.thumbtackLeadId.deleteMany({ where });

    this.logger.log(
      `Deleted ${result.count} collected leads for user ${userId}`,
    );

    return { ok: true, deletedCount: result.count };
  }

  /**
   * Get stats for the auth/me endpoint.
   */
  async getExtensionStats(userId: string) {
    const collectedLeads = await this.prisma.thumbtackLeadId.count({
      where: { userId },
    });

    return { collectedLeads };
  }
}
