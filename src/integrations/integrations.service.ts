import { Injectable, Logger, Inject, Optional, forwardRef } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../common/utils/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { LeadsService } from '../leads/leads.service';
import { LeadStatusService } from '../leads/lead-status.service';
import { FollowUpEngineService } from '../follow-up-engine/follow-up-engine.service';
import { BudgetSnapshotDto } from './dto/budget-snapshot.dto';
import { CollectLeadsDto } from './dto/collect-leads.dto';
import { mapThumbtackToLbStatus, isRelevantThumbtackSignal } from './thumbtack-status-map';

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private prisma: PrismaService,
    private analyticsService: AnalyticsService,
    private leadsService: LeadsService,
    private readonly leadStatusService: LeadStatusService,
    @Optional()
    @Inject(forwardRef(() => FollowUpEngineService))
    private readonly followUpEngine: FollowUpEngineService | null,
  ) {}

  /**
   * Save a budget snapshot with windowing logic.
   * Closes the previous active snapshot and opens a new one.
   */
  async saveBudgetSnapshot(userId: string, dto: BudgetSnapshotDto) {
    const now = new Date();
    const snapshotId = crypto.randomUUID();
    // Yelp monthly budgets attach a 'YYYY-MM' period in scope.period and we
    // persist it into scopeCategory (which is unused for budget_monthly).
    // This gives each calendar month its own snapshot history.
    const periodKey = dto.scope?.period || dto.scope?.category || null;

    const result = await this.prisma.$transaction(async (tx) => {
      // Close the previous active snapshot (effective_to IS NULL).
      // Scope by savedAccountId when provided so multi-account budgets don't
      // close each other; legacy callers without savedAccountId keep the
      // old per-user behavior. When a period (YYYY-MM) is provided, scope
      // by period too — different months are independent histories.
      const previous = await tx.thumbtackSettingsSnapshot.findFirst({
        where: {
          userId,
          snapshotType: dto.snapshotType || 'budget',
          effectiveTo: null,
          ...(dto.savedAccountId ? { savedAccountId: dto.savedAccountId } : {}),
          ...(periodKey ? { scopeCategory: periodKey } : {}),
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
          scopeCategory: periodKey,
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
        // Don't auto-flag needsRefetch on re-collection. Page-scrape data (budget,
        // city, postcode) doesn't change after lead creation, so re-scraping
        // every re-collected lead just creates a permanent "missing details"
        // backlog. The genuine case (API recovered from local data, full details
        // unavailable) is handled in leads.service.ts where the data is missing.
        await this.prisma.thumbtackLeadId.update({
          where: { id: existing.id },
          data: {
            batchId,
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

      // Propagate status changes to the real Lead row through LeadStatusService
      // so audit log + FSM + follow-up engine all fire — same path as Yelp.
      if (status) {
        await this.syncStatusToLead(userId, thumbtackId, status);
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
   * Propagate a Thumbtack-extension scraped status to the canonical Lead row.
   *
   * Mirrors the post-39ac863 Yelp flow: a single writeStatus call carries both
   * the raw platformStatus and the mapped canonical newStatus.
   * LeadStatusService.applyPlatformSync is the authoritative gate — it owns
   * SF_STATUS_WINS, the completed-lock, the pipeline-downgrade guard, and dedup.
   * The returned skipReason tells us which (if any) guard fired so we can log
   * it greppably in Loki (skipReason=sf_protected / pipeline_downgrade /
   * duplicate / hard_terminal / invalid_status / stale_event).
   *
   * No-ops silently when no Lead row exists yet (Chrome extension scrapes can
   * arrive before the user has imported the negotiation via the Thumbtack API).
   */
  private async syncStatusToLead(
    userId: string,
    thumbtackId: string,
    rawStatus: string,
  ): Promise<void> {
    let lead;
    try {
      lead = await this.prisma.lead.findUnique({
        where: {
          platform_externalRequestId: {
            platform: 'thumbtack',
            externalRequestId: thumbtackId,
          },
        },
        select: {
          id: true,
          userId: true,
          status: true,
          platformStatus: true,
          thumbtackStatus: true,
          threadId: true,
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `[TT Status Sync] Lead lookup failed for ${thumbtackId}: ${err.message}`,
      );
      return;
    }

    if (!lead) return;

    // Cross-tenant safety: the (platform, externalRequestId) pair is globally
    // unique, but the row could belong to another tenant. Don't mutate it.
    if (lead.userId !== userId) {
      this.logger.warn(
        `[TT Status Sync] Skipping ${thumbtackId}: Lead row owned by another user`,
      );
      return;
    }

    const mapped = mapThumbtackToLbStatus(rawStatus);
    const platformStatusChanged =
      (lead.platformStatus ?? lead.thumbtackStatus) !== rawStatus;
    const canonicalChanged = mapped !== null && mapped !== lead.status;

    if (!platformStatusChanged && !canonicalChanged) return;

    // Stable, deterministic source event ID — feeds the dedup guard inside
    // applyPlatformSync, so a re-sent scrape batch produces no duplicate audit.
    const normalized = (mapped ?? rawStatus)
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '_');
    const sourceEventId = `tt_scrape_${thumbtackId}_${normalized}`;

    const result = await this.leadStatusService.writeStatus({
      leadId: lead.id,
      source: 'platform_sync',
      platformStatus: platformStatusChanged ? rawStatus : undefined,
      newStatus: canonicalChanged ? mapped! : undefined,
      actorType: 'extension',
      sourceEventId,
    });

    const touched: string[] = [];
    if (platformStatusChanged && result.platformStatus === rawStatus) {
      touched.push('platformStatus');
    }
    if (canonicalChanged && result.status === mapped) {
      touched.push('status');
    }
    const skipReason = result.skipReason;
    this.logger.log(
      `[TT Status Sync] lead=${thumbtackId} touched=${touched.join(',') || '(none)'}${skipReason ? ` skipReason=${skipReason}` : ''}`,
    );

    if (
      platformStatusChanged &&
      lead.threadId &&
      this.followUpEngine &&
      isRelevantThumbtackSignal(rawStatus)
    ) {
      this.followUpEngine
        .handlePlatformSignal(lead.threadId, rawStatus)
        .then((action) => {
          if (action !== 'no_change' && action !== 'no_enrollment') {
            this.logger.log(
              `[TT Status Sync] Platform signal "${rawStatus}" on lead ${thumbtackId} → ${action}`,
            );
          }
        })
        .catch((err) =>
          this.logger.warn(
            `[TT Status Sync] handlePlatformSignal failed: ${err.message}`,
          ),
        );
    }
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
    let referencedAccounts: { id: string; businessName: string; emailHint: string | null }[] = [];
    if (accountIds.length > 0) {
      const accs = await this.prisma.savedAccount.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, businessName: true, emailHint: true },
      });
      referencedAccounts = accs.map((a) => ({ id: a.id, businessName: a.businessName, emailHint: a.emailHint ?? null }));
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
   * Pre-flight partition for the bulk import paths. Splits collected
   * thumbtackIds into three buckets so we never call the Partner API for IDs
   * we already have or for IDs that belong to a different SavedAccount than
   * the one the operator picked.
   *
   * Returns:
   *   - alreadyImported: lead row exists under the operator-selected
   *                      SavedAccount's businessId (or no specific account
   *                      was chosen). Mark imported=true and skip.
   *   - otherAccount:    lead row exists under a *different* businessId.
   *                      Skip with the owning account's businessName so the
   *                      UI can tell the operator where it actually lives.
   *   - toImport:        no Lead row anywhere — a real Partner API fetch is
   *                      needed.
   */
  private async partitionCollectedIds(
    userId: string,
    thumbtackIds: string[],
    savedAccountId?: string,
  ): Promise<{
    alreadyImported: string[];
    otherAccount: Array<{ id: string; businessId: string; businessName: string | null }>;
    toImport: string[];
  }> {
    let currentBusinessId: string | null = null;
    if (savedAccountId) {
      const sa = await this.prisma.savedAccount.findFirst({
        where: { id: savedAccountId, userId },
        select: { businessId: true },
      });
      currentBusinessId = sa?.businessId ?? null;
    }

    const existingLeads = await this.prisma.lead.findMany({
      where: { platform: 'thumbtack', externalRequestId: { in: thumbtackIds }, userId },
      select: { externalRequestId: true, businessId: true },
    });
    const byThumbtackId = new Map(existingLeads.map((l) => [l.externalRequestId, l]));

    // Resolve businessName for the cross-account messages in one round-trip.
    const otherBusinessIds = Array.from(
      new Set(
        existingLeads
          .map((l) => l.businessId)
          .filter((b): b is string => !!b && (currentBusinessId ? b !== currentBusinessId : false)),
      ),
    );
    const accounts = otherBusinessIds.length
      ? await this.prisma.savedAccount.findMany({
          where: { userId, platform: 'thumbtack', businessId: { in: otherBusinessIds } },
          select: { businessId: true, businessName: true },
        })
      : [];
    const businessIdToName = new Map(accounts.map((a) => [a.businessId, a.businessName]));

    const alreadyImported: string[] = [];
    const otherAccount: Array<{ id: string; businessId: string; businessName: string | null }> = [];
    const toImport: string[] = [];

    for (const id of thumbtackIds) {
      const existing = byThumbtackId.get(id);
      if (!existing) {
        toImport.push(id);
        continue;
      }
      if (currentBusinessId && existing.businessId && existing.businessId !== currentBusinessId) {
        otherAccount.push({
          id,
          businessId: existing.businessId,
          businessName: businessIdToName.get(existing.businessId) ?? null,
        });
      } else {
        alreadyImported.push(id);
      }
    }

    return { alreadyImported, otherAccount, toImport };
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
      return {
        ok: true, missingCount: 0, total: 0, imported: 0, failed: 0,
        skipped: { alreadyImported: 0, otherAccount: [] as any[], wrongScope: [] as any[] },
        errors: [],
      };
    }

    const allIds = collected.map((l) => l.thumbtackId);
    const partitioned = await this.partitionCollectedIds(userId, allIds, savedAccountId);

    this.logger.log(
      `[reimportFailed] user=${userId} account=${savedAccountId ?? 'all'} total=${allIds.length} ` +
      `alreadyImported=${partitioned.alreadyImported.length} ` +
      `otherAccount=${partitioned.otherAccount.length} toImport=${partitioned.toImport.length}`,
    );

    // Mark already-existing rows imported=true so they stop showing as pending.
    const flagAsImported = [
      ...partitioned.alreadyImported,
      ...partitioned.otherAccount.map((o) => o.id),
    ];
    if (flagAsImported.length > 0) {
      await this.prisma.thumbtackLeadId.updateMany({
        where: { userId, thumbtackId: { in: flagAsImported } },
        data: { imported: true, importedAt: new Date(), needsRefetch: false },
      });
    }

    if (partitioned.toImport.length === 0) {
      return {
        ok: true, missingCount: 0, total: allIds.length, imported: 0, failed: 0,
        skipped: {
          alreadyImported: partitioned.alreadyImported.length,
          otherAccount: partitioned.otherAccount,
          wrongScope: [],
        },
        errors: [],
      };
    }

    const results = await this.leadsService.importThumbtackNegotiations(
      userId, partitioned.toImport, savedAccountId,
    );

    // Successfully-imported IDs from the API path also get the imported flag.
    const failedIds = new Set(results.errors.map((e: string) => e.split(':')[0]));
    const skippedIds = new Set(results.skipped.map((s) => s.id));
    const successIds = partitioned.toImport.filter((id) => !failedIds.has(id) && !skippedIds.has(id));
    if (successIds.length > 0) {
      await this.prisma.thumbtackLeadId.updateMany({
        where: { userId, thumbtackId: { in: successIds } },
        data: { imported: true, importedAt: new Date(), needsRefetch: false },
      });
    }

    return {
      ok: true,
      missingCount: partitioned.toImport.length,
      total: allIds.length,
      imported: results.imported,
      failed: results.failed,
      skipped: {
        alreadyImported: partitioned.alreadyImported.length,
        otherAccount: partitioned.otherAccount,
        wrongScope: results.skipped.filter((s) => s.reason === 'THUMBTACK_WRONG_SCOPE'),
      },
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
      return {
        ok: true, total: 0, imported: 0, failed: 0,
        skipped: { alreadyImported: 0, otherAccount: [] as any[], wrongScope: [] as any[] },
        errors: [],
      };
    }

    const thumbtackIds = collected.map((l) => l.thumbtackId);
    const partitioned = await this.partitionCollectedIds(userId, thumbtackIds, savedAccountId);

    this.logger.log(
      `[reimportLeads] user=${userId} account=${savedAccountId ?? 'all'} total=${thumbtackIds.length} ` +
      `alreadyImported=${partitioned.alreadyImported.length} ` +
      `otherAccount=${partitioned.otherAccount.length} toImport=${partitioned.toImport.length}`,
    );

    // Mark already-existing rows imported=true so they stop showing as pending.
    const flagAsImported = [
      ...partitioned.alreadyImported,
      ...partitioned.otherAccount.map((o) => o.id),
    ];
    if (flagAsImported.length > 0) {
      await this.prisma.thumbtackLeadId.updateMany({
        where: { userId, thumbtackId: { in: flagAsImported } },
        data: { imported: true, importedAt: new Date(), needsRefetch: false },
      });
    }

    if (partitioned.toImport.length === 0) {
      return {
        ok: true, total: thumbtackIds.length, imported: 0, failed: 0,
        skipped: {
          alreadyImported: partitioned.alreadyImported.length,
          otherAccount: partitioned.otherAccount,
          wrongScope: [],
        },
        errors: [],
      };
    }

    const results = await this.leadsService.importThumbtackNegotiations(
      userId, partitioned.toImport, savedAccountId,
    );

    // Mark successfully-imported ones as imported. The singular call has
    // already flagged THUMBTACK_WRONG_SCOPE rows so we only need to touch
    // pure successes here.
    const failedIds = new Set(results.errors.map((e: string) => e.split(':')[0]));
    const skippedIds = new Set(results.skipped.map((s) => s.id));
    const successIds = partitioned.toImport.filter((id) => !failedIds.has(id) && !skippedIds.has(id));
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
      skipped: {
        alreadyImported: partitioned.alreadyImported.length,
        otherAccount: partitioned.otherAccount,
        wrongScope: results.skipped.filter((s) => s.reason === 'THUMBTACK_WRONG_SCOPE'),
      },
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
