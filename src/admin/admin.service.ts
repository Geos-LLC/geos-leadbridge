import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { ListUsersDto } from './dto/list-users.dto';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';
import { SubscriptionTier, SubscriptionStatus } from '../../generated/prisma';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private prisma: PrismaService,
    private stripeService: StripeService,
  ) {}

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
    const users = rawUsers.map(({ _count, ...user }) => ({
      ...user,
      leadsCount: _count.leads,
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

    // Log admin action
    await this.logAdminAction(adminId, 'DELETE_USER', userId, {
      email: user.email,
    });

    this.logger.log(`Admin ${adminId} deleted user ${userId}`);

    return { success: true };
  }

  async getStats() {
    // Get total users
    const totalUsers = await this.prisma.user.count();

    // Get users by subscription tier
    const usersByTier = await this.prisma.user.groupBy({
      by: ['subscriptionTier'],
      _count: true,
      where: {
        subscriptionTier: { not: null },
      },
    });

    // Get active subscriptions
    const activeSubscriptions = await this.prisma.user.count({
      where: {
        subscriptionStatus: {
          in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
        },
      },
    });

    // Calculate MRR (Monthly Recurring Revenue)
    const subscriptions = await this.prisma.user.findMany({
      where: {
        subscriptionStatus: {
          in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING],
        },
        subscriptionTier: { not: null },
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

    return {
      totalUsers,
      activeSubscriptions,
      monthlyRevenue,
      churnRate: parseFloat(churnRate),
      usersByTier: usersByTier.map((item: any) => ({
        tier: item.subscriptionTier,
        count: item._count,
      })),
    };
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

    // If resetting leads to 0, also reset trial dates to give a fresh 14-day trial
    if (dto.trialLeadsHandled === 0) {
      const now = new Date();
      const newTrialEnd = new Date(now);
      newTrialEnd.setDate(newTrialEnd.getDate() + 14);
      data.trialStartDate = now;
      data.trialEndDate = newTrialEnd;
      data.trialUsed = false;
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data,
    });

    await this.logAdminAction(adminId, 'UPDATE_TRIAL_LEADS', userId, dto);
    this.logger.log(`Admin ${adminId} updated trial leads for user ${userId}: ${JSON.stringify(dto)}`);

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
            select: { sigcoreProvider: true, sigcoreFromPhone: true, senderMode: true },
          });
          notificationSettings = ns;
        }
        // Check if this phone exists in the pool to determine its origin provider
        let originProvider: string | null = null;
        const poolEntry = await this.prisma.phonePool.findUnique({
          where: { phoneNumber: phone.phoneNumber },
          select: { provider: true },
        });
        originProvider = poolEntry?.provider || null;

        const { user, ...rest } = phone;
        return {
          ...rest,
          user,
          savedAccount,
          notificationSettings: notificationSettings || { sigcoreProvider: originProvider, sigcoreFromPhone: null, senderMode: null },
        };
      }),
    );

    return { phones: enriched, total, offset: Number(offset), limit: Number(limit) };
  }
}
