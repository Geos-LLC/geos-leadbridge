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

export class AnalyticsResponseDto {
  categoryDistribution: CategoryDistribution[];
  connectionTime: ConnectionTimeMetric;
  proResponseTime: ResponseTimeMetric;
  customerResponseTime: ResponseTimeMetric;
  messagesPerLead: MessagesPerLeadMetric;
  customerEngagement: CustomerEngagementMetric;
  totalLeads: number;

  // Job status from Thumbtack UI (Hired, Not hired, etc.)
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

  dateRange: {
    start: string;
    end: string;
  };
  filters: {
    businessId?: string;
    businessName?: string;
  };
}
