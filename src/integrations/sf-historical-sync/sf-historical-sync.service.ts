/**
 * SfHistoricalSyncService — SF→LB historical reconciliation.
 *
 * Architecture: ServiceFlow is the source of truth. This service:
 *   1. Enumerates unsynced LB leads and marks them with a syncStatus
 *      lifecycle (pending → linked | no_match | needs_review | failed,
 *      or skipped for terminal statuses).
 *   2. Receives match results from SF (via the bulk receiver controller)
 *      or from operator manual-link calls, applies them with safeguards.
 *   3. Routes status updates from the SF-supplied status through the
 *      existing LeadStatusService.writeStatus so all downgrade /
 *      duplicate / stale guards continue to apply.
 *
 * What this service does NOT do:
 *   - Create SF jobs or customers
 *   - Push LB leads into SF
 *   - Re-implement status guards (delegates to LeadStatusService)
 *
 * Called from:
 *   - SfConnectionLifecycleService.applyConnectionConnected (one-shot
 *     enumeration after a fresh SF connection)
 *   - SfHistoricalSyncController (admin dashboard, manual link, trigger,
 *     bulk receiver)
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/utils/prisma.service';
import { LeadStatusService } from '../../leads/lead-status.service';
import { mapSfStatus } from '../service-flow/sf-status-map';
import type {
  BulkLinkRequest,
  BulkLinkResponse,
  BulkLinkRowResult,
  ConnectionTimeEnumerationResult,
  ManualLinkRequest,
  ManualLinkResponse,
  SyncCandidate,
  SyncDashboardCounts,
  SyncStatus,
  SyncTriggerRequest,
  SyncTriggerResponse,
} from './sf-historical-sync.contracts';

// Terminal LB statuses that have no SF reconciliation value — sync is
// skipped for these (sfJobId never set automatically; operator can still
// manual-link if needed).
const TERMINAL_STATUSES = new Set(['lost', 'cancelled', 'no_show', 'archived']);
// `completed` is technically terminal but is the most common state where
// SF reconciliation MATTERS — Spotless wants completion mirrored. So we
// treat `completed` as actionable (pending) so SF can confirm/agree, and
// rely on the downgrade guard to block any spurious revert.
const STALE_DAYS = 14;

@Injectable()
export class SfHistoricalSyncService {
  private readonly logger = new Logger(SfHistoricalSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly leadStatus: LeadStatusService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════
  // Enumeration — called on connect + on operator "Sync" trigger
  // ═══════════════════════════════════════════════════════════════════

  async enumerateOnConnect(userId: string): Promise<ConnectionTimeEnumerationResult> {
    return this.enumerate(userId, { forceResync: false, source: 'connection_time' });
  }

  async enumerateOnTrigger(userId: string, req: SyncTriggerRequest): Promise<SyncTriggerResponse> {
    const r = await this.enumerate(userId, {
      forceResync: !!req.forceResync,
      source: 'admin_trigger',
      onlyStatuses: req.onlyStatuses,
    });
    return {
      ok: true,
      userId,
      scanned: r.scanned,
      newlyPending: r.markedPending,
      movedToSkipped: r.markedSkipped,
      alreadyLinked: r.alreadyLinked,
      alreadyTerminal: 0, // collapsed into markedSkipped below
    };
  }

  private async enumerate(
    userId: string,
    opts: { forceResync: boolean; source: 'connection_time' | 'admin_trigger'; onlyStatuses?: string[] },
  ): Promise<ConnectionTimeEnumerationResult> {
    const where: any = { userId };
    if (opts.onlyStatuses && opts.onlyStatuses.length > 0) {
      where.status = { in: opts.onlyStatuses };
    }

    const leads = await this.prisma.lead.findMany({
      where,
      select: { id: true, status: true, sfJobId: true, syncStatus: true },
    });

    let markedPending = 0;
    let markedSkipped = 0;
    let alreadyLinked = 0;
    const now = new Date();

    for (const lead of leads) {
      if (lead.sfJobId) {
        // Already linked. Always set syncStatus='linked' if missing
        // (the 49 May-26 backfill rows currently have syncStatus=null).
        if (lead.syncStatus !== 'linked') {
          await this.prisma.lead.update({
            where: { id: lead.id },
            data: { syncStatus: 'linked', syncReason: 'sfJobId_already_set', syncAttemptedAt: now },
          });
        }
        alreadyLinked++;
        continue;
      }
      if (TERMINAL_STATUSES.has(lead.status)) {
        // Terminal LB-side. Skip unless forced.
        if (!opts.forceResync && lead.syncStatus === 'skipped') continue;
        await this.prisma.lead.update({
          where: { id: lead.id },
          data: { syncStatus: 'skipped', syncReason: `terminal_${lead.status}`, syncAttemptedAt: now },
        });
        markedSkipped++;
        continue;
      }
      // Actionable: any non-terminal, non-linked lead.
      if (!opts.forceResync && lead.syncStatus && lead.syncStatus !== 'failed') {
        // Don't churn rows that are already pending/needs_review/no_match.
        continue;
      }
      await this.prisma.lead.update({
        where: { id: lead.id },
        data: { syncStatus: 'pending', syncReason: opts.source, syncAttemptedAt: now },
      });
      markedPending++;
    }

    this.logger.log(
      `[SfHistoricalSync] event=enumerate user_id=${userId} source=${opts.source} ` +
        `scanned=${leads.length} marked_pending=${markedPending} marked_skipped=${markedSkipped} already_linked=${alreadyLinked}`,
    );

    return { userId, scanned: leads.length, markedPending, markedSkipped, alreadyLinked };
  }

  // ═══════════════════════════════════════════════════════════════════
  // Dashboard — read-only counts
  // ═══════════════════════════════════════════════════════════════════

  async dashboard(userId: string): Promise<SyncDashboardCounts> {
    const conn = await this.prisma.sfConnection.findUnique({
      where: { userId },
      select: { sfTenantId: true },
    });

    const leads = await this.prisma.lead.findMany({
      where: { userId },
      select: {
        status: true, syncStatus: true, sfJobId: true,
        customerPhone: true, customerEmail: true, externalRequestId: true,
        statusUpdatedAt: true,
      },
    });

    const byStatus: Record<string, number> = {};
    const bySyncStatus: Record<string, number> = {};
    let staleScheduled = 0;
    let staleBooked = 0;
    let withPhone = 0, withEmail = 0, withExtReq = 0, withNone = 0;
    let unsyncedActionable = 0;

    const staleCutoff = Date.now() - STALE_DAYS * 86400_000;

    for (const l of leads) {
      byStatus[l.status] = (byStatus[l.status] || 0) + 1;
      const ss = l.syncStatus ?? 'null';
      bySyncStatus[ss] = (bySyncStatus[ss] || 0) + 1;

      const isLinked = ss === 'linked';
      if (!isLinked && l.statusUpdatedAt && l.statusUpdatedAt.getTime() < staleCutoff) {
        if (l.status === 'scheduled') staleScheduled++;
        if (l.status === 'booked') staleBooked++;
      }
      if (!isLinked && (ss === 'pending' || ss === 'needs_review' || ss === 'failed') &&
          !TERMINAL_STATUSES.has(l.status)) {
        unsyncedActionable++;
      }

      const hasPhone = !!l.customerPhone && l.customerPhone.length >= 7;
      const hasEmail = !!l.customerEmail;
      const hasExt = !!l.externalRequestId;
      if (hasPhone) withPhone++;
      if (hasEmail) withEmail++;
      if (hasExt) withExtReq++;
      if (!hasPhone && !hasEmail && !hasExt) withNone++;
    }

    return {
      userId,
      sfTenantId: conn?.sfTenantId ?? null,
      totalLeads: leads.length,
      byStatus,
      bySyncStatus: bySyncStatus as any,
      staleScheduled,
      staleBooked,
      unsyncedActionable,
      matchKeysAvailable: { withPhone, withEmail, withExternalRequestId: withExtReq, withNone },
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // Candidates — paged list for operator dashboard
  // ═══════════════════════════════════════════════════════════════════

  async candidates(
    userId: string,
    opts: { syncStatus?: SyncStatus | null; status?: string; limit?: number; offset?: number } = {},
  ): Promise<SyncCandidate[]> {
    const where: any = { userId };
    if (opts.syncStatus !== undefined) {
      where.syncStatus = opts.syncStatus;
    } else {
      // Default: rows with anything other than 'linked' and 'skipped'
      where.syncStatus = { in: ['pending', 'needs_review', 'failed', 'no_match'] };
    }
    if (opts.status) where.status = opts.status;

    const leads = await this.prisma.lead.findMany({
      where,
      select: {
        id: true, customerName: true, customerPhone: true, customerEmail: true,
        platform: true, businessId: true, externalRequestId: true, status: true,
        syncStatus: true, sfJobId: true, sfCustomerId: true,
        syncAttemptedAt: true, syncReason: true, createdAt: true, statusUpdatedAt: true,
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: Math.min(opts.limit ?? 100, 500),
      skip: opts.offset ?? 0,
    });
    const now = Date.now();
    return leads.map((l) => ({
      leadId: l.id,
      customerName: l.customerName,
      customerPhone: l.customerPhone,
      customerEmail: l.customerEmail,
      platform: l.platform,
      businessId: l.businessId,
      externalRequestId: l.externalRequestId,
      status: l.status,
      syncStatus: (l.syncStatus as SyncStatus | null),
      sfJobId: l.sfJobId,
      sfCustomerId: l.sfCustomerId,
      syncAttemptedAt: l.syncAttemptedAt?.toISOString() ?? null,
      syncReason: l.syncReason,
      createdAt: l.createdAt.toISOString(),
      statusUpdatedAt: l.statusUpdatedAt?.toISOString() ?? null,
      ageDays: Math.floor((now - l.createdAt.getTime()) / 86400_000),
    }));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Manual link — operator submits {lb_lead_id, sf_job_id, sf_customer_id?}
  // ═══════════════════════════════════════════════════════════════════

  async manualLink(actorUserId: string, req: ManualLinkRequest): Promise<ManualLinkResponse> {
    const lead = await this.prisma.lead.findUnique({ where: { id: req.lbLeadId } });
    if (!lead) {
      return {
        ok: false, leadId: req.lbLeadId, syncStatus: 'failed',
        conflict: 'lead_not_found',
      };
    }
    // Cross-tenant guard: the operator must own this lead's user, OR the
    // caller is a support-grant admin (the controller checks the grant).
    // We still defensively confirm the actorUserId matches the lead.userId
    // unless the controller layer signals admin.
    // (Controller currently uses @RequiresSupportGrant for admin endpoints,
    // so actorUserId here is the admin's own id; we don't enforce a strict
    // owner match here — the support-grant decorator is the gate.)

    // Safeguard: don't overwrite a DIFFERENT existing sfJobId.
    if (lead.sfJobId && lead.sfJobId !== req.sfJobId) {
      this.logger.warn(
        `[SfHistoricalSync] event=manual_link_conflict lead_id=${lead.id} ` +
          `existing_sf_job_id=${lead.sfJobId} attempted=${req.sfJobId} actor=${actorUserId}`,
      );
      return {
        ok: false, leadId: lead.id, syncStatus: lead.syncStatus as SyncStatus || 'failed',
        conflict: 'existing_sfJobId_differs',
        conflictDetail: `lead.sfJobId=${lead.sfJobId} != input=${req.sfJobId}`,
      };
    }

    const now = new Date();
    const occurredAt = req.occurredAt ? new Date(req.occurredAt) : now;
    const reason = req.reason
      ? `manual_link:${req.reason.slice(0, 100)}`
      : `manual_link_by_admin:${actorUserId.slice(0, 8)}`;

    // 1. Write the link (idempotent if sfJobId matches).
    await this.prisma.lead.update({
      where: { id: lead.id },
      data: {
        sfJobId: req.sfJobId,
        sfCustomerId: req.sfCustomerId ?? lead.sfCustomerId ?? null,
        sfJobMappedAt: lead.sfJobMappedAt ?? now,
        syncStatus: 'linked',
        syncAttemptedAt: now,
        syncReason: reason,
      },
    });

    // 2. Optionally update LB status from SF-supplied status. Routes
    //    through writeStatus so downgrade/dedup guards apply.
    let statusUpdated = false;
    let newStatus: string | undefined;
    if (req.sfStatus || req.sfPaymentStatus) {
      const rawSf = req.sfPaymentStatus === 'paid' ? 'paid' : (req.sfStatus ?? '');
      const canonical = mapSfStatus(rawSf);
      if (canonical) {
        const r = await this.leadStatus.writeStatus({
          leadId: lead.id,
          newStatus: canonical,
          source: 'service_flow',
          occurredAt,
          sourceEventId: `manual_link:${actorUserId.slice(0, 8)}:${lead.id.slice(0, 8)}:${occurredAt.getTime()}`,
          actorType: 'admin',
          actorId: actorUserId,
          actorName: 'manual_link',
          extraLeadUpdates: { sfLastEventAt: occurredAt },
        });
        statusUpdated = !!r.applied;
        if (r.applied) newStatus = canonical;
      }
    }

    this.logger.log(
      `[SfHistoricalSync] event=manual_link lead_id=${lead.id} sf_job_id=${req.sfJobId} ` +
        `sf_customer_id=${req.sfCustomerId ?? 'null'} status_updated=${statusUpdated} ` +
        `new_status=${newStatus ?? 'unchanged'} actor=${actorUserId}`,
    );

    return {
      ok: true, leadId: lead.id, syncStatus: 'linked',
      linkedSfJobId: req.sfJobId,
      statusUpdated,
      newStatus,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // Bulk link — receiver endpoint (SF posts back match results)
  // ═══════════════════════════════════════════════════════════════════

  async applyBulkLink(req: BulkLinkRequest): Promise<BulkLinkResponse> {
    const rows: BulkLinkRowResult[] = [];
    let linked = 0, needsReview = 0, noMatch = 0, conflict = 0, notFound = 0, failed = 0, statusUpdates = 0;

    for (const row of req.rows ?? []) {
      try {
        const lead = await this.prisma.lead.findUnique({ where: { id: row.lb_lead_id } });
        if (!lead) {
          notFound++;
          rows.push({ lb_lead_id: row.lb_lead_id, result: 'not_found', sync_status: null, detail: 'lead_not_found' });
          continue;
        }

        // Confidence handling:
        //   exact|high  → auto-link
        //   medium|low  → needs_review (don't write sfJobId)
        //   none        → no_match (sfJobId stays null, syncStatus moves)
        if (row.confidence === 'none') {
          await this.prisma.lead.update({
            where: { id: lead.id },
            data: { syncStatus: 'no_match', syncReason: `sf_no_match:${row.match_basis}`, syncAttemptedAt: new Date() },
          });
          noMatch++;
          rows.push({ lb_lead_id: lead.id, result: 'no_match', sync_status: 'no_match' });
          continue;
        }
        if (row.confidence === 'medium' || row.confidence === 'low') {
          await this.prisma.lead.update({
            where: { id: lead.id },
            data: { syncStatus: 'needs_review', syncReason: `sf_${row.confidence}_confidence:${row.match_basis}`, syncAttemptedAt: new Date() },
          });
          needsReview++;
          rows.push({ lb_lead_id: lead.id, result: 'needs_review', sync_status: 'needs_review',
            detail: `sf_proposed_job_id=${row.sf_job_id}` });
          continue;
        }

        // exact | high → auto-link, with safeguard.
        if (lead.sfJobId && lead.sfJobId !== row.sf_job_id) {
          conflict++;
          rows.push({ lb_lead_id: lead.id, result: 'conflict', sync_status: lead.syncStatus as SyncStatus | null,
            detail: `existing_sfJobId=${lead.sfJobId}_differs_from_input=${row.sf_job_id}` });
          continue;
        }
        const now = new Date();
        const occurredAt = row.occurred_at ? new Date(row.occurred_at) : now;
        await this.prisma.lead.update({
          where: { id: lead.id },
          data: {
            sfJobId: row.sf_job_id,
            sfCustomerId: row.sf_customer_id ?? lead.sfCustomerId ?? null,
            sfJobMappedAt: lead.sfJobMappedAt ?? now,
            syncStatus: 'linked',
            syncReason: `sf_${row.confidence}_${row.match_basis}` + (row.reason ? `:${row.reason.slice(0, 80)}` : ''),
            syncAttemptedAt: now,
          },
        });
        linked++;

        // Apply SF status if supplied.
        let statusUpdated = false;
        let newStatus: string | undefined;
        if (row.sf_status || row.sf_payment_status) {
          const rawSf = row.sf_payment_status === 'paid' ? 'paid' : (row.sf_status ?? '');
          const canonical = mapSfStatus(rawSf);
          if (canonical) {
            const r = await this.leadStatus.writeStatus({
              leadId: lead.id,
              newStatus: canonical,
              source: 'service_flow',
              occurredAt,
              sourceEventId: `bulk_link:${row.sf_job_id}:${occurredAt.getTime()}`,
              actorType: 'sf_reconcile',
              actorId: row.sf_customer_id ?? null,
              actorName: 'bulk_link_receiver',
              extraLeadUpdates: { sfLastEventAt: occurredAt },
            });
            statusUpdated = !!r.applied;
            if (r.applied) { newStatus = canonical; statusUpdates++; }
          }
        }
        rows.push({ lb_lead_id: lead.id, result: 'linked', sync_status: 'linked',
          status_updated: statusUpdated, new_status: newStatus });
      } catch (e: any) {
        failed++;
        rows.push({ lb_lead_id: row.lb_lead_id, result: 'failed', sync_status: 'failed',
          detail: (e?.message ?? 'unknown').slice(0, 120) });
      }
    }

    this.logger.log(
      `[SfHistoricalSync] event=bulk_link rows=${req.rows?.length ?? 0} linked=${linked} ` +
        `needs_review=${needsReview} no_match=${noMatch} conflict=${conflict} not_found=${notFound} ` +
        `failed=${failed} status_updates=${statusUpdates}`,
    );

    return {
      ok: failed === 0,
      summary: {
        total: req.rows?.length ?? 0,
        linked, needs_review: needsReview, no_match: noMatch,
        conflict, not_found: notFound, failed, status_updates_applied: statusUpdates,
      },
      rows,
    };
  }
}
