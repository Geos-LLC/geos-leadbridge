import axios, { AxiosError } from 'axios';
import type { AuthResponse, Lead, Business, Platform, SavedAccount, MessageTemplate, BulkMessagePreview, BulkSendResult, AutomationRule, PendingAutomatedMessage, NotificationSettings, NotificationLog, NotificationRule, SubscriptionDetails, AdminUser, AdminUserDetails, AdminStats, AdminLog } from '../types';
import { notify } from '../store/notificationStore';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://thumbtack-bridge-production.up.railway.app/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add auth token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Error message mapping for common errors
function getErrorDetails(error: AxiosError<any>): { title: string; message: string } | null {
  const status = error.response?.status;
  const data = error.response?.data;
  const errorMessage = data?.message || data?.error || error.message;

  // Skip showing toast for 401 (handled separately with redirect)
  if (status === 401) {
    return null;
  }

  // Skip toasts for login/token errors - Dashboard handles these with a reconnect banner
  const lowerMsg = errorMessage?.toLowerCase() || '';
  if (lowerMsg.includes('login required') ||
      lowerMsg.includes('token') ||
      lowerMsg.includes('expired') ||
      lowerMsg.includes('session') ||
      lowerMsg.includes('unauthorized') ||
      lowerMsg.includes('reconnect')) {
    return null;
  }

  // Not found errors
  if (status === 404) {
    if (errorMessage?.toLowerCase().includes('lead') ||
        errorMessage?.toLowerCase().includes('negotiation')) {
      return {
        title: 'Lead Not Found',
        message: 'This lead may have been removed or is no longer accessible.',
      };
    }
    if (errorMessage?.toLowerCase().includes('account') ||
        errorMessage?.toLowerCase().includes('platform') ||
        errorMessage?.toLowerCase().includes('connected')) {
      return {
        title: 'Account Not Connected',
        message: 'Please connect your Thumbtack account first.',
      };
    }
    return {
      title: 'Not Found',
      message: errorMessage || 'The requested resource was not found.',
    };
  }

  // Forbidden errors (wrong account, permission issues)
  if (status === 403) {
    return {
      title: 'Access Denied',
      message: errorMessage || 'You don\'t have permission to access this resource.',
    };
  }

  // Bad request (validation errors)
  if (status === 400) {
    return {
      title: 'Invalid Request',
      message: errorMessage || 'The request was invalid. Please check your input.',
    };
  }

  // Server errors
  if (status && status >= 500) {
    return {
      title: 'Server Error',
      message: 'Something went wrong on our end. Please try again later.',
    };
  }

  // Network errors
  if (error.code === 'ERR_NETWORK' || !error.response) {
    return {
      title: 'Connection Error',
      message: 'Unable to connect to the server. Please check your internet connection.',
    };
  }

  // Webhook/API errors from Thumbtack
  if (errorMessage?.toLowerCase().includes('webhook')) {
    return {
      title: 'Webhook Error',
      message: errorMessage || 'There was a problem with the webhook connection.',
    };
  }

  // Generic error with message
  if (errorMessage) {
    return {
      title: 'Error',
      message: errorMessage,
    };
  }

  return null;
}

// Handle errors and show toast notifications
api.interceptors.response.use(
  (response) => response,
  (error: AxiosError<any>) => {
    // Handle 401 - redirect to login
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      localStorage.removeItem('auth-storage'); // Clear zustand persisted auth state
      window.location.href = '/login';
      return Promise.reject(error);
    }

    // Show toast notification for other errors
    const errorDetails = getErrorDetails(error);
    if (errorDetails) {
      notify.error(errorDetails.title, errorDetails.message);
    }

    return Promise.reject(error);
  }
);

// Auth
export const authApi = {
  register: async (email: string, password: string, name?: string): Promise<AuthResponse> => {
    const { data } = await api.post('/auth/register', { email, password, name });
    console.log('[API] Register response:', data);
    return data;
  },
  login: async (email: string, password: string): Promise<AuthResponse> => {
    const { data } = await api.post('/auth/login', { email, password });
    console.log('[API] Login response:', data);
    console.log('[API] User from login:', data.user);
    console.log('[API] User role from login:', data.user?.role);
    return data;
  },
  getProfile: async () => {
    const { data } = await api.get('/auth/profile');
    console.log('[API] Profile response:', data);
    return data;
  },
  forgotPassword: async (email: string): Promise<{ message: string; resetUrl?: string }> => {
    const { data } = await api.post('/auth/forgot-password', { email });
    return data;
  },
  resetPassword: async (token: string, password: string): Promise<{ message: string }> => {
    const { data } = await api.post('/auth/reset-password', { token, password });
    return data;
  },
};

