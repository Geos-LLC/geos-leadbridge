/**
 * Lead Status Service
 *
 * Single write path for Lead.status / Lead.platformStatus with conflict
 * detection. Replaces ad-hoc `prisma.lead.update({ status })` calls so every
 * write gets an audit log and (for manual writes) a conflict check against
 * upstream sources.
 *
 * Conflict rules (user-specified, 2026-04-20):
 *  - source=service_flow → silent overwrite of Lead.status (no conflict).
 *  - source=platform_sync → silent overwrite of Lead.platformStatus only (no conflict).
 *  - source=manual:
 *      • SF integrated (lead.sfJobId is set)  → conflict: push to SF.
 *      • platformStatus diverges from new     → conflict: nudge to update platform.
 *      • else                                 → no conflict, just write.
 *  - source=lb_automation → silent write.
 *
 * Conflicts are recorded as LeadStatusAuditLog rows with conflict=true +
 * conflictNote. The frontend lists unresolved conflicts and shows a modal.
 */

import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/utils/prisma.service';

export type StatusSource =
  | 'service_flow'
  | 'platform_sync'
  | 'manual'
  | 'lb_automation';

export type ConflictKind = 'sf_push_needed' | 'platform_nudge_needed';

export interface ConflictInfo {
  kind: ConflictKind;
  auditLogId: string;
  note: string;
  /** Only set for platform_nudge_needed: which platform + its last-known status */
  platform?: string;
  platformStatus?: string | null;
  /** Only set for sf_push_needed: the sf_job_id that should be nudged */
  sfJobId?: string | null;
}

export interface WriteStatusInput {
  leadId: string;
  /** The new canonical pipeline status. Ignored when source=platform_sync. */
  newStatus?: string;
  /** Platform-native status (Thumbtack "Hired", Yelp "Done", etc.). Only for source=platform_sync. */
  platformStatus?: string;
  source: StatusSource;
  occurredAt?: Date;
  actorType?: string | null;
  actorId?: string | null;
  actorName?: string | null;
  sourceEventId?: string | null;
  /** Additional updates that should be written in the same transaction (e.g. sfJobId, sfLastEventAt). */
  extraLeadUpdates?: Record<string, any>;
}

export interface WriteStatusResult {
  leadId: string;
  applied: boolean;
  /** Status as written (or current status if applied=false). */
  status: string;
  platformStatus: string | null;
  conflict: ConflictInfo | null;
  auditLogId: string | null;
}

/**
 * Pairs of canonical LB status ↔ platform-native values that are considered
 * equivalent. If the pair matches, platformStatus disagreement is NOT a conflict.
 * Keep in sync with §2.3 of plans/2026-04-17-job-sync-sf-lb.md.
 */
const CONSISTENT_PAIRS: Array<{ lb: string; platform: string }> = [
  { lb: 'completed', platform: 'hired' },
  { lb: 'completed', platform: 'job complete' },
  { lb: 'completed', platform: 'done' },
  { lb: 'in_progress', platform: 'hired' },
  { lb: 'scheduled', platform: 'scheduled' },
  { lb: 'scheduled', platform: 'job scheduled' },
  { lb: 'lost', platform: 'not hired' },
  { lb: 'lost', platform: 'closed' },
  { lb: 'lost', platform: 'no response' },
  { lb: 'archived', platform: 'archived' },
  { lb: 'cancelled', platform: 'cancelled' },
];

function statusesAreConsistent(lb: string, platform: string): boolean {
  const lbNorm = lb.toLowerCase().trim();
  const platNorm = platform.toLowerCase().trim().replace(/_/g, ' ');
  if (lbNorm === platNorm) return true;
  return CONSISTENT_PAIRS.some((p) => p.lb === lbNorm && p.platform === platNorm);
}

