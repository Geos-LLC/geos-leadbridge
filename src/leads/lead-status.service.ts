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

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '../../generated/prisma';
import { PrismaService } from '../common/utils/prisma.service';
import {
  AUTOMATION_TERMINAL,
  HARD_TERMINAL,
  isCanonicalStatus,
  isPipelineDowngrade,
} from './canonical-status';

export type StatusSource =
  | 'service_flow'
  | 'platform_sync'
  | 'manual'
  | 'lb_automation';

export type ConflictKind = 'sf_push_needed' | 'platform_nudge_needed';

/**
 * Reasons writeStatus may return applied=false. Each maps to a guard in
 * writeStatus(). Callers can use this to log/diagnose silent skips without
 * inspecting log lines.
 */
export type WriteSkipReason =
  | 'no_change'
  | 'invalid_status'
  | 'hard_terminal'
  | 'sf_protected'
  | 'automation_terminal'
  | 'pipeline_downgrade'
  | 'duplicate'
  | 'stale_event';

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
  /**
   * Reason for the transition. Persisted on the audit row. For lost
   * transitions this typically mirrors lostReason; for non-lost transitions
   * it's a freeform note like 'customer_replied' or 'price_quoted'.
   */
  reason?: string | null;
  /**
   * Reason the lead was lost. Persisted on `Lead.lostReason` AND mirrored
   * onto the audit row's `reason` field when `reason` is not provided.
   * Cleared automatically when transitioning out of `lost`.
   *   'opt_out' | 'hired_someone' | 'no_response' | 'manual'
   */
  lostReason?: string | null;
  /**
   * When this lead becomes a re-engage candidate. Pass `null` to clear,
   * `Date` to set, omit to leave unchanged. Cleared automatically when
   * transitioning out of `lost`.
   */
  reengageAt?: Date | null;
  /** Free-form metadata persisted on the audit row. */
  metadata?: Record<string, any> | null;
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
  /** Set when applied=false, identifying which guard rejected the write. */
  skipReason?: WriteSkipReason;
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
  { lb: 'booked', platform: 'hired' },
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

  /**
   * Whether SF holds canonical-status authority for this lead's owning user.
   *
   * Resolution order:
   *   1. If `SF_STATUS_WINS_USER_IDS` (csv) is non-empty → SF authority is
   *      active *only* for users in that list. Empty fallback to global is
   *      intentional: an explicit allowlist overrides the global flag so a
   *      partial rollout cannot be widened by accidentally leaving the global
   *      switch on.
   *   2. If the allowlist is empty → fall back to global `SF_STATUS_WINS`.
   *
   * Returns `false` for any non-SF-linked lead at the call site (callers gate
   * on `lead.sfJobId` before invoking this).
   */
  private isSfAuthorityActive(userId: string): boolean {
    const csv = this.config.get<string>('SF_STATUS_WINS_USER_IDS', '') ?? '';
    const scoped = csv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (scoped.length > 0) {
      return scoped.includes(userId);
    }
    return this.config.get<string>('SF_STATUS_WINS', 'false') === 'true';
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
  ) {}

  /**
   * Write a status for a lead. Routes through 8 guards (see WriteSkipReason)
   * before mutating, then writes Lead.status + audit log + (manual writes
   * only) a conflict SSE event.
   *
   * Guard order:
   *   1. same-status no-op
   *   2. canonical validation
   *   3. hard-terminal (blocks all sources)
   *   4. SF_STATUS_WINS protection (lb_automation only)
   *   5. automation-terminal (lb_automation only)
   *   6. pipeline-downgrade
   *   7. dedup by (leadId, source, sourceEventId)
   *   8. stale-event (occurredAt < lead.statusUpdatedAt)
   *
   * Manual override rule:
   *   manual writes are allowed against SF-linked leads, but produce a
   *   `sf_push_needed` conflict on the audit row so operators are prompted
   *   to push the change to SF.
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
        lostReason: true,
        reengageAt: true,
      },
    });
    if (!lead) {
      throw new Error(`Lead ${input.leadId} not found`);
    }

    const occurredAt = input.occurredAt || new Date();

    if (input.source === 'platform_sync') {
      return this.applyPlatformSync(lead, input, occurredAt);
    }

    if (!input.newStatus) {
      throw new Error(`newStatus is required when source=${input.source}`);
    }

    const newStatus = input.newStatus;
    const oldStatus = lead.status;

    // ── Guard 1: same-status no-op ────────────────────────────────────────
    // No audit row, no SSE — keeps the activity timeline noise-free when
    // a webhook retry / extension re-sync hands us the same status.
    if (newStatus === oldStatus) {
      return this.skipped(lead, 'no_change');
    }

    // ── Guard 2: canonical validation ─────────────────────────────────────
    if (!isCanonicalStatus(newStatus)) {
      throw new BadRequestException(
        `Invalid status "${newStatus}". Must be one of the canonical set; see canonical-status.ts.`,
      );
    }

    // ── Guard 3: hard-terminal blocks all sources ─────────────────────────
    if (HARD_TERMINAL.has(oldStatus)) {
      this.logger.warn(
        `[LeadStatus] hard_terminal — blocked ${input.source} write ${oldStatus}→${newStatus} on lead ${lead.id}`,
      );
      return this.skipped(lead, 'hard_terminal');
    }

    // ── Guard 4: SF_STATUS_WINS protection (lb_automation only) ───────────
    // Manual is intentionally allowed; it produces a sf_push_needed conflict
    // below so the operator pushes to SF.
    // Authority can be globally enabled (SF_STATUS_WINS=true) or scoped to a
    // csv allowlist (SF_STATUS_WINS_USER_IDS). See isSfAuthorityActive().
    const sfActive = lead.sfJobId ? this.isSfAuthorityActive(lead.userId) : false;
    if (sfActive && input.source === 'lb_automation') {
      this.logger.log(
        `[LeadStatus] sf_protected — blocked lb_automation write on SF-linked lead ${lead.id} (sfJobId=${lead.sfJobId}, userId=${lead.userId})`,
      );
      return this.skipped(lead, 'sf_protected');
    }

    // ── Guard 5: automation-terminal (lb_automation only) ─────────────────
    // Manual + SF can still transition out of these (e.g. operator marks
    // a `lost` lead as `engaged` after a re-engagement reply).
    if (AUTOMATION_TERMINAL.has(oldStatus) && input.source === 'lb_automation') {
      this.logger.log(
        `[LeadStatus] automation_terminal — blocked lb_automation write ${oldStatus}→${newStatus} on lead ${lead.id}`,
      );
      return this.skipped(lead, 'automation_terminal');
    }

    // ── Guard 6: pipeline-downgrade ───────────────────────────────────────
    // Off-pipeline transitions (anything involving a terminal) are exempt
    // because terminals are not in PIPELINE_ORDER.
    if (isPipelineDowngrade(oldStatus, newStatus)) {
      this.logger.log(
        `[LeadStatus] pipeline_downgrade — blocked ${input.source} write ${oldStatus}→${newStatus} on lead ${lead.id}`,
      );
      return this.skipped(lead, 'pipeline_downgrade');
    }

    // ── Guard 7: dedup by sourceEventId ───────────────────────────────────
    // Skipped when sourceEventId is null (operator clicks have no event id).
    if (input.sourceEventId) {
      const dup = await this.prisma.leadStatusAuditLog.findFirst({
        where: {
          leadId: lead.id,
          source: input.source,
          sourceEventId: input.sourceEventId,
        },
        select: { id: true },
      });
      if (dup) {
        this.logger.log(
          `[LeadStatus] duplicate — already saw (${input.source}, ${input.sourceEventId}) on lead ${lead.id}`,
        );
        return this.skipped(lead, 'duplicate');
      }
    }

    // ── Guard 8: stale-event (occurredAt < lead.statusUpdatedAt) ──────────
    // Prevents an old webhook retry from overwriting a newer state.
    if (lead.statusUpdatedAt && occurredAt < lead.statusUpdatedAt) {
      this.logger.warn(
        `[LeadStatus] stale_event — ${input.source} occurredAt=${occurredAt.toISOString()} < lead.statusUpdatedAt=${lead.statusUpdatedAt.toISOString()} on lead ${lead.id}`,
      );
      return this.skipped(lead, 'stale_event');
    }

    // ── All guards passed; apply the write ────────────────────────────────
    // Compute lostReason / reengageAt projections:
    //   - transitioning INTO 'lost' → set from input (or default 'manual')
    //   - transitioning OUT of 'lost' → clear both columns
    //   - all other transitions → leave both columns untouched
    let lostReasonUpdate: { lostReason: string | null } | undefined;
    let reengageAtUpdate: { reengageAt: Date | null } | undefined;
    if (newStatus === 'lost') {
      lostReasonUpdate = {
        lostReason: input.lostReason ?? (input.source === 'manual' ? 'manual' : null),
      };
      if (input.reengageAt !== undefined) {
        reengageAtUpdate = { reengageAt: input.reengageAt };
      }
    } else if (oldStatus === 'lost') {
      lostReasonUpdate = { lostReason: null };
      reengageAtUpdate = { reengageAt: null };
    }

    const auditReason = input.reason ?? input.lostReason ?? null;

    const { conflict, auditLogId } = await this.prisma.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: lead.id },
        data: {
          status: newStatus,
          statusSource: input.source,
          statusUpdatedAt: occurredAt,
          ...(lostReasonUpdate || {}),
          ...(reengageAtUpdate || {}),
          ...(input.extraLeadUpdates || {}),
        },
      });

      // Conflict detection: manual writes only.
      let conflictInfo: ConflictInfo | null = null;
      let conflictFlag = false;
      let conflictNote: string | null = null;
      let conflictKind: ConflictKind | null = null;

      if (input.source === 'manual') {
        if (lead.sfJobId) {
          conflictFlag = true;
          conflictKind = 'sf_push_needed';
          conflictNote = `Manual status change to "${newStatus}" — push to Service Flow (job ${lead.sfJobId}).`;
        } else {
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
          activityType: 'status_changed',
          oldStatus,
          newStatus,
          source: input.source,
          sourceEventId: input.sourceEventId ?? null,
          actorType: input.actorType ?? null,
          actorId: input.actorId ?? null,
          actorName: input.actorName ?? null,
          reason: auditReason,
          metadata: input.metadata ?? Prisma.JsonNull,
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

  /** Build a skip result without mutating anything. */
  private skipped(
    lead: { id: string; status: string; platformStatus: string | null },
    reason: WriteSkipReason,
  ): WriteStatusResult {
    return {
      leadId: lead.id,
      applied: false,
      status: lead.status,
      platformStatus: lead.platformStatus,
      conflict: null,
      auditLogId: null,
      skipReason: reason,
    };
  }

  /**
   * Apply a platform-sync update. Platform signal is the source of truth for
   * the platform-native column; the canonical Lead.status is also updated
   * unless SF_STATUS_WINS is on AND the lead is SF-mapped (SF owns the
   * canonical status in that mode — platformStatus still flows through).
   *
   *   - Lead.platformStatus ← input.platformStatus (always when changed)
   *   - Lead.status         ← input.newStatus (subject to SF protection,
   *                           same-value skip, downgrade guard)
   *
   * Never flags a conflict. Conflicts only arise from manual writes.
   */
  private async applyPlatformSync(
    lead: {
      id: string;
      userId: string;
      platform: string;
      status: string;
      platformStatus: string | null;
      thumbtackStatus: string | null;
      sfJobId: string | null;
      statusUpdatedAt: Date | null;
    },
    input: WriteStatusInput,
    occurredAt: Date,
  ): Promise<WriteStatusResult> {
    if (!input.platformStatus && !input.newStatus) {
      throw new Error(`platformStatus or newStatus is required for source=platform_sync`);
    }

    // Stale-event guard: drop platform_sync writes that pre-date the last
    // accepted status transition (out-of-order webhook retries).
    if (lead.statusUpdatedAt && occurredAt < lead.statusUpdatedAt) {
      this.logger.warn(
        `[LeadStatus] stale_event — platform_sync occurredAt=${occurredAt.toISOString()} < lead.statusUpdatedAt=${lead.statusUpdatedAt.toISOString()} on lead ${lead.id}`,
      );
      return this.skipped(lead, 'stale_event');
    }

    // Dedup: if we already saw this exact (source, sourceEventId), skip.
    if (input.sourceEventId) {
      const dup = await this.prisma.leadStatusAuditLog.findFirst({
        where: {
          leadId: lead.id,
          source: 'platform_sync',
          sourceEventId: input.sourceEventId,
        },
        select: { id: true },
      });
      if (dup) {
        return this.skipped(lead, 'duplicate');
      }
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

    // Lead.status write: gated by canonical validation, downgrade guard,
    // hard-terminal, completed-lock, and SF protection.
    let lbStatusBlocked: WriteSkipReason | null = null;
    if (input.newStatus && input.newStatus !== oldLbStatus) {
      const sfActive = lead.sfJobId ? this.isSfAuthorityActive(lead.userId) : false;
      if (!isCanonicalStatus(input.newStatus)) {
        lbStatusBlocked = 'invalid_status';
      } else if (HARD_TERMINAL.has(oldLbStatus)) {
        lbStatusBlocked = 'hard_terminal';
      } else if (sfActive) {
        // SF owns the canonical status when integrated; platformStatus still flows.
        lbStatusBlocked = 'sf_protected';
      } else if (oldLbStatus === 'completed') {
        // Completed is a hard floor for platform_sync — once completed, the
        // platform cannot move the canonical status (forward to a non-existent
        // higher rank, backward to active pipeline, or sideways into terminals
        // like `lost`/`cancelled`). Manual + SF override paths are unaffected.
        lbStatusBlocked = 'pipeline_downgrade';
      } else if (isPipelineDowngrade(oldLbStatus, input.newStatus)) {
        lbStatusBlocked = 'pipeline_downgrade';
      } else {
        data.status = input.newStatus;
        data.statusSource = 'platform_sync';
        data.statusUpdatedAt = occurredAt;
      }
    }

    if (Object.keys(data).length === 0) {
      // Nothing to write — newStatus blocked AND platformStatus unchanged.
      const skipReason = lbStatusBlocked ?? 'no_change';
      return this.skipped(lead, skipReason);
    }

    await this.prisma.lead.update({ where: { id: lead.id }, data });

    const audit = await this.prisma.leadStatusAuditLog.create({
      data: {
        leadId: lead.id,
        activityType: 'status_changed',
        oldStatus: data.status ? oldLbStatus : oldPlatform ?? null,
        newStatus: data.status ?? input.platformStatus!,
        source: 'platform_sync',
        sourceEventId: input.sourceEventId ?? null,
        actorType: input.actorType ?? null,
        actorId: input.actorId ?? null,
        actorName: input.actorName ?? null,
        reason: input.reason ?? null,
        metadata: input.metadata ?? Prisma.JsonNull,
        conflict: false,
        conflictNote: null,
        occurredAt,
      },
    });

    if (lbStatusBlocked) {
      // Partial-skip: platformStatus was written but canonical Lead.status
      // was held back by a guard. Log greppably so operators can confirm the
      // guard fired (search Loki for `skipReason=pipeline_downgrade` etc.).
      this.logger.log(
        `[LeadStatus] platform_sync skipReason=${lbStatusBlocked} lead=${lead.id} platform=${lead.platform} attempted=${input.newStatus} current=${oldLbStatus} platformStatus=${input.platformStatus ?? 'null'}`,
      );
    } else {
      this.logger.log(
        `[LeadStatus] platform_sync applied lead=${lead.id} platform=${lead.platform} status=${input.newStatus ?? oldLbStatus} platformStatus=${input.platformStatus ?? oldPlatform ?? 'null'}`,
      );
    }

    return {
      leadId: lead.id,
      applied: true,
      status: data.status ?? oldLbStatus,
      platformStatus: data.platformStatus ?? oldPlatform ?? null,
      conflict: null,
      auditLogId: audit.id,
      skipReason: lbStatusBlocked ?? undefined,
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