// Health issue type from backend
export interface HealthIssue {
  code: 'no_webhooks' | 'not_connected';
  severity: 'error' | 'warning';
  title: string;
  message: string;
  action?: string;
  actionLabel?: string;
}

// Webhook diagnostic types
export interface WebhookVerifyResult {
  accountId: string;
  businessId: string;
  businessName: string;
  storedWebhookId: string | null;
  actualWebhooks?: {
    webhookId: string;
    webhookURL: string;
    eventTypes: string[];
    enabled: boolean;
  }[];
  status: 'active' | 'no_webhooks' | 'error';
  match?: boolean;
  error?: string;
}

export interface WebhookEventSummary {
  id: string;
  eventType: string;
  businessId?: string;
  negotiationId?: string;
  messageId?: string;
  isYourAccount?: boolean;
  receivedAt: string;
  processed: boolean;
  error?: string;
}

// Platforms
export const platformsApi = {
  getStatus: async (): Promise<{ platforms: Platform[] }> => {
    const { data } = await api.get('/v1/platforms/status');
    return data;
  },
  getConnection: async (): Promise<{
    thumbtack: {
      connected: boolean;
      configuredBusinessId: string | null;
      webhookId: string | null;
      lastSyncAt: string | null;
    };
  }> => {
    const { data } = await api.get('/v1/platforms/connection');
    return data;
  },
  getHealth: async (): Promise<{ healthy: boolean; issues: HealthIssue[] }> => {
    const { data } = await api.get('/v1/platforms/health');
    return data;
  },
  getAuthUrl: async (): Promise<{ authUrl: string }> => {
    const { data } = await api.get('/v1/thumbtack/auth/url');
    return data;
  },
  disconnect: async (): Promise<void> => {
    await api.post('/v1/thumbtack/auth/disconnect');
  },
  // Diagnostic endpoints
  verifyWebhooks: async (): Promise<{ accounts: WebhookVerifyResult[] }> => {
    const { data } = await api.get('/v1/platforms/webhooks/verify');
    return data;
  },
  getRecentWebhookEvents: async (): Promise<{
    totalEvents: number;
    byEventType: Record<string, { count: number; yourAccount: number }>;
    yourBusinessIds: string[];
    recentEvents: WebhookEventSummary[];
  }> => {
    const { data } = await api.get('/v1/platforms/webhooks/recent');
    return data;
  },
};

// Thumbtack
export const thumbtackApi = {
  getBusinesses: async (): Promise<{ businesses: Business[] }> => {
    const { data } = await api.get('/v1/thumbtack/businesses');
    return data;
  },
  setupWebhook: async (
    businessId: string,
    businessName?: string,
    imageUrl?: string,
    emailHint?: string,
  ): Promise<{ webhookId: string }> => {
    const { data } = await api.post(`/v1/thumbtack/businesses/${businessId}/webhooks/setup`, {
      businessName,
      imageUrl,
      emailHint,
    });
    return data;
  },
  getWebhooks: async (businessId: string): Promise<{ webhooks: any[] }> => {
    const { data } = await api.get(`/v1/thumbtack/businesses/${businessId}/webhooks`);
    return data;
  },
  // Saved accounts for multi-account switching
  getSavedAccounts: async (): Promise<{ accounts: SavedAccount[]; count: number }> => {
    const { data } = await api.get('/v1/thumbtack/saved-accounts');
    return data;
  },
  saveAccount: async (
    businessId: string,
    businessName: string,
    imageUrl?: string,
    emailHint?: string,
  ): Promise<{ success: boolean }> => {
    const { data } = await api.post('/v1/thumbtack/saved-accounts', {
      businessId,
      businessName,
      imageUrl,
      emailHint,
    });
    return data;
  },
  removeSavedAccount: async (id: string, deleteLeads: boolean = false): Promise<{ success: boolean; deletedLeads: number }> => {
    const { data } = await api.delete(`/v1/thumbtack/saved-accounts/${id}?deleteLeads=${deleteLeads}`);
    return data;
  },
  updateSavedAccount: async (id: string, updates: { emailHint?: string }): Promise<{ success: boolean }> => {
    const { data } = await api.patch(`/v1/thumbtack/saved-accounts/${id}`, updates);
    return data;
  },
  disconnectAccount: async (id: string): Promise<{
    success: boolean;
    webhookDeleted: boolean;
    message: string;
    errorCode?: 'token_expired' | 'token_revoked' | 'webhook_not_found' | 'network_error' | 'permission_denied' | 'unknown';
    errorMessage?: string;
    warning?: string;
  }> => {
    const { data } = await api.post(`/v1/thumbtack/saved-accounts/${id}/disconnect`);
    return data;
  },
  reconnectAccount: async (id: string): Promise<{ success: boolean; webhookId: string }> => {
    const { data } = await api.post(`/v1/thumbtack/saved-accounts/${id}/reconnect`);
    return data;
  },
  validateToken: async (id: string): Promise<{ valid: boolean; reason?: string }> => {
    const { data } = await api.get(`/v1/thumbtack/saved-accounts/${id}/validate-token`);
    return data;
  },
};

