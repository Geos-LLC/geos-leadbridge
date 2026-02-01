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

  // Basic analytics - Fast metrics only (categories, total leads, engagement)
  async getBasicAnalytics(
    userId: string,
    query: AnalyticsQueryDto,
  ): Promise<Partial<AnalyticsResponseDto>> {
    this.logger.log(`Getting basic analytics for user ${userId}`, query);

    // Build date filter
    const dateFilter = this.buildDateFilter(query);

    // Build base where clause
    const baseWhere = {
      userId,
      ...(query.businessId && { businessId: query.businessId }),
      ...dateFilter,
    };

    // Execute only fast metrics in parallel
    const [categoryDist, engagement, totalLeads, businessInfo] =
      await Promise.all([
        this.getCategoryDistribution(baseWhere),
        this.getCustomerEngagement(baseWhere),
        this.getTotalLeads(baseWhere),
        query.businessId
          ? this.getBusinessInfo(userId, query.businessId)
          : null,
      ]);

    return {
      categoryDistribution: categoryDist,
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
      cleaningTypes,
      addOns,
      frequencies,
      locations,
      zipCodes,
      roomStats,
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
      this.getCleaningTypeDistribution(baseWhere),
      this.getAddOnsDistribution(baseWhere),
      this.getFrequencyDistribution(baseWhere),
      this.getLocationDistribution(baseWhere),
      this.getZipCodeDistribution(baseWhere),
      this.getRoomStats(baseWhere),
    ]);

    return {
      categoryDistribution: categoryDist,
      connectionTime,
      proResponseTime: proResponse,
      customerResponseTime: customerResponse,
      messagesPerLead,
      customerEngagement: engagement,
      totalLeads,
      cleaningTypeDistribution: cleaningTypes,
      addOnsDistribution: addOns,
      frequencyDistribution: frequencies,
      locationDistribution: locations,
      zipCodeDistribution: zipCodes,
      roomStats,
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

  // ==========================================
  // Service Detail Analytics
  // ==========================================

  /**
   * Get cleaning type distribution from rawJson
   */
  private async getCleaningTypeDistribution(where: any) {
    const leads = await this.prisma.lead.findMany({
      where,
      select: { rawJson: true },
    });

    const typeCounts = new Map<string, number>();
    let total = 0;

    for (const lead of leads) {
      try {
        const raw = JSON.parse(lead.rawJson);
        const details = raw.request?.details || {};

        const cleaningType = details.cleaningType || details.serviceType || details.type;
        if (cleaningType) {
          const type = String(cleaningType);
          typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
          total++;
        }
      } catch (err) {
        // Skip invalid JSON
      }
    }

    return Array.from(typeCounts.entries())
      .map(([name, count]) => ({
        name,
        count,
        percentage: total > 0 ? (count / total) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Get add-ons distribution from rawJson
   */
  private async getAddOnsDistribution(where: any) {
    const leads = await this.prisma.lead.findMany({
      where,
      select: { rawJson: true },
    });

    const addonCounts = new Map<string, number>();
    let totalLeadsWithAddons = 0;

    for (const lead of leads) {
      try {
        const raw = JSON.parse(lead.rawJson);
        const details = raw.request?.details || {};

        const addOns = details.addOns || details.addons;
        if (addOns && Array.isArray(addOns) && addOns.length > 0) {
          totalLeadsWithAddons++;
          for (const addon of addOns) {
            const addonName = String(addon);
            addonCounts.set(addonName, (addonCounts.get(addonName) || 0) + 1);
          }
        }
      } catch (err) {
        // Skip invalid JSON
      }
    }

    const totalLeads = leads.length;
    return Array.from(addonCounts.entries())
      .map(([name, count]) => ({
        name,
        count,
        percentage: totalLeads > 0 ? (count / totalLeads) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Get frequency distribution from rawJson
   */
  private async getFrequencyDistribution(where: any) {
    const leads = await this.prisma.lead.findMany({
      where,
      select: { rawJson: true },
    });

    const frequencyCounts = new Map<string, number>();
    let total = 0;

    for (const lead of leads) {
      try {
        const raw = JSON.parse(lead.rawJson);
        const details = raw.request?.details || {};

        const frequency = details.frequency || details.serviceFrequency || details.schedule;
        if (frequency) {
          const freq = String(frequency);
          frequencyCounts.set(freq, (frequencyCounts.get(freq) || 0) + 1);
          total++;
        }
      } catch (err) {
        // Skip invalid JSON
      }
    }

    return Array.from(frequencyCounts.entries())
      .map(([name, count]) => ({
        name,
        count,
        percentage: total > 0 ? (count / total) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Get location distribution (city, state)
   */
  private async getLocationDistribution(where: any) {
    const results = await this.prisma.lead.groupBy({
      by: ['city', 'state'],
      where,
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    });

    const total = results.reduce((sum, r) => sum + r._count.id, 0);

    return results
      .filter(r => r.city || r.state)
      .map((r) => ({
        name: [r.city, r.state].filter(Boolean).join(', ') || 'Unknown',
        count: r._count.id,
        percentage: total > 0 ? (r._count.id / total) * 100 : 0,
      }));
  }

  /**
   * Get zip code distribution
   */
  private async getZipCodeDistribution(where: any) {
    const results = await this.prisma.lead.groupBy({
      by: ['postcode'],
      where: {
        ...where,
        postcode: { not: null },
      },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 20, // Top 20 zip codes
    });

    const total = results.reduce((sum, r) => sum + r._count.id, 0);

    return results.map((r) => ({
      name: r.postcode || 'Unknown',
      count: r._count.id,
      percentage: total > 0 ? (r._count.id / total) * 100 : 0,
    }));
  }

  /**
   * Get bedroom/bathroom statistics from rawJson
   */
  private async getRoomStats(where: any) {
    const leads = await this.prisma.lead.findMany({
      where,
      select: { rawJson: true },
    });

    const bedrooms: number[] = [];
    const bathrooms: number[] = [];

    for (const lead of leads) {
      try {
        const raw = JSON.parse(lead.rawJson);
        const details = raw.request?.details || {};

        if (details.bedrooms !== undefined && details.bedrooms !== null) {
          const beds = Number(details.bedrooms);
          if (!isNaN(beds)) bedrooms.push(beds);
        }

        if (details.bathrooms !== undefined && details.bathrooms !== null) {
          const baths = Number(details.bathrooms);
          if (!isNaN(baths)) bathrooms.push(baths);
        }
      } catch (err) {
        // Skip invalid JSON
      }
    }

    return {
      averageBedrooms: bedrooms.length > 0
        ? bedrooms.reduce((a, b) => a + b, 0) / bedrooms.length
        : 0,
      averageBathrooms: bathrooms.length > 0
        ? bathrooms.reduce((a, b) => a + b, 0) / bathrooms.length
        : 0,
      maxBedrooms: bedrooms.length > 0 ? Math.max(...bedrooms) : 0,
      maxBathrooms: bathrooms.length > 0 ? Math.max(...bathrooms) : 0,
      minBedrooms: bedrooms.length > 0 ? Math.min(...bedrooms) : 0,
      minBathrooms: bathrooms.length > 0 ? Math.min(...bathrooms) : 0,
    };
  }
}
