import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../common/utils/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { LeadsService } from '../leads/leads.service';
import { BudgetSnapshotDto } from './dto/budget-snapshot.dto';
import { CollectLeadsDto } from './dto/collect-leads.dto';

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private prisma: PrismaService,
    private analyticsService: AnalyticsService,
    private leadsService: LeadsService,
  ) {}

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
      const customerName = dto.leadNames?.[thumbtackId] || null;
      const leadDate = dto.leadDates?.[thumbtackId] || null;
      const existing = await this.prisma.thumbtackLeadId.findUnique({
        where: { userId_thumbtackId: { userId, thumbtackId } },
      });

      if (existing) {
        // Update: only mark needsRefetch if the lead was already imported
        // (avoids marking all leads as needsRefetch when batch streaming re-sends them)
        await this.prisma.thumbtackLeadId.update({
          where: { id: existing.id },
          data: {
            batchId,
            ...(existing.imported ? { needsRefetch: true } : {}),
            lastActivityAt: capturedAt,
            ...(status ? { thumbtackStatus: status } : {}),
            ...(customerName ? { customerName } : {}),
            ...(leadDate ? { leadDate } : {}),
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
            customerName,
            leadDate,
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
      orderBy: [{ leadDate: 'desc' }, { collectedAt: 'desc' }],
      ...(filters.limit ? { take: filters.limit } : {}),
    });

    // Collect distinct savedAccountIds from leads for filter dropdown
    const accountIds = [...new Set(leads.map((l) => l.savedAccountId).filter(Boolean))] as string[];
    let referencedAccounts: { id: string; businessName: string }[] = [];
    if (accountIds.length > 0) {
      const accs = await this.prisma.savedAccount.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, businessName: true },
      });
      referencedAccounts = accs.map((a) => ({ id: a.id, businessName: a.businessName }));
    }

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
        customerName: l.customerName,
        leadDate: l.leadDate,
        imported: l.imported,
        importedAt: l.importedAt,
        needsRefetch: l.needsRefetch,
        lastActivityAt: l.lastActivityAt,
      })),
      total: leads.length,
      accounts: referencedAccounts,
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
   * Reset lead IDs back to pending (imported = false).
   * Pass specific thumbtackIds, or omit to reset ALL imported leads for the user.
   */
  async resetImported(userId: string, thumbtackIds?: string[]) {
    const where: any = { userId, imported: true };
    if (thumbtackIds && thumbtackIds.length > 0) {
      where.thumbtackId = { in: thumbtackIds };
    }

    const result = await this.prisma.thumbtackLeadId.updateMany({
      where,
      data: {
        imported: false,
        importedAt: null,
        needsRefetch: false,
      },
    });

    this.logger.log(`Reset ${result.count} leads to pending for user ${userId}`);

    return { ok: true, resetCount: result.count };
  }

  /**
   * Get IDs of leads that need page scraping (recovered from local sources, missing full details).
   */
  async getNeedsScrapeIds(userId: string, savedAccountId?: string) {
    const where: any = { userId, needsRefetch: true };
    if (savedAccountId) where.savedAccountId = savedAccountId;

    const records = await this.prisma.thumbtackLeadId.findMany({
      where,
      select: { thumbtackId: true },
    });

    return {
      ok: true,
      count: records.length,
      thumbtackIds: records.map((r) => r.thumbtackId),
    };
  }

  /**
   * Count collected leads that have no matching Lead record (without importing).
   */
  async countMissingLeads(userId: string, savedAccountId?: string) {
    const where: any = { userId };
    if (savedAccountId) where.savedAccountId = savedAccountId;

    const collected = await this.prisma.thumbtackLeadId.findMany({
      where,
      select: { thumbtackId: true },
    });

    if (collected.length === 0) return { ok: true, missingCount: 0, total: 0 };

    const allIds = collected.map((l) => l.thumbtackId);
    const existing = await this.prisma.lead.findMany({
      where: { platform: 'thumbtack', externalRequestId: { in: allIds } },
      select: { externalRequestId: true },
    });
    const existingSet = new Set(existing.map((l) => l.externalRequestId));

    return {
      ok: true,
      total: allIds.length,
      missingCount: allIds.filter((id) => !existingSet.has(id)).length,
    };
  }

  /**
   * Re-import only the leads that are marked imported=true in ThumbtackLeadId
   * but have NO matching Lead record — i.e. truly skipped/failed imports.
   * Also returns the count of missing leads for UI display.
   */
  async reimportFailed(userId: string, savedAccountId?: string) {
    const where: any = { userId };
    if (savedAccountId) where.savedAccountId = savedAccountId;

    const collected = await this.prisma.thumbtackLeadId.findMany({
      where,
      select: { thumbtackId: true },
    });

    if (collected.length === 0) {
      return { ok: true, missingCount: 0, total: 0, imported: 0, failed: 0, errors: [] };
    }

    const allIds = collected.map((l) => l.thumbtackId);

    // Find which thumbtackIds have no corresponding Lead record
    const existingLeads = await this.prisma.lead.findMany({
      where: { platform: 'thumbtack', externalRequestId: { in: allIds } },
      select: { externalRequestId: true },
    });
    const existingSet = new Set(existingLeads.map((l) => l.externalRequestId));
    const missingIds = allIds.filter((id) => !existingSet.has(id));

    this.logger.log(`[reimportFailed] user=${userId}: ${allIds.length} collected, ${missingIds.length} missing Lead records`);

    if (missingIds.length === 0) {
      return { ok: true, missingCount: 0, total: 0, imported: 0, failed: 0, errors: [] };
    }

    const results = await this.leadsService.importThumbtackNegotiations(userId, missingIds, savedAccountId);

    const failedSet = new Set(results.errors.map((e: string) => e.split(':')[0]));
    const successIds = missingIds.filter((id) => !failedSet.has(id));
    if (successIds.length > 0) {
      await this.prisma.thumbtackLeadId.updateMany({
        where: { userId, thumbtackId: { in: successIds } },
        data: { imported: true, importedAt: new Date(), needsRefetch: false },
      });
    }

    return {
      ok: true,
      missingCount: missingIds.length,
      total: missingIds.length,
      imported: results.imported,
      failed: results.failed,
      errors: results.errors,
    };
  }

  /**
   * Re-import ALL leads for a user/account from ThumbtackLeadId table.
   * Runs the import server-side without requiring the Chrome extension.
   */
  async reimportLeads(userId: string, savedAccountId?: string) {
    const where: any = { userId };
    if (savedAccountId) where.savedAccountId = savedAccountId;

    const collected = await this.prisma.thumbtackLeadId.findMany({
      where,
      select: { thumbtackId: true },
      orderBy: { capturedAt: 'desc' },
    });

    if (collected.length === 0) {
      return { ok: true, total: 0, imported: 0, failed: 0, errors: [] };
    }

    const thumbtackIds = collected.map((l) => l.thumbtackId);
    this.logger.log(`[reimportLeads] Re-importing ${thumbtackIds.length} leads for user ${userId}`);

    const results = await this.leadsService.importThumbtackNegotiations(userId, thumbtackIds, savedAccountId);

    // Mark successfully-imported ones (all that didn't fail) as imported
    const failedIds = new Set(results.errors.map((e: string) => e.split(':')[0]));
    const successIds = thumbtackIds.filter((id) => !failedIds.has(id));

    if (successIds.length > 0) {
      await this.prisma.thumbtackLeadId.updateMany({
        where: { userId, thumbtackId: { in: successIds } },
        data: { imported: true, importedAt: new Date(), needsRefetch: false },
      });
    }

    return {
      ok: true,
      total: thumbtackIds.length,
      imported: results.imported,
      failed: results.failed,
      errors: results.errors,
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
   * Delete all budget snapshots for a user.
   */
  async deleteSnapshots(userId: string) {
    const result = await this.prisma.thumbtackSettingsSnapshot.deleteMany({
      where: { userId },
    });

    this.logger.log(
      `Deleted ${result.count} budget snapshots for user ${userId}`,
    );

    return { ok: true, deletedCount: result.count };
  }

  /**
   * Delete collected lead IDs. If thumbtackIds provided, delete those; otherwise delete all.
   */
  async deleteLeadIds(userId: string, thumbtackIds?: string[], savedAccountId?: string) {
    const where: any = { userId };
    if (thumbtackIds?.length) {
      where.thumbtackId = { in: thumbtackIds };
    }
    if (savedAccountId) {
      where.savedAccountId = savedAccountId;
    }

    // Collect thumbtackIds before deleting so we can cascade to the leads table
    const toDelete = await this.prisma.thumbtackLeadId.findMany({
      where,
      select: { thumbtackId: true },
    });
    const externalIds = toDelete.map((t) => t.thumbtackId);

    const result = await this.prisma.thumbtackLeadId.deleteMany({ where });

    // Also delete corresponding leads from the main leads table
    let leadsDeleted = 0;
    if (externalIds.length > 0) {
      const leadsResult = await this.prisma.lead.deleteMany({
        where: {
          userId,
          platform: 'thumbtack',
          externalRequestId: { in: externalIds },
        },
      });
      leadsDeleted = leadsResult.count;
    }

    this.logger.log(
      `Deleted ${result.count} collected leads + ${leadsDeleted} leads for user ${userId}`,
    );

    // Invalidate analytics cache so insights reflects the deletion immediately
    if (leadsDeleted > 0) {
      await this.analyticsService.invalidateCache(userId);
    }

    return { ok: true, deletedCount: result.count, leadsDeleted };
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
