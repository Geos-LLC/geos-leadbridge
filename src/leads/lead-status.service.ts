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

import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '../../generated/prisma';
import { PrismaService } from '../common/utils/prisma.service';
import { IntegrationMetricsService } from '../integrations/health/integration-metrics.service';
import {
  AUTOMATION_TERMINAL,
  HARD_TERMINAL,
  isCanonicalStatus,
  isPipelineDowngrade,
} from './canonical-status';
import { isSfLinkedLead } from './sf-link';

/**
 * Canonical statuses SF may transition a lead INTO via the archived-reactivation
 * carve-out (Guard 3 exception). Restricted to fulfillment lifecycle states —
 * pre-fulfillment values (new/contacted/engaged/quoted) are excluded because a
 * real SF job implies post-acquisition work; reactivating archived into the
 * funnel would corrupt funnel metrics. `lost` is excluded as a sideways terminal
 * swap with no useful semantics, and `archived → archived` is a no-op.
 *
 * This allowlist is consulted ONLY when source === 'service_flow'. Every other
 * source (platform_sync, lb_automation, manual, backfill) remains hard-blocked
 * by the HARD_TERMINAL guard.
 */
const SF_REACTIVATION_TARGETS: ReadonlySet<string> = new Set([
  'booked',
  'scheduled',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
]);

