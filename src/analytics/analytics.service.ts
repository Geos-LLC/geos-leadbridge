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
  OutcomeBreakdown,
} from './dto/analytics-response.dto';
import { activityBucketFromThreadContext } from '../conversation-context/activity-bucket';

export interface TimeSeriesPoint {
  period: string;
  label: string;
  total: number;
  /**
   * 5-bucket aggregate keyed by marketplace label
   * (Active / Scheduled / Done / Lost / Cancelled). Drives the stacked-bar
   * segments. Unknown statuses surface under their raw label.
   */
  statuses: { [bucketLabel: string]: number };
  /** Active = new + engaged + quoted + in_progress (+ legacy contacted). */
  activeCount: number;
  /** Scheduled = booked (+ legacy scheduled). */
  scheduledCount: number;
  /** Done = completed. */
  doneCount: number;
  /** Lost = lost + no_show + archived. */
  lostCount: number;
  /** Cancelled = cancelled (separate from Lost). */
  cancelledCount: number;
  /**
   * Aggregate won = scheduledCount + doneCount. Kept so the existing chart
   * stacked-bar logic can read either fine-grained or aggregate.
   */
  wonCount: number;
  /** Legacy alias of wonCount — pre-2026-06-08 frontend builds read this. */
  hiredCount: number;
  /**
   * Hire Rate for this bucket: won / (won + lost + cancelled).
   * Null when there are zero resolved leads in the bucket.
   */
  hireRate: number | null;
  /** Legacy alias of hireRate. */
  conversionRate: number | null;
  /** active / total in the bucket; null when bucket is empty. */
  activeRate: number | null;
  /** Legacy alias of activeRate. */
  activeLeadRate: number | null;
  avgBudget: number | null;
  totalBudget: number | null;
}

// ===========================================================================
// Status classification — driven exclusively by Lead.status (canonical).
//
// Target production statuses:
//   active : new, engaged
//   won    : booked, completed
//   lost   : lost, cancelled
//
// Legal-but-inactive (kept here so they never default to "Not hired"):
//   active : quoted, in_progress
//   lost   : no_show, archived
//
// Legacy-safe (pre-2026-06-08 status simplification; should be zero rows
// after the migration but the analytics layer reads them defensively in
// case any drift creeps in):
//   active : contacted     → counted as active (was the engaged synonym)
//   won    : scheduled     → counted as won (was the booked synonym)
// ===========================================================================

export const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'new',
  'engaged',
  'quoted',
  'in_progress',
  // legacy-safe
  'contacted',
]);

export const WON_STATUSES: ReadonlySet<string> = new Set([
  'booked',
  'completed',
  // legacy-safe
  'scheduled',
]);

export const LOST_STATUSES: ReadonlySet<string> = new Set([
  'lost',
  'cancelled',
  'no_show',
  'archived',
]);

export type OutcomeClass = 'active' | 'won' | 'lost' | 'unknown';

export function classifyStatus(s: string | null | undefined): OutcomeClass {
  if (!s) return 'unknown';
  const lower = s.toLowerCase().trim();
  if (WON_STATUSES.has(lower)) return 'won';
  if (LOST_STATUSES.has(lower)) return 'lost';
  if (ACTIVE_STATUSES.has(lower)) return 'active';
  return 'unknown';
}

/**
 * Granular display label for a canonical Lead.status — used on per-lead
 * pills, conversation headers, and the Job Status detail panel where
 * operators want to see the specific lifecycle position.
 *
 * Marketplace-friendly (Thumbtack/Yelp) terminology:
 *   booked    → "Scheduled" (the lead is on the calendar)
 *   completed → "Done"      (the job has been performed)
 */
export function statusDisplayLabel(s: string | null | undefined): string {
  if (!s) return 'Unknown';
  const lower = s.toLowerCase().trim();
  switch (lower) {
    case 'new':         return 'New';
    case 'engaged':     return 'Engaged';
    case 'contacted':   return 'Engaged';      // legacy-safe
    case 'quoted':      return 'Quoted';
    case 'in_progress': return 'In progress';
    case 'booked':      return 'Scheduled';
    case 'scheduled':   return 'Scheduled';    // legacy-safe
    case 'completed':   return 'Done';
    case 'lost':        return 'Lost';
    case 'cancelled':   return 'Cancelled';
    case 'no_show':     return 'No show';
    case 'archived':    return 'Archived';
    default:            return s;
  }
}

