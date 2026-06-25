/**
 * Appointment Sweeper
 *
 * Autonomous-mode helper. Pairs with AppointmentDetectorService: once the
 * detector parks a lead as `booked` via reason='dispatcher_confirmed' with
 * `metadata.appointmentAt` set, this cron is what eventually flips the lead
 * to `completed` once the appointment time + slot duration + a 6h grace
 * window has elapsed and nothing else has overridden the canonical status in
 * the meantime.
 *
 * Why 6 hours: dispatchers occasionally finish a job an hour or two late,
 * customers occasionally cancel only after the cleaner is already on the
 * road. A six-hour grace lets those messages land via the platform-sync
 * pipeline (which can write `cancelled` / `lost`) before we mark anything
 * completed. In a fully connected world SF would deliver the real outcome;
 * in autonomous mode we're inferring the most likely outcome.
 *
 * What this cron does NOT do:
 *   - Touch leads that aren't `booked` (anything cancelled / lost / completed
 *     by a more authoritative source is left alone).
 *   - Touch leads whose owning user has an active sf_connection (the carve-out
 *     gate inside LeadStatusService also blocks these, but we skip the work
 *     up-front so we don't spam the audit log with skip rows).
 *   - Touch leads that don't have a `dispatcher_confirmed` audit row (we only
 *     auto-complete what we auto-booked — never inferred completions on leads
 *     parked by manual / platform_sync / service_flow).
 *
 * The cron runs hourly. With a 6h grace and hourly cadence the worst-case
 * completion delay is ~1h after the grace ends — fine for a UI label.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/utils/prisma.service';
import { isSkipped, withCronLock } from '../common/utils/cron-lock';
import { LeadStatusService } from './lead-status.service';

const SWEEPER_LOCK_KEY = 7011;
const SWEEPER_LABEL = 'AppointmentSweeper';

/** Grace period after the slot end before we mark the lead completed. */
export const APPOINTMENT_GRACE_MINUTES = 6 * 60;

/** Default slot length when the detector couldn't infer one from the message. */
const DEFAULT_SLOT_MINUTES = 30;

/** Cap on per-tick work so a backlog can't blow the txn budget. */
const SWEEPER_BATCH_LIMIT = 200;

export interface SweepStats {
  examined: number;
  completed: number;
  skipped: number;
}

