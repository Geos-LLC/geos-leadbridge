import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { TrialService } from '../trial/trial.service';
import { ListUsersDto } from './dto/list-users.dto';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';
import { Prisma, SubscriptionTier, SubscriptionStatus } from '../../generated/prisma';
import { CacheService } from '../common/cache/cache.service';
import { CacheKeys } from '../common/cache/cache-keys';

// Synthetic/internal accounts that must not inflate revenue or subscriber
// metrics. Captures (a) Geos staff (role=ADMIN) and (b) accounts created by
// our test/canary tooling, identified by email suffix. Listed here rather
// than via a User column because the set is small, stable, and code-owned.
const TEST_ACCOUNT_EMAIL_SUFFIXES = [
  '@leadbridge.test',           // UI/overlay paywall test users
  '@leadbridge-test.local',     // SF commhub canary
  '@claude-test.com',           // onboarding debug seeds
  '@staging.local',             // SF provisioning smoke tests
];
const EXCLUDE_TEST_ACCOUNTS_WHERE: Prisma.UserWhereInput = {
  AND: [
    { role: { not: 'ADMIN' } },
    ...TEST_ACCOUNT_EMAIL_SUFFIXES.map((s) => ({
      NOT: { email: { endsWith: s } },
    })),
  ],
};

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private prisma: PrismaService,
    private stripeService: StripeService,
    private trialService: TrialService,
    private cache: CacheService,
  ) {}

  /**
   * Reset trials for all non-paid users back to a fresh start, then re-init
   * trialType per their currently connected platforms (adaptive trial system).
   * Paid users (subscriptionTier set + active/past_due/trialing) are skipped.
   */
  async resetAllTrials(adminId: string): Promise<{ totalScanned: number; reset: number; reInitialized: number; skippedPaid: number }> {
    const users = await this.prisma.user.findMany({
      select: {
        id: true,
        email: true,
        subscriptionTier: true,
        subscriptionStatus: true,
      },
    });

    let reset = 0;
    let reInitialized = 0;
    let skippedPaid = 0;

    for (const u of users) {
      const isActivePaid =
        u.subscriptionTier &&
        (u.subscriptionStatus === SubscriptionStatus.ACTIVE ||
          u.subscriptionStatus === SubscriptionStatus.TRIALING ||
          u.subscriptionStatus === SubscriptionStatus.PAST_DUE);
      if (isActivePaid) {
        skippedPaid++;
        continue;
      }

      // Wipe trial state to a fresh starting point
      await this.prisma.user.update({
        where: { id: u.id },
        data: {
          trialLeadsHandled: 0,
          trialEndedAt: null,
          trialEndNotifiedAt: null,
          trialUsed: false,
          trialType: null,
          trialEndDate: null,
          trialStartDate: null,
        },
      });
      reset++;

      // If they already have platforms connected, re-init trialType per the
      // adaptive rules. Otherwise trialType stays null until they connect one.
      const platforms = await this.prisma.savedAccount.findMany({
        where: { userId: u.id },
        select: { platform: true },
        distinct: ['platform'],
      });
      if (platforms.length > 0) {
        // onPlatformConnected reads ALL their connected platforms internally,
        // so a single call with any one of them computes the right config.
        await this.trialService.onPlatformConnected(u.id, platforms[0].platform);
        reInitialized++;
      }
    }

    await this.prisma.adminLog.create({
      data: {
        adminId,
        action: 'reset_all_trials',
        details: { totalScanned: users.length, reset, reInitialized, skippedPaid } as any,
      },
    });

    this.logger.log(
      `[resetAllTrials] admin=${adminId} scanned=${users.length} reset=${reset} reInit=${reInitialized} skippedPaid=${skippedPaid}`,
    );

    return { totalScanned: users.length, reset, reInitialized, skippedPaid };
  }

  async listUsers(query: ListUsersDto) {
    const { search, tier, offset = 0, limit = 50 } = query;

    // Build where clause
    const where: any = {};

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (tier === 'FREE') {
      where.subscriptionTier = null;
      where.role = 'USER';
    } else if (tier) {
      where.subscriptionTier = tier;
    }

    // Get users with pagination
    const [rawUsers, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          subscriptionTier: true,
          subscriptionStatus: true,
          subscriptionPeriodEnd: true,
          stripeSubscriptionId: true,
          hasOwnNumber: true,
          trialLeadsHandled: true,
          trialLeadsLimit: true,
          trialEndDate: true,
          createdAt: true,
          updatedAt: true,
          savedAccounts: {
            select: { id: true, businessName: true, businessId: true, platform: true },
          },
          _count: {
            select: { leads: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    // Flatten _count into leadsCount
    const users = rawUsers.map(({ _count, savedAccounts, ...user }) => ({
      ...user,
      leadsCount: _count.leads,
      connectedAccounts: savedAccounts.map((a) => ({
        id: a.id,
        businessName: a.businessName,
        businessId: a.businessId,
        platform: a.platform,
      })),
    }));

    return {
      users,
      total,
      offset,
      limit,
    };
  }

  async getUserDetails(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        subscriptionHistory: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        leads: {
          select: { id: true },
        },
        conversations: {
          select: { id: true },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      ...user,
      leadsCount: user.leads.length,
      conversationsCount: user.conversations.length,
    };
  }

  async updateUserSubscription(
    adminId: string,
    userId: string,
    dto: UpdateSubscriptionDto,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Update user subscription
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        subscriptionTier: dto.tier,
        subscriptionStatus: dto.status,
        hasOwnNumber: dto.hasOwnNumber,
      },
    });

    // Invalidate JwtStrategy auth cache so the new subscription/hasOwnNumber
    // values are reflected on the next request rather than waiting on TTL.
    await this.cache.del(CacheKeys.authUser(userId));

    // Log admin action
    await this.logAdminAction(adminId, 'UPDATE_USER_SUBSCRIPTION', userId, dto);

    this.logger.log(`Admin ${adminId} updated subscription for user ${userId}`);

    return updatedUser;
  }

  async cancelUserSubscription(adminId: string, userId: string, immediate: boolean = true) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Cancel subscription in Stripe
    const result = await this.stripeService.cancelSubscription(userId, immediate);

    // Log admin action
    await this.logAdminAction(adminId, 'CANCEL_USER_SUBSCRIPTION', userId, {
      immediate,
      stripeSubscriptionId: user.stripeSubscriptionId,
    });

    this.logger.log(`Admin ${adminId} cancelled subscription for user ${userId} (immediate: ${immediate})`);

    return result;
  }

  async deleteUser(adminId: string, userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Delete user (cascade will handle related records)
    await this.prisma.user.delete({ where: { id: userId } });

    // SECURITY: invalidate the auth cache immediately so the deleted user's
    // still-valid JWT can't be used to make authed requests for up to TTL.
    await this.cache.del(CacheKeys.authUser(userId));

    // Log admin action
    await this.logAdminAction(adminId, 'DELETE_USER', userId, {
      email: user.email,
    });

    this.logger.log(`Admin ${adminId} deleted user ${userId}`);

    return { success: true };
  }

  async getStats() {
    // Get total users (platform-wide signal; includes test accounts)
    const totalUsers = await this.prisma.user.count();

    // Get users by subscription tier — revenue-adjacent, excludes test accounts
    const usersByTier = await this.prisma.user.groupBy({
      by: ['subscriptionTier'],
      _count: true,
      where: {
        subscriptionTier: { not: null },
        ...EXCLUDE_TEST_ACCOUNTS_WHERE,
      },
    });

    // Get active subscriptions (revenue-adjacent, excludes test accounts)
    const activeSubscriptions = await this.prisma.user.count({
      where: {
        subscriptionStatus: {
          in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
        },
        ...EXCLUDE_TEST_ACCOUNTS_WHERE,
      },
    });

    // Calculate MRR (Monthly Recurring Revenue) — excludes test accounts
    const subscriptions = await this.prisma.user.findMany({
      where: {
        subscriptionStatus: {
          in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
        },
        subscriptionTier: { not: null },
        ...EXCLUDE_TEST_ACCOUNTS_WHERE,
      },
      select: {
        subscriptionTier: true,
        hasOwnNumber: true,
      },
    });

    let monthlyRevenue = 0;
    const tierPrices = {
      [SubscriptionTier.STARTER]: 49,
      [SubscriptionTier.PRO]: 99,
      [SubscriptionTier.ENTERPRISE]: 129,
    };

    for (const sub of subscriptions) {
      if (sub.subscriptionTier && sub.subscriptionTier in tierPrices) {
        monthlyRevenue += tierPrices[sub.subscriptionTier as keyof typeof tierPrices] || 0;
      }
      if (sub.hasOwnNumber) {
        monthlyRevenue += 29; // Add-on price
      }
    }

    // Calculate churn rate (simplified - last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const cancelledInLastMonth = await this.prisma.user.count({
      where: {
        subscriptionStatus: SubscriptionStatus.CANCELLED,
        updatedAt: { gte: thirtyDaysAgo },
      },
    });

    const churnRate = activeSubscriptions > 0
      ? ((cancelledInLastMonth / activeSubscriptions) * 100).toFixed(2)
      : '0.00';

    // Count total connected accounts (SavedAccounts)
    const totalConnectedAccounts = await this.prisma.savedAccount.count();

    return {
      totalUsers,
      activeSubscriptions,
      monthlyRevenue,
      churnRate: parseFloat(churnRate),
      totalConnectedAccounts,
      usersByTier: usersByTier.map((item: any) => ({
        tier: item.subscriptionTier,
        count: item._count,
      })),
    };
  }

  /**
   * Billing overview for the admin "Subscriptions" page.
   *
   * Buckets every USER-role account by where they sit in the funnel and
   * returns aggregate stats + a paginated, filterable, searchable row list.
   *
   * Buckets:
   *  - paying      : tier set + status ACTIVE (real money, recurring)
   *  - trialing    : Stripe TRIALING or in-app trial window still open
   *  - trial_ended : in-app trial finished (cap hit or window expired), no paid sub
   *  - cancelled   : Stripe sub CANCELLED
   *  - past_due    : Stripe sub PAST_DUE (card failure on a previously paying sub)
   *  - free        : no tier, never started a trial
   *
   * "monthlyRevenue" sums tier prices + $29 phone add-on for paying users only.
   */
  async getBillingOverview(query: {
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }) {
    const { status = 'all', search, limit = 50, offset = 0 } = query;
    const now = new Date();

    const where: any = { role: 'USER', ...EXCLUDE_TEST_ACCOUNTS_WHERE };
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }

    const users = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        name: true,
        subscriptionTier: true,
        subscriptionStatus: true,
        subscriptionPeriodEnd: true,
        stripeSubscriptionId: true,
        stripeCustomerId: true,
        hasOwnNumber: true,
        cancelAtPeriodEnd: true,
        trialStartDate: true,
        trialEndDate: true,
        trialEndedAt: true,
        trialUsed: true,
        trialLeadsHandled: true,
        trialLeadsLimit: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const tierPrices: Record<string, number> = {
      [SubscriptionTier.STARTER]: 49,
      [SubscriptionTier.PRO]: 99,
      [SubscriptionTier.ENTERPRISE]: 129,
    };
    const phoneAddOn = 29;

    type Annotated = (typeof users)[number] & { bucket: string; mrr: number };

    const annotated: Annotated[] = users.map((u) => {
      const bucket = this.classifyBillingBucket(u, now);
      let mrr = 0;
      if (bucket === 'paying' && u.subscriptionTier) {
        mrr = tierPrices[u.subscriptionTier] ?? 0;
        if (u.hasOwnNumber) mrr += phoneAddOn;
      }
      return { ...u, bucket, mrr };
    });

    const counts = {
      paying: 0,
      trialing: 0,
      trial_ended: 0,
      cancelled: 0,
      past_due: 0,
      free: 0,
    };
    let monthlyRevenue = 0;
    for (const u of annotated) {
      counts[u.bucket as keyof typeof counts]++;
      monthlyRevenue += u.mrr;
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cancelledLast30d = annotated.filter(
      (u) =>
        u.subscriptionStatus === SubscriptionStatus.CANCELLED &&
        u.updatedAt >= thirtyDaysAgo,
    ).length;

    // Conversion = paying / (paying + ever-ended-trial). Approximate but useful.
    const conversionDenom = counts.paying + counts.trial_ended;
    const trialConversionRate =
      conversionDenom > 0 ? (counts.paying / conversionDenom) * 100 : 0;
    const churnRate =
      counts.paying > 0 ? (cancelledLast30d / counts.paying) * 100 : 0;

    const filtered =
      status === 'all'
        ? annotated
        : annotated.filter((u) => u.bucket === status);

    const paged = filtered.slice(offset, offset + limit);

    return {
      stats: {
        paying: counts.paying,
        trialing: counts.trialing,
        trialEnded: counts.trial_ended,
        cancelled: counts.cancelled,
        pastDue: counts.past_due,
        free: counts.free,
        monthlyRevenue,
        trialConversionRate: Number(trialConversionRate.toFixed(2)),
        churnRate: Number(churnRate.toFixed(2)),
        cancelledLast30d,
      },
      users: paged,
      total: filtered.length,
      offset,
      limit,
    };
  }

  private classifyBillingBucket(
    u: {
      subscriptionTier: SubscriptionTier | null;
      subscriptionStatus: SubscriptionStatus | null;
      trialStartDate: Date | null;
      trialEndDate: Date | null;
      trialEndedAt: Date | null;
    },
    now: Date,
  ): 'paying' | 'trialing' | 'trial_ended' | 'cancelled' | 'past_due' | 'free' {
    if (u.subscriptionTier && u.subscriptionStatus === SubscriptionStatus.ACTIVE) {
      return 'paying';
    }
    if (u.subscriptionStatus === SubscriptionStatus.TRIALING) {
      return 'trialing';
    }
    if (u.subscriptionStatus === SubscriptionStatus.PAST_DUE) {
      return 'past_due';
    }
    if (u.subscriptionStatus === SubscriptionStatus.CANCELLED) {
      return 'cancelled';
    }
    if (u.trialEndedAt) {
      return 'trial_ended';
    }
    if (u.trialEndDate && u.trialEndDate > now) {
      return 'trialing';
    }
    if (u.trialStartDate && u.trialEndDate && u.trialEndDate <= now) {
      return 'trial_ended';
    }
    return 'free';
  }

  async updateTrialLeads(
    adminId: string,
    userId: string,
    dto: { trialLeadsHandled?: number; trialLeadsLimit?: number },
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const data: any = {};
    if (dto.trialLeadsHandled !== undefined) data.trialLeadsHandled = dto.trialLeadsHandled;
    if (dto.trialLeadsLimit !== undefined) data.trialLeadsLimit = dto.trialLeadsLimit;

    // If resetting leads to 0, also reset trial dates to give a fresh 7-day trial.
    // Must clear trialEndedAt/trialEndNotifiedAt too — otherwise canProcessLead() keeps
    // blocking and the trial-end notification won't re-fire if they exhaust again.
    if (dto.trialLeadsHandled === 0) {
      const now = new Date();
      const newTrialEnd = new Date(now);
      newTrialEnd.setDate(newTrialEnd.getDate() + 7);
      data.trialStartDate = now;
      data.trialEndDate = newTrialEnd;
      data.trialUsed = false;
      data.trialEndedAt = null;
      data.trialEndNotifiedAt = null;
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data,
    });

    await this.logAdminAction(adminId, 'UPDATE_TRIAL_LEADS', userId, dto);
    this.logger.log(`Admin ${adminId} updated trial leads for user ${userId}: ${JSON.stringify(dto)}`);

    return updatedUser;
  }

  /**
   * Extend a trial by N days without resetting the lead counter.
   *
   * Bumps `trialEndDate` forward by N days from whichever is later: the
   * current trialEndDate or now (so extending an already-expired trial
   * still produces a window that ends N days from today, not in the past).
   * Clears `trialEndedAt` / `trialEndNotifiedAt` so the gate re-opens and
   * the user can be re-notified if they expire again. `trialType` is
   * normalized to TIME_BASED since lead caps no longer gate.
   */
  async extendTrial(adminId: string, userId: string, days: number) {
    if (!Number.isInteger(days) || days <= 0 || days > 365) {
      throw new BadRequestException('days must be a positive integer up to 365');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, trialEndDate: true, trialType: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const now = new Date();
    const base = user.trialEndDate && user.trialEndDate > now ? user.trialEndDate : now;
    const newEnd = new Date(base);
    newEnd.setDate(newEnd.getDate() + days);

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        trialEndDate: newEnd,
        trialEndedAt: null,
        trialEndNotifiedAt: null,
        trialUsed: false,
        trialType: user.trialType ?? 'TIME_BASED',
      },
    });

    await this.logAdminAction(adminId, 'EXTEND_TRIAL', userId, { days, newTrialEndDate: newEnd });
    this.logger.log(
      `Admin ${adminId} extended trial for user ${userId} by ${days}d → ${newEnd.toISOString()}`,
    );

    return updatedUser;
  }

  async logAdminAction(
    adminId: string,
    action: string,
    targetUserId: string | null,
    details?: any,
  ) {
    await this.prisma.adminLog.create({
      data: {
        adminId,
        action,
        targetUserId,
        details: details || {},
      },
    });
  }

  async getAdminLogs(query: { limit?: number; offset?: number }) {
    const { limit = 50, offset = 0 } = query;

    const [logs, total] = await Promise.all([
      this.prisma.adminLog.findMany({
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          admin: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
        },
      }),
      this.prisma.adminLog.count(),
    ]);

    return {
      logs,
      total,
      offset,
      limit,
    };
  }

  async getNotificationLogs(query: { limit?: number }) {
    const limit = query.limit ? Number(query.limit) : 100;

    const logs = await this.prisma.notificationLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        notificationSettings: {
          select: {
            savedAccount: {
              select: {
                id: true,
                businessId: true,
                businessName: true,
                user: {
                  select: {
                    email: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    // Flatten savedAccount from notificationSettings for easier frontend consumption
    const flatLogs = logs.map(log => {
      const { notificationSettings, ...rest } = log;
      return {
        ...rest,
        savedAccount: notificationSettings?.savedAccount || null,
      };
    });

    return { count: flatLogs.length, logs: flatLogs };
  }

  async getTenantErrorFeed(query: {
    status?: string;
    limit?: number;
    offset?: number;
  }) {
    const { limit = 50, offset = 0 } = query;
    const statusFilter = query.status || 'failed';

    const where: any = {};
    if (statusFilter !== 'all') {
      where.status = statusFilter;
    }

    const [logs, total, failedCount24h] = await Promise.all([
      this.prisma.notificationLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: Number(offset),
        take: Number(limit),
        include: {
          notificationSettings: {
            select: {
              savedAccount: {
                select: {
                  id: true,
                  businessId: true,
                  businessName: true,
                  user: {
                    select: {
                      id: true,
                      email: true,
                      name: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),
      this.prisma.notificationLog.count({ where }),
      this.prisma.notificationLog.count({
        where: {
          status: 'failed',
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
    ]);

    const flatLogs = logs.map(log => {
      const { notificationSettings, ...rest } = log;
      return {
        ...rest,
        savedAccount: notificationSettings?.savedAccount || null,
      };
    });

    return { logs: flatLogs, total, offset: Number(offset), limit: Number(limit), failedCount24h };
  }

  async getTenantNumbers(query: {
    search?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }) {
    const { search, limit = 50, offset = 0 } = query;
    const statusFilter = query.status || undefined;

    const where: any = {};
    // Hide RELEASED tenant numbers by default (they've been moved back to pool)
    if (statusFilter) where.status = statusFilter;
    else where.status = { not: 'RELEASED' };
    if (search) {
      where.OR = [
        { phoneNumber: { contains: search } },
        { friendlyName: { contains: search, mode: 'insensitive' } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { user: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [phones, total] = await Promise.all([
      this.prisma.tenantPhoneNumber.findMany({
        where,
        orderBy: { purchasedAt: 'desc' },
        skip: Number(offset),
        take: Number(limit),
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
      }),
      this.prisma.tenantPhoneNumber.count({ where }),
    ]);

    // Enrich with savedAccount info and notification settings
    const enriched = await Promise.all(
      phones.map(async (phone) => {
        let savedAccount: any = null;
        let notificationSettings: any = null;
        if (phone.savedAccountId) {
          const sa = await this.prisma.savedAccount.findUnique({
            where: { id: phone.savedAccountId },
            select: { id: true, businessId: true, businessName: true },
          });
          savedAccount = sa;
          const ns = await this.prisma.notificationSettings.findUnique({
            where: { savedAccountId: phone.savedAccountId },
            select: { senderMode: true },
          });
          notificationSettings = ns;
        }

        const { user: usr, ...rest } = phone;

        const tenantName = usr?.name || savedAccount?.businessName || null;
        return {
          ...rest,
          user: usr,
          savedAccount,
          tenantName,
          notificationSettings: {
            senderMode: notificationSettings?.senderMode || null,
          },
        };
      }),
    );

    return { phones: enriched, total, offset: Number(offset), limit: Number(limit) };
  }
}