// Attachment type for messages
export interface MessageAttachment {
  url: string;
  mimeType?: string;
  fileName?: string;
}

// Message type for API responses
export interface ApiMessage {
  id: string;
  conversationId: string;
  platform: string;
  externalMessageId: string;
  sender: 'customer' | 'pro';
  content: string;
  attachments?: MessageAttachment[];
  isRead: boolean;
  sentAt: string;
  deliveredAt?: string;
}

// Leads
export const leadsApi = {
  getLeads: async (limit?: number): Promise<{ leads: Lead[]; count: number }> => {
    const params = limit ? { limit } : {};
    const { data } = await api.get('/v1/thumbtack/leads', { params });
    return data;
  },
  getLead: async (id: string): Promise<Lead> => {
    const { data } = await api.get(`/v1/thumbtack/leads/${id}`);
    return data;
  },
  getMessages: async (leadId: string): Promise<{ messages: ApiMessage[]; count: number }> => {
    const { data } = await api.get(`/v1/thumbtack/leads/${leadId}/messages`);
    return data;
  },
  sendMessage: async (leadId: string, message: string): Promise<{ success: boolean }> => {
    const { data } = await api.post(`/v1/thumbtack/leads/${leadId}/message`, { message });
    return data;
  },
  importNegotiation: async (negotiationId: string, accountId?: string): Promise<{ lead: Lead; isNew: boolean; message: string }> => {
    const { data } = await api.post(`/v1/thumbtack/negotiations/${negotiationId}/import`, { accountId });
    return data;
  },
  syncLead: async (leadId: string): Promise<{ success: boolean; lead: Lead }> => {
    const { data } = await api.post(`/v1/leads/${leadId}/sync`);
    return data;
  },
  resyncMessages: async (leadId: string): Promise<{ success: boolean; cleaned: number; imported: number; statusUpdated?: boolean }> => {
    const { data } = await api.post(`/v1/leads/${leadId}/resync-messages`);
    return data;
  },
};

// Message Templates
export const templatesApi = {
  getTemplates: async (): Promise<{ templates: MessageTemplate[]; count: number }> => {
    const { data } = await api.get('/v1/templates');
    return data;
  },
  getTemplate: async (id: string): Promise<MessageTemplate> => {
    const { data } = await api.get(`/v1/templates/${id}`);
    return data;
  },
  createTemplate: async (name: string, content: string, isDefault?: boolean): Promise<{ success: boolean; template: MessageTemplate }> => {
    const { data } = await api.post('/v1/templates', { name, content, isDefault });
    return data;
  },
  updateTemplate: async (id: string, updates: { name?: string; content?: string; isDefault?: boolean }): Promise<{ success: boolean; template: MessageTemplate }> => {
    const { data } = await api.patch(`/v1/templates/${id}`, updates);
    return data;
  },
  deleteTemplate: async (id: string): Promise<{ success: boolean }> => {
    const { data } = await api.delete(`/v1/templates/${id}`);
    return data;
  },
};