@Injectable()
export class LeadStatusService {
  private readonly logger = new Logger(LeadStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Write a status for a lead, enforcing the conflict rules and producing
   * an audit log + (if applicable) a conflict SSE event.
   */
  async writeStatus(input: WriteStatusInput): Promise<WriteStatusResult> {
    const lead = await this.prisma.lead.findUnique({
      where: { id: input.leadId },
      select: {
        id: true,
        userId: true,
        status: true,
        platform: true,
        platformStatus: true,
        platformStatusAt: true,
        statusUpdatedAt: true,
        statusSource: true,
        sfJobId: true,
        thumbtackStatus: true,
      },
    });
    if (!lead) {
      throw new Error(`Lead ${input.leadId} not found`);
    }

    const occurredAt = input.occurredAt || new Date();

    if (input.source === 'platform_sync') {
      return this.applyPlatformSync(lead, input, occurredAt);
    }

    // lb_automation uses the same write path as manual but without conflict
    // detection (automation never prompts operators for confirmation).

    // All other sources write to Lead.status
    if (!input.newStatus) {
      throw new Error(`newStatus is required when source=${input.source}`);
    }

    const newStatus = input.newStatus;
    const oldStatus = lead.status;

    if (newStatus === oldStatus && input.source !== 'manual') {
      // No-op for non-manual sources; manual still goes through so conflict
      // detection runs (user may have clicked to force-acknowledge).
      return {
        leadId: lead.id,
        applied: false,
        status: oldStatus,
        platformStatus: lead.platformStatus,
        conflict: null,
        auditLogId: null,
      };
    }

    // Write lead.status transactionally with the audit row so we can flag
    // conflict=true atomically.
    const { conflict, auditLogId } = await this.prisma.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: lead.id },
        data: {
          status: newStatus,
          statusSource: input.source,
          statusUpdatedAt: occurredAt,
          ...(input.extraLeadUpdates || {}),
        },
      });

      // Conflict detection only fires for manual writes (per §2.3 rules).
      let conflictInfo: ConflictInfo | null = null;
      let conflictFlag = false;
      let conflictNote: string | null = null;
      let conflictKind: ConflictKind | null = null;

      if (input.source === 'manual') {
        // Rule: SF integrated + manual write → conflict (operator must confirm push).
        if (lead.sfJobId) {
          conflictFlag = true;
          conflictKind = 'sf_push_needed';
          conflictNote = `Manual status change to "${newStatus}" — push to Service Flow (job ${lead.sfJobId}).`;
        } else {
          // Rule: platform status diverges → conflict (operator must update on platform).
          const platVal = lead.platformStatus || lead.thumbtackStatus;
          if (platVal && !statusesAreConsistent(newStatus, platVal)) {
            conflictFlag = true;
            conflictKind = 'platform_nudge_needed';
            conflictNote = `Manual status "${newStatus}" diverges from ${lead.platform} status "${platVal}" — update on platform.`;
          }
        }
      }

      const audit = await tx.leadStatusAuditLog.create({
        data: {
          leadId: lead.id,
          oldStatus,
          newStatus,
          source: input.source,
          sourceEventId: input.sourceEventId ?? null,
          actorType: input.actorType ?? null,
          actorId: input.actorId ?? null,
          actorName: input.actorName ?? null,
          conflict: conflictFlag,
          conflictNote,
          occurredAt,
        },
      });

      if (conflictFlag && conflictKind) {
        conflictInfo = {
          kind: conflictKind,
          auditLogId: audit.id,
          note: conflictNote ?? '',
          sfJobId: conflictKind === 'sf_push_needed' ? lead.sfJobId : null,
          platform: conflictKind === 'platform_nudge_needed' ? lead.platform : undefined,
          platformStatus: conflictKind === 'platform_nudge_needed'
            ? (lead.platformStatus || lead.thumbtackStatus) ?? null
            : undefined,
        };
      }

      return { conflict: conflictInfo, auditLogId: audit.id };
    });

    if (conflict) {
      // Notify the frontend via SSE — Messages / Leads page can react.
      this.events.emit(`lead.status.conflict.${lead.userId}`, {
        leadId: lead.id,
        userId: lead.userId,
        conflict,
      });
      this.logger.warn(
        `[LeadStatus] Conflict on lead ${lead.id}: ${conflict.kind} — ${conflict.note}`,
      );
    }

    this.logger.log(
      `[LeadStatus] ${input.source} wrote ${oldStatus}→${newStatus} on lead ${lead.id}${conflict ? ' (CONFLICT)' : ''}`,
    );

    return {
      leadId: lead.id,
      applied: true,
      status: newStatus,
      platformStatus: lead.platformStatus,
      conflict,
      auditLogId,
    };
  }

  /**
   * Apply a platform-sync update. Platform signal is "source of truth" per
   * the user's model (rule #3): platform → LB silent overwrite.
   *   - Lead.platformStatus ← input.platformStatus (raw platform-native value)
   *   - Lead.status         ← input.newStatus (canonical, if provided)
   *
   * Never flags as a conflict. Manual writes are the only source that can
   * create a conflict (against an already-set platformStatus).
   */
  private async applyPlatformSync(
    lead: { id: string; platform: string; status: string; platformStatus: string | null; thumbtackStatus: string | null },
    input: WriteStatusInput,
    occurredAt: Date,
  ): Promise<WriteStatusResult> {
    if (!input.platformStatus && !input.newStatus) {
      throw new Error(`platformStatus or newStatus is required for source=platform_sync`);
    }

    const oldPlatform = lead.platformStatus || lead.thumbtackStatus;
    const oldLbStatus = lead.status;

    const data: any = { ...(input.extraLeadUpdates || {}) };

    if (input.platformStatus && oldPlatform !== input.platformStatus) {
      data.platformStatus = input.platformStatus;
      data.platformStatusAt = occurredAt;
      if (lead.platform === 'thumbtack') {
        data.thumbtackStatus = input.platformStatus;
      }
    }
    if (input.newStatus && input.newStatus !== oldLbStatus) {
      data.status = input.newStatus;
      data.statusSource = 'platform_sync';
      data.statusUpdatedAt = occurredAt;
    }

    if (Object.keys(data).length === 0) {
      // Nothing changed.
      return {
        leadId: lead.id,
        applied: false,
        status: oldLbStatus,
        platformStatus: oldPlatform ?? null,
        conflict: null,
        auditLogId: null,
      };
    }

    await this.prisma.lead.update({ where: { id: lead.id }, data });

    // Audit row records whichever field actually changed (prefer lb status
    // transition; fall back to platform status transition).
    const audit = await this.prisma.leadStatusAuditLog.create({
      data: {
        leadId: lead.id,
        oldStatus: input.newStatus ? oldLbStatus : oldPlatform ?? null,
        newStatus: input.newStatus ?? input.platformStatus!,
        source: 'platform_sync',
        sourceEventId: input.sourceEventId ?? null,
        actorType: input.actorType ?? null,
        actorId: input.actorId ?? null,
        actorName: input.actorName ?? null,
        conflict: false,
        conflictNote: null,
        occurredAt,
      },
    });

    this.logger.log(
      `[LeadStatus] platform_sync on ${lead.platform} lead ${lead.id} → ${JSON.stringify({
        status: input.newStatus,
        platformStatus: input.platformStatus,
      })}`,
    );

    return {
      leadId: lead.id,
      applied: true,
      status: data.status ?? oldLbStatus,
      platformStatus: data.platformStatus ?? oldPlatform ?? null,
      conflict: null,
      auditLogId: audit.id,
    };
  }

  /**
   * List unresolved conflicts (conflict=true and not yet resolved) for a lead.
   * The modal on the lead page polls this.
   */
  async listConflicts(leadId: string): Promise<ConflictInfo[]> {
    const rows = await this.prisma.leadStatusAuditLog.findMany({
      where: { leadId, conflict: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
      select: { platform: true, platformStatus: true, thumbtackStatus: true, sfJobId: true },
    });
    return rows.map((r) => {
      const isSf = r.conflictNote?.includes('Service Flow');
      const kind: ConflictKind = isSf ? 'sf_push_needed' : 'platform_nudge_needed';
      return {
        kind,
        auditLogId: r.id,
        note: r.conflictNote ?? '',
        sfJobId: kind === 'sf_push_needed' ? lead?.sfJobId ?? null : null,
        platform: kind === 'platform_nudge_needed' ? lead?.platform : undefined,
        platformStatus: kind === 'platform_nudge_needed'
          ? (lead?.platformStatus || lead?.thumbtackStatus) ?? null
          : undefined,
      };
    });
  }

  /**
   * Mark a conflict audit row as resolved. The audit row stays, conflict flag flips off.
   * resolveNote records what the operator chose (e.g. "kept_manual", "accepted_sf").
   */
  async resolveConflict(auditLogId: string, resolveNote: string): Promise<void> {
    await this.prisma.leadStatusAuditLog.updateMany({
      where: { id: auditLogId, conflict: true },
      data: {
        conflict: false,
        conflictNote: resolveNote,
      },
    });
  }
}