export type StatusSource =
  | 'service_flow'
  | 'platform_sync'
  | 'manual'
  | 'lb_automation'
  // One-off canonical-status backfill (Phase 4). Flows through writeStatus's
  // main path: dedup by (leadId, source, sourceEventId) makes re-runs no-ops,
  // canonical-validation guard rejects bad mappings, audit row is created.
  // Does NOT trigger conflict detection (manual-only) or SF protection
  // (lb_automation-only). Callers must still skip SF-linked leads themselves.
  | 'backfill';

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
  // SF-connected mode: a normal-user manual write on an SF-linked lead is
  // rejected because SF owns lifecycle. Admin/support paths bypass by
  // passing WriteStatusInput.adminOverride=true.
  | 'sf_managed'
  // Platform_sync attempted to mark a lead `lost`/`archived` while the lead
  // is already linked to SF (sfJobId set, sfCustomerId set, or
  // syncStatus='linked'). SF owns lifecycle for linked leads — a
  // marketplace archive event must not downgrade them. The platformStatus
  // column still flows through; only the canonical Lead.status is held back.
  | 'sf_link_protected'
  // SF-connected mode: lb_automation tried to mutate Lead.status to a
  // terminal (lost / booked) on an SF-linked lead. Recorded for audit; the
  // intent is still tracked in conversation runtime + the audit log, but
  // the canonical status stays put because SF owns lifecycle.
  | 'sf_linked_customer'
  // lb_automation tried to write a lifecycle terminal it is NOT permitted
  // to author. Per the lifecycle rule (spec 2026-06-17):
  //   - lb_automation may write `lost` with lostReason='opt_out'.
  //   - lb_automation may write `lost` with lostReason='hired_someone' ONLY
  //     when the prior status is not booked / in_progress / completed
  //     (post-acquisition states the AI must not downgrade).
  //   - lb_automation may NOT write booked / completed / cancelled /
  //     no_show / in_progress / archived under any circumstance — those
  //     are real-world outcomes only SF, platform_sync, or manual can
  //     report. Gate side-effects (stop sequence, fire handoff) still
  //     execute; only the canonical Lead.status write is suppressed.
  | 'automation_forbidden_destination'
  | 'automation_terminal'
  | 'pipeline_downgrade'
  | 'duplicate'
  | 'stale_event'
  // Autonomous-booking carve-out path: a dispatcher_confirmed write arrived
  // for a lead whose owning user has an active sf_connection. SF owns the
  // lifecycle in that mode, so the LB autonomous detector must not flip the
  // canonical status. Logged distinctly so dashboards can confirm the
  // carve-out only fires in the intended mode.
  | 'sf_connected_autonomous_blocked';

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
  /**
   * Admin/support escape hatch. When true, the sf_managed guard (which
   * normally blocks `source='manual'` writes on SF-linked leads under an
   * active sf_connection) is bypassed. ONLY admin/support paths that have
   * already cleared a RequiresSupportGrant decorator should set this true.
   * Normal user-facing routes MUST leave this undefined/false.
   */
  adminOverride?: boolean;
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
    // Optional so existing unit tests that instantiate `new LeadStatusService(prisma, events, config)`
    // continue to compile without churn. In production DI always wires it.
    @Optional() private readonly metrics: IntegrationMetricsService | null = null,
  ) {}

  /**
   * Returns true when the given user has an active sf_connection. Powers the
   * autonomous-mode carve-outs (dispatcher_confirmed, appointment_date_passed)
   * which must never fire when SF owns the lifecycle.
   *
   * Single-shot DB read; callers gate this behind a carve-out shape check so
   * the hot path doesn't pay for it on every write.
   */
  private async hasActiveSfConnection(userId: string): Promise<boolean> {
    const conn = await this.prisma.sfConnection.findUnique({
      where: { userId },
      select: { isActive: true, status: true },
    });
    return !!(conn && conn.isActive && conn.status === 'active');
  }

  /**
   * Reschedule check (Risk #3 fix). Returns true when the incoming
   * appointmentAt is materially different (≥5 minutes apart) from the
   * appointmentAt on the latest dispatcher_confirmed audit row for this lead.
   * Used by the Guard 1 carve-out: if a new dispatcher confirmation message
   * carries a fresh appointment time we must accept a new audit row even when
   * Lead.status hasn't changed.
   *
   * Returns true when no prior dispatcher_confirmed audit row exists — that's
   * the first confirmation for this lead and is always "fresh" for sweeper
   * purposes, even when the canonical status is somehow already `booked` (e.g.
   * a manual mark before the detector ran).
   */
  private async isAppointmentRescheduled(
    leadId: string,
    incomingAppointmentAtIso: string,
  ): Promise<boolean> {
    if (!incomingAppointmentAtIso) return false;
    const incoming = new Date(incomingAppointmentAtIso);
    if (Number.isNaN(incoming.getTime())) return false;
    const latest = await this.prisma.leadStatusAuditLog.findFirst({
      where: {
        leadId,
        source: 'lb_automation',
        reason: 'dispatcher_confirmed',
      },
      orderBy: { occurredAt: 'desc' },
      select: { metadata: true },
    });
    if (!latest?.metadata || typeof latest.metadata !== 'object') return true;
    const priorRaw = (latest.metadata as any).appointmentAt;
    if (typeof priorRaw !== 'string' || !priorRaw) return true;
    const prior = new Date(priorRaw);
    if (Number.isNaN(prior.getTime())) return true;
    return Math.abs(incoming.getTime() - prior.getTime()) >= 5 * 60 * 1000;
  }

  /**
   * Standard k=v skip log. Loki-friendly — every guard rejection emits the
   * same shape so dashboards/alerts can filter on `skip_reason=`.
   */
  private logSkip(
    input: WriteStatusInput,
    leadId: string,
    oldStatus: string,
    newStatus: string,
    skipReason: WriteSkipReason,
    platformStatus: string | null,
    level: 'log' | 'warn' = 'log',
  ): void {
    const line = `[LeadStatus] event_id=${input.sourceEventId ?? 'null'} lead_id=${leadId} source=${input.source} result=skipped skip_reason=${skipReason} status=${oldStatus} platform_status=${platformStatus ?? 'null'} attempted=${newStatus}`;
    if (level === 'warn') this.logger.warn(line);
    else this.logger.log(line);
  }

  /**
   * Write a status for a lead. Routes through 8 guards (see WriteSkipReason)
   * before mutating, then writes Lead.status + audit log + (manual writes
   * only) a conflict SSE event.
   *
   * Guard order:
   *   1. same-status no-op
   *   2. canonical validation
   *   2b. SF-linked lb_automation lost/booked suppression (lb_automation only)
   *   3. hard-terminal (blocks all sources except service_flow on SF-linked
   *      leads via SF_REACTIVATION_TARGETS carve-out)
   *   4. SF_STATUS_WINS protection (lb_automation only)
   *   5. automation-terminal (lb_automation only)
   *   6. pipeline-downgrade
   *   7. dedup by (leadId, source, sourceEventId)
   *   8. stale-event (occurredAt < lead.statusUpdatedAt)
   *
   * SF-connected mode (lead is SF-linked via sfJobId / sfCustomerId /
   * syncStatus='linked'): service_flow writes flow through the normal guard
   * chain — SF is authoritative for the full lifecycle including reversals
   * (cancelled → booked, completed → cancelled). The mirror fields
   * (sfJobOutcome / sfJobOutcomeAt) are still written by the Phase 1 mirror
   * call in sf-inbound-status.service.ts so the SF-side view is preserved
   * alongside the canonical Lead.status.
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
        // sfCustomerId + syncStatus power the SF-link guard inside
        // applyPlatformSync. A linked lead (any of: sfJobId, sfCustomerId,
        // syncStatus='linked') is operationally owned by SF; a marketplace
        // archive sweep must not drag it back to `lost`/`archived`.
        sfCustomerId: true,
        syncStatus: true,
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
    //
    // Carve-out (autonomous-booking reschedule, 2026-06-24): when a
    // dispatcher_confirmed write arrives for a lead that's already booked,
    // the Lead.status doesn't change but the appointment time might —
    // dispatcher sent "tomorrow at 10" on day 1, then "moved to Friday at 2"
    // on day 3. The sweeper relies on the LATEST audit row's
    // metadata.appointmentAt to decide when to flip booked→completed; if we
    // short-circuit here the new appointmentAt is lost and the sweeper acts
    // on the stale slot. So when source=lb_automation, reason=dispatcher_confirmed,
    // and the incoming appointmentAt differs from the last accepted one, we
    // bypass the no-op and write a fresh audit row (status unchanged).
    if (newStatus === oldStatus) {
      const isRescheduleWrite =
        input.source === 'lb_automation' &&
        input.reason === 'dispatcher_confirmed' &&
        newStatus === 'booked' &&
        !!input.metadata?.appointmentAt;
      if (!isRescheduleWrite) {
        return this.skipped(lead, 'no_change');
      }
      const isFreshAppointment = await this.isAppointmentRescheduled(
        lead.id,
        String(input.metadata?.appointmentAt ?? ''),
      );
      if (!isFreshAppointment) {
        return this.skipped(lead, 'no_change');
      }
      // Fall through: write the audit row for the new appointmentAt without
      // touching Lead.status. The remaining guards (dedup, stale_event) still
      // run so the reschedule write is itself replay-safe.
    }

    // ── Guard 2: canonical validation ─────────────────────────────────────
    if (!isCanonicalStatus(newStatus)) {
      throw new BadRequestException(
        `Invalid status "${newStatus}". Must be one of the canonical set; see canonical-status.ts.`,
      );
    }

    // ── Guard 2b: SF-connected mode — lb_automation lost/booked suppression ──
    // In SF-connected mode the AI classifier's terminal intents (opt_out,
    // hired_elsewhere, agreed) still record runtime/audit state but must NOT
    // mark the SF-linked lead `lost` or `booked` in Lead.status. SF owns the
    // outcome — a customer who already booked via SF cannot be auto-marked
    // lost by LB because the customer said "thanks, we're done" (Donna-class
    // false positive); a customer mid-SF-booking cannot be marked booked by
    // LB because SF's own webhook will deliver the booked event when the
    // calendar slot is confirmed.
    //
    // Non-terminal lb_automation writes (`engaged`, etc.) still flow — they
    // are funnel/observability signals, not lifecycle commitments.
    if (
      input.source === 'lb_automation' &&
      isSfLinkedLead(lead) &&
      (newStatus === 'lost' || newStatus === 'booked')
    ) {
      this.metrics?.recordSkip('sf_linked_customer');
      this.logger.log(
        `[LeadStatus] event_id=${input.sourceEventId ?? 'null'} lead_id=${lead.id} source=lb_automation result=skipped skip_reason=sf_linked_customer status=${oldStatus} attempted=${newStatus} sf_job_id=${lead.sfJobId ?? 'null'} sf_customer_id=${lead.sfCustomerId ?? 'null'} sync_status=${lead.syncStatus ?? 'null'} note=sf_owns_lifecycle`,
      );
      return this.skipped(lead, 'sf_linked_customer');
    }

    // ── Guard 2c: lb_automation lifecycle-terminal rule (2026-06-17 spec) ──
    // AI observes intent (opt_out, hired_elsewhere, agreed, wants_to_schedule,
    // etc.), not real-world outcomes. SF / platform_sync / manual remain the
    // only authorities for booked / completed / cancelled / no_show /
    // in_progress / archived writes. Two carve-outs let AI mark `lost`:
    //
    //   (a) opt_out — explicit "stop messaging me" / "delete my account".
    //       Customer asked us to stop; respect it without waiting on an
    //       external signal. lostReason MUST be 'opt_out'.
    //
    //   (b) hired_elsewhere — customer explicitly said they hired somebody
    //       else. Allowed ONLY when the prior status is not a
    //       post-acquisition lifecycle state (booked / in_progress /
    //       completed). A booked customer saying "thanks!" must not be
    //       downgraded to lost (Feryal Berjawi / Donna-class incident).
    //
    // All other lb_automation terminal writes (booked, completed, etc., or
    // `lost` with any other lostReason) are blocked. The follow-up gate's
    // stop_only side-effect still fires — sequence is stopped, handoff
    // alert dispatches — only the canonical Lead.status flip is suppressed.
    const isTerminalDestination =
      newStatus === 'booked' ||
      newStatus === 'in_progress' ||
      newStatus === 'completed' ||
      newStatus === 'cancelled' ||
      newStatus === 'no_show' ||
      newStatus === 'archived' ||
      newStatus === 'lost';
    if (input.source === 'lb_automation' && isTerminalDestination) {
      const isOptOutLost =
        newStatus === 'lost' && input.lostReason === 'opt_out';
      const isHiredElseRecoverable =
        newStatus === 'lost' &&
        input.lostReason === 'hired_someone' &&
        oldStatus !== 'booked' &&
        oldStatus !== 'in_progress' &&
        oldStatus !== 'completed';
      // ── Autonomous-booking carve-outs (2026-06-24) ─────────────────────
      // In autonomous mode (no active sf_connection), LB has no upstream
      // truth about scheduling outcomes. Two narrow lb_automation carve-outs
      // let the appointment-detector + sweeper write the lifecycle states
      // SF would normally own:
      //
      //   (a) reason='dispatcher_confirmed' + newStatus='booked'
      //       — appointment-detector saw a dispatcher confirmation message
      //         on TT with a concrete date+time, parked the lead as booked.
      //         Stops follow-ups (booked is in AUTOMATION_TERMINAL).
      //         Requires metadata.appointmentAt for the sweeper to consult later.
      //
      //   (b) reason='appointment_date_passed' + newStatus='completed'
      //       — appointment-sweeper saw a booked lead whose scheduled slot
      //         ended 6h+ ago with no contradicting platform_sync override,
      //         marked it completed.
      //
      // Both carve-outs require the user has NO active sf_connection. The
      // check is async (DB hit) so it lives below in its own guard step —
      // here we only short-circuit the forbidden-destination guard for the
      // two recognized carve-out shapes. The sf-connection gate is enforced
      // in Guard 2d (see below).
      const isAutonomousDispatcherConfirmed =
        newStatus === 'booked' &&
        input.reason === 'dispatcher_confirmed' &&
        !!input.metadata?.appointmentAt;
      const isAutonomousAppointmentDatePassed =
        newStatus === 'completed' && input.reason === 'appointment_date_passed';
      if (
        !isOptOutLost &&
        !isHiredElseRecoverable &&
        !isAutonomousDispatcherConfirmed &&
        !isAutonomousAppointmentDatePassed
      ) {
        this.metrics?.recordSkip('automation_forbidden_destination');
        this.logSkip(
          input,
          lead.id,
          oldStatus,
          newStatus,
          'automation_forbidden_destination',
          lead.platformStatus,
        );
        return this.skipped(lead, 'automation_forbidden_destination');
      }

      // ── Guard 2d: autonomous-only enforcement for the new carve-outs ────
      // The two autonomous carve-outs above MUST NOT fire when the user has
      // an active SF connection. SF owns the lifecycle in connected mode —
      // a stale LB heuristic must not flip a lead behind SF's back. The
      // check is a single SfConnection lookup; skipped when neither carve-out
      // shape matches to avoid an unnecessary query on the hot path.
      if (isAutonomousDispatcherConfirmed || isAutonomousAppointmentDatePassed) {
        const hasActiveSf = await this.hasActiveSfConnection(lead.userId);
        if (hasActiveSf) {
          this.metrics?.recordSkip('sf_connected_autonomous_blocked');
          this.logSkip(
            input,
            lead.id,
            oldStatus,
            newStatus,
            'sf_connected_autonomous_blocked',
            lead.platformStatus,
          );
          return this.skipped(lead, 'sf_connected_autonomous_blocked');
        }
      }
    }

    // ── Guard 3: hard-terminal blocks all sources, with one carve-out ─────
    // SF (and only SF) may reactivate an archived lead into a fulfillment
    // lifecycle state. Required because SF is the operational lifecycle
    // owner: a real job/customer in SF must override a stale marketplace
    // "archived" sweep. Every other source — platform_sync, lb_automation,
    // manual, backfill — stays hard-blocked.
    let sfReactivation = false;
    if (HARD_TERMINAL.has(oldStatus)) {
      if (
        input.source === 'service_flow' &&
        SF_REACTIVATION_TARGETS.has(newStatus)
      ) {
        // Mark for downstream metric/log; counter is bumped only after the
        // remaining guards (dedup, stale_event) pass and the write actually
        // commits, so we don't over-count rejected replays.
        sfReactivation = true;
      } else {
        this.logSkip(input, lead.id, oldStatus, newStatus, 'hard_terminal', null, 'warn');
        return this.skipped(lead, 'hard_terminal');
      }
    }

    // ── Guard 4: SF_STATUS_WINS protection (lb_automation only) ───────────
    // Manual is intentionally allowed; it produces a sf_push_needed conflict
    // below so the operator pushes to SF.
    // Authority can be globally enabled (SF_STATUS_WINS=true) or scoped to a
    // csv allowlist (SF_STATUS_WINS_USER_IDS). See isSfAuthorityActive().
    const sfActive = lead.sfJobId ? this.isSfAuthorityActive(lead.userId) : false;
    if (sfActive && input.source === 'lb_automation') {
      this.metrics?.recordSkip('sf_protected');
      this.logSkip(input, lead.id, oldStatus, newStatus, 'sf_protected', lead.platformStatus);
      return this.skipped(lead, 'sf_protected');
    }

    // ── Guard 4b: SF-managed lead (manual user writes blocked) ────────────
    // Architecture: a tenant operates in one of two modes.
    //   - Autonomous LB mode: no sf_connection. LB owns status. Manual
    //     writes flow normally (this guard short-circuits).
    //   - SF-connected mode: tenant has an active sf_connection AND the
    //     specific lead is linked (sfJobId set). SF is the source of
    //     truth; LB mirrors SF. A normal-user "mark done / mark lost"
    //     from the LB UI on a linked lead is rejected — the operator
    //     must drive the change in SF (which then flows back to LB via
    //     job.status_changed).
    // Admin/support paths that have already passed RequiresSupportGrant
    // can bypass by setting WriteStatusInput.adminOverride=true.
    if (
      input.source === 'manual' &&
      lead.sfJobId &&
      !input.adminOverride
    ) {
      const conn = await this.prisma.sfConnection.findUnique({
        where: { userId: lead.userId },
        select: { isActive: true, status: true },
      });
      if (conn && conn.isActive && conn.status === 'active') {
        this.metrics?.recordSkip('sf_managed');
        this.logSkip(input, lead.id, oldStatus, newStatus, 'sf_managed', lead.platformStatus);
        return this.skipped(lead, 'sf_managed');
      }
    }

    // ── Guard 5: automation-terminal (lb_automation only) ─────────────────
    // Manual + SF can still transition out of these (e.g. operator marks
    // a `lost` lead as `engaged` after a re-engagement reply).
    //
    // Carve-out (2026-06-17 spec A.3): lb_automation MAY transition a lead
    // out of `lost+hired_someone` into `engaged` (or `quoted`). This is the
    // re-engagement loop — a customer flagged hired_elsewhere who comes back
    // and replies should be promoted into the active funnel. `opt_out` is
    // never recoverable by lb_automation (explicit unsubscribe); `lost` with
    // any other lostReason continues to require manual / service_flow to
    // reactivate. `completed` / `cancelled` / `no_show` stay strict — these
    // are real outcomes, not AI guesses.
    //
    // Extended 2026-06-20: lostReason='archived' (Yelp closed the thread —
    // see yelp-status-map.ts) is treated the same way. If a Yelp customer
    // un-archives and replies, lb_automation must be able to promote them
    // back into `engaged`/`quoted`, identically to the hired_someone case.
    if (AUTOMATION_TERMINAL.has(oldStatus) && input.source === 'lb_automation') {
      const isReengageRecoverable =
        oldStatus === 'lost' &&
        (lead.lostReason === 'hired_someone' || lead.lostReason === 'archived') &&
        (newStatus === 'engaged' || newStatus === 'quoted');
      if (!isReengageRecoverable) {
        this.logSkip(input, lead.id, oldStatus, newStatus, 'automation_terminal', lead.platformStatus);
        return this.skipped(lead, 'automation_terminal');
      }
      this.logger.log(
        `[LeadStatus] event_id=${input.sourceEventId ?? 'null'} lead_id=${lead.id} source=lb_automation result=carve_out_reengage status=${oldStatus} lost_reason=${lead.lostReason} attempted=${newStatus}`,
      );
    }

    // ── Guard 6: pipeline-downgrade ───────────────────────────────────────
    // Off-pipeline transitions (anything involving a terminal) are exempt
    // because terminals are not in PIPELINE_ORDER.
    if (isPipelineDowngrade(oldStatus, newStatus)) {
      this.metrics?.recordSkip('pipeline_downgrade');
      this.logSkip(input, lead.id, oldStatus, newStatus, 'pipeline_downgrade', lead.platformStatus);
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
        this.logSkip(input, lead.id, oldStatus, newStatus, 'duplicate', lead.platformStatus);
        return this.skipped(lead, 'duplicate');
      }
    }

    // ── Guard 8: stale-event (occurredAt < lead.statusUpdatedAt) ──────────
    // Prevents an old webhook retry from overwriting a newer state.
    if (lead.statusUpdatedAt && occurredAt < lead.statusUpdatedAt) {
      this.logSkip(input, lead.id, oldStatus, newStatus, 'stale_event', lead.platformStatus, 'warn');
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

    const auditReason = sfReactivation
      ? (input.reason ?? 'sf_reactivated_archived')
      : (input.reason ?? input.lostReason ?? null);

    // Reschedule-only path: when Guard 1's carve-out let us through with
    // newStatus===oldStatus to record a new appointmentAt, we MUST NOT touch
    // the Lead row (no status change, no statusUpdatedAt bump — that would
    // mask the original transition timestamp). The audit row still goes in.
    const isRescheduleOnly = newStatus === oldStatus;

    const { conflict, auditLogId } = await this.prisma.$transaction(async (tx) => {
      if (!isRescheduleOnly) {
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
      } else if (input.extraLeadUpdates && Object.keys(input.extraLeadUpdates).length > 0) {
        // Reschedule writes never carry extraLeadUpdates today, but if a
        // future caller passes them we shouldn't silently drop them.
        await tx.lead.update({
          where: { id: lead.id },
          data: { ...input.extraLeadUpdates },
        });
      }

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

    if (sfReactivation) {
      this.metrics?.recordSfReactivation();
    }

    if (conflict) {
      this.events.emit(`lead.status.conflict.${lead.userId}`, {
        leadId: lead.id,
        userId: lead.userId,
        conflict,
      });
      this.logger.warn(
        `[LeadStatus] event_id=${input.sourceEventId ?? 'null'} lead_id=${lead.id} source=${input.source} result=conflict skip_reason=null status=${newStatus} platform_status=${lead.platformStatus ?? 'null'} kind=${conflict.kind}`,
      );
    }

    this.logger.log(
      `[LeadStatus] event_id=${input.sourceEventId ?? 'null'} lead_id=${lead.id} source=${input.source} result=${conflict ? 'applied_with_conflict' : 'applied'} skip_reason=null status=${newStatus} platform_status=${lead.platformStatus ?? 'null'} old_status=${oldStatus}` +
        (sfReactivation ? ' reason=sf_reactivated_archived' : ''),
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
      sfCustomerId: string | null;
      syncStatus: string | null;
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
        `[LeadStatus] event_id=${input.sourceEventId ?? 'null'} lead_id=${lead.id} source=platform_sync result=skipped skip_reason=stale_event status=${lead.status} platform_status=${input.platformStatus ?? lead.platformStatus ?? 'null'} occurred_at=${occurredAt.toISOString()} status_updated_at=${lead.statusUpdatedAt.toISOString()}`,
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
    // hard-terminal, completed-lock, SF protection (env-flag + link-based),
    // and fulfillment-state protection.
    let lbStatusBlocked: WriteSkipReason | null = null;
    if (input.newStatus && input.newStatus !== oldLbStatus) {
      const sfActive = lead.sfJobId ? this.isSfAuthorityActive(lead.userId) : false;
      // SF-link guard: marketplace-archive events ("Archived" / "Closed" /
      // "Not hired" / "Cancelled" — anything that lands LB in `lost` or
      // `archived`) must NOT downgrade a lead that SF has already linked.
      // The link comes from any of: sfJobId set, sfCustomerId set, or
      // syncStatus='linked' (historical sync). Independent of
      // SF_STATUS_WINS — this rule fires regardless of the env flag because
      // the link itself is the authority signal. platformStatus still
      // flows so analytics keeps the marketplace breadcrumb.
      const sfLinked = !!(
        lead.sfJobId || lead.sfCustomerId || lead.syncStatus === 'linked'
      );
      const newIsArchiveTerminal =
        input.newStatus === 'lost' || input.newStatus === 'archived';
      if (!isCanonicalStatus(input.newStatus)) {
        lbStatusBlocked = 'invalid_status';
      } else if (HARD_TERMINAL.has(oldLbStatus)) {
        lbStatusBlocked = 'hard_terminal';
      } else if (sfLinked && newIsArchiveTerminal) {
        // Explicit "skipped_archived_due_to_sf_link" marker for Loki —
        // operators triaging "why didn't Yelp archive flow through" can
        // grep this exact phrase. The structured skip_reason on the
        // standard log line below carries `sf_link_protected`.
        lbStatusBlocked = 'sf_link_protected';
        this.logger.log(
          `[LeadStatus] skipped_archived_due_to_sf_link lead_id=${lead.id} attempted=${input.newStatus} platform_status=${input.platformStatus ?? oldPlatform ?? 'null'} sf_job_id=${lead.sfJobId ?? 'null'} sf_customer_id=${lead.sfCustomerId ?? 'null'} sync_status=${lead.syncStatus ?? 'null'}`,
        );
      } else if (sfActive) {
        // SF owns the canonical status when integrated; platformStatus still flows.
        lbStatusBlocked = 'sf_protected';
      } else if (oldLbStatus === 'completed') {
        // Completed is a hard floor for platform_sync — once completed, the
        // platform cannot move the canonical status (forward to a non-existent
        // higher rank, backward to active pipeline, or sideways into terminals
        // like `lost`/`cancelled`). Manual + SF override paths are unaffected.
        lbStatusBlocked = 'pipeline_downgrade';
      } else if (
        input.newStatus === 'lost' &&
        (oldLbStatus === 'scheduled' ||
          oldLbStatus === 'booked' ||
          oldLbStatus === 'in_progress')
      ) {
        // Fulfillment-state protection: once a lead reaches a post-acquisition
        // lifecycle state in LB, a marketplace archive sweep cannot drag it
        // back to `lost`. The marketplace's view is stale — the work moved
        // off-platform. Manual + service_flow can still override these.
        lbStatusBlocked = 'pipeline_downgrade';
      } else if (isPipelineDowngrade(oldLbStatus, input.newStatus)) {
        lbStatusBlocked = 'pipeline_downgrade';
      } else {
        data.status = input.newStatus;
        data.statusSource = 'platform_sync';
        data.statusUpdatedAt = occurredAt;
        // Project lostReason / reengageAt the same way the manual-source
        // path does: caller-supplied on entering `lost`, cleared on exit.
        // Yelp-archive callers pass lostReason='archived' (yelp-status-map);
        // other platform_sync writes that land in `lost` may pass null.
        if (input.newStatus === 'lost') {
          data.lostReason = input.lostReason ?? null;
          if (input.reengageAt !== undefined) {
            data.reengageAt = input.reengageAt;
          }
        } else if (oldLbStatus === 'lost') {
          data.lostReason = null;
          data.reengageAt = null;
        }
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
        // Fall back to lostReason when caller didn't supply an explicit
        // reason — keeps Yelp-archive audit rows greppable as
        // reason=hired_someone without forcing every caller to set both.
        reason: input.reason ?? input.lostReason ?? null,
        metadata: input.metadata ?? Prisma.JsonNull,
        conflict: false,
        conflictNote: null,
        occurredAt,
      },
    });

    if (lbStatusBlocked) {
      // Partial-skip: platformStatus was written but canonical Lead.status
      // was held back by a guard. Counter feeds /v1/integrations/health.
      if (lbStatusBlocked === 'sf_protected') this.metrics?.recordSkip('sf_protected');
      if (lbStatusBlocked === 'sf_link_protected') this.metrics?.recordSkip('sf_protected');
      if (lbStatusBlocked === 'pipeline_downgrade') this.metrics?.recordSkip('pipeline_downgrade');
      this.logger.log(
        `[LeadStatus] event_id=${input.sourceEventId ?? 'null'} lead_id=${lead.id} source=platform_sync result=partial_skip skip_reason=${lbStatusBlocked} status=${oldLbStatus} platform_status=${input.platformStatus ?? oldPlatform ?? 'null'} attempted=${input.newStatus ?? 'null'} platform=${lead.platform}`,
      );
    } else {
      this.logger.log(
        `[LeadStatus] event_id=${input.sourceEventId ?? 'null'} lead_id=${lead.id} source=platform_sync result=applied skip_reason=null status=${input.newStatus ?? oldLbStatus} platform_status=${input.platformStatus ?? oldPlatform ?? 'null'} platform=${lead.platform}`,
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
   * Phase 1 SF operational lifecycle mirror.
   *
   * Writes `Lead.sfJobOutcome` + `Lead.sfJobOutcomeAt` independently of the
   * canonical Lead.status write path. This is the "SF said this last" column
   * that the conversation-centric UI reads — it must reflect SF's view even
   * when the canonical writeStatus is blocked (carve-out, dedup, downgrade,
   * pipeline_downgrade, etc.).
   *
   * Stale-protected by the same `sfJobOutcomeAt < occurredAt` clause the live
   * webhook uses. Callers: sf-inbound-status (live), sf-historical-sync
   * (manual link + bulk link). Keep all three in sync — if a fourth SF write
   * path is added, route it through here.
   *
   * Returns whether the write actually changed a row (false when stale).
   * Never throws; persistence failures are swallowed with a warn log because
   * the mirror is informational, not load-bearing for behavior.
   */
  async writeSfJobOutcomeMirror(
    leadId: string,
    outcome: string,
    occurredAt: Date,
    context: { sfJobId?: string | null; sourceEventId?: string | null; userId?: string | null } = {},
  ): Promise<{ written: boolean }> {
    try {
      const result = await this.prisma.lead.updateMany({
        where: {
          id: leadId,
          OR: [{ sfJobOutcomeAt: null }, { sfJobOutcomeAt: { lt: occurredAt } }],
        },
        data: { sfJobOutcome: outcome, sfJobOutcomeAt: occurredAt },
      });
      if (result.count > 0) {
        this.logger.log(
          `[ConversationRuntime] event=sf_job_outcome_write lead_id=${leadId} new_outcome=${outcome} sf_job_id=${context.sfJobId ?? 'null'} source_event_id=${context.sourceEventId ?? 'null'} user_id=${context.userId ?? 'null'}`,
        );
      }
      return { written: result.count > 0 };
    } catch (e: any) {
      this.logger.warn(
        `[LeadStatus] sfJobOutcome write failed lead_id=${leadId} err=${e?.message ?? e}`,
      );
      return { written: false };
    }
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
