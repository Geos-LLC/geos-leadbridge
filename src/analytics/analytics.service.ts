import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { TimeSeriesQueryDto } from './dto/analytics-timeseries-query.dto';
import {
  AnalyticsResponseDto,
  CategoryDistribution,
  ConnectionTimeMetric,
  ResponseTimeMetric,
  MessagesPerLeadMetric,
  CustomerEngagementMetric,
  ServiceDetailDistribution,
} from './dto/analytics-response.dto';

export interface TimeSeriesPoint {
  period: string;
  label: string;
  total: number;
  statuses: { [status: string]: number };
  hiredCount: number;
  conversionRate: number;
  avgBudget: number | null;
  totalBudget: number | null;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  private static readonly CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

  constructor(private prisma: PrismaService) {}

  private buildCacheKey(userId: string, businessId?: string, platform?: string): string {
    return `${userId}::${businessId ?? '__all__'}::${platform ?? '__any__'}`;
  }

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
      ...(query.platform && { platform: query.platform }),
      ...dateFilter,
    };

    // Execute only fast metrics in parallel
    const [categoryDist, engagement, totalLeads, jobStatusDist, businessInfo, lastLead] =
      await Promise.all([
        this.getCategoryDistribution(baseWhere),
        this.getCustomerEngagement(baseWhere),
        this.getTotalLeads(baseWhere),
        this.getJobStatusDistribution(baseWhere),
        query.businessId
          ? this.getBusinessInfo(userId, query.businessId)
          : null,
        this.prisma.lead.findFirst({
          where: {
            userId,
            ...(query.businessId && { businessId: query.businessId }),
            ...(query.platform && { platform: query.platform }),
          },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        }),
      ]);

    return {
      categoryDistribution: categoryDist,
      customerEngagement: engagement,
      totalLeads,
      jobStatusDistribution: jobStatusDist,
      lastLeadSyncAt: lastLead?.createdAt?.toISOString() || null,
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

  private async timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      this.logger.log(`[analytics] ${label} took ${Date.now() - start}ms`);
      return result;
    } catch (err: any) {
      this.logger.error(`[analytics] ${label} FAILED after ${Date.now() - start}ms: ${err.message}`);
      throw err;
    }
  }

  async getAnalytics(
    userId: string,
    query: AnalyticsQueryDto,
  ): Promise<{ data: AnalyticsResponseDto; calculatedAt: Date | null }> {
    // Only cache all-time queries (no date filter)
    const canCache = !query.startDate && !query.endDate;

    if (canCache) {
      const key = this.buildCacheKey(userId, query.businessId, query.platform);
      const cached = await this.prisma.analyticsCache.findUnique({ where: { cacheKey: key } });
      if (cached) {
        const ageMs = Date.now() - cached.calculatedAt.getTime();
        if (ageMs < AnalyticsService.CACHE_TTL_MS) {
          this.logger.log(`[analytics] cache HIT for ${key} (age ${Math.round(ageMs / 1000)}s)`);
          return { data: cached.data as unknown as AnalyticsResponseDto, calculatedAt: cached.calculatedAt };
        }
        this.logger.log(`[analytics] cache STALE for ${key} (age ${Math.round(ageMs / 1000)}s) — recomputing`);
      }
    }

    const data = await this.computeAnalytics(userId, query);

    if (canCache) {
      const key = this.buildCacheKey(userId, query.businessId, query.platform);
      const record = await this.prisma.analyticsCache.upsert({
        where:  { cacheKey: key },
        create: { cacheKey: key, userId, data: data as any },
        update: { data: data as any, calculatedAt: new Date() },
      });
      return { data, calculatedAt: record.calculatedAt };
    }

    return { data, calculatedAt: null };
  }

  async refreshAnalytics(
    userId: string,
    query: AnalyticsQueryDto,
  ): Promise<{ data: AnalyticsResponseDto; calculatedAt: Date }> {
    const data = await this.computeAnalytics(userId, query);
    const key = this.buildCacheKey(userId, query.businessId, query.platform);
    const record = await this.prisma.analyticsCache.upsert({
      where:  { cacheKey: key },
      create: { cacheKey: key, userId, data: data as any },
      update: { data: data as any, calculatedAt: new Date() },
    });
    return { data, calculatedAt: record.calculatedAt };
  }

  async getTimeSeries(userId: string, dto: TimeSeriesQueryDto): Promise<TimeSeriesPoint[]> {
    // period is validated by DTO @IsIn — safe to embed as SQL literal
    const period = dto.period ?? 'month';

    // Statuses that count as 'hired/converted' for conversion rate.
    // Includes Thumbtack terminal-complete + Yelp terminal-complete (done/closed/completed).
    const HIRED_STATUSES = new Set([
      'hired', 'job scheduled', 'scheduled', 'job done',
      'done', 'closed', 'completed', 'job complete', 'booked',
    ]);

    // Use tli.leadDate ("Feb 23") with year inference as the canonical lead date.
    // leads.createdAt and tli.capturedAt are both the import/capture timestamp (same day for bulk imports).
    // leadPrice from rawJson is the cost Thumbtack charged the pro per lead (estimate.total is typically null).
    const sqlStr = `
      WITH raw_leads AS (
        SELECT
          l.id,
          l."userId",
          l."businessId",
          l."thumbtackStatus",
          l."status" AS lead_status,
          l."rawJson",
          tli."thumbtackStatus" AS tli_status,
          tli."capturedAt"      AS tli_captured_at,
          l."createdAt"         AS l_created_at,
          -- Extract just the "Mon DD" prefix; leadDate may have trailing text like "Feb 23 · $52"
          CASE WHEN tli."leadDate" IS NOT NULL
            THEN regexp_replace(
              SUBSTRING(tli."leadDate" FROM '^[A-Za-z]{3}\\s+[0-9]{1,2}'),
              '\\s+', ' '
            )
            ELSE NULL
          END AS date_str
        FROM leads l
        LEFT JOIN thumbtack_lead_ids tli
          ON tli."thumbtackId" = l."externalRequestId"
         AND tli."userId"      = l."userId"
        WHERE l."userId" = $1
          AND ($2::text IS NULL OR l."businessId" = $2::text)
          AND ($5::text IS NULL OR l."platform" = $5::text)
      ),
      lead_dates AS (
        SELECT
          id, "userId", "businessId", "thumbtackStatus", lead_status, "rawJson", tli_status,
          CASE
            WHEN date_str IS NOT NULL AND date_str <> ''
            THEN
              CASE
                WHEN TO_DATE(date_str || ' ' || EXTRACT(YEAR FROM NOW())::text, 'Mon DD YYYY') > CURRENT_DATE
                THEN TO_DATE(date_str || ' ' || (EXTRACT(YEAR FROM NOW())::int - 1)::text, 'Mon DD YYYY')::timestamptz
                ELSE TO_DATE(date_str || ' ' || EXTRACT(YEAR FROM NOW())::text, 'Mon DD YYYY')::timestamptz
              END
            ELSE COALESCE(tli_captured_at, l_created_at)
          END AS lead_date
        FROM raw_leads
      ),
      status_counts AS (
        SELECT
          DATE_TRUNC('${period}', ld.lead_date AT TIME ZONE 'UTC') AS bucket,
          -- Prefer thumbtackStatus, fall back to tli_status (Thumbtack), then lead_status (Yelp + generic).
          -- Exclude 'new' — that's the default on creation and doesn't represent a job outcome.
          COALESCE(
            NULLIF(TRIM(COALESCE(ld."thumbtackStatus", ld.tli_status)), ''),
            NULLIF(CASE WHEN LOWER(ld.lead_status) = 'new' THEN NULL ELSE ld.lead_status END, ''),
            'No Status'
          ) AS job_status,
          COUNT(*) AS cnt
        FROM lead_dates ld
        WHERE ($3::timestamptz IS NULL OR ld.lead_date >= $3::timestamptz)
          AND ($4::timestamptz IS NULL OR ld.lead_date <= $4::timestamptz)
        GROUP BY bucket, job_status
      ),
      budget_stats AS (
        SELECT
          DATE_TRUNC('${period}', ld.lead_date AT TIME ZONE 'UTC') AS bucket,
          AVG(
            CASE WHEN ld."rawJson" IS NOT NULL AND ld."rawJson" != ''
              THEN NULLIF(LTRIM(ld."rawJson"::jsonb->>'leadPrice', '$'), '')::numeric
              ELSE NULL
            END
          ) AS avg_budget,
          SUM(
            CASE WHEN ld."rawJson" IS NOT NULL AND ld."rawJson" != ''
              THEN NULLIF(LTRIM(ld."rawJson"::jsonb->>'leadPrice', '$'), '')::numeric
              ELSE NULL
            END
          ) AS total_budget
        FROM lead_dates ld
        WHERE ($3::timestamptz IS NULL OR ld.lead_date >= $3::timestamptz)
          AND ($4::timestamptz IS NULL OR ld.lead_date <= $4::timestamptz)
        GROUP BY bucket
      )
      SELECT
        sc.bucket,
        sc.job_status,
        sc.cnt,
        bs.avg_budget,
        bs.total_budget
      FROM status_counts sc
      LEFT JOIN budget_stats bs ON bs.bucket = sc.bucket
      ORDER BY sc.bucket ASC, sc.cnt DESC
    `;

    const rows = await this.prisma.$queryRawUnsafe<Array<{
      bucket: Date;
      job_status: string;
      cnt: bigint;
      avg_budget: string | null;
      total_budget: string | null;
    }>>(
      sqlStr,
      userId,
      dto.businessId ?? null,
      dto.startDate ? new Date(dto.startDate) : null,
      dto.endDate   ? new Date(dto.endDate)   : null,
      dto.platform ?? null,
    );

    // Normalize display labels: merge similar statuses into canonical buckets.
    // Covers both Thumbtack (Hired, Job Done, etc.) and Yelp (Hired, Done, Closed, etc.).
    const normalizeStatus = (s: string): string => {
      const lower = s.toLowerCase();
      if (lower === 'hired')                               return 'Hired';
      if (lower === 'done' || lower === 'job done' || lower === 'job complete' || lower === 'completed')
                                                           return 'Job done';
      if (lower === 'closed' || lower === 'booked')        return 'Job done';
      if (lower === 'job scheduled' || lower === 'scheduled' || lower === 'in progress')
                                                           return 'Scheduled';
      if (lower === 'not scheduled yet') return 'Not hired';
      if (lower === 'not hired')         return 'Not hired';
      if (lower === 'no response' || lower === 'lost')     return 'Not hired';
      if (lower === 'no status')         return 'Not hired';   // no status → not hired
      return 'Not hired'; // any other unknown status → not hired
    };

    // Pivot rows into one point per bucket
    const bucketMap = new Map<string, TimeSeriesPoint>();
    for (const row of rows) {
      const key = row.bucket.toISOString();
      if (!bucketMap.has(key)) {
        bucketMap.set(key, {
          period: key,
          label: this.formatPeriodLabel(row.bucket, period as 'day' | 'week' | 'month' | 'year'),
          total: 0,
          statuses: {},
          hiredCount: 0,
          conversionRate: 0,
          avgBudget: row.avg_budget != null ? parseFloat(row.avg_budget) : null,
          totalBudget: row.total_budget != null ? parseFloat(row.total_budget) : null,
        });
      }
      const entry = bucketMap.get(key)!;
      const cnt = Number(row.cnt);
      const status = normalizeStatus(row.job_status);
      entry.statuses[status] = (entry.statuses[status] ?? 0) + cnt; // merge same-display statuses
      entry.total += cnt;
      if (HIRED_STATUSES.has(row.job_status.toLowerCase())) {
        entry.hiredCount += cnt;
      }
    }

    for (const entry of bucketMap.values()) {
      entry.conversionRate = entry.total > 0 ? (entry.hiredCount / entry.total) * 100 : 0;
    }

    return Array.from(bucketMap.values());
  }

  private formatPeriodLabel(date: Date, period: 'day' | 'week' | 'month' | 'year'): string {
    switch (period) {
      case 'year':
        return date.getUTCFullYear().toString();
      case 'month':
        return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
      case 'week':
        return 'Wk ' + date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
      case 'day':
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    }
  }

  async invalidateCache(userId: string) {
    const result = await this.prisma.analyticsCache.deleteMany({ where: { userId } });
    if (result.count > 0) {
      this.logger.log(`[analytics] invalidated ${result.count} cache entries for user ${userId}`);
    }
  }

  async getCacheInfo(userId: string, businessId?: string): Promise<{ calculatedAt: Date } | null> {
    const key = this.buildCacheKey(userId, businessId);
    const cached = await this.prisma.analyticsCache.findUnique({ where: { cacheKey: key } });
    return cached ? { calculatedAt: cached.calculatedAt } : null;
  }

  private async computeAnalytics(
    userId: string,
    query: AnalyticsQueryDto,
  ): Promise<AnalyticsResponseDto> {
    this.logger.log(`[analytics] computing for user ${userId}`);
    const totalStart = Date.now();

    // Build date filter
    const dateFilter = this.buildDateFilter(query);

    // Build base where clause
    const baseWhere = {
      userId,
      ...(query.businessId && { businessId: query.businessId }),
      ...(query.platform && { platform: query.platform }),
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
      jobStatusDist,
      businessInfo,
      cleaningTypes,
      addOns,
      frequencies,
      locations,
      zipCodes,
      roomStats,
      avgLeadPrice,
      avgJobPrice,
      lastLead,
    ] = await Promise.all([
      this.timed('categoryDistribution', () => this.getCategoryDistribution(baseWhere)),
      this.timed('connectionTime', () => this.getConnectionTime(baseWhere)),
      this.timed('proResponseTime', () => this.getProResponseTime(baseWhere)),
      this.timed('customerResponseTime', () => this.getCustomerResponseTime(baseWhere)),
      this.timed('messagesPerLead', () => this.getMessagesPerLead(baseWhere)),
      this.timed('customerEngagement', () => this.getCustomerEngagement(baseWhere)),
      this.timed('totalLeads', () => this.getTotalLeads(baseWhere)),
      this.timed('jobStatusDistribution', () => this.getJobStatusDistribution(baseWhere)),
      query.businessId
        ? this.timed('businessInfo', () => this.getBusinessInfo(userId, query.businessId!))
        : Promise.resolve(null),
      this.timed('cleaningTypeDistribution', () => this.getCleaningTypeDistribution(baseWhere)),
      this.timed('addOnsDistribution', () => this.getAddOnsDistribution(baseWhere)),
      this.timed('frequencyDistribution', () => this.getFrequencyDistribution(baseWhere)),
      this.timed('locationDistribution', () => this.getLocationDistribution(baseWhere)),
      this.timed('zipCodeDistribution', () => this.getZipCodeDistribution(baseWhere)),
      this.timed('roomStats', () => this.getRoomStats(baseWhere)),
      this.timed('averageLeadPrice', () => this.getAverageLeadPrice(userId, query)),
      this.timed('averageJobPrice', () => this.getAverageJobPrice(userId, query)),
      this.prisma.lead.findFirst({
        where: {
          userId,
          ...(query.businessId && { businessId: query.businessId }),
          ...(query.platform && { platform: query.platform }),
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);

    this.logger.log(`[analytics] computeAnalytics TOTAL took ${Date.now() - totalStart}ms`);

    return {
      categoryDistribution: categoryDist,
      connectionTime,
      proResponseTime: proResponse,
      customerResponseTime: customerResponse,
      messagesPerLead,
      customerEngagement: engagement,
      totalLeads,
      jobStatusDistribution: jobStatusDist,
      lastLeadSyncAt: lastLead?.createdAt?.toISOString() || null,
      cleaningTypeDistribution: cleaningTypes,
      addOnsDistribution: addOns,
      frequencyDistribution: frequencies,
      locationDistribution: locations,
      zipCodeDistribution: zipCodes,
      roomStats,
      averageLeadPrice: avgLeadPrice,
      averageJobPrice: avgJobPrice,
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

  // Job Status Distribution — combines Thumbtack (thumbtackStatus) and Yelp (lead.status)
  // into a single distribution. Yelp uses l.status with values like 'done', 'closed',
  // 'hired', etc. Thumbtack uses thumbtackStatus. 'new' is excluded for both.
  private async getJobStatusDistribution(
    where: any,
  ): Promise<ServiceDetailDistribution[]> {
    // Pull all leads with any terminal status via raw SQL so we can COALESCE and filter
    const userId = where.userId;
    if (!userId) return [];

    const rows = await this.prisma.$queryRawUnsafe<Array<{ job_status: string; cnt: bigint }>>(
      `SELECT
         COALESCE(
           NULLIF(TRIM(l."thumbtackStatus"), ''),
           NULLIF(CASE WHEN LOWER(l."status") = 'new' THEN NULL ELSE l."status" END, ''),
           'Unknown'
         ) AS job_status,
         COUNT(*)::bigint AS cnt
       FROM leads l
       WHERE l."userId" = $1
         AND ($2::text IS NULL OR l."businessId" = $2::text)
         AND ($3::text IS NULL OR l."platform" = $3::text)
         AND (
           (l."thumbtackStatus" IS NOT NULL AND TRIM(l."thumbtackStatus") <> '')
           OR (l."status" IS NOT NULL AND LOWER(l."status") NOT IN ('new', '') AND TRIM(l."status") <> '')
         )
       GROUP BY job_status
       ORDER BY cnt DESC`,
      userId,
      where.businessId ?? null,
      where.platform ?? null,
    );

    if (rows.length === 0) {
      // Fallback for legacy Thumbtack leads: ThumbtackLeadId table
      const collectedWithStatus = await this.prisma.thumbtackLeadId.groupBy({
        by: ['thumbtackStatus'],
        where: {
          userId,
          thumbtackStatus: { not: null },
          imported: true,
          ...(where.businessId ? {
            savedAccount: { businessId: where.businessId },
          } : {}),
        },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
      });
      const total = collectedWithStatus.reduce((sum, r) => sum + r._count.id, 0);
      return collectedWithStatus.map((r) => ({
        name: r.thumbtackStatus || 'Unknown',
        count: r._count.id,
        percentage: total > 0 ? (r._count.id / total) * 100 : 0,
      }));
    }

    const total = rows.reduce((sum, r) => sum + Number(r.cnt), 0);
    return rows.map((r) => ({
      name: r.job_status,
      count: Number(r.cnt),
      percentage: total > 0 ? (Number(r.cnt) / total) * 100 : 0,
    }));
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
    // Only measure leads that were replied to via LeadBridge (have a notification log)
    // First, get leadIds that have successful notification logs
    const sentLogs = await this.prisma.notificationLog.findMany({
      where: {
        leadId: { not: null },
        status: { in: ['sent', 'delivered', 'queued'] },
      },
      distinct: ['leadId'],
      select: { leadId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    // Build map: leadId → earliest notification sent time
    const leadFirstNotif = new Map<string, Date>();
    for (const log of sentLogs) {
      if (!log.leadId) continue;
      if (!leadFirstNotif.has(log.leadId) || log.createdAt < leadFirstNotif.get(log.leadId)!) {
        leadFirstNotif.set(log.leadId, log.createdAt);
      }
    }

    if (leadFirstNotif.size === 0) {
      return { averageMinutes: 0, median: 0, min: 0, max: 0, count: 0 };
    }

    // Fetch those leads with their createdAt
    const leads = await this.prisma.lead.findMany({
      where: {
        ...where,
        id: { in: [...leadFirstNotif.keys()] },
      },
      select: { id: true, createdAt: true },
    });

    const connectionTimes: number[] = [];

    for (const lead of leads) {
      const notifTime = leadFirstNotif.get(lead.id);
      if (!notifTime) continue;
      const diffMs = notifTime.getTime() - lead.createdAt.getTime();
      if (diffMs < 0) continue;
      connectionTimes.push(diffMs / (1000 * 60));
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
      where: { ...where, threadId: { not: null } },
      select: { conversation: { select: { id: true } } },
    });

    const conversationIds = leads
      .filter((l) => l.conversation)
      .map((l) => l.conversation!.id);

    if (conversationIds.length === 0) {
      return { averageMinutes: 0, median: 0, count: 0 };
    }

    // Single bulk query for all messages across all conversations
    const allMessages = await this.prisma.message.findMany({
      where: { conversationId: { in: conversationIds } },
      orderBy: { sentAt: 'asc' },
      select: { conversationId: true, sender: true, sentAt: true },
    });

    // Group messages by conversation in memory
    const byConv = new Map<string, { sender: string; sentAt: Date }[]>();
    for (const msg of allMessages) {
      if (!byConv.has(msg.conversationId)) byConv.set(msg.conversationId, []);
      byConv.get(msg.conversationId)!.push(msg);
    }

    const responseTimes: number[] = [];

    for (const messages of byConv.values()) {
      // Find customer -> pro message pairs
      for (let i = 0; i < messages.length - 1; i++) {
        if (messages[i].sender === 'customer') {
          for (let j = i + 1; j < messages.length; j++) {
            if (messages[j].sender === 'pro') {
              const diffMin = (messages[j].sentAt.getTime() - messages[i].sentAt.getTime()) / 60000;
              if (diffMin >= 0) responseTimes.push(diffMin);
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
      where: { ...where, threadId: { not: null } },
      select: { conversation: { select: { id: true } } },
    });

    const conversationIds = leads
      .filter((l) => l.conversation)
      .map((l) => l.conversation!.id);

    if (conversationIds.length === 0) {
      return { averageMinutes: 0, median: 0, count: 0 };
    }

    // Single bulk query for all messages across all conversations
    const allMessages = await this.prisma.message.findMany({
      where: { conversationId: { in: conversationIds } },
      orderBy: { sentAt: 'asc' },
      select: { conversationId: true, sender: true, sentAt: true },
    });

    // Group messages by conversation in memory
    const byConv = new Map<string, { sender: string; sentAt: Date }[]>();
    for (const msg of allMessages) {
      if (!byConv.has(msg.conversationId)) byConv.set(msg.conversationId, []);
      byConv.get(msg.conversationId)!.push(msg);
    }

    const responseTimes: number[] = [];

    for (const messages of byConv.values()) {
      // Find pro -> customer message pairs
      for (let i = 0; i < messages.length - 1; i++) {
        if (messages[i].sender === 'pro') {
          for (let j = i + 1; j < messages.length; j++) {
            if (messages[j].sender === 'customer') {
              responseTimes.push(
                (messages[j].sentAt.getTime() - messages[i].sentAt.getTime()) / 60000,
              );
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

    // Only count leads that were contacted via LeadBridge (have notification logs)
    const sentLogLeadIds = await this.prisma.notificationLog.findMany({
      where: {
        leadId: { not: null },
        status: { in: ['sent', 'delivered', 'queued'] },
      },
      distinct: ['leadId'],
      select: { leadId: true },
    });
    const contactedLeadIds = sentLogLeadIds.map(l => l.leadId).filter(Boolean) as string[];

    const leadsContactedViaApp = contactedLeadIds.length > 0
      ? await this.prisma.lead.findMany({
          where: {
            ...where,
            id: { in: contactedLeadIds },
            threadId: { not: null },
          },
          select: {
            conversation: {
              select: { id: true },
            },
          },
        })
      : [];

    const contactedCount = contactedLeadIds.length; // Total leads contacted, even those without threads
    const conversationIds = leadsContactedViaApp
      .filter((l) => l.conversation)
      .map((l) => l.conversation!.id);

    if (conversationIds.length === 0) {
      return { engagedCount: 0, totalCount: contactedCount || totalLeads, engagementRate: 0 };
    }

    // Find conversations where the customer replied back
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
      totalCount: contactedCount,
      engagementRate: contactedCount > 0 ? (engagedCount / contactedCount) * 100 : 0,
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

  // Average job price across leads in a "won" terminal state — booked /
  // scheduled / hired / completed / done / closed (Yelp + Thumbtack vocab).
  // Reads Lead.budget (customer-stated budget at request time) as the
  // closest proxy for actual job value, since neither platform reliably
  // exposes a final-price field.
  private async getAverageJobPrice(
    userId: string,
    query: AnalyticsQueryDto,
  ): Promise<{ value: number | null; count: number }> {
    const wonStatuses = [
      'hired', 'job scheduled', 'scheduled', 'job done',
      'done', 'closed', 'completed', 'job complete', 'booked',
    ];
    const rows = await this.prisma.$queryRawUnsafe<Array<{ avg_price: string | null; cnt: bigint }>>(
      `SELECT
         AVG(l."budget")::text AS avg_price,
         COUNT(l."budget")::bigint AS cnt
       FROM leads l
       WHERE l."userId" = $1
         AND ($2::text IS NULL OR l."businessId" = $2::text)
         AND ($3::timestamptz IS NULL OR l."createdAt" >= $3::timestamptz)
         AND ($4::timestamptz IS NULL OR l."createdAt" <= $4::timestamptz)
         AND ($5::text IS NULL OR l."platform" = $5::text)
         AND l."budget" IS NOT NULL
         AND (
           LOWER(COALESCE(l."thumbtackStatus", '')) = ANY($6::text[])
           OR LOWER(COALESCE(l."status", '')) = ANY($6::text[])
         )`,
      userId,
      query.businessId ?? null,
      query.startDate ? new Date(query.startDate) : null,
      query.endDate ? new Date(query.endDate) : null,
      query.platform ?? null,
      wonStatuses,
    );

    const row = rows[0];
    return {
      value: row?.avg_price != null ? parseFloat(row.avg_price) : null,
      count: row?.cnt != null ? Number(row.cnt) : 0,
    };
  }

  // Average Thumbtack lead price (cost the pro paid per lead).
  // Pulled from rawJson.leadPrice — only meaningful for Thumbtack leads.
  // Skipped when caller filters to platform='yelp' (Yelp doesn't bill per-lead).
  private async getAverageLeadPrice(
    userId: string,
    query: AnalyticsQueryDto,
  ): Promise<{ value: number | null; count: number }> {
    if (query.platform === 'yelp') {
      return { value: null, count: 0 };
    }

    const rows = await this.prisma.$queryRawUnsafe<Array<{ avg_price: string | null; cnt: bigint }>>(
      `SELECT
         AVG(NULLIF(LTRIM(l."rawJson"::jsonb->>'leadPrice', '$'), '')::numeric) AS avg_price,
         COUNT(NULLIF(LTRIM(l."rawJson"::jsonb->>'leadPrice', '$'), '')::numeric)::bigint AS cnt
       FROM leads l
       WHERE l."userId" = $1
         AND l."platform" = 'thumbtack'
         AND ($2::text IS NULL OR l."businessId" = $2::text)
         AND ($3::timestamptz IS NULL OR l."createdAt" >= $3::timestamptz)
         AND ($4::timestamptz IS NULL OR l."createdAt" <= $4::timestamptz)
         AND l."rawJson" IS NOT NULL
         AND l."rawJson" <> ''
         AND l."rawJson"::jsonb->>'leadPrice' IS NOT NULL`,
      userId,
      query.businessId ?? null,
      query.startDate ? new Date(query.startDate) : null,
      query.endDate ? new Date(query.endDate) : null,
    );

    const row = rows[0];
    return {
      value: row?.avg_price != null ? parseFloat(row.avg_price) : null,
      count: row?.cnt != null ? Number(row.cnt) : 0,
    };
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
        const details = raw.request?.details || [];

        // Details is an array of {question, answer} objects
        const cleaningTypeAnswer = this.findAnswer(details, ['Cleaning type', 'Type of cleaning', 'Service type']);
        if (cleaningTypeAnswer) {
          typeCounts.set(cleaningTypeAnswer, (typeCounts.get(cleaningTypeAnswer) || 0) + 1);
          total++;
        }
      } catch (_err) {
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
    let _totalLeadsWithAddons = 0;

    for (const lead of leads) {
      try {
        const raw = JSON.parse(lead.rawJson);
        const details = raw.request?.details || [];

        // Details is an array of {question, answer} objects
        const addOnsAnswer = this.findAnswer(details, ['Add-ons', 'Additional services', 'Extras']);
        if (addOnsAnswer) {
          _totalLeadsWithAddons++;
          // Answer might be comma-separated or a single value
          const addons = addOnsAnswer.split(/,|\n/).map(a => a.trim()).filter(Boolean);
          for (const addon of addons) {
            addonCounts.set(addon, (addonCounts.get(addon) || 0) + 1);
          }
        }
      } catch (_err) {
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
        const details = raw.request?.details || [];

        // Details is an array of {question, answer} objects
        const frequencyAnswer = this.findAnswer(details, ['Frequency', 'Service frequency', 'How often']);
        if (frequencyAnswer) {
          frequencyCounts.set(frequencyAnswer, (frequencyCounts.get(frequencyAnswer) || 0) + 1);
          total++;
        }
      } catch (_err) {
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
        const details = raw.request?.details || [];

        // Details is an array of {question, answer} objects
        const bedroomsAnswer = this.findAnswer(details, ['Number of bedrooms', 'Bedrooms', 'How many bedrooms']);
        if (bedroomsAnswer) {
          // Extract number from answer like "3 bedrooms" or "3"
          const beds = this.extractNumber(bedroomsAnswer);
          if (beds !== null) bedrooms.push(beds);
        }

        const bathroomsAnswer = this.findAnswer(details, ['Number of bathrooms', 'Bathrooms', 'How many bathrooms']);
        if (bathroomsAnswer) {
          // Extract number from answer like "2 bathrooms" or "2"
          const baths = this.extractNumber(bathroomsAnswer);
          if (baths !== null) bathrooms.push(baths);
        }
      } catch (_err) {
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

  /**
   * Helper to find an answer from details array by question
   */
  private findAnswer(details: any[], questionVariants: string[]): string | null {
    if (!Array.isArray(details)) return null;

    for (const item of details) {
      if (item.question && item.answer) {
        const question = String(item.question).toLowerCase();
        for (const variant of questionVariants) {
          if (question.includes(variant.toLowerCase())) {
            return String(item.answer);
          }
        }
      }
    }
    return null;
  }

  /**
   * Helper to extract first number from a string
   */
  private extractNumber(text: string): number | null {
    const match = text.match(/\d+/);
    if (match) {
      const num = parseInt(match[0]);
      return isNaN(num) ? null : num;
    }
    return null;
  }
}
