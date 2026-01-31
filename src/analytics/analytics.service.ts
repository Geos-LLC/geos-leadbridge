import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import {
  AnalyticsResponseDto,
  CategoryDistribution,
  ConnectionTimeMetric,
  ResponseTimeMetric,
  MessagesPerLeadMetric,
  CustomerEngagementMetric,
} from './dto/analytics-response.dto';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private prisma: PrismaService) {}

  async getAnalytics(
    userId: string,
    query: AnalyticsQueryDto,
  ): Promise<AnalyticsResponseDto> {
    this.logger.log(`Getting analytics for user ${userId}`, query);

    // Build date filter
    const dateFilter = this.buildDateFilter(query);

    // Build base where clause
    const baseWhere = {
      userId,
      ...(query.businessId && { businessId: query.businessId }),
      ...dateFilter,
    };

    // Execute all metrics in parallel for performance
    const [
      categoryDist,
      connectionTime,
      proResponse,
      customerResponse,
      messagesPerLead,
      engagement,
      totalLeads,
      businessInfo,
    ] = await Promise.all([
      this.getCategoryDistribution(baseWhere),
      this.getConnectionTime(baseWhere),
      this.getProResponseTime(baseWhere),
      this.getCustomerResponseTime(baseWhere),
      this.getMessagesPerLead(baseWhere),
      this.getCustomerEngagement(baseWhere),
      this.getTotalLeads(baseWhere),
      query.businessId
        ? this.getBusinessInfo(userId, query.businessId)
        : null,
    ]);

    return {
      categoryDistribution: categoryDist,
      connectionTime,
      proResponseTime: proResponse,
      customerResponseTime: customerResponse,
      messagesPerLead,
      customerEngagement: engagement,
      totalLeads,
      dateRange: {
        start: query.startDate || 'all-time',
        end: query.endDate || 'now',
      },
      filters: {
        businessId: query.businessId,
        businessName: businessInfo?.businessName,
      },
    };
  }

  private buildDateFilter(query: AnalyticsQueryDto) {
    const filter: any = {};
    if (query.startDate || query.endDate) {
      filter.createdAt = {};
      if (query.startDate) {
        filter.createdAt.gte = new Date(query.startDate);
      }
      if (query.endDate) {
        filter.createdAt.lte = new Date(query.endDate);
      }
    }
    return filter;
  }

  // Category Distribution - Group by category field
  private async getCategoryDistribution(
    where: any,
  ): Promise<CategoryDistribution[]> {
    const results = await this.prisma.lead.groupBy({
      by: ['category'],
      where,
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    });

    const total = results.reduce((sum, r) => sum + r._count.id, 0);

    return results.map((r) => ({
      category: r.category || 'Uncategorized',
      count: r._count.id,
      percentage: total > 0 ? (r._count.id / total) * 100 : 0,
    }));
  }

  // Connection Time - Time from lead creation to first pro message
  private async getConnectionTime(
    where: any,
  ): Promise<ConnectionTimeMetric> {
    // Get all leads with conversations
    const leads = await this.prisma.lead.findMany({
      where: {
        ...where,
        threadId: { not: null },
      },
      select: {
        id: true,
        createdAt: true,
        conversation: {
          select: {
            id: true,
          },
        },
      },
    });

    const connectionTimes: number[] = [];

    // For each lead, find first pro message
    for (const lead of leads) {
      if (!lead.conversation) continue;

      const firstProMessage = await this.prisma.message.findFirst({
        where: {
          conversationId: lead.conversation.id,
          sender: 'pro',
        },
        orderBy: { sentAt: 'asc' },
        select: { sentAt: true },
      });

      if (firstProMessage) {
        const diffMs =
          firstProMessage.sentAt.getTime() - lead.createdAt.getTime();
        const diffMinutes = diffMs / (1000 * 60);
        connectionTimes.push(diffMinutes);
      }
    }

    if (connectionTimes.length === 0) {
      return {
        averageMinutes: 0,
        median: 0,
        min: 0,
        max: 0,
        count: 0,
      };
    }

    connectionTimes.sort((a, b) => a - b);
    const median = this.calculateMedian(connectionTimes);

    return {
      averageMinutes:
        connectionTimes.reduce((a, b) => a + b, 0) / connectionTimes.length,
      median,
      min: Math.min(...connectionTimes),
      max: Math.max(...connectionTimes),
      count: connectionTimes.length,
    };
  }

  // Pro Response Time - Time between customer messages and next pro reply
  private async getProResponseTime(where: any): Promise<ResponseTimeMetric> {
    const leads = await this.prisma.lead.findMany({
      where: {
        ...where,
        threadId: { not: null },
      },
      select: {
        conversation: {
          select: { id: true },
        },
      },
    });

    const conversationIds = leads
      .filter((l) => l.conversation)
      .map((l) => l.conversation!.id);

    if (conversationIds.length === 0) {
      return { averageMinutes: 0, median: 0, count: 0 };
    }

    const responseTimes: number[] = [];

    // For each conversation, calculate response times
    for (const convId of conversationIds) {
      const messages = await this.prisma.message.findMany({
        where: { conversationId: convId },
        orderBy: { sentAt: 'asc' },
        select: { sender: true, sentAt: true },
      });

      // Find customer -> pro message pairs
      for (let i = 0; i < messages.length - 1; i++) {
        if (messages[i].sender === 'customer') {
          // Find next pro message
          for (let j = i + 1; j < messages.length; j++) {
            if (messages[j].sender === 'pro') {
              const diffMs =
                messages[j].sentAt.getTime() - messages[i].sentAt.getTime();
              const diffMinutes = diffMs / (1000 * 60);
              responseTimes.push(diffMinutes);
              break;
            }
          }
        }
      }
    }

    if (responseTimes.length === 0) {
      return { averageMinutes: 0, median: 0, count: 0 };
    }

    responseTimes.sort((a, b) => a - b);

    return {
      averageMinutes:
        responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length,
      median: this.calculateMedian(responseTimes),
      count: responseTimes.length,
    };
  }

  // Customer Response Time - Time between pro messages and next customer reply
  private async getCustomerResponseTime(
    where: any,
  ): Promise<ResponseTimeMetric> {
    const leads = await this.prisma.lead.findMany({
      where: {
        ...where,
        threadId: { not: null },
      },
      select: {
        conversation: {
          select: { id: true },
        },
      },
    });

    const conversationIds = leads
      .filter((l) => l.conversation)
      .map((l) => l.conversation!.id);

    if (conversationIds.length === 0) {
      return { averageMinutes: 0, median: 0, count: 0 };
    }

    const responseTimes: number[] = [];

    // For each conversation, calculate response times
    for (const convId of conversationIds) {
      const messages = await this.prisma.message.findMany({
        where: { conversationId: convId },
        orderBy: { sentAt: 'asc' },
        select: { sender: true, sentAt: true },
      });

      // Find pro -> customer message pairs
      for (let i = 0; i < messages.length - 1; i++) {
        if (messages[i].sender === 'pro') {
          // Find next customer message
          for (let j = i + 1; j < messages.length; j++) {
            if (messages[j].sender === 'customer') {
              const diffMs =
                messages[j].sentAt.getTime() - messages[i].sentAt.getTime();
              const diffMinutes = diffMs / (1000 * 60);
              responseTimes.push(diffMinutes);
              break;
            }
          }
        }
      }
    }

    if (responseTimes.length === 0) {
      return { averageMinutes: 0, median: 0, count: 0 };
    }

    responseTimes.sort((a, b) => a - b);

    return {
      averageMinutes:
        responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length,
      median: this.calculateMedian(responseTimes),
      count: responseTimes.length,
    };
  }

  // Messages Per Lead - Count messages grouped by lead
  private async getMessagesPerLead(
    where: any,
  ): Promise<MessagesPerLeadMetric> {
    const leads = await this.prisma.lead.findMany({
      where: {
        ...where,
        threadId: { not: null },
      },
      select: {
        conversation: {
          select: {
            id: true,
          },
        },
      },
    });

    const conversationIds = leads
      .filter((l) => l.conversation)
      .map((l) => l.conversation!.id);

    if (conversationIds.length === 0) {
      return { average: 0, median: 0, min: 0, max: 0 };
    }

    const messageCounts = await this.prisma.message.groupBy({
      by: ['conversationId'],
      where: {
        conversationId: { in: conversationIds },
      },
      _count: { id: true },
    });

    const counts = messageCounts.map((c) => c._count.id);

    if (counts.length === 0) {
      return { average: 0, median: 0, min: 0, max: 0 };
    }

    counts.sort((a, b) => a - b);

    return {
      average: counts.reduce((a, b) => a + b, 0) / counts.length,
      median: this.calculateMedian(counts),
      min: Math.min(...counts),
      max: Math.max(...counts),
    };
  }

  // Customer Engagement - Did customer send any messages
  private async getCustomerEngagement(
    where: any,
  ): Promise<CustomerEngagementMetric> {
    const totalLeads = await this.prisma.lead.count({ where });

    const leadsWithThreads = await this.prisma.lead.findMany({
      where: {
        ...where,
        threadId: { not: null },
      },
      select: {
        conversation: {
          select: { id: true },
        },
      },
    });

    const conversationIds = leadsWithThreads
      .filter((l) => l.conversation)
      .map((l) => l.conversation!.id);

    if (conversationIds.length === 0) {
      return { engagedCount: 0, totalCount: totalLeads, engagementRate: 0 };
    }

    // Find conversations with at least one customer message
    const engagedConversations = await this.prisma.message.groupBy({
      by: ['conversationId'],
      where: {
        conversationId: { in: conversationIds },
        sender: 'customer',
      },
    });

    const engagedCount = engagedConversations.length;

    return {
      engagedCount,
      totalCount: totalLeads,
      engagementRate: totalLeads > 0 ? (engagedCount / totalLeads) * 100 : 0,
    };
  }

  private calculateMedian(numbers: number[]): number {
    if (numbers.length === 0) return 0;
    const sorted = [...numbers].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  private async getTotalLeads(where: any): Promise<number> {
    return this.prisma.lead.count({ where });
  }

  private async getBusinessInfo(userId: string, businessId: string) {
    const account = await this.prisma.savedAccount.findFirst({
      where: { userId, businessId },
      select: { businessName: true },
    });
    return account;
  }
}
