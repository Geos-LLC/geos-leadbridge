import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { TrialType, SubscriptionStatus } from '../../generated/prisma';

const TT = 'thumbtack';
const YELP = 'yelp';

const LEAD_BASED_LIMIT = 10;
const LEAD_BASED_SAFETY_DAYS = 7;
const TIME_BASED_DAYS = 14;
const TIME_BASED_LEAD_FALLBACK = 999;
const HYBRID_DAYS = 14;
const HYBRID_LEAD_LIMIT = 15;

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

  constructor(private prisma: PrismaService) {}

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
   * Atomically increment lead counter. Call this AFTER a successful first
   * AI auto-response is recorded for a lead. Returns whether this call caused
   * the trial to transition into the ended state.
   */
  async consumeLead(userId: string): Promise<{ justExhausted: boolean; nowEnded: boolean }> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { trialLeadsHandled: { increment: 1 } },
      select: {
        trialType: true,
        trialEndedAt: true,
        trialEndDate: true,
        trialLeadsHandled: true,
        trialLeadsLimit: true,
      },
    });

    const exhaustedByLeads =
      (user.trialType === TrialType.LEAD_BASED || user.trialType === TrialType.HYBRID) &&
      user.trialLeadsHandled >= user.trialLeadsLimit;

    if (!exhaustedByLeads) {
      return { justExhausted: false, nowEnded: !!user.trialEndedAt };
    }

    if (user.trialEndedAt) {
      return { justExhausted: false, nowEnded: true };
    }

    return this.markEnded(userId);
  }

  /**
   * Mark trial as ended (idempotent). Returns whether this call was the one
   * that flipped trialEndedAt. Used by the time-based scheduler too.
   */
  async markEnded(userId: string): Promise<{ justExhausted: boolean; nowEnded: boolean }> {
    const result = await this.prisma.user.updateMany({
      where: { id: userId, trialEndedAt: null },
      data: { trialEndedAt: new Date() },
    });
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

    let label = '';
    let progress = '';
    switch (user.trialType) {
      case TrialType.LEAD_BASED:
        label = `Free trial: ${user.trialLeadsLimit} leads`;
        progress = `${user.trialLeadsHandled} / ${user.trialLeadsLimit} leads used`;
        break;
      case TrialType.TIME_BASED:
        label = `Free trial: ${TIME_BASED_DAYS} days`;
        progress = daysRemaining !== null ? `${daysRemaining} days remaining` : '';
        break;
      case TrialType.HYBRID:
        label = `Free trial: ${HYBRID_DAYS} days or ${user.trialLeadsLimit} leads`;
        progress =
          daysRemaining !== null
            ? `${daysRemaining} days left • ${user.trialLeadsHandled} / ${user.trialLeadsLimit} leads used`
            : `${user.trialLeadsHandled} / ${user.trialLeadsLimit} leads used`;
        break;
    }

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
    const timeOk = !user.trialEndDate || now < user.trialEndDate;
    const leadsOk = user.trialLeadsHandled < user.trialLeadsLimit;

    switch (user.trialType) {
      case TrialType.LEAD_BASED:
        return leadsOk;
      case TrialType.TIME_BASED:
        return timeOk;
      case TrialType.HYBRID:
        return timeOk && leadsOk;
      default:
        return false;
    }
  }

  private computeTrialConfig(
    platforms: string[],
  ): { type: TrialType; endDate: Date | null; leadLimit: number } {
    const has = (p: string) => platforms.includes(p);
    const hasTT = has(TT);
    const hasYelp = has(YELP);
    const now = new Date();

    if (hasTT && hasYelp) {
      return {
        type: TrialType.HYBRID,
        endDate: addDays(now, HYBRID_DAYS),
        leadLimit: HYBRID_LEAD_LIMIT,
      };
    }
    if (hasYelp) {
      return {
        type: TrialType.TIME_BASED,
        endDate: addDays(now, TIME_BASED_DAYS),
        leadLimit: TIME_BASED_LEAD_FALLBACK,
      };
    }
    // Default: TT-only (or any other platform we don't yet specialize)
    return {
      type: TrialType.LEAD_BASED,
      endDate: addDays(now, LEAD_BASED_SAFETY_DAYS),
      leadLimit: LEAD_BASED_LIMIT,
    };
  }
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
