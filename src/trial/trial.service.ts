import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/utils/prisma.service';
import { TrialType, SubscriptionStatus } from '../../generated/prisma';

export const TRIAL_ENDED_EVENT = 'trial.ended';

const TRIAL_DAYS = 7;
// Lead caps were removed — trials are time-only. We keep the column populated
// with a sentinel so any legacy code that reads trialLeadsLimit for display or
// safety checks doesn't see 0/null. Sized to fit Prisma Int32.
const TRIAL_LEAD_LIMIT_SENTINEL = 1_000_000;

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

type TrialView = {
  trialType: TrialType | null;
  trialEndDate: Date | null;
  trialEndedAt: Date | null;
  trialLeadsHandled: number;
  trialLeadsLimit: number;
};

type CanProcessResult =
  | { allowed: true; via: 'paid' | 'trial' | 'grace' }
  | { allowed: false; reason: 'no_trial' | 'trial_ended' };

@Injectable()
export class TrialService {
  private readonly logger = new Logger(TrialService.name);

  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Initialize or upgrade trial when a platform is connected.
   * Safe to call repeatedly — never restricts an existing trial.
   */
  async onPlatformConnected(userId: string, platform: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        subscriptionTier: true,
        trialType: true,
        trialUsed: true,
        trialStartDate: true,
        trialEndDate: true,
        trialLeadsLimit: true,
      },
    });

    if (!user) return;
    // Paid users have no trial
    if (user.subscriptionTier) return;
    // trialUsed=true means abuse-flag wiped the trial — don't re-init
    if (user.trialUsed) return;

    const platforms = await this.prisma.savedAccount.findMany({
      where: { userId },
      select: { platform: true },
      distinct: ['platform'],
    });
    const connected = new Set(platforms.map((p) => p.platform.toLowerCase()));
    // Ensure the platform that just connected is in the set even if SavedAccount
    // hasn't been written yet (race-safe).
    connected.add(platform.toLowerCase());

    const target = this.computeTrialConfig([...connected]);
    const now = new Date();

    // Apply upgrade-only semantics for both first-init and subsequent connects.
    // When the user already had a signup-set trialEndDate, never shorten it.
    const updates: Record<string, unknown> = {};

    if (user.trialType !== target.type) {
      updates.trialType = target.type;
    }
    if (!user.trialStartDate) {
      updates.trialStartDate = now;
    }
    if (target.leadLimit > user.trialLeadsLimit) {
      updates.trialLeadsLimit = target.leadLimit;
    }
    if (target.endDate) {
      if (!user.trialEndDate || target.endDate > user.trialEndDate) {
        updates.trialEndDate = target.endDate;
      }
    }

    if (Object.keys(updates).length > 0) {
      await this.prisma.user.update({ where: { id: userId }, data: updates });
      this.logger.log(
        `[onPlatformConnected] ${user.trialType ? 'Upgraded' : 'Initialized'} trial for ${userId}: ${JSON.stringify(updates)}`,
      );
    }
  }

  /**
   * Gate for automation/AI/follow-up actions.
   * Pass conversationId for the 24h grace window on existing conversations.
   */
  async canProcessLead(userId: string, conversationId?: string): Promise<CanProcessResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        subscriptionTier: true,
        subscriptionStatus: true,
        trialType: true,
        trialEndDate: true,
        trialEndedAt: true,
        trialLeadsHandled: true,
        trialLeadsLimit: true,
      },
    });
    if (!user) return { allowed: false, reason: 'no_trial' };

    if (this.hasActivePaidSub(user.subscriptionTier, user.subscriptionStatus)) {
      return { allowed: true, via: 'paid' };
    }

    if (!user.trialType) {
      return { allowed: false, reason: 'no_trial' };
    }

    if (this.isTrialActive(user)) {
      return { allowed: true, via: 'trial' };
    }

    // Trial ended — 24h grace for conversations created BEFORE trial end
    if (user.trialEndedAt && conversationId) {
      const conv = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { createdAt: true },
      });
      if (
        conv &&
        conv.createdAt < user.trialEndedAt &&
        Date.now() < user.trialEndedAt.getTime() + GRACE_PERIOD_MS
      ) {
        return { allowed: true, via: 'grace' };
      }
    }

    return { allowed: false, reason: 'trial_ended' };
  }

  /**
   * Count a freshly-delivered Lead toward the trial quota.
   *
   * Call once per Lead from the live inbound webhook handlers — the moment a
   * Lead row is first created for a real, customer-originated delivery (TT
   * NEW_NEGOTIATION, TT/Yelp MessageCreated, Yelp NEW_EVENT). Do NOT call
   * from backfills, scrape imports, sync upserts, or synthetic test leads —
   * those paths intentionally bypass the meter so a new tenant connecting
   * Yelp/TT and pulling historical records doesn't burn its trial.
   *
   * Idempotency: a compare-and-swap on `Lead.trialCounted` (false → true)
   * inside a transaction guarantees exactly-once counting per Lead even
   * under webhook retries and concurrent processing. The atomic update is
   * the source of truth; the user counter increment runs only when the CAS
   * actually flipped the flag.
   *
   * Paid users and users without an active trial are skipped entirely
   * (`counted: false`) — their Leads stay `trialCounted=false` so that if a
   * trial is ever reset by an admin, future inbound leads still count.
   */
  async consumeLead(
    userId: string,
    leadId: string,
  ): Promise<{ justExhausted: boolean; nowEnded: boolean; counted: boolean }> {
    const u0 = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        subscriptionTier: true,
        subscriptionStatus: true,
        trialType: true,
        trialEndedAt: true,
      },
    });
    if (!u0) {
      return { justExhausted: false, nowEnded: false, counted: false };
    }
    if (this.hasActivePaidSub(u0.subscriptionTier, u0.subscriptionStatus)) {
      return { justExhausted: false, nowEnded: false, counted: false };
    }
    if (!u0.trialType || u0.trialEndedAt) {
      return { justExhausted: false, nowEnded: !!u0.trialEndedAt, counted: false };
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // CAS — only the first caller to find trialCounted=false succeeds.
      const flip = await tx.lead.updateMany({
        where: { id: leadId, userId, trialCounted: false },
        data: { trialCounted: true },
      });
      if (flip.count === 0) {
        return null;
      }
      return tx.user.update({
        where: { id: userId },
        data: { trialLeadsHandled: { increment: 1 } },
        select: {
          trialType: true,
          trialEndedAt: true,
          trialLeadsHandled: true,
          trialLeadsLimit: true,
        },
      });
    });

    if (!updated) {
      return { justExhausted: false, nowEnded: false, counted: false };
    }

    // Lead-based trial exhaustion removed — trials are time-only (7 days).
    // The counter still ticks for analytics / admin visibility.
    return {
      justExhausted: false,
      nowEnded: !!updated.trialEndedAt,
      counted: true,
    };
  }

  /**
   * Mark trial as ended (idempotent). Returns whether this call was the one
   * that flipped trialEndedAt. Used by the time-based scheduler too.
   * On the first transition, fires `trial.ended` so notifications can dispatch
   * without TrialService having to depend on TrialNotificationService directly.
   */
  async markEnded(userId: string): Promise<{ justExhausted: boolean; nowEnded: boolean }> {
    const result = await this.prisma.user.updateMany({
      where: { id: userId, trialEndedAt: null },
      data: { trialEndedAt: new Date() },
    });
    if (result.count > 0) {
      this.eventEmitter.emit(TRIAL_ENDED_EVENT, { userId });
    }
    return { justExhausted: result.count > 0, nowEnded: true };
  }

  /**
   * Build the public-facing trial view for an account: type, progress, and
   * adaptive labels for the UI. Pulled into getSubscriptionDetails.
   */
  buildTrialView(user: TrialView & { subscriptionTier: unknown }) {
    const now = new Date();
    const isActive = !user.subscriptionTier && user.trialType !== null && this.isTrialActive(user);

    const daysRemaining = user.trialEndDate
      ? Math.max(0, Math.ceil((user.trialEndDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
      : null;
    const leadsRemaining = Math.max(0, user.trialLeadsLimit - user.trialLeadsHandled);

    const label = user.trialType ? `Free trial: ${TRIAL_DAYS} days` : '';
    const progress =
      user.trialType && daysRemaining !== null ? `${daysRemaining} days remaining` : '';

    return {
      trialType: user.trialType,
      isActive,
      isEnded: !!user.trialEndedAt || (user.trialType !== null && !isActive),
      daysRemaining,
      leadsHandled: user.trialLeadsHandled,
      leadsLimit: user.trialLeadsLimit,
      leadsRemaining,
      endDate: user.trialEndDate,
      endedAt: user.trialEndedAt,
      label,
      progress,
    };
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private hasActivePaidSub(tier: unknown, status: SubscriptionStatus | null): boolean {
    if (!tier) return false;
    return (
      status === SubscriptionStatus.ACTIVE ||
      status === SubscriptionStatus.TRIALING ||
      status === SubscriptionStatus.PAST_DUE
    );
  }

  private isTrialActive(user: TrialView): boolean {
    if (!user.trialType) return false;
    if (user.trialEndedAt) return false;

    const now = new Date();
    return !user.trialEndDate || now < user.trialEndDate;
  }

  private computeTrialConfig(
    _platforms: string[],
  ): { type: TrialType; endDate: Date | null; leadLimit: number } {
    return {
      type: TrialType.TIME_BASED,
      endDate: addDays(new Date(), TRIAL_DAYS),
      leadLimit: TRIAL_LEAD_LIMIT_SENTINEL,
    };
  }
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