// Bulk Messaging
export const bulkMessageApi = {
  preview: async (leadIds: string[], templateContent: string): Promise<{ success: boolean; previews: BulkMessagePreview[] }> => {
    const { data } = await api.post('/v1/leads/bulk-message/preview', { leadIds, templateContent });
    return data;
  },
  send: async (leadIds: string[], templateContent: string, templateId?: string): Promise<{ success: boolean; message: string } & BulkSendResult> => {
    const { data } = await api.post('/v1/leads/bulk-message/send', { leadIds, templateContent, templateId });
    return data;
  },
};

// Automation Rules
export interface CreateAutomationRuleDto {
  savedAccountId: string;
  name: string;
  triggerType: 'new_lead' | 'customer_reply';
  replyTriggerMode?: 'first_only' | 'every_reply';
  templateId: string;
  delayMinutes?: number;
  enabled?: boolean;
}

export interface UpdateAutomationRuleDto {
  name?: string;
  triggerType?: 'new_lead' | 'customer_reply';
  replyTriggerMode?: 'first_only' | 'every_reply';
  templateId?: string;
  delayMinutes?: number;
  enabled?: boolean;
}

export const automationApi = {
  getRules: async (): Promise<{ rules: AutomationRule[] }> => {
    const { data } = await api.get('/v1/automation/rules');
    return data;
  },
  getRulesForAccount: async (accountId: string): Promise<{ rules: AutomationRule[] }> => {
    const { data } = await api.get(`/v1/automation/rules/account/${accountId}`);
    return data;
  },
  getRule: async (ruleId: string): Promise<AutomationRule> => {
    const { data } = await api.get(`/v1/automation/rules/${ruleId}`);
    return data;
  },
  createRule: async (ruleData: CreateAutomationRuleDto): Promise<{ success: boolean; message: string; rule: AutomationRule }> => {
    const { data } = await api.post('/v1/automation/rules', ruleData);
    return data;
  },
  updateRule: async (ruleId: string, updates: UpdateAutomationRuleDto): Promise<{ success: boolean; message: string; rule: AutomationRule }> => {
    const { data } = await api.patch(`/v1/automation/rules/${ruleId}`, updates);
    return data;
  },
  deleteRule: async (ruleId: string): Promise<{ success: boolean; message: string }> => {
    const { data } = await api.delete(`/v1/automation/rules/${ruleId}`);
    return data;
  },
  getPendingMessages: async (ruleId: string): Promise<{ pending: PendingAutomatedMessage[] }> => {
    const { data } = await api.get(`/v1/automation/rules/${ruleId}/pending`);
    return data;
  },
  cancelPendingMessage: async (pendingId: string): Promise<{ success: boolean; message: string }> => {
    const { data } = await api.post(`/v1/automation/pending/${pendingId}/cancel`);
    return data;
  },
};

// Update notification settings DTO
export interface UpdateNotificationSettingsDto {
  enabled?: boolean;
  destinationPhone?: string;
  senderMode?: 'shared' | 'dedicated' | 'openphone';
  callioApiKey?: string;
  callioFromPhone?: string;
  callioWorkspaceId?: string;
  template?: string;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  quietHoursTimezone?: string;
  requirePhone?: boolean;
}

// Notification Rule DTOs
export interface CreateNotificationRuleDto {
  name: string;
  triggerType: 'new_lead' | 'customer_reply';
  replyTriggerMode?: 'first_only' | 'every_reply';
  fromPhone: string;  // Callio phone to send FROM
  toPhone: string;    // Destination phone to send TO
  template: string;
  enabled?: boolean;
}

export interface UpdateNotificationRuleDto {
  name?: string;
  triggerType?: 'new_lead' | 'customer_reply';
  replyTriggerMode?: 'first_only' | 'every_reply';
  fromPhone?: string;
  toPhone?: string;
  template?: string;
  enabled?: boolean;
}

// Callio phone number type
export interface CallioPhoneNumber {
  id: string;
  phoneNumber: string;
  provider: 'twilio' | 'openphone' | string;
  friendlyName?: string;
  capabilities?: string[];
  // A2P Compliance fields
  a2pStatus?: 'pending' | 'approved' | 'rejected' | 'not_required' | string;
  a2pBrandId?: string;
  a2pCampaignId?: string;
  smsEnabled?: boolean;
  mmsEnabled?: boolean;
  voiceEnabled?: boolean;
}

