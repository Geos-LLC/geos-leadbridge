/**
 * Partner Network Beta API client.
 *
 * Self-contained — mirrors src/modules/partner-network/* and can be extracted
 * alongside the backend module without dragging any other LeadBridge API
 * surface.
 */

import api from './api';

export type PartnerLeadIntent = 'this_week' | 'this_month' | 'not_sure';
export type PartnerLeadStatus =
  | 'new'
  | 'contacted'
  | 'qualified'
  | 'rejected'
  | 'booked'
  | 'paid_manually';

export interface PartnerBusiness {
  id: string;
  workspaceId: string;
  name: string;
  category: string | null;
  phone: string | null;
  website: string | null;
  serviceArea: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PartnerRelationship {
  id: string;
  workspaceId: string;
  sourceBusinessId: string;
  destinationBusinessId: string;
  name: string | null;
  active: boolean;
  defaultOfferText: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  sourceBusiness: PartnerBusiness;
  destinationBusiness: PartnerBusiness;
}

export interface PartnerReferralCode {
  id: string;
  workspaceId: string;
  code: string;
  sourceBusinessId: string;
  destinationBusinessId: string;
  partnerRelationshipId: string | null;
  employeeName: string | null;
  active: boolean;
  publicUrl: string;
  createdAt: string;
  updatedAt: string;
  sourceBusiness: PartnerBusiness;
  destinationBusiness: PartnerBusiness;
}

export interface PartnerLead {
  id: string;
  workspaceId: string;
  referralCodeId: string;
  sourceBusinessId: string;
  destinationBusinessId: string;
  customerName: string;
  customerPhone: string;
  notes: string | null;
  intentTiming: PartnerLeadIntent;
  estimatedValue: number;
  status: PartnerLeadStatus;
  possibleDuplicate: boolean;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  createdAt: string;
  updatedAt: string;
  referralCode: PartnerReferralCode;
  sourceBusiness: PartnerBusiness;
  destinationBusiness: PartnerBusiness;
}

export interface DashboardSummary {
  totals: {
    total: number;
    hot: number;
    warm: number;
    cold: number;
    estimatedTotalValue: number;
  };
  bySourceBusiness: Array<{ businessId: string; businessName: string; count: number; value: number }>;
  byReferralCode: Array<{ codeId: string; code: string; employeeName: string | null; count: number; value: number }>;
  byStatus: Record<string, number>;
}

export interface PublicReferralView {
  code: string;
  destinationBusinessName: string;
  offerText: string | null;
  active: boolean;
}

export const partnerNetworkApi = {
  // Businesses
  listBusinesses: async (): Promise<PartnerBusiness[]> => {
    const { data } = await api.get('/partner-network/businesses');
    return data.businesses;
  },
  createBusiness: async (body: Partial<PartnerBusiness>): Promise<PartnerBusiness> => {
    const { data } = await api.post('/partner-network/businesses', body);
    return data.business;
  },
  updateBusiness: async (id: string, body: Partial<PartnerBusiness>): Promise<PartnerBusiness> => {
    const { data } = await api.patch(`/partner-network/businesses/${id}`, body);
    return data.business;
  },

  // Relationships
  listRelationships: async (): Promise<PartnerRelationship[]> => {
    const { data } = await api.get('/partner-network/relationships');
    return data.relationships;
  },
  createRelationship: async (body: {
    sourceBusinessId: string;
    destinationBusinessId: string;
    name?: string;
    defaultOfferText?: string;
    notes?: string;
  }): Promise<PartnerRelationship> => {
    const { data } = await api.post('/partner-network/relationships', body);
    return data.relationship;
  },
  updateRelationship: async (
    id: string,
    body: Partial<Pick<PartnerRelationship, 'name' | 'active' | 'defaultOfferText' | 'notes'>>,
  ): Promise<PartnerRelationship> => {
    const { data } = await api.patch(`/partner-network/relationships/${id}`, body);
    return data.relationship;
  },

  // Referral codes
  listReferralCodes: async (): Promise<PartnerReferralCode[]> => {
    const { data } = await api.get('/partner-network/referral-codes');
    return data.referralCodes;
  },
  createReferralCode: async (body: {
    code: string;
    sourceBusinessId: string;
    destinationBusinessId: string;
    partnerRelationshipId?: string;
    employeeName?: string;
  }): Promise<PartnerReferralCode> => {
    const { data } = await api.post('/partner-network/referral-codes', body);
    return data.referralCode;
  },
  updateReferralCode: async (
    id: string,
    body: { active?: boolean; employeeName?: string },
  ): Promise<PartnerReferralCode> => {
    const { data } = await api.patch(`/partner-network/referral-codes/${id}`, body);
    return data.referralCode;
  },

  // Leads
  listLeads: async (filters: {
    sourceBusinessId?: string;
    destinationBusinessId?: string;
    referralCodeId?: string;
    status?: PartnerLeadStatus;
    intentTiming?: PartnerLeadIntent;
  } = {}): Promise<PartnerLead[]> => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) {
      if (v) params.append(k, v);
    }
    const { data } = await api.get(`/partner-network/leads${params.toString() ? `?${params.toString()}` : ''}`);
    return data.leads;
  },
  updateLead: async (id: string, body: { status?: PartnerLeadStatus; notes?: string }): Promise<PartnerLead> => {
    const { data } = await api.patch(`/partner-network/leads/${id}`, body);
    return data.lead;
  },
  csvUrl: (): string => {
    // Caller appends auth token via download flow if needed; for now returns
    // the relative URL so a regular <a download> works for logged-in users.
    return '/api/partner-network/leads.csv';
  },

  // Dashboard
  getDashboard: async (): Promise<DashboardSummary> => {
    const { data } = await api.get('/partner-network/dashboard');
    return data;
  },

  // Public (no auth)
  getPublicReferral: async (code: string): Promise<PublicReferralView> => {
    const { data } = await api.get(`/partner-network/public/r/${encodeURIComponent(code)}`);
    return data.referral;
  },
  submitPublicLead: async (
    code: string,
    body: {
      customerName: string;
      customerPhone: string;
      intentTiming: PartnerLeadIntent;
      notes?: string;
      utmSource?: string;
      utmMedium?: string;
      utmCampaign?: string;
    },
  ): Promise<{ success: boolean; leadId: string; possibleDuplicate: boolean }> => {
    const { data } = await api.post(`/partner-network/public/r/${encodeURIComponent(code)}/submit`, body);
    return data;
  },
};
