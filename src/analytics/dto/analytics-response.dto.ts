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
 * Internal canonical Lead.status values vs marketplace-facing display:
 *   new + engaged + quoted + in_progress  →  Active  (one card)
 *   booked                                →  Scheduled
 *   completed                             →  Done
 *   lost  + no_show + archived            →  Lost
 *   cancelled                             →  Cancelled  (separate card)
 *
 * `won` and `conversionRate` are kept as aggregate aliases over Scheduled +
 * Done for back-compat; `hireRate` is the same value re-labelled with the
 * marketplace term LB users expect.
 *
 * Driven exclusively by Lead.status — raw platform statuses (thumbtackStatus,
 * platformStatus) are NOT consulted for KPI math.
 */
export interface OutcomeBreakdown {
  active: number;
  /** Lead.status='booked' count — surfaces as the "Scheduled" KPI card. */
  scheduled: number;
  /** Lead.status='completed' count — surfaces as the "Done" KPI card. */
  done: number;
  /**
   * Aggregate "won" = scheduled + done. Kept for back-compat with consumers
   * built against the 2026-06-08 OutcomeBreakdown; new consumers should
   * read scheduled / done directly.
   */
  won: number;
  /** Lead.status in {lost, no_show, archived}. */
  lost: number;
  /** Lead.status='cancelled' — separated for the dedicated "Cancelled" card. */
  cancelled: number;
  total: number;
  /**
   * Sub-breakdown of the Active card derived from
   * ThreadContext.conversationState + Lead.status.
   *
   *   engagement      — first contact / no customer reply yet
   *   ai_conversation — AI is actively replying
   *   follow_up       — waiting for the customer; sequence active
   *   human_handoff   — customer waiting on a human (visually urgent)
   *
   * Sums to `active`. Driven by src/conversation-context/activity-bucket.ts.
   */
  activeBuckets: {
    engagement: number;
    ai_conversation: number;
    follow_up: number;
    human_handoff: number;
  };
  /**
   * Hire Rate (primary KPI, marketplace label):
   *   (scheduled + done) / (scheduled + done + lost + cancelled)
   * Null when there are zero resolved leads.
   */
  hireRate: number | null;
  /**
   * Legacy alias of hireRate — same value, kept for back-compat with any
   * consumer built against the 2026-06-08 payload.
   */
  conversionRate: number | null;
  /**
   * Active Rate:
   *   active / total
   * Null when total is zero.
   */
  activeRate: number | null;
  /** Legacy alias of activeRate — kept for back-compat. */
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