/**
 * 5-bucket aggregate label for analytics dashboards — collapses new/engaged
 * (and other active sub-states) into a single "Active" segment so the
 * Trends chart and KPI row read at the marketplace level rather than the
 * canonical pipeline level.
 *
 *   Active     ← new, engaged, quoted, in_progress, contacted (legacy)
 *   Scheduled  ← booked, scheduled (legacy)
 *   Done       ← completed
 *   Cancelled  ← cancelled                       (separated from Lost per UX spec)
 *   Lost       ← lost, no_show, archived
 */
export type BucketLabel = 'Active' | 'Scheduled' | 'Done' | 'Cancelled' | 'Lost' | 'Unknown';

export function statusBucketLabel(s: string | null | undefined): BucketLabel {
  if (!s) return 'Unknown';
  const lower = s.toLowerCase().trim();
  if (lower === 'cancelled') return 'Cancelled';
  if (lower === 'booked' || lower === 'scheduled') return 'Scheduled';
  if (lower === 'completed') return 'Done';
  if (LOST_STATUSES.has(lower)) return 'Lost';
  if (ACTIVE_STATUSES.has(lower)) return 'Active';
  return 'Unknown';
}

/**
 * Optional Active sub-bucket counts. When omitted the breakdown returns a
 * zeroed `activeBuckets`. Callers that have joined ThreadContext can
 * compute the per-bucket totals via activityBucketFromThreadContext and
 * pass them through here.
 */
export interface ComputeOutcomeBreakdownOpts {
  activeBuckets?: {
    engagement?: number;
    ai_conversation?: number;
    follow_up?: number;
    human_handoff?: number;
  };
}

