/**
 * Partner Network Beta API client.
 *
 * Self-contained — mirrors src/modules/partner-network/* and can be extracted
 * alongside the backend module without dragging any other LeadBridge API
 * surface.
 */

import api from './api';

export type PartnerLeadIntent = 'this_week' | 'this_month' | 'future_interest' | 'not_sure';
export type PartnerLeadStatus =
  | 'new'
  | 'contacted'
  | 'interested_not_now'
  | 'qualified'
  | 'rejected'
  | 'booked'
  | 'paid_manually';
export type PartnerLeadEventType = 'page_view' | 'form_started' | 'form_submitted';
export type PartnerLeadContactPref = 'call' | 'text' | 'either';

export interface PartnerBusinessWebsiteMetadata {
  title?: string;
  description?: string;
  phone?: string;
}

export interface PartnerBusiness {
  id: string;
  workspaceId: string;
  name: string;
  category: string | null;
  phone: string | null;
  website: string | null;
  // Set by the backend when the admin clicks "Verify" on the business form
  // and successfully reaches the site. Read by the AI relationship-copy
  // suggester so partnership offers reflect what the site actually says.
  websiteMetadataJson: string | null;
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
  widgetEnabled: boolean;
  widgetType: string | null;
  popupDelayMs: number | null;
  autoOpenFromReferral: boolean;
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
  qrUrl: string | null;
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
  preferredContact: PartnerLeadContactPref;
  notes: string | null;
  intentTiming: PartnerLeadIntent;
  estimatedValue: number;
  status: PartnerLeadStatus;
  assignedTo: string | null;
  possibleDuplicate: boolean;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  pageViewedAt: string | null;
  formStartedAt: string | null;
  submittedAt: string | null;
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
  byDestinationBusiness: Array<{ businessId: string; businessName: string; count: number; value: number }>;
  byReferralCode: Array<{ codeId: string; code: string; employeeName: string | null; count: number; value: number }>;
  byEmployee: Array<{
    employeeName: string;
    pageViews: number;
    formStarts: number;
    submissions: number;
    value: number;
  }>;
  byStatus: Record<string, number>;
  funnel: {
    views: number;
    started: number;
    submitted: number;
    qualified: number;
    booked: number;
  };
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
  createBusiness: async (
    body: Partial<PartnerBusiness> & { websiteMetadata?: PartnerBusinessWebsiteMetadata },
  ): Promise<PartnerBusiness> => {
    const { data } = await api.post('/partner-network/businesses', body);
    return data.business;
  },
  updateBusiness: async (
    id: string,
    body: Partial<PartnerBusiness> & { websiteMetadata?: PartnerBusinessWebsiteMetadata },
  ): Promise<PartnerBusiness> => {
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
    widgetEnabled?: boolean;
    widgetType?: string;
    popupDelayMs?: number;
    autoOpenFromReferral?: boolean;
  }): Promise<PartnerRelationship> => {
    const { data } = await api.post('/partner-network/relationships', body);
    return data.relationship;
  },
  updateRelationship: async (
    id: string,
    body: Partial<
      Pick<
        PartnerRelationship,
        | 'name'
        | 'active'
        | 'defaultOfferText'
        | 'notes'
        | 'widgetEnabled'
        | 'widgetType'
        | 'popupDelayMs'
        | 'autoOpenFromReferral'
      >
    >,
  ): Promise<PartnerRelationship> => {
    const { data } = await api.patch(`/partner-network/relationships/${id}`, body);
    return data.relationship;
  },

  // AI-suggest a partnership Name + Default Offer Text for two businesses.
  // Backend grounds the model in each business's name, category, service
  // area, and cached website metadata (when present). `hint` lets the admin
  // steer the output, e.g. "lead with a first-time discount".
  suggestRelationshipCopy: async (body: {
    sourceBusinessId: string;
    destinationBusinessId: string;
    hint?: string;
  }): Promise<{ name: string; offerText: string; usedMetadata: boolean }> => {
    const { data } = await api.post('/partner-network/relationships/ai-suggest', body);
    return data.suggestion;
  },

  // Live verify a business website URL. Hits the partner-network module's
  // own endpoint — does NOT use /v1/users/me/website/verify or any other
  // main-app endpoint. Result shape matches the main-app verifier so
  // existing UI code can be ported with no changes.
  verifyBusinessWebsite: async (
    url: string,
  ): Promise<{
    reachable: boolean;
    normalizedUrl: string;
    metadata?: { title?: string; description?: string; phone?: string };
    errorCode?: 'invalid_url' | 'private_host' | 'dns_not_found' | 'connection_refused' | 'timeout' | 'http_error' | 'unreachable';
    errorMessage?: string;
  }> => {
    const { data } = await api.post('/partner-network/businesses/verify-website', { url });
    return data;
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
  updateLead: async (
    id: string,
    body: { status?: PartnerLeadStatus; notes?: string; assignedTo?: string | null },
  ): Promise<PartnerLead> => {
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
  logPublicEvent: async (
    code: string,
    eventType: 'page_view' | 'form_started',
  ): Promise<{ recorded: boolean }> => {
    // Best-effort fire-and-forget; if the request fails we swallow the error
    // in callers so the customer page never breaks on analytics.
    const { data } = await api.post(
      `/partner-network/public/r/${encodeURIComponent(code)}/events`,
      { eventType },
    );
    return data;
  },
  submitPublicLead: async (
    code: string,
    body: {
      customerName: string;
      customerPhone: string;
      intentTiming: PartnerLeadIntent;
      preferredContact?: PartnerLeadContactPref;
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

/**
 * Capture a `?ref=CODE` from the current URL into localStorage so a future
 * widget runtime can attribute a conversion across sessions even when the
 * customer lands on the partner's own site first.
 *
 * Placeholder per spec — no attribution logic is wired up yet. Returns the
 * code that was just captured (or the previously stored code if no param is
 * present). Safe to call from non-React contexts; no-ops in SSR / non-browser.
 */
export function captureReferralSource(
  search: string | URLSearchParams = typeof window === 'undefined' ? '' : window.location.search,
): string | null {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return null;
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const ref = params.get('ref');
  const KEY = 'partner-network:ref';
  if (ref && ref.trim()) {
    try {
      const value = ref.trim().toUpperCase();
      localStorage.setItem(KEY, value);
      localStorage.setItem(`${KEY}:capturedAt`, new Date().toISOString());
      return value;
    } catch {
      // localStorage can throw in private mode / cookie-blocked frames —
      // attribution is best-effort, so swallow.
      return ref.trim().toUpperCase();
    }
  }
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
