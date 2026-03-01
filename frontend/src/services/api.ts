import axios, { AxiosError } from 'axios';
import type { AuthResponse, Lead, Business, Platform, SavedAccount, MessageTemplate, BulkMessagePreview, BulkSendResult, AutomationRule, PendingAutomatedMessage, NotificationSettings, NotificationLog, NotificationRule, SubscriptionDetails, AdminUser, AdminUserDetails, AdminStats, AdminLog, PhonePoolEntry, PhonePoolStats, AvailablePhoneNumber } from '../types';
import { notify } from '../store/notificationStore';
import { useAuthStore } from '../store/authStore';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add auth token + impersonation header to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  // Inject impersonation header for admin "View As" feature
  const impersonatingUser = useAuthStore.getState().impersonatingUser;
  if (impersonatingUser?.id && !config.url?.includes('/admin/')) {
    config.headers['X-Impersonate-User'] = impersonatingUser.id;
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
  changePassword: async (currentPassword: string, newPassword: string): Promise<{ message: string }> => {
    const { data } = await api.post('/auth/change-password', { currentPassword, newPassword });
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
  getAuthUrl: async (forceLogin = false): Promise<{ authUrl: string }> => {
    const { data } = await api.get('/v1/thumbtack/auth/url', { params: forceLogin ? { forceLogin: 'true' } : undefined });
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
  getBusinesses: async (): Promise<{ businesses: Business[]; needsReauth?: boolean }> => {
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
  getAccountHealth: async (id: string): Promise<AccountDiagnostics> => {
    const { data } = await api.get(`/v1/thumbtack/saved-accounts/${id}/health`);
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
  sender: 'customer' | 'pro' | 'system';
  content: string;
  attachments?: MessageAttachment[];
  isRead: boolean;
  sentAt: string;
  deliveredAt?: string;
  notificationLogId?: string;
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
  sigcoreApiKey?: string;
  sigcoreFromPhone?: string;
  sigcoreWorkspaceId?: string;
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
  fromPhone: string;  // Sigcore phone to send FROM
  toPhone: string;    // Destination phone to send TO
  sendToCustomer?: boolean; // If true, send to lead's phone instead of toPhone
  template: string;
  templateId?: string;
  delayMinutes?: number;
  stopOnCustomerReply?: boolean;
  stopOnLeadClosed?: boolean;
  stopOnOptOut?: boolean;
  enabled?: boolean;
}

export interface UpdateNotificationRuleDto {
  name?: string;
  triggerType?: 'new_lead' | 'customer_reply';
  replyTriggerMode?: 'first_only' | 'every_reply';
  fromPhone?: string;
  toPhone?: string;
  sendToCustomer?: boolean;
  template?: string;
  templateId?: string;
  delayMinutes?: number;
  stopOnCustomerReply?: boolean;
  stopOnLeadClosed?: boolean;
  stopOnOptOut?: boolean;
  enabled?: boolean;
}

// Sigcore phone number type
export interface SigcorePhoneNumber {
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

export interface TenantPhoneNumber {
  id: string;
  userId: string;
  savedAccountId: string | null;
  phoneNumber: string;
  friendlyName: string | null;
  areaCode: string | null;
  sigcoreAllocationId: string | null;
  stripeSubItemId: string | null;
  status: 'ACTIVE' | 'GRACE_PERIOD' | 'RELEASED';
  purchasedAt: string;
  cancelledAt: string | null;
  gracePeriodEndsAt: string | null;
  releasedAt: string | null;
}

// SMS Notifications (Sigcore Integration)
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
  getLogsByLead: async (leadId: string, limit?: number): Promise<{ success: boolean; count: number; logs: NotificationLog[] }> => {
    const params = limit ? { limit } : {};
    const { data } = await api.get(`/v1/notifications/logs/lead/${leadId}`, { params });
    return data;
  },
  sendAdHocSms: async (savedAccountId: string, leadId: string, message: string): Promise<{ success: boolean; message: string; logId?: string }> => {
    const { data } = await api.post('/v1/notifications/send-sms', { savedAccountId, leadId, message });
    return data;
  },
  sendTest: async (savedAccountId: string, ruleId?: string, toPhone?: string, template?: string): Promise<{ success: boolean; message: string }> => {
    const body: { ruleId?: string; toPhone?: string; template?: string } = {};
    if (ruleId) body.ruleId = ruleId;
    if (toPhone) body.toPhone = toPhone;
    if (template) body.template = template;
    const { data } = await api.post(`/v1/notifications/test/${savedAccountId}`, body);
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
  // Provider integration
  getSigcorePhoneNumbers: async (savedAccountId: string): Promise<{ success: boolean; phoneNumbers: SigcorePhoneNumber[] }> => {
    const { data } = await api.get(`/v1/notifications/sigcore/phone-numbers/${savedAccountId}`);
    return data;
  },
  saveApiKey: async (savedAccountId: string, apiKey: string): Promise<{ success: boolean; error?: string }> => {
    const { data } = await api.post(`/v1/notifications/sigcore/api-key/${savedAccountId}`, { apiKey });
    return data;
  },
  connectSigcore: async (
    savedAccountId: string,
    provider: 'openphone' | 'twilio',
    providerCredentials: {
      apiKey?: string;
      accountSid?: string;
      authToken?: string;
      phoneNumber?: string;
    },
  ): Promise<{ success: boolean; phoneNumbers: SigcorePhoneNumber[]; error?: string }> => {
    const { data } = await api.post(`/v1/notifications/sigcore/connect/${savedAccountId}`, {
      provider,
      providerCredentials,
    });
    return data;
  },
  disconnectSigcore: async (savedAccountId: string): Promise<{ success: boolean; error?: string }> => {
    const { data } = await api.delete(`/v1/notifications/sigcore/disconnect/${savedAccountId}`);
    return data;
  },
  provisionSigcoreWorkspace: async (savedAccountId: string): Promise<{ success: boolean; data: { provisioned: boolean; tenantId: string } }> => {
    const { data } = await api.post(`/v1/notifications/sigcore/provision/${savedAccountId}`);
    return data;
  },
  searchAvailableNumbers: async (
    savedAccountId: string,
    country: string = 'US',
    areaCode?: string,
    locality?: string,
  ): Promise<{ success: boolean; data: AvailablePhoneNumber[] }> => {
    const params = new URLSearchParams({ country });
    if (areaCode) params.append('areaCode', areaCode);
    if (locality) params.append('locality', locality);
    const { data } = await api.get(`/v1/notifications/sigcore/available-numbers/${savedAccountId}?${params}`);
    return data;
  },
  purchasePhoneNumber: async (
    savedAccountId: string,
    phoneNumber: string,
    friendlyName?: string,
  ): Promise<{ success: boolean; data: { phoneNumber: string; allocationId: string } }> => {
    const { data } = await api.post(`/v1/notifications/sigcore/purchase-number/${savedAccountId}`, { phoneNumber, friendlyName });
    return data;
  },
  // Tenant Phone Numbers (Dedicated Numbers)
  getPhonePricing: async (): Promise<{ success: boolean; data: { priceMonthly: number | null; gracePeriodDays: number } }> => {
    const { data } = await api.get('/v1/notifications/phone-pricing');
    return data;
  },
  listTenantPhones: async (): Promise<{ success: boolean; data: TenantPhoneNumber[] }> => {
    const { data } = await api.get('/v1/notifications/tenant-phones');
    return data;
  },
  purchaseTenantPhone: async (savedAccountId: string, phoneNumber: string, friendlyName?: string): Promise<{ success: boolean; tenantPhone?: TenantPhoneNumber; error?: string }> => {
    const { data } = await api.post('/v1/notifications/tenant-phones/purchase', { savedAccountId, phoneNumber, friendlyName });
    return data;
  },
  cancelTenantPhone: async (tenantPhoneId: string): Promise<{ success: boolean; error?: string }> => {
    const { data } = await api.post(`/v1/notifications/tenant-phones/${tenantPhoneId}/cancel`);
    return data;
  },
  // Customer Texting
  getCustomerTextingSettings: async (savedAccountId: string): Promise<{ success: boolean; enabled: boolean; fromPhone: string | null; autoReplyTemplate: string }> => {
    const { data } = await api.get(`/v1/notifications/customer-texting/${savedAccountId}`);
    return data;
  },
  saveCustomerTextingSettings: async (savedAccountId: string, settings: { enabled: boolean; fromPhone?: string; autoReplyTemplate: string }): Promise<{ success: boolean }> => {
    const { data } = await api.put(`/v1/notifications/customer-texting/${savedAccountId}`, settings);
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

  // Job status from Thumbtack UI
  jobStatusDistribution?: ServiceDetailDistribution[];

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
  }): Promise<{ success: boolean; data: AnalyticsData; calculatedAt: string | null }> => {
    const queryParams = new URLSearchParams();
    if (params.businessId) queryParams.append('businessId', params.businessId);
    if (params.startDate) queryParams.append('startDate', params.startDate);
    if (params.endDate) queryParams.append('endDate', params.endDate);

    const { data } = await api.get(`/v1/analytics?${queryParams.toString()}`);
    return data;
  },

  refreshAnalytics: async (params: {
    businessId?: string;
  }): Promise<{ success: boolean; data: AnalyticsData; calculatedAt: string }> => {
    const queryParams = new URLSearchParams();
    if (params.businessId) queryParams.append('businessId', params.businessId);

    const { data } = await api.post(`/v1/analytics/refresh?${queryParams.toString()}`);
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

// Users API (Phone provisioning, etc)
export const usersApi = {
  getMyPhoneNumber: async (): Promise<{ phoneNumber: string | null; allocationId: string | null; hasPhoneNumber: boolean }> => {
    const { data } = await api.get('/v1/users/me/phone-number');
    return data;
  },
  provisionPhoneNumber: async (areaCode?: string): Promise<{ phoneNumber: string | null; allocationId?: string; message: string }> => {
    const url = areaCode ? `/v1/users/me/phone-number/provision?areaCode=${areaCode}` : '/v1/users/me/phone-number/provision';
    const { data } = await api.post(url);
    return data;
  },
  getMyPoolPhone: async (): Promise<{ success: boolean; poolPhone: PhonePoolEntry | null; poolPhones: PhonePoolEntry[] }> => {
    const { data } = await api.get('/v1/users/me/pool-phone');
    return data;
  },
  getPoolPhonesForSms: async (): Promise<{ success: boolean; phoneNumbers: { id: string; phoneNumber: string; provider: string; friendlyName: string | null; assigned: boolean }[] }> => {
    const { data } = await api.get('/v1/users/me/pool-phones-for-sms');
    return data;
  },
  updateProfile: async (updates: { name?: string }): Promise<{ success: boolean; user: { id: string; name: string; email: string } }> => {
    const { data } = await api.patch('/v1/users/me', updates);
    return data;
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
  cancelUserSubscription: async (userId: string, immediate: boolean = true): Promise<{ success: boolean; immediate: boolean }> => {
    const { data } = await api.post(`/v1/admin/users/${userId}/cancel-subscription`, { immediate });
    return data.data;
  },
  updateTrialLeads: async (userId: string, updates: { trialLeadsHandled?: number; trialLeadsLimit?: number }): Promise<any> => {
    const { data } = await api.patch(`/v1/admin/users/${userId}/trial-leads`, updates);
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
  getNotificationLogs: async (limit?: number): Promise<{ count: number; logs: NotificationLog[] }> => {
    const params = limit ? { limit } : {};
    const { data } = await api.get('/v1/admin/notification-logs', { params });
    return data;
  },
  // Phone Pool
  getPhonePool: async (params?: { status?: string; areaCode?: string; search?: string; offset?: number; limit?: number }): Promise<{ phones: PhonePoolEntry[]; total: number; offset: number; limit: number }> => {
    const queryParams = new URLSearchParams();
    if (params?.status) queryParams.append('status', params.status);
    if (params?.areaCode) queryParams.append('areaCode', params.areaCode);
    if (params?.search) queryParams.append('search', params.search);
    if (params?.offset !== undefined) queryParams.append('offset', params.offset.toString());
    if (params?.limit !== undefined) queryParams.append('limit', params.limit.toString());

    const { data } = await api.get(`/v1/admin/phone-pool?${queryParams.toString()}`);
    return data.data;
  },
  getPhonePoolStats: async (): Promise<PhonePoolStats> => {
    const { data } = await api.get('/v1/admin/phone-pool/stats');
    return data.data;
  },
  getPoolConfig: async (): Promise<{ configured: boolean }> => {
    const { data } = await api.get('/v1/admin/phone-pool/config');
    return data.data;
  },
  connectPoolProvider: async (provider: 'openphone' | 'twilio', credentials: {
    apiKey?: string;
    accountSid?: string;
    authToken?: string;
    phoneNumber?: string;
  }): Promise<{ success: boolean; data?: any; error?: string }> => {
    const { data } = await api.post('/v1/admin/phone-pool/connect-provider', { provider, credentials });
    return data;
  },
  disconnectPoolProvider: async (provider: 'openphone' | 'twilio'): Promise<{ success: boolean; error?: string }> => {
    const { data } = await api.post('/v1/admin/phone-pool/disconnect-provider', { provider });
    return data;
  },
  syncPoolNumbers: async (): Promise<{ success: boolean; data: { results: { provider: string; synced: number; errors: string[] }[] } }> => {
    const { data } = await api.post('/v1/admin/phone-pool/sync');
    return data;
  },
  setupDeliveryWebhook: async (): Promise<{ success: boolean; data?: { webhookId?: string }; error?: string }> => {
    const { data } = await api.post('/v1/admin/phone-pool/setup-webhook');
    return data;
  },
  assignPhone: async (phonePoolId: string, userId: string): Promise<PhonePoolEntry> => {
    const { data } = await api.post(`/v1/admin/phone-pool/${phonePoolId}/assign/${userId}`);
    return data.data;
  },
  assignPhoneToAll: async (phonePoolId: string): Promise<PhonePoolEntry> => {
    const { data } = await api.post(`/v1/admin/phone-pool/${phonePoolId}/assign-all`);
    return data.data;
  },
  unassignPhone: async (phonePoolId: string, userId: string): Promise<PhonePoolEntry> => {
    const { data } = await api.post(`/v1/admin/phone-pool/${phonePoolId}/unassign/${userId}`);
    return data.data;
  },
  releasePhone: async (phonePoolId: string): Promise<void> => {
    await api.delete(`/v1/admin/phone-pool/${phonePoolId}`);
  },
  updateSmsApproved: async (phonePoolId: string, smsApproved: boolean): Promise<PhonePoolEntry> => {
    const { data } = await api.patch(`/v1/admin/phone-pool/${phonePoolId}/sms-approved`, { smsApproved });
    return data.data;
  },
  getPhonePoolUsers: async (search?: string): Promise<{ data: { id: string; email: string; name: string | null }[] }> => {
    const params = search ? `?search=${encodeURIComponent(search)}` : '';
    const { data } = await api.get(`/v1/admin/phone-pool/users${params}`);
    return data;
  },
  getAdminConfig: async (): Promise<{ id: string; testData: Record<string, string> }> => {
    const { data } = await api.get('/v1/admin/phone-pool/admin-config');
    return data.data;
  },
  updateAdminConfig: async (testData: Record<string, string>): Promise<{ id: string; testData: Record<string, string> }> => {
    const { data } = await api.patch('/v1/admin/phone-pool/admin-config', { testData });
    return data.data;
  },
  // Phone Pricing
  getPhonePricing: async (): Promise<{ priceMonthly: number | null; gracePeriodDays: number; stripePriceId: string | null }> => {
    const { data } = await api.get('/v1/admin/phone-pool/phone-pricing');
    return data.data;
  },
  updatePhonePricing: async (priceMonthly: number, gracePeriodDays: number): Promise<{ priceMonthly: number; gracePeriodDays: number; stripePriceId: string }> => {
    const { data } = await api.patch('/v1/admin/phone-pool/phone-pricing', { priceMonthly, gracePeriodDays });
    return data.data;
  },
  checkTwilioHealth: async (): Promise<{
    status: 'connected' | 'disconnected' | 'error';
    phoneCount: number;
    message: string;
    checkedAt: string;
  }> => {
    const { data } = await api.get('/v1/admin/phone-pool/twilio-health');
    return data.data;
  },
  getTenantErrors: async (params?: {
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    logs: any[];
    total: number;
    offset: number;
    limit: number;
    failedCount24h: number;
  }> => {
    const qp = new URLSearchParams();
    if (params?.status) qp.append('status', params.status);
    if (params?.limit !== undefined) qp.append('limit', params.limit.toString());
    if (params?.offset !== undefined) qp.append('offset', params.offset.toString());
    const { data } = await api.get(`/v1/admin/tenant-errors?${qp.toString()}`);
    return data.data;
  },
};

// API Test / Webhook Simulation
export interface SimulateWebhookRequest {
  targetUserId: string;
  savedAccountId: string;
  eventType: 'NegotiationCreatedV4' | 'MessageCreatedV4';
  customerFirstName?: string;
  customerLastName?: string;
  customerPhone?: string;
  category?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  message?: string;
  estimateTotal?: string;
  details?: Array<{ question: string; answer: string }>;
  messageText?: string;
  negotiationId?: string;
  messageSender?: 'Customer' | 'Pro';
}

export interface TestUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  subscriptionTier: string | null;
}

export interface TestAccount {
  id: string;
  businessId: string;
  businessName: string;
  webhookId: string | null;
}

export interface SimulationResult {
  success: boolean;
  eventType: string;
  negotiationId: string;
  payload: any;
  results: {
    webhookProcessed: boolean;
    webhookError: string | null;
    leadCreated: boolean;
    leadId: string | null;
    leadStatus: string | null;
    leadName: string | null;
    sseEventEmitted: boolean;
    automationRulesFound: number;
    automationRules: Array<{ name: string; triggerType: string }>;
    notificationRulesFound: number;
    notificationRules: Array<{ name: string; triggerType: string }>;
    sigcoreConnected: boolean;
    smsLogs: Array<{ id: string; status: string; ruleName: string | null; error: string | null; toPhone?: string; fromPhone?: string }>;
    smsSent: boolean;
    smsSuccessCount: number;
    smsFailedCount: number;
    smsNotSentReason: string | null;
    webhookEventId: string | null;
    webhookEventError: string | null;
    pipelineTrace: Array<{ step: string; status: 'pass' | 'fail' | 'skip'; detail: string }>;
    notificationDiagnostics: {
      settingsExist: boolean;
      settingsEnabled: boolean;
      hasSigcoreApiKey: boolean;
      totalRules: number;
      newLeadRules: number;
      customerReplyRules: number;
    };
  };
}

export interface TestLead {
  id: string;
  externalRequestId: string;
  customerName: string;
  category: string | null;
  status: string;
  createdAt: string;
}

export interface AccountDiagnostics {
  account: {
    id: string;
    businessId: string;
    businessName: string;
    hasWebhook: boolean;
  };
  platform: {
    connected: boolean;
    externalBusinessId: string | null;
  };
  notifications: {
    settingsExist: boolean;
    settingsEnabled: boolean;
    hasSigcoreApiKey: boolean;
    totalRules: number;
    newLeadRules: number;
    customerReplyRules: number;
    rules: Array<{ name: string; triggerType: string; toPhone: string | null; fromPhone: string | null }>;
  };
  automation: {
    totalRules: number;
    rules: Array<{ name: string; triggerType: string }>;
  };
  recentLogs: Array<{ status: string; ruleName: string | null; error: string | null; createdAt: string }>;
  healthy: boolean;
  issues: string[];
  notificationIssues: string[];
}

export const testApi = {
  getUsers: async (search?: string): Promise<{ users: TestUser[] }> => {
    const params = search ? `?search=${encodeURIComponent(search)}` : '';
    const { data } = await api.get(`/v1/test/users${params}`);
    return data;
  },
  getUserAccounts: async (userId: string): Promise<{ accounts: TestAccount[] }> => {
    const { data } = await api.get(`/v1/test/users/${userId}/accounts`);
    return data;
  },
  simulate: async (request: SimulateWebhookRequest): Promise<SimulationResult> => {
    const { data } = await api.post('/v1/test/simulate', request);
    return data;
  },
  getDiagnostics: async (savedAccountId: string): Promise<AccountDiagnostics> => {
    const { data } = await api.get(`/v1/test/diagnostics/${savedAccountId}`);
    return data;
  },
  getLeadsForAccount: async (savedAccountId: string, userId: string): Promise<{ leads: TestLead[]; count: number }> => {
    const { data } = await api.get(`/v1/test/leads/${savedAccountId}?userId=${userId}`);
    return data;
  },
};

// Extension Sync (Chrome extension collected data)
export const integrationsApi = {
  getCollectedLeads: async (filters?: { pending?: boolean; refetch?: boolean; accountId?: string }): Promise<{
    ok: boolean;
    leads: Array<{
      id: string;
      thumbtackId: string;
      savedAccountId: string | null;
      batchId: string | null;
      capturedAt: string;
      collectedAt: string;
      source: string | null;
      thumbtackStatus: string | null;
      imported: boolean;
      importedAt: string | null;
      needsRefetch: boolean;
      lastActivityAt: string | null;
    }>;
    total: number;
  }> => {
    const params = new URLSearchParams();
    if (filters?.pending) params.append('pending', 'true');
    if (filters?.refetch) params.append('refetch', 'true');
    if (filters?.accountId) params.append('accountId', filters.accountId);
    const query = params.toString();
    const { data } = await api.get(`/integrations/thumbtack/leads${query ? `?${query}` : ''}`);
    return data;
  },
  markLeadsImported: async (thumbtackIds: string[]): Promise<{ ok: boolean; markedCount: number }> => {
    const { data } = await api.patch('/integrations/thumbtack/leads/mark-imported', { thumbtackIds });
    return data;
  },
  getBudgetSnapshots: async (accountId?: string): Promise<{
    ok: boolean;
    snapshots: Array<{
      id: string;
      savedAccountId: string | null;
      snapshotType: string;
      scopeCategory: string | null;
      scopeLocation: string | null;
      weeklyBudget: string;
      currency: string;
      capturedAt: string;
      effectiveFrom: string;
      effectiveTo: string | null;
      source: string | null;
      active: boolean;
    }>;
    total: number;
  }> => {
    const query = accountId ? `?accountId=${accountId}` : '';
    const { data } = await api.get(`/integrations/thumbtack/snapshots${query}`);
    return data;
  },
  deleteCollectedLeads: async (thumbtackIds?: string[]): Promise<{ ok: boolean; deletedCount: number }> => {
    const { data } = await api.delete('/integrations/thumbtack/leads', { data: thumbtackIds?.length ? { thumbtackIds } : {} });
    return data;
  },
  deleteBudgetSnapshots: async (): Promise<{ ok: boolean; deletedCount: number }> => {
    const { data } = await api.delete('/integrations/thumbtack/snapshots');
    return data;
  },
  importNegotiationBatch: async (negotiationIds: string[], accountId?: string): Promise<{
    success: boolean;
    imported: number;
    skipped: number;
    errors: string[];
    results: Array<{ negotiationId: string; leadId?: string; isNew?: boolean; error?: string }>;
  }> => {
    const { data } = await api.post('/v1/thumbtack/negotiations/import-batch', {
      negotiationIds,
      ...(accountId ? { accountId } : {}),
    });
    return data;
  },
};

// Instant Call Connect API
import type { CallConnectSettings, LeadCallConnect } from '../types';

export const callConnectApi = {
  getSettings: async (accountId: string): Promise<{ settings: CallConnectSettings | null }> => {
    const { data } = await api.get(`/v1/call-connect/settings?accountId=${accountId}`);
    return data;
  },
  saveSettings: async (
    savedAccountId: string,
    updates: Partial<Omit<CallConnectSettings, 'id' | 'savedAccountId' | 'createdAt' | 'updatedAt'>>,
  ): Promise<{ settings: CallConnectSettings }> => {
    const { data } = await api.put('/v1/call-connect/settings', { savedAccountId, ...updates });
    return data;
  },
  getLeadSessions: async (leadId: string): Promise<{ sessions: LeadCallConnect[] }> => {
    const { data } = await api.get(`/v1/call-connect/lead/${leadId}`);
    return data;
  },
  cancelSession: async (sessionId: string, savedAccountId: string): Promise<{ cancelled: boolean }> => {
    const { data } = await api.post('/v1/call-connect/cancel', { sessionId, savedAccountId });
    return data;
  },
  testCall: async (savedAccountId: string, testPhone: string): Promise<{ triggered: boolean; sessionId: string | null }> => {
    const { data } = await api.post('/v1/call-connect/test', { savedAccountId, testPhone });
    return data;
  },
  uploadVoicemail: async (savedAccountId: string, file: File): Promise<{ recordingUrl: string }> => {
    const form = new FormData();
    form.append('file', file);
    form.append('savedAccountId', savedAccountId);
    const { data } = await api.post('/v1/call-connect/upload-voicemail', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data;
  },
};

export default api;