export function computeOutcomeBreakdown(
  rows: { status: string; count: number }[],
  opts: ComputeOutcomeBreakdownOpts = {},
): OutcomeBreakdown {
  let active = 0, scheduled = 0, done = 0, lost = 0, cancelled = 0;
  for (const r of rows) {
    const lower = (r.status ?? '').toLowerCase().trim();
    if (lower === 'cancelled') { cancelled += r.count; continue; }
    if (lower === 'booked' || lower === 'scheduled') { scheduled += r.count; continue; }
    if (lower === 'completed') { done += r.count; continue; }
    switch (classifyStatus(r.status)) {
      case 'active': active += r.count; break;
      case 'lost':   lost   += r.count; break;
      // 'won' is fully decomposed above into scheduled / done.
      // 'unknown' is intentionally excluded — never silently absorbed.
    }
  }
  const won = scheduled + done;
  const total = active + scheduled + done + lost + cancelled;
  const resolved = won + lost + cancelled;
  const hireRate = resolved > 0 ? (won / resolved) * 100 : null;
  const activeRate = total > 0 ? (active / total) * 100 : null;
  return {
    active,
    scheduled,
    done,
    won,
    lost,
    cancelled,
    total,
    activeBuckets: {
      engagement:      opts.activeBuckets?.engagement      ?? 0,
      ai_conversation: opts.activeBuckets?.ai_conversation ?? 0,
      follow_up:       opts.activeBuckets?.follow_up       ?? 0,
      human_handoff:   opts.activeBuckets?.human_handoff   ?? 0,
    },
    hireRate,
    conversionRate: hireRate,    // back-compat alias
    activeRate,
    activeLeadRate: activeRate,  // back-compat alias
  };
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
    const [categoryDist, engagement, totalLeads, jobStatusDist, outcomes, businessInfo, lastLead] =
      await Promise.all([
        this.getCategoryDistribution(baseWhere),
        this.getCustomerEngagement(baseWhere),
        this.getTotalLeads(baseWhere),
        this.getJobStatusDistribution(baseWhere),
        this.getOutcomes(baseWhere),
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
      outcomes,
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

    // Bucket leads by Lead.status only. Raw platform statuses are
    // intentionally excluded from KPI math (2026-06-08 spec rule 6).
    // tli.leadDate is still used for date placement of legacy leads.
    //
    // leadPrice from rawJson is the cost Thumbtack charged the pro per lead.
    const sqlStr = `
      WITH raw_leads AS (
        SELECT
          l.id,
          l."userId",
          l."businessId",
          l."status" AS lead_status,
          l."rawJson",
          tli."capturedAt"      AS tli_captured_at,
          l."createdAt"         AS l_created_at,
          CASE
            WHEN tli."leadDate" ~ '^[A-Za-z]{3}\\s+[0-9]{1,2},?\\s+[0-9]{4}'
            THEN regexp_replace(
              SUBSTRING(tli."leadDate" FROM '^[A-Za-z]{3}\\s+[0-9]{1,2},?\\s+[0-9]{4}'),
              ',', '', 'g'
            )
            ELSE NULL
          END AS full_date_str
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
          id, "userId", "businessId", lead_status, "rawJson",
          CASE
            WHEN full_date_str IS NOT NULL
            THEN TO_DATE(full_date_str, 'Mon DD YYYY')::timestamptz
            ELSE COALESCE(l_created_at, tli_captured_at)
          END AS lead_date
        FROM raw_leads
      ),
      status_counts AS (
        SELECT
          DATE_TRUNC('${period}', ld.lead_date AT TIME ZONE 'UTC') AS bucket,
          COALESCE(NULLIF(TRIM(LOWER(ld.lead_status)), ''), 'unknown') AS job_status,
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

    // Pivot rows into one point per bucket. Each canonical status is
    // assigned to one of the 5 marketplace buckets — Active / Scheduled /
    // Done / Lost / Cancelled — for both the stacked-bar `statuses` dict and
    // the per-bucket KPI fields.
    const bucketMap = new Map<string, TimeSeriesPoint>();
    for (const row of rows) {
      const key = row.bucket.toISOString();
      if (!bucketMap.has(key)) {
        bucketMap.set(key, {
          period: key,
          label: this.formatPeriodLabel(row.bucket, period as 'day' | 'week' | 'month' | 'year'),
          total: 0,
          statuses: {},
          activeCount: 0,
          scheduledCount: 0,
          doneCount: 0,
          lostCount: 0,
          cancelledCount: 0,
          wonCount: 0,
          hiredCount: 0,
          hireRate: null,
          conversionRate: null,
          activeRate: null,
          activeLeadRate: null,
          avgBudget: row.avg_budget != null ? parseFloat(row.avg_budget) : null,
          totalBudget: row.total_budget != null ? parseFloat(row.total_budget) : null,
        });
      }
      const entry = bucketMap.get(key)!;
      const cnt = Number(row.cnt);
      const bucket = statusBucketLabel(row.job_status);
      entry.statuses[bucket] = (entry.statuses[bucket] ?? 0) + cnt;
      entry.total += cnt;
      switch (bucket) {
        case 'Active':    entry.activeCount    += cnt; break;
        case 'Scheduled': entry.scheduledCount += cnt; break;
        case 'Done':      entry.doneCount      += cnt; break;
        case 'Lost':      entry.lostCount      += cnt; break;
        case 'Cancelled': entry.cancelledCount += cnt; break;
        // 'Unknown' rows still appear in `statuses` and `total` but
        // are excluded from the Active / Scheduled / Done / Lost /
        // Cancelled KPI fields — never silently absorbed.
      }
    }

    for (const entry of bucketMap.values()) {
      entry.wonCount = entry.scheduledCount + entry.doneCount;
      entry.hiredCount = entry.wonCount;
      const resolved = entry.wonCount + entry.lostCount + entry.cancelledCount;
      entry.hireRate = resolved > 0 ? (entry.wonCount / resolved) * 100 : null;
      entry.conversionRate = entry.hireRate;
      entry.activeRate = entry.total > 0 ? (entry.activeCount / entry.total) * 100 : null;
      entry.activeLeadRate = entry.activeRate;
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
      outcomes,
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
      this.timed('outcomes', () => this.getOutcomes(baseWhere)),
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
      outcomes,
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

  // Job Status Distribution — aggregated to the 5 marketplace buckets
  // (Active / Scheduled / Done / Lost / Cancelled) per the 2026-06-08 UX
  // spec. new/engaged are intentionally collapsed into Active for the
  // dashboard; per-lead pills continue to show the granular status via
  // statusDisplayLabel. Driven exclusively by canonical Lead.status — raw
  // platform statuses are excluded.
  private async getJobStatusDistribution(
    where: any,
  ): Promise<ServiceDetailDistribution[]> {
    const userId = where.userId;
    if (!userId) return [];

    const rows = await this.prisma.lead.groupBy({
      by: ['status'],
      where: {
        userId,
        ...(where.businessId && { businessId: where.businessId }),
        ...(where.platform && { platform: where.platform }),
        ...(where.createdAt && { createdAt: where.createdAt }),
      },
      _count: { id: true },
    });

    const bucketCounts = new Map<string, number>();
    for (const r of rows) {
      const raw = (r.status ?? '').toString().toLowerCase().trim();
      if (!raw) continue;
      const bucket = statusBucketLabel(raw);
      if (bucket === 'Unknown') continue;
      bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + r._count.id);
    }
    const total = Array.from(bucketCounts.values()).reduce((s, n) => s + n, 0);
    // Stable display order matching the KPI row.
    const order: BucketLabel[] = ['Active', 'Scheduled', 'Done', 'Lost', 'Cancelled'];
    return order
      .filter((b) => (bucketCounts.get(b) ?? 0) > 0)
      .map((b) => ({
        name: b,
        count: bucketCounts.get(b)!,
        percentage: total > 0 ? (bucketCounts.get(b)! / total) * 100 : 0,
      }));
  }

  // Outcome breakdown — active / won / lost split + Conversion Rate +
  // Active Lead Rate. Driven exclusively by canonical Lead.status; raw
  // platform statuses are excluded.
  //
  // The Active card is sub-bucketed via a second join against
  // ThreadContext.conversationState. The mapping (TC → bucket) lives in
  // src/conversation-context/activity-bucket.ts.
  private async getOutcomes(where: any): Promise<OutcomeBreakdown> {
    const userId = where.userId;
    if (!userId) {
      return computeOutcomeBreakdown([]);
    }
    const [rows, activeBuckets] = await Promise.all([
      this.prisma.lead.groupBy({
        by: ['status'],
        where: {
          userId,
          ...(where.businessId && { businessId: where.businessId }),
          ...(where.platform && { platform: where.platform }),
          ...(where.createdAt && { createdAt: where.createdAt }),
        },
        _count: { id: true },
      }),
      this.getActiveBuckets(where),
    ]);
    return computeOutcomeBreakdown(
      rows.map((r) => ({ status: (r.status ?? '').toString(), count: r._count.id })),
      { activeBuckets },
    );
  }

  /**
   * Active sub-bucket counts — joins Lead → ThreadContext on the active
   * pool and applies `activityBucketFromThreadContext` per
   * (lead.status × tc.conversationState) cell. Single raw SQL.
   */
  private async getActiveBuckets(where: any): Promise<{
    engagement: number;
    ai_conversation: number;
    follow_up: number;
    human_handoff: number;
  }> {
    const userId = where.userId;
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      lead_status: string | null;
      tc_state: string | null;
      cnt: bigint;
    }>>(
      `SELECT l.status AS lead_status,
              tc."conversationState" AS tc_state,
              COUNT(*)::bigint AS cnt
         FROM leads l
         LEFT JOIN thread_contexts tc ON tc."conversationId" = l."threadId"
        WHERE l."userId" = $1
          AND ($2::text IS NULL OR l."businessId" = $2::text)
          AND ($3::text IS NULL OR l."platform"   = $3::text)
          AND ($4::timestamptz IS NULL OR l."createdAt" >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR l."createdAt" <= $5::timestamptz)
          AND LOWER(COALESCE(l.status, '')) IN ('new','engaged','contacted','quoted','in_progress')
        GROUP BY l.status, tc."conversationState"`,
      userId,
      where.businessId ?? null,
      where.platform ?? null,
      where.createdAt?.gte ?? null,
      where.createdAt?.lte ?? null,
    );

    const buckets = { engagement: 0, ai_conversation: 0, follow_up: 0, human_handoff: 0 };
    for (const r of rows) {
      const b = activityBucketFromThreadContext(r.tc_state, r.lead_status);
      if (b) buckets[b] += Number(r.cnt);
    }
    return buckets;
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

  // Average job price across leads in a "won" canonical state
  // (booked / completed, plus legacy-safe 'scheduled'). Reads
  // Lead.budget (customer-stated budget at request time) as the closest
  // proxy for actual job value, since neither platform reliably exposes a
  // final-price field. Driven exclusively by Lead.status — raw platform
  // statuses are excluded per 2026-06-08 spec rule 6.
  private async getAverageJobPrice(
    userId: string,
    query: AnalyticsQueryDto,
  ): Promise<{ value: number | null; count: number }> {
    const wonStatuses = Array.from(WON_STATUSES); // booked, completed, scheduled (legacy-safe)
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
         AND LOWER(COALESCE(l."status", '')) = ANY($6::text[])`,
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
