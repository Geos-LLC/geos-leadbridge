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

export class AnalyticsResponseDto {
  categoryDistribution: CategoryDistribution[];
  connectionTime: ConnectionTimeMetric;
  proResponseTime: ResponseTimeMetric;
  customerResponseTime: ResponseTimeMetric;
  messagesPerLead: MessagesPerLeadMetric;
  customerEngagement: CustomerEngagementMetric;
  totalLeads: number;
  dateRange: {
    start: string;
    end: string;
  };
  filters: {
    businessId?: string;
    businessName?: string;
  };
}