// SMS Notifications (Callio Integration)
export const notificationsApi = {
  getSettings: async (savedAccountId: string): Promise<{ success: boolean; settings: NotificationSettings | null }> => {
    const { data } = await api.get(`/v1/notifications/settings/${savedAccountId}`);
    return data;
  },
  updateSettings: async (savedAccountId: string, updates: UpdateNotificationSettingsDto): Promise<{ success: boolean; message: string; settings: NotificationSettings }> => {
    const { data } = await api.put(`/v1/notifications/settings/${savedAccountId}`, updates);
    return data;
  },
  getLogs: async (savedAccountId: string, limit?: number): Promise<{ success: boolean; count: number; logs: NotificationLog[] }> => {
    const params = limit ? { limit } : {};
    const { data } = await api.get(`/v1/notifications/logs/${savedAccountId}`, { params });
    return data;
  },
  getAllLogs: async (limit?: number): Promise<{ success: boolean; count: number; logs: (NotificationLog & { savedAccountId?: string; savedAccount?: { id: string; businessId: string; businessName: string } })[] }> => {
    const params = limit ? { limit } : {};
    const { data } = await api.get('/v1/notifications/logs', { params });
    return data;
  },
  sendTest: async (savedAccountId: string, ruleId?: string): Promise<{ success: boolean; message: string }> => {
    const { data } = await api.post(`/v1/notifications/test/${savedAccountId}`, ruleId ? { ruleId } : {});
    return data;
  },
  // Notification Rules
  getAllRules: async (): Promise<{ success: boolean; count: number; rules: NotificationRule[] }> => {
    const { data } = await api.get('/v1/notifications/rules');
    return data;
  },
  getRules: async (savedAccountId: string): Promise<{ success: boolean; count: number; rules: NotificationRule[] }> => {
    const { data } = await api.get(`/v1/notifications/rules/${savedAccountId}`);
    return data;
  },
  createRule: async (savedAccountId: string, ruleData: CreateNotificationRuleDto): Promise<{ success: boolean; message: string; rule: NotificationRule }> => {
    const { data } = await api.post(`/v1/notifications/rules/${savedAccountId}`, ruleData);
    return data;
  },
  updateRule: async (savedAccountId: string, ruleId: string, updates: UpdateNotificationRuleDto): Promise<{ success: boolean; message: string; rule: NotificationRule }> => {
    const { data } = await api.put(`/v1/notifications/rules/${savedAccountId}/${ruleId}`, updates);
    return data;
  },
  deleteRule: async (savedAccountId: string, ruleId: string): Promise<{ success: boolean; message: string }> => {
    const { data } = await api.delete(`/v1/notifications/rules/${savedAccountId}/${ruleId}`);
    return data;
  },
  // Callio integration
  validateCallioApiKey: async (apiKey: string): Promise<{ success: boolean; valid: boolean; phoneNumbers: CallioPhoneNumber[] }> => {
    const { data } = await api.post('/v1/notifications/callio/validate', { apiKey });
    return data;
  },
  getCallioPhoneNumbers: async (savedAccountId: string): Promise<{ success: boolean; phoneNumbers: CallioPhoneNumber[] }> => {
    const { data } = await api.get(`/v1/notifications/callio/phone-numbers/${savedAccountId}`);
    return data;
  },
  connectCallio: async (savedAccountId: string, apiKey: string): Promise<{ success: boolean; phoneNumbers: CallioPhoneNumber[]; error?: string }> => {
    const { data } = await api.post(`/v1/notifications/callio/connect/${savedAccountId}`, { apiKey });
    return data;
  },
  disconnectCallio: async (savedAccountId: string): Promise<{ success: boolean; error?: string }> => {
    const { data } = await api.delete(`/v1/notifications/callio/disconnect/${savedAccountId}`);
    return data;
  },
};

// Analytics types
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

export interface AnalyticsData {
  categoryDistribution: CategoryDistribution[];
  connectionTime: ConnectionTimeMetric;
  proResponseTime: ResponseTimeMetric;
  customerResponseTime: ResponseTimeMetric;
  messagesPerLead: MessagesPerLeadMetric;
  customerEngagement: CustomerEngagementMetric;
  totalLeads: number;

