import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { ListUsersDto } from './dto/list-users.dto';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';
import { SubscriptionTier, SubscriptionStatus } from '../../generated/prisma';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(private prisma: PrismaService) {}

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

    if (tier) {
      where.subscriptionTier = tier;
    }

    // Get users with pagination
    const [users, total] = await Promise.all([
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
          hasOwnNumber: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

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
      [SubscriptionTier.STARTER]: 29,
      [SubscriptionTier.PRO]: 79,
      [SubscriptionTier.ENTERPRISE]: 149,
    };

    for (const sub of subscriptions) {
      if (sub.subscriptionTier && sub.subscriptionTier in tierPrices) {
        monthlyRevenue += tierPrices[sub.subscriptionTier as keyof typeof tierPrices] || 0;
      }
      if (sub.hasOwnNumber) {
        monthlyRevenue += 10; // Add-on price
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
}
