export interface CategoryDistribution {
  category: string;
  count: number;
  percentage: number;
}

export interface ConnectionTimeMetric {
  averageMinutes: number;
  median: number;
  min: number;
  max: number;
  count: number;
}

export interface ResponseTimeMetric {
  averageMinutes: number;
  median: number;
  count: number;
}

export interface MessagesPerLeadMetric {
  average: number;
  median: number;
  min: number;
  max: number;
}

export interface CustomerEngagementMetric {
  engagedCount: number;
  totalCount: number;
  engagementRate: number;
}

export interface ServiceDetailDistribution {
  name: string;
  count: number;
  percentage: number;
}

export interface RoomStatsMetric {
  averageBedrooms: number;
  averageBathrooms: number;
  maxBedrooms: number;
  maxBathrooms: number;
  minBedrooms: number;
  minBathrooms: number;
}

export interface AverageLeadPriceMetric {
  value: number | null;
  count: number;
}

/**
 * Outcome split of all leads in the period.
 *
 * Classification (2026-06-08 status simplification):
 *   active = new + engaged + quoted + in_progress
 *   won    = booked + completed (+ legacy 'scheduled' / 'contacted' if present)
 *   lost   = lost + cancelled + no_show + archived
 *
 * Driven exclusively by Lead.status — raw platform statuses (thumbtackStatus,
 * platformStatus) are NOT consulted for KPI math.
 */
export interface OutcomeBreakdown {
  active: number;
  won: number;
  lost: number;
  total: number;
  /**
   * Conversion Rate (primary KPI):
   *   won / (won + lost)
   * Null when there are zero resolved leads (no won + no lost).
   */
  conversionRate: number | null;
  /**
   * Active Lead Rate:
   *   active / total
   * Null when total is zero.
   */
  activeLeadRate: number | null;
}

export class AnalyticsResponseDto {
  categoryDistribution: CategoryDistribution[];
  connectionTime: ConnectionTimeMetric;
  proResponseTime: ResponseTimeMetric;
  customerResponseTime: ResponseTimeMetric;
  messagesPerLead: MessagesPerLeadMetric;
  customerEngagement: CustomerEngagementMetric;
  totalLeads: number;

  /**
   * Outcome split of all leads matching the current filter.
   * Provides Conversion Rate + Active Lead Rate per the 2026-06-08 spec.
   */
  outcomes?: OutcomeBreakdown;

  // Job status counts by canonical Lead.status (active/won/lost class noted
  // per row). Derived from Lead.status only — raw platform statuses are
  // excluded.
  jobStatusDistribution?: ServiceDetailDistribution[];

  // When the last lead was synced (extension or webhook)
  lastLeadSyncAt?: string | null;

  // Service detail analytics
  cleaningTypeDistribution?: ServiceDetailDistribution[];
  addOnsDistribution?: ServiceDetailDistribution[];
  frequencyDistribution?: ServiceDetailDistribution[];
  locationDistribution?: ServiceDetailDistribution[];
  zipCodeDistribution?: ServiceDetailDistribution[];
  roomStats?: RoomStatsMetric;

  // Average Thumbtack lead price (cost-per-lead from rawJson.leadPrice).
  // Null when filtering to platform='yelp'.
  averageLeadPrice?: AverageLeadPriceMetric;

  // Average customer-stated budget across leads in a "won" terminal
  // state (booked / hired / scheduled / completed / done) — proxy for
  // actual job value since neither platform exposes a final-price field.
  averageJobPrice?: AverageLeadPriceMetric;

  dateRange: {
    start: string;
    end: string;
  };
  filters: {
    businessId?: string;
    businessName?: string;
  };
}