  // Service detail analytics
  cleaningTypeDistribution?: ServiceDetailDistribution[];
  addOnsDistribution?: ServiceDetailDistribution[];
  frequencyDistribution?: ServiceDetailDistribution[];
  locationDistribution?: ServiceDetailDistribution[];
  zipCodeDistribution?: ServiceDetailDistribution[];
  roomStats?: RoomStatsMetric;

  dateRange: {
    start: string;
    end: string;
  };
  filters: {
    businessId?: string;
    businessName?: string;
  };
}

// Analytics API
export const analyticsApi = {
  getBasicAnalytics: async (params: {
    businessId?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<{ success: boolean; data: Partial<AnalyticsData> }> => {
    const queryParams = new URLSearchParams();
    if (params.businessId) queryParams.append('businessId', params.businessId);
    if (params.startDate) queryParams.append('startDate', params.startDate);
    if (params.endDate) queryParams.append('endDate', params.endDate);

    const { data } = await api.get(`/v1/analytics/basic?${queryParams.toString()}`);
    return data;
  },

  getAnalytics: async (params: {
    businessId?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<{ success: boolean; data: AnalyticsData }> => {
    const queryParams = new URLSearchParams();
    if (params.businessId) queryParams.append('businessId', params.businessId);
    if (params.startDate) queryParams.append('startDate', params.startDate);
    if (params.endDate) queryParams.append('endDate', params.endDate);

    const { data } = await api.get(`/v1/analytics?${queryParams.toString()}`);
    return data;
  },
};

// Billing API (Stripe)
export const billingApi = {
  createCheckoutSession: async (tier: 'STARTER' | 'PRO' | 'ENTERPRISE', addOns: string[] = []): Promise<{ sessionUrl: string }> => {
    const { data } = await api.post('/v1/stripe/create-checkout-session', { tier, addOns });
    return data.data;
  },
  createPortalSession: async (): Promise<{ portalUrl: string }> => {
    const { data } = await api.post('/v1/stripe/create-portal-session');
    return data.data;
  },
  getSubscription: async (): Promise<SubscriptionDetails> => {
    const { data } = await api.get('/v1/stripe/subscription');
    return data.data;
  },
};

// Admin API
export const adminApi = {
  listUsers: async (params: { search?: string; tier?: string; offset?: number; limit?: number }): Promise<{ users: AdminUser[]; total: number; offset: number; limit: number }> => {
    const queryParams = new URLSearchParams();
    if (params.search) queryParams.append('search', params.search);
    if (params.tier) queryParams.append('tier', params.tier);
    if (params.offset !== undefined) queryParams.append('offset', params.offset.toString());
    if (params.limit !== undefined) queryParams.append('limit', params.limit.toString());

    const { data } = await api.get(`/v1/admin/users?${queryParams.toString()}`);
    return data.data;
  },
  getUserDetails: async (userId: string): Promise<AdminUserDetails> => {
    const { data } = await api.get(`/v1/admin/users/${userId}`);
    return data.data;
  },
  updateUserSubscription: async (userId: string, updates: { tier?: string; status?: string; hasOwnNumber?: boolean }): Promise<AdminUser> => {
    const { data } = await api.patch(`/v1/admin/users/${userId}/subscription`, updates);
    return data.data;
  },
  deleteUser: async (userId: string): Promise<{ success: boolean }> => {
    const { data } = await api.delete(`/v1/admin/users/${userId}`);
    return data.data;
  },
  getStats: async (): Promise<AdminStats> => {
    const { data } = await api.get('/v1/admin/stats');
    return data.data;
  },
  getAdminLogs: async (params: { limit?: number; offset?: number }): Promise<{ logs: AdminLog[]; total: number; offset: number; limit: number }> => {
    const queryParams = new URLSearchParams();
    if (params.limit !== undefined) queryParams.append('limit', params.limit.toString());
    if (params.offset !== undefined) queryParams.append('offset', params.offset.toString());

    const { data } = await api.get(`/v1/admin/logs?${queryParams.toString()}`);
    return data.data;
  },
};

export default api;