@Injectable()
export class AppointmentSweeperService {
  private readonly logger = new Logger(AppointmentSweeperService.name);
  private readonly schedulerEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly leadStatus: LeadStatusService,
  ) {
    // Mirrors the convention used by other LB crons — staging stays out of
    // the loop when prod is the authoritative writer, set via env on the
    // staging Railway service.
    this.schedulerEnabled = process.env.FOLLOWUP_SCHEDULER !== 'false';
  }

  @Cron(CronExpression.EVERY_HOUR)
  async runHourly(): Promise<void> {
    if (!this.schedulerEnabled) return;
    // The dry-run / shadow flag — when LB_AUTONOMOUS_AUTOCOMPLETE=false the
    // sweeper still runs, logs what it WOULD complete, but does not call
    // writeStatus. This is how we soak the heuristic on staging without
    // shipping behavior changes.
    const dryRun = process.env.LB_AUTONOMOUS_AUTOCOMPLETE !== 'true';
    const outcome = await withCronLock(
      this.prisma,
      this.logger,
      SWEEPER_LOCK_KEY,
      SWEEPER_LABEL,
      (tx) => this.sweepOnce(tx as unknown as PrismaService, { dryRun }),
      { timeoutMs: 180_000 },
    );
    if (isSkipped(outcome)) return;
    this.logger.log(
      `[AppointmentSweeper] tick examined=${outcome.examined} completed=${outcome.completed} skipped=${outcome.skipped} dry_run=${dryRun}`,
    );
  }

  /**
   * One sweep pass — exposed for the spec so it can drive deterministically
   * without ticking the cron.
   */
  async sweepOnce(
    db: PrismaService,
    opts: { dryRun: boolean; now?: Date } = { dryRun: true },
  ): Promise<SweepStats> {
    const now = opts.now ?? new Date();
    const stats: SweepStats = { examined: 0, completed: 0, skipped: 0 };

    // Eligible-lead query. Two layers:
    //   1. Lead.status='booked' + statusSource='lb_automation' narrows to
    //      autonomous-mode bookings only — manual / platform_sync / sf bookings
    //      are excluded because we don't own their completion.
    //   2. The audit metadata + grace check is a JS pass below, since
    //      Prisma can't filter on a JSON cast + arithmetic without raw SQL.
    const candidates = await db.lead.findMany({
      where: {
        status: 'booked',
        statusSource: 'lb_automation',
      },
      select: {
        id: true,
        userId: true,
        sfJobId: true,
        sfCustomerId: true,
        syncStatus: true,
      },
      take: SWEEPER_BATCH_LIMIT,
    });

    if (candidates.length === 0) return stats;

    // Pull each candidate's latest dispatcher_confirmed audit row in one
    // findMany — cheaper than N findFirst calls when the batch is full. The
    // sort + dedup is done in JS.
    const auditRows = await db.leadStatusAuditLog.findMany({
      where: {
        leadId: { in: candidates.map((c) => c.id) },
        source: 'lb_automation',
        reason: 'dispatcher_confirmed',
      },
      orderBy: { occurredAt: 'desc' },
      select: { leadId: true, metadata: true, occurredAt: true },
    });

    const latestByLead = new Map<string, { metadata: any; occurredAt: Date }>();
    for (const row of auditRows) {
      if (!latestByLead.has(row.leadId)) {
        latestByLead.set(row.leadId, { metadata: row.metadata, occurredAt: row.occurredAt });
      }
    }

    for (const lead of candidates) {
      const latest = latestByLead.get(lead.id);
      if (!latest) {
        // No dispatcher_confirmed audit row — sweeper has nothing to act on.
        // Common when a lead was marked booked by some path we don't own.
        continue;
      }
      stats.examined++;

      const md = (latest.metadata && typeof latest.metadata === 'object') ? latest.metadata : null;
      const appointmentAtRaw = md && typeof (md as any).appointmentAt === 'string' ? (md as any).appointmentAt : null;
      const slotMinutesRaw = md && typeof (md as any).slotMinutes === 'number' ? (md as any).slotMinutes : null;
      if (!appointmentAtRaw) {
        stats.skipped++;
        continue;
      }
      const appointmentAt = new Date(appointmentAtRaw);
      if (Number.isNaN(appointmentAt.getTime())) {
        stats.skipped++;
        continue;
      }
      const slotMinutes = Number.isFinite(slotMinutesRaw) && slotMinutesRaw > 0 ? slotMinutesRaw : DEFAULT_SLOT_MINUTES;
      const completedThreshold = appointmentAt.getTime() + (slotMinutes + APPOINTMENT_GRACE_MINUTES) * 60_000;
      if (completedThreshold > now.getTime()) {
        // Slot hasn't passed yet (or is still inside the grace window).
        continue;
      }

      // SF-link short-circuit — Lead.status guards will block the write
      // anyway, but skipping here keeps the audit log clean and avoids the
      // SfConnection lookup per stale row.
      if (lead.sfJobId || lead.sfCustomerId || lead.syncStatus === 'linked') {
        stats.skipped++;
        continue;
      }

      if (opts.dryRun) {
        this.logger.log(
          `[AppointmentSweeper] would_complete lead_id=${lead.id} appointment_at=${appointmentAt.toISOString()} slot_minutes=${slotMinutes} grace_minutes=${APPOINTMENT_GRACE_MINUTES}`,
        );
        stats.completed++;
        continue;
      }

      try {
        const result = await this.leadStatus.writeStatus({
          leadId: lead.id,
          newStatus: 'completed',
          source: 'lb_automation',
          reason: 'appointment_date_passed',
          occurredAt: now,
          metadata: {
            appointmentAt: appointmentAt.toISOString(),
            slotMinutes,
            graceMinutes: APPOINTMENT_GRACE_MINUTES,
            triggeredBy: 'AppointmentSweeper',
          },
        });
        if (result.applied) {
          stats.completed++;
          this.logger.log(
            `[AppointmentSweeper] completed lead_id=${lead.id} appointment_at=${appointmentAt.toISOString()}`,
          );
        } else {
          stats.skipped++;
          this.logger.log(
            `[AppointmentSweeper] write_skipped lead_id=${lead.id} skip_reason=${result.skipReason ?? 'unknown'} appointment_at=${appointmentAt.toISOString()}`,
          );
        }
      } catch (err: any) {
        stats.skipped++;
        this.logger.warn(
          `[AppointmentSweeper] write_failed lead_id=${lead.id} err=${err?.message ?? err}`,
        );
      }
    }

    return stats;
  }
}
