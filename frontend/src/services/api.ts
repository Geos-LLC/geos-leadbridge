import axios, { AxiosError } from 'axios';
import type { AuthResponse, Lead, Business, Platform, SavedAccount, MessageTemplate, BulkMessagePreview, BulkSendResult, AutomationRule, PendingAutomatedMessage, NotificationSettings, NotificationLog, NotificationRule, SubscriptionDetails, AdminUser, AdminUserDetails, AdminStats, AdminLog, AvailablePhoneNumber } from '../types';
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
    // Handle 401 - redirect to login ONLY when the user previously had a
    // valid token. Anonymous visitors on the public Landing page also hit
    // authenticated endpoints (e.g. getPhonePricing for the pricing block);
    // booting them to /login on the first paint is wrong — they were never
    // logged in, so there's nothing to "log them out" of. Without this guard
    // the marketing site auto-redirects every visitor to the login form.
    if (error.response?.status === 401) {
      const hadToken = !!localStorage.getItem('token');
      if (hadToken) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        localStorage.removeItem('auth-storage'); // Clear zustand persisted auth state
        window.location.href = '/login';
      }
      return Promise.reject(error);
    }

    // Skip global toast for endpoints that handle their own error display
    const url = error.config?.url || '';
    const silentPatterns = [/\/negotiations\/[^/]+\/import$/];
    const isSilent = silentPatterns.some(p => p.test(url));

    // SupportGrant-guarded admin endpoints render a SupportAccessRequired
    // banner inline. The guard returns 404 with message "Resource not found"
    // (NotFoundException) — same shape as a real 404, so we match on the URL
    // prefix to scope the suppression.
    const isSupportGuardDenial =
      error.response?.status === 404 &&
      /\/v1\/admin\//.test(url) &&
      (error.response?.data as any)?.message === 'Resource not found';

    // Show toast notification for other errors
    const errorDetails = (!isSilent && !isSupportGuardDenial) ? getErrorDetails(error) : null;
    if (errorDetails) {
      notify.error(errorDetails.title, errorDetails.message);
    }

    return Promise.reject(error);
  }
);

// SupportGrant denial detector — share with components so they can swap in the
// SupportAccessRequired UI instead of the empty-state.
export function isSupportAccessDenied(err: any): boolean {
  return err?.response?.status === 404 &&
    err?.response?.data?.message === 'Resource not found';
}

// Auth
export const authApi = {
  register: async (email: string, password: string, name?: string, businessPhone?: string): Promise<AuthResponse> => {
    const { data } = await api.post('/auth/register', { email, password, name, businessPhone });
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
  // Yelp OAuth
  getYelpAuthUrl: async (): Promise<{ url: string }> => {
    const { data } = await api.get('/v1/yelp/auth/url');
    return data;
  },
  disconnectYelp: async (accountId: string): Promise<void> => {
    await api.post('/v1/yelp/auth/disconnect', { accountId });
  },
  getYelpAccountHealth: async (id: string): Promise<AccountDiagnostics> => {
    const { data } = await api.get(`/v1/yelp/saved-accounts/${id}/health`);
    return data;
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
    const { data } = await api.get('/v1/platforms/saved-accounts');
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
  updateSavedAccount: async (id: string, updates: { emailHint?: string; agentPhoneOverride?: string | null }): Promise<{ success: boolean }> => {
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
  senderType?: 'ai' | 'user' | null;
  content: string;
  attachments?: MessageAttachment[];
  isRead: boolean;
  sentAt: string;
  deliveredAt?: string;
  notificationLogId?: string;
}

// Leads
export const leadsApi = {
  /**
   * Fetch leads. Account-scope is REQUIRED:
   *   - businessId: scope to one saved account (per-account inbox view)
   *   - scope: 'all' for the unified all-accounts view
   * Both at once is rejected by the backend with 400. Omitting both still works
   * during the transition window but the backend logs a warning and returns the
   * X-LeadBridge-Boundary-Warning header. Callers should always pass one or
   * the other so we can flip the backend to strict mode without breaking the UI.
   */
  getLeads: async (params?: {
    limit?: number;
    businessId?: string;
    scope?: 'all';
  }): Promise<{ leads: Lead[]; count: number }> => {
    const query = new URLSearchParams();
    if (params?.limit) query.append('limit', params.limit.toString());
    if (params?.businessId) query.append('businessId', params.businessId);
    if (params?.scope) query.append('scope', params.scope);
    const qs = query.toString();
    const { data } = await api.get(`/v1/thumbtack/leads${qs ? `?${qs}` : ''}`);
    return data;
  },
  getLead: async (id: string): Promise<Lead> => {
    const { data } = await api.get(`/v1/thumbtack/leads/${id}`);
    return data;
  },
  getMessages: async (leadId: string, opts?: { fresh?: boolean }): Promise<{ messages: ApiMessage[]; count: number }> => {
    const qs = opts?.fresh ? '?fresh=1' : '';
    const { data } = await api.get(`/v1/thumbtack/leads/${leadId}/messages${qs}`);
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
  /**
   * Manually change a lead's pipeline status.
   * Backend always writes the status; `conflict` is populated when the write
   * diverges from what SF or the platform last knew — the UI should surface
   * it as a modal. See LeadStatusService.writeStatus.
   */
  updateStatus: async (leadId: string, status: string): Promise<{
    success: boolean;
    lead?: Lead;
    conflict?: StatusConflict | null;
    error?: string;
  }> => {
    const { data } = await api.patch(`/v1/leads/${leadId}/status`, { status });
    return data;
  },
  listStatusConflicts: async (leadId: string): Promise<{
    success: boolean;
    conflicts?: StatusConflict[];
    error?: string;
  }> => {
    const { data } = await api.get(`/v1/leads/${leadId}/status-conflicts`);
    return data;
  },
  resolveStatusConflict: async (
    leadId: string,
    auditId: string,
    resolveNote: string,
  ): Promise<{ success: boolean; error?: string }> => {
    const { data } = await api.post(
      `/v1/leads/${leadId}/status-conflicts/${auditId}/resolve`,
      { resolveNote },
    );
    return data;
  },
  /**
   * Lead Activity timeline. Returns the audit log rows describing every
   * status transition that touched the lead. `limit` is hard-capped server-side at 200.
   */
  getActivity: async (
    leadId: string,
    limit?: number,
  ): Promise<{
    success: boolean;
    error?: string;
    activity: LeadActivityEntry[];
  }> => {
    const { data } = await api.get(`/v1/leads/${leadId}/activity`, {
      params: limit ? { limit } : undefined,
    });
    return data;
  },
};

/** A single Lead Activity row as returned by GET /v1/leads/:id/activity. */
export interface LeadActivityEntry {
  id: string;
  type: string;
  fromStatus: string | null;
  toStatus: string;
  source: 'service_flow' | 'platform_sync' | 'manual' | 'lb_automation';
  reason: string | null;
  metadata: Record<string, any> | null;
  actorType: string | null;
  actorName: string | null;
  occurredAt: string;
  createdAt: string;
}

/**
 * Status-conflict payload emitted by the backend when a manual status change
 * diverges from SF's or the platform's last-known status.
 *
 * - `sf_push_needed`: lead has an sfJobId → operator must push new status to SF.
 *   Frontend shows: "This lead is tracked in Service Flow. Update there too?"
 * - `platform_nudge_needed`: lead.platformStatus differs from the new LB status.
 *   Frontend shows: "Platform status is '{platformStatus}' on {platform}. Update it too?"
 */
export interface StatusConflict {
  kind: 'sf_push_needed' | 'platform_nudge_needed';
  auditLogId: string;
  note: string;
  sfJobId?: string | null;
  platform?: string;
  platformStatus?: string | null;
}

// Message Templates
export const templatesApi = {
  getTemplates: async (type?: 'message' | 'prompt'): Promise<{ templates: MessageTemplate[]; count: number }> => {
    const { data } = await api.get('/v1/templates', { params: type ? { type } : undefined });
    return data;
  },
  getTemplate: async (id: string): Promise<MessageTemplate> => {
    const { data } = await api.get(`/v1/templates/${id}`);
    return data;
  },
  createTemplate: async (name: string, content: string, isDefault?: boolean, type?: 'message' | 'prompt'): Promise<{ success: boolean; template: MessageTemplate }> => {
    const { data } = await api.post('/v1/templates', { name, content, isDefault, type });
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
  templateId?: string;
  promptTemplateId?: string;
  delayMinutes?: number;
  enabled?: boolean;
  useAi?: boolean;
  replyMode?: 'custom' | 'price' | 'auto';
  aiSystemPrompt?: string;
  isFollowUp?: boolean;
  activeHoursStart?: string;
  activeHoursEnd?: string;
  activeHoursTimezone?: string;
  stopOnCustomerReply?: boolean;
}

export interface UpdateAutomationRuleDto {
  name?: string;
  triggerType?: 'new_lead' | 'customer_reply';
  replyTriggerMode?: 'first_only' | 'every_reply';
  templateId?: string;
  promptTemplateId?: string;
  delayMinutes?: number;
  enabled?: boolean;
  useAi?: boolean;
  replyMode?: 'custom' | 'price' | 'auto';
  aiSystemPrompt?: string;
  isFollowUp?: boolean;
  activeHoursStart?: string;
  activeHoursEnd?: string;
  activeHoursTimezone?: string;
  stopOnCustomerReply?: boolean;
}

export const aiApi = {
  previewForLead: async (
    leadId: string,
    customerMessage: string,
    conversationHistory: { role: 'customer' | 'pro'; content: string }[],
    strategyPrompt?: string,
  ): Promise<{ reply: string }> => {
    const { data } = await api.post('/v1/ai/preview-for-lead', { leadId, customerMessage, conversationHistory, strategyPrompt });
    return data;
  },
  previewWithContext: async (
    leadId: string,
    conversationId: string,
    customerMessage: string,
    strategyPrompt?: string,
    contextMode?: 'full' | 'light' | 'none',
  ): Promise<{ reply: string; contextMode: string }> => {
    const { data } = await api.post('/v1/ai/preview-with-context', { leadId, conversationId, customerMessage, strategyPrompt, contextMode });
    return data;
  },
};

export const conversationContextApi = {
  suggestStrategy: async (conversationId: string): Promise<{
    success: boolean;
    suggested: string;
    reason: string;
    confidence: number;
    scores: Record<string, number>;
    threadState: Record<string, any>;
  }> => {
    const { data } = await api.get(`/v1/conversation-context/${conversationId}/suggest-strategy`);
    return data;
  },
  getAiContext: async (conversationId: string): Promise<{
    success: boolean;
    context: {
      systemContext: string;
      recentMessages: Array<{ role: 'customer' | 'pro'; content: string }>;
      threadState: Record<string, any>;
    } | null;
  }> => {
    const { data } = await api.get(`/v1/conversation-context/${conversationId}/ai-context`);
    return data;
  },
};

/**
 * Conversation Runtime — Phase 1.5 observability layer.
 *
 * Read-only diagnostic endpoints comparing legacy Lead.status against the
 * new durable conversation runtime state (conversationState, aiStatus,
 * lastClassifiedIntent, handoff lifecycle, sfJobOutcome, waitingSince).
 *
 * These endpoints are SAFE TO POLL — they perform no writes, no auto-fix,
 * and never expose customer message body / phone / email / name. Used by
 * the UI runtime-state panel + drift dashboard. Not yet wired into the
 * primary lead UI — those callers stay on the existing Lead.status pill
 * until Phase 3 swaps decision logic.
 */
export interface RuntimeStateResponse {
  success: boolean;
  leadId: string;
  error?: string;
  lead?: {
    status: string;
    statusSource: string | null;
    statusUpdatedAt: string | null;
    platform: string;
    externalRequestId: string;
    sfJobId: string | null;
    sfJobOutcome: string | null;
    sfJobOutcomeAt: string | null;
    sfLastEventAt: string | null;
  };
  threadContext?: {
    conversationState: string | null;
    conversationStateAt: string | null;
    conversationStateReason: string | null;
    aiStatus: string | null;
    aiStatusAt: string | null;
    aiStatusReason: string | null;
    lastClassifiedIntent: string | null;
    lastClassifiedConfidence: number | null;
    lastClassifiedAt: string | null;
    handoffRequestedAt: string | null;
    handoffRequestedReason: string | null;
    handoffResolvedAt: string | null;
    waitingSince: string | null;
    lastCustomerMessageAt: string | null;
    lastBusinessMessageAt: string | null;
    lastAiMessageAt: string | null;
    awaitingCustomerReply: boolean;
    followUpStatus: string | null;
    nextFollowUpAt: string | null;
    activeEnrollmentId: string | null;
  } | null;
  followUp?: {
    enrollmentId: string | null;
    status: string | null;
    stoppedReason: string | null;
    currentStepIndex: number | null;
    nextFollowUpAt: string | null;
    followUpMode: string | null;
    modeReason: string | null;
  } | null;
  displayLabels?: {
    conversationState: string;
    aiStatus: string;
    lastClassifiedIntent: string;
    sfJobOutcome: string;
    followUp: string;
    handoff: string;
  };
}

export interface RuntimeSummaryResponse {
  tenantUserId: string;
  generatedAt: string;
  totals: { threadContexts: number; leadsSfLinked: number };
  byConversationState: Record<string, number> & { _null: number };
  byAiStatus: Record<string, number> & { _null: number };
  // Phase 2A — booking orchestration runtime. Counts will be zero on
  // first deploy because PR-A doesn't write any of these fields.
  byBookingState: Record<string, number> & { _null: number };
  byLastClassifiedIntent: Record<string, number>;
  sfJobOutcomeCounts: Record<string, number>;
  sfOutcomeCoverage: {
    populated: number;
    sfLinkedTotal: number;
    ratio: number | null;
  };
  mismatchCounts: {
    legacyTerminalRuntimeActive: number;
    runtimeTerminalLegacyActive: number;
  };
  waitingSinceCount: number;
  handoffOpen: number;
  staleWaiting: number;
  updatedLast24h: {
    conversationState: number;
    aiStatus: number;
    classifiedIntent: number;
    handoffRequested: number;
    sfJobOutcome: number;
  };
  // Phase 2B PR-B1 — orchestration observability. flagEnabledForTenant
  // and every counter is zero/false on first deploy because PR-B1 ships
  // no callers of SfOrchestrationClient.
  orchestrationFlag: {
    flagEnabledForTenant: boolean;
    enabledTenantCount: number;
  };
  orchestrationMetrics: {
    attempts: Record<string, number>;
    successes: Record<string, number>;
    failures: Record<string, number>;
    retries: Record<string, number>;
    failuresByCode: Record<string, number>;
    lastLatencyMs: Record<string, number | null>;
  };
}

export interface LegacyComparisonExample {
  leadId: string | null;
  platform: string | null;
  legacyStatus: string | null;
  conversationState?: string | null;
  conversationStateReason?: string | null;
  aiStatus?: string | null;
  aiStatusReason?: string | null;
  waitingSince?: string | null;
  handoffRequestedAt?: string | null;
  handoffResolvedAt?: string | null;
  lastCustomerMessageAt?: string | null;
  lastClassifiedAt?: string | null;
  // For Lead-shaped examples (sf_outcome_present_but_lead_status_not_sf_owned):
  statusSource?: string | null;
  sfJobOutcome?: string | null;
  sfJobOutcomeAt?: string | null;
  sfJobId?: string | null;
  sfLastEventAt?: string | null;
}

export interface LegacyComparisonCategory {
  description: string;
  count: number;
  examples: LegacyComparisonExample[];
}

export interface LegacyComparisonResponse {
  tenantUserId: string;
  generatedAt: string;
  examplesPerCategory: number;
  categories: Record<string, LegacyComparisonCategory>;
}

export const conversationRuntimeApi = {
  /** Per-lead runtime snapshot. `{success: false}` if not owned by caller. */
  getLeadRuntimeState: async (leadId: string): Promise<RuntimeStateResponse> => {
    const { data } = await api.get(`/v1/leads/${leadId}/runtime-state`);
    return data;
  },

  /** Tenant-wide counts. Snapshot at request time. */
  getSummary: async (): Promise<RuntimeSummaryResponse> => {
    const { data } = await api.get('/v1/conversation-runtime/summary');
    return data;
  },

  /** Legacy/runtime drift diagnostic. examplesPerCategory clamped 1..20. */
  getLegacyComparison: async (
    examplesPerCategory = 5,
  ): Promise<LegacyComparisonResponse> => {
    const { data } = await api.get('/v1/conversation-runtime/legacy-comparison', {
      params: { examplesPerCategory },
    });
    return data;
  },
};

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
  previewAiReply: async (ruleId: string, leadId: string): Promise<{ reply: string }> => {
    const { data } = await api.post(`/v1/automation/rules/${ruleId}/preview-ai`, { leadId });
    return data;
  },
};

// Update notification settings DTO
export interface UpdateNotificationSettingsDto {
  enabled?: boolean;
  destinationPhone?: string;
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
  saveApiKey: async (savedAccountId: string, apiKey: string): Promise<{ success: boolean; error?: string }> => {
    const { data } = await api.post(`/v1/notifications/sigcore/api-key/${savedAccountId}`, { apiKey });
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
  assignTenantPhone: async (tenantPhoneId: string, savedAccountId: string | null): Promise<{ success: boolean; tenantPhone?: TenantPhoneNumber; error?: string }> => {
    const { data } = await api.post(`/v1/notifications/tenant-phones/${tenantPhoneId}/assign`, { savedAccountId });
    return data;
  },
  restoreTenantPhone: async (tenantPhoneId: string): Promise<{ success: boolean; tenantPhone?: TenantPhoneNumber; error?: string }> => {
    const { data } = await api.post(`/v1/notifications/tenant-phones/${tenantPhoneId}/restore`);
    return data;
  },
  // Customer Texting
  getCustomerTextingSettings: async (savedAccountId: string): Promise<{ success: boolean; enabled: boolean; autoReplyTemplate: string }> => {
    const { data } = await api.get(`/v1/notifications/customer-texting/${savedAccountId}`);
    return data;
  },
  saveCustomerTextingSettings: async (savedAccountId: string, settings: { enabled: boolean; autoReplyTemplate: string }): Promise<{ success: boolean }> => {
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

  // When the last lead was synced (extension or webhook)
  lastLeadSyncAt?: string | null;

  // Service detail analytics
  cleaningTypeDistribution?: ServiceDetailDistribution[];
  addOnsDistribution?: ServiceDetailDistribution[];
  frequencyDistribution?: ServiceDetailDistribution[];
  locationDistribution?: ServiceDetailDistribution[];
  zipCodeDistribution?: ServiceDetailDistribution[];
  roomStats?: RoomStatsMetric;

  averageLeadPrice?: { value: number | null; count: number };
  averageJobPrice?: { value: number | null; count: number };

  dateRange: {
    start: string;
    end: string;
  };
  filters: {
    businessId?: string;
    businessName?: string;
  };
}

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

// Analytics API
export type AnalyticsPlatform = 'thumbtack' | 'yelp';

export const analyticsApi = {
  getBasicAnalytics: async (params: {
    businessId?: string;
    platform?: AnalyticsPlatform;
    startDate?: string;
    endDate?: string;
  }): Promise<{ success: boolean; data: Partial<AnalyticsData> }> => {
    const queryParams = new URLSearchParams();
    if (params.businessId) queryParams.append('businessId', params.businessId);
    if (params.platform) queryParams.append('platform', params.platform);
    if (params.startDate) queryParams.append('startDate', params.startDate);
    if (params.endDate) queryParams.append('endDate', params.endDate);

    const { data } = await api.get(`/v1/analytics/basic?${queryParams.toString()}`);
    return data;
  },

  getAnalytics: async (params: {
    businessId?: string;
    platform?: AnalyticsPlatform;
    startDate?: string;
    endDate?: string;
  }): Promise<{ success: boolean; data: AnalyticsData; calculatedAt: string | null }> => {
    const queryParams = new URLSearchParams();
    if (params.businessId) queryParams.append('businessId', params.businessId);
    if (params.platform) queryParams.append('platform', params.platform);
    if (params.startDate) queryParams.append('startDate', params.startDate);
    if (params.endDate) queryParams.append('endDate', params.endDate);

    const { data } = await api.get(`/v1/analytics?${queryParams.toString()}`);
    return data;
  },

  refreshAnalytics: async (params: {
    businessId?: string;
    platform?: AnalyticsPlatform;
  }): Promise<{ success: boolean; data: AnalyticsData; calculatedAt: string }> => {
    const queryParams = new URLSearchParams();
    if (params.businessId) queryParams.append('businessId', params.businessId);
    if (params.platform) queryParams.append('platform', params.platform);

    const { data } = await api.post(`/v1/analytics/refresh?${queryParams.toString()}`);
    return data;
  },

  getTimeSeries: async (params: {
    period?: 'day' | 'week' | 'month' | 'year';
    businessId?: string;
    platform?: AnalyticsPlatform;
    startDate?: string;
    endDate?: string;
  }): Promise<{ success: boolean; data: TimeSeriesPoint[] }> => {
    const queryParams = new URLSearchParams();
    if (params.period) queryParams.append('period', params.period);
    if (params.businessId) queryParams.append('businessId', params.businessId);
    if (params.platform) queryParams.append('platform', params.platform);
    if (params.startDate) queryParams.append('startDate', params.startDate);
    if (params.endDate) queryParams.append('endDate', params.endDate);

    const { data } = await api.get(`/v1/analytics/timeseries?${queryParams.toString()}`);
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
  getInvoices: async (): Promise<{ invoices: StripeInvoice[] }> => {
    const { data } = await api.get('/v1/stripe/invoices');
    return data.data;
  },
};

export interface StripeInvoice {
  id: string;
  number: string | null;
  status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void' | null;
  amountPaid: number;
  amountDue: number;
  total: number;
  currency: string;
  created: number;
  periodStart: number;
  periodEnd: number;
  hostedInvoiceUrl: string | null;
  invoicePdf: string | null;
  description: string | null;
}

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
  updateProfile: async (
    updates: {
      name?: string;
      businessPhone?: string;
      website?: string | null;
      websiteMetadata?: { title?: string; description?: string; phone?: string } | null;
    },
  ): Promise<{
    success: boolean;
    user: {
      id: string;
      name: string;
      email: string;
      businessPhone?: string | null;
      website?: string | null;
      websiteMetadataJson?: { title?: string; description?: string; phone?: string } | null;
    };
  }> => {
    const { data } = await api.patch('/v1/users/me', updates);
    return data;
  },
  // Onboarding wizard's Business step calls this before saving the URL.
  // The backend normalizes ("myco.com" → "https://myco.com"), runs an
  // SSRF guard, fetches with a timeout, and extracts <title> + meta
  // description + a likely phone number. If unreachable, returns a
  // typed errorCode so the UI can show a specific message.
  verifyWebsite: async (
    url: string,
  ): Promise<{
    reachable: boolean;
    normalizedUrl: string;
    metadata?: { title?: string; description?: string; phone?: string };
    errorCode?: 'invalid_url' | 'private_host' | 'dns_not_found' | 'connection_refused' | 'timeout' | 'http_error' | 'unreachable';
    errorMessage?: string;
  }> => {
    const { data } = await api.post('/v1/users/me/website/verify', { url });
    return data;
  },
  deleteOwnAccount: async (): Promise<{ success: boolean }> => {
    const { data } = await api.delete('/v1/users/me');
    return data;
  },
  getGlobalAiPrompt: async (): Promise<{ prompt: string; isDefault: boolean }> => {
    const { data } = await api.get('/v1/users/me/ai-prompt');
    return data;
  },
  updateGlobalAiPrompt: async (prompt: string): Promise<{ success: boolean }> => {
    const { data } = await api.patch('/v1/users/me/ai-prompt', { prompt });
    return data;
  },
  getServicePricing: async (accountId: string): Promise<{ success: boolean; pricing: any; inherited?: boolean; sourceAccountId?: string | null }> => {
    const { data } = await api.get(`/v1/users/me/pricing/${accountId}`);
    return data;
  },
  updateServicePricing: async (accountId: string, pricing: any): Promise<{ success: boolean }> => {
    const { data } = await api.patch(`/v1/users/me/pricing/${accountId}`, { pricing });
    return data;
  },
  copyServicePricingToAll: async (sourceAccountId: string): Promise<{ success: boolean; updated: number }> => {
    const { data } = await api.post(`/v1/users/me/pricing/${sourceAccountId}/copy-to-all`);
    return data;
  },
  getAccountFaq: async (accountId: string): Promise<{ success: boolean; faq: any; inherited?: boolean; sourceAccountId?: string | null }> => {
    const { data } = await api.get(`/v1/users/me/faq/${accountId}`);
    return data;
  },
  updateAccountFaq: async (accountId: string, faq: any): Promise<{ success: boolean }> => {
    const { data } = await api.patch(`/v1/users/me/faq/${accountId}`, { faq });
    return data;
  },
  copyAccountFaqToAll: async (sourceAccountId: string): Promise<{ success: boolean; updated: number }> => {
    const { data } = await api.post(`/v1/users/me/faq/${sourceAccountId}/copy-to-all`);
    return data;
  },
  parseChecklistFile: async (file: File): Promise<{ success: boolean; text: string; truncated: boolean; originalLength: number }> => {
    const form = new FormData();
    form.append('file', file);
    const { data } = await api.post('/v1/users/me/faq/parse-checklist', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data;
  },
  getBusinessHours: async (): Promise<{
    timezone: string;
    schedule: Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', { start: string; end: string } | null>;
  }> => {
    const { data } = await api.get('/v1/users/me/business-hours');
    return data;
  },
  updateBusinessHours: async (
    body: { timezone?: string; schedule?: Record<string, { start: string; end: string } | null> },
  ): Promise<{
    timezone: string;
    schedule: Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', { start: string; end: string } | null>;
  }> => {
    const { data } = await api.patch('/v1/users/me/business-hours', body);
    return data;
  },
  getQuietHours: async (): Promise<{ enabled: boolean; start: string; end: string; timezone: string }> => {
    const { data } = await api.get('/v1/users/me/quiet-hours');
    return data;
  },
  updateQuietHours: async (
    body: { enabled?: boolean; start?: string; end?: string; timezone?: string },
  ): Promise<{ enabled: boolean; start: string; end: string; timezone: string }> => {
    const { data } = await api.patch('/v1/users/me/quiet-hours', body);
    return data;
  },
  getAccountHours: async (
    accountId: string,
  ): Promise<{
    override: { start?: string; end?: string; timezone?: string; days?: string[] } | null;
    callDuringBusinessHours: boolean;
    firstMsgDuringBusinessHours: boolean;
    followUpsApplyQuietHours: boolean;
    aiConversationMode: 'always' | 'when_dispatcher_unavailable';
  }> => {
    const { data } = await api.get(`/v1/users/me/account-hours/${accountId}`);
    return data;
  },
  updateAccountHours: async (
    accountId: string,
    body: {
      override?: { start?: string; end?: string; timezone?: string; days?: string[] } | null;
      callDuringBusinessHours?: boolean;
      firstMsgDuringBusinessHours?: boolean;
      followUpsApplyQuietHours?: boolean;
      aiConversationMode?: 'always' | 'when_dispatcher_unavailable';
    },
  ): Promise<{
    override: any;
    callDuringBusinessHours: boolean;
    firstMsgDuringBusinessHours: boolean;
    followUpsApplyQuietHours: boolean;
    aiConversationMode: string;
  }> => {
    const { data } = await api.patch(`/v1/users/me/account-hours/${accountId}`, body);
    return data;
  },
};

// Teams API
export const teamsApi = {
  getMyOrg: async (): Promise<{ success: boolean; organization: any; myRole: string | null }> => {
    const { data } = await api.get('/v1/teams/my-org');
    return data;
  },
  createOrg: async (name: string): Promise<{ success: boolean; organization: any }> => {
    const { data } = await api.post('/v1/teams', { name });
    return data;
  },
  invite: async (email: string, role: 'ADMIN' | 'MEMBER' = 'MEMBER'): Promise<{ success: boolean; invitation: any; inviteLink: string }> => {
    const { data } = await api.post('/v1/teams/invite', { email, role });
    return data;
  },
  acceptInvite: async (token: string): Promise<{ success: boolean; organizationId: string; role: string }> => {
    const { data } = await api.post('/v1/teams/invite/accept', { token });
    return data;
  },
  removeMember: async (userId: string): Promise<{ success: boolean }> => {
    const { data } = await api.delete(`/v1/teams/members/${userId}`);
    return data;
  },
  updateRole: async (userId: string, role: 'ADMIN' | 'MEMBER'): Promise<{ success: boolean }> => {
    const { data } = await api.patch(`/v1/teams/members/${userId}/role`, { role });
    return data;
  },
  getInvitations: async (): Promise<{ success: boolean; invitations: any[] }> => {
    const { data } = await api.get('/v1/teams/invitations');
    return data;
  },
  revokeInvitation: async (id: string): Promise<{ success: boolean }> => {
    const { data } = await api.delete(`/v1/teams/invitations/${id}`);
    return data;
  },
  leaveOrg: async (): Promise<{ success: boolean }> => {
    const { data } = await api.post('/v1/teams/leave');
    return data;
  },
  deleteOrg: async (): Promise<{ success: boolean }> => {
    const { data } = await api.delete('/v1/teams');
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
  // Global admin config (test data, phone pricing, A2P messaging service)
  getAdminConfig: async (): Promise<{ id: string; testData: Record<string, string>; yelpTestData?: Record<string, string> }> => {
    const { data } = await api.get('/v1/admin/phone-pool/admin-config');
    return data.data;
  },
  updateAdminConfig: async (testData: Record<string, string>, yelpTestData?: Record<string, string>): Promise<{ id: string; testData: Record<string, string>; yelpTestData?: Record<string, string> }> => {
    const { data } = await api.patch('/v1/admin/phone-pool/admin-config', { testData, yelpTestData });
    return data.data;
  },
  // Phone Pricing
  getPhonePricing: async (): Promise<{ priceMonthly: number | null; gracePeriodDays: number; stripePriceId: string | null; messagingServiceSid: string | null }> => {
    const { data } = await api.get('/v1/admin/phone-pool/phone-pricing');
    return data.data;
  },
  updatePhonePricing: async (priceMonthly: number, gracePeriodDays: number): Promise<{ priceMonthly: number; gracePeriodDays: number; stripePriceId: string }> => {
    const { data } = await api.patch('/v1/admin/phone-pool/phone-pricing', { priceMonthly, gracePeriodDays });
    return data.data;
  },
  updateMessagingService: async (messagingServiceSid: string): Promise<{ messagingServiceSid: string; synced: boolean }> => {
    const { data } = await api.patch('/v1/admin/phone-pool/messaging-service', { messagingServiceSid });
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
  getTenantNumbers: async (params?: {
    search?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    phones: any[];
    total: number;
    offset: number;
    limit: number;
  }> => {
    const qp = new URLSearchParams();
    if (params?.search) qp.append('search', params.search);
    if (params?.status) qp.append('status', params.status);
    if (params?.limit !== undefined) qp.append('limit', params.limit.toString());
    if (params?.offset !== undefined) qp.append('offset', params.offset.toString());
    const { data } = await api.get(`/v1/admin/tenant-numbers?${qp.toString()}`);
    return data.data;
  },
  reassignTenantPhone: async (tenantPhoneId: string, userId: string): Promise<any> => {
    const { data } = await api.patch(`/v1/admin/phone-pool/tenant/${tenantPhoneId}/reassign`, { userId });
    return data.data;
  },
};

// SupportGrant — admins issue grants to themselves so they can access guarded
// admin endpoints. Backend route: POST /v1/me/support-grants. Required scope is
// per-endpoint (e.g. 'user:list', 'phones:read', 'notifications:read').
export interface SupportGrantResponse {
  id: string;
  tenantId: string;
  scopes: string[];
  reason: string;
  expiresAt: string;
  createdAt: string;
}
export const supportGrantsApi = {
  createSelf: async (input: {
    tenantId: string;
    scopes: string[];
    reason: string;
    durationMinutes?: number;
  }): Promise<SupportGrantResponse> => {
    const { data } = await api.post('/v1/me/support-grants', input);
    return data.grant;
  },
};

// Monitoring / Error Log
export const monitoringApi = {
  getErrors: async (params?: { limit?: number; onlyUnresolved?: boolean; category?: string }) => {
    const { data } = await api.get('/v1/monitoring/errors', { params });
    return data.errors as {
      id: string;
      category: string;
      severity: string;
      message: string;
      context: string | null;
      userId: string | null;
      accountName: string | null;
      resolved: boolean;
      createdAt: string;
    }[];
  },
  getSummary: async () => {
    const { data } = await api.get('/v1/monitoring/errors/summary');
    return data as {
      totalUnresolved: number;
      byCategory: Record<string, number>;
      last24h: number;
    };
  },
  resolveError: async (id: string) => {
    await api.patch(`/v1/monitoring/errors/${id}/resolve`);
  },
  resolveAll: async (category: string) => {
    const { data } = await api.patch(`/v1/monitoring/errors/resolve-all/${category}`);
    return data as { success: boolean; resolved: number };
  },
  getSystemHealth: async () => {
    const { data } = await api.get('/v1/monitoring/system-health');
    return data as {
      healthy: boolean;
      status: 'healthy' | 'warning' | 'critical';
      lastCheckedAt: string | null;
      summary: { critical: number; warning: number };
      issues: {
        accountId: string;
        accountName: string;
        platform: string;
        issueCode: string;
        status: 'warning' | 'critical';
        message: string;
        firstDetectedAt: string;
        lastDetectedAt: string;
      }[];
    };
  },
  runHealthCheck: async () => {
    const { data } = await api.post('/v1/monitoring/system-health/run');
    return data;
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
      leadDate: string | null;
      imported: boolean;
      importedAt: string | null;
      needsRefetch: boolean;
      lastActivityAt: string | null;
    }>;
    total: number;
    accounts?: Array<{ id: string; businessName: string; emailHint: string | null }>;
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
  resetImported: async (thumbtackIds?: string[]): Promise<{ ok: boolean; resetCount: number }> => {
    const { data } = await api.patch('/integrations/thumbtack/leads/reset-imported', { thumbtackIds });
    return data;
  },
  reimportLeads: async (savedAccountId?: string): Promise<{ ok: boolean; total: number; imported: number; failed: number; errors: string[] }> => {
    const { data } = await api.post('/integrations/thumbtack/leads/reimport', { savedAccountId });
    return data;
  },
  reimportFailed: async (savedAccountId?: string): Promise<{ ok: boolean; missingCount: number; total: number; imported: number; failed: number; errors: string[] }> => {
    const { data } = await api.post('/integrations/thumbtack/leads/reimport-failed', { savedAccountId });
    return data;
  },
  getMissingCount: async (accountId?: string): Promise<{ ok: boolean; missingCount: number; total: number }> => {
    const query = accountId ? `?accountId=${accountId}` : '';
    const { data } = await api.get(`/integrations/thumbtack/leads/missing-count${query}`);
    return data;
  },
  getNeedsScrape: async (accountId?: string): Promise<{ ok: boolean; count: number; thumbtackIds: string[] }> => {
    const query = accountId ? `?accountId=${accountId}` : '';
    const { data } = await api.get(`/integrations/thumbtack/leads/needs-scrape${query}`);
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
  deleteCollectedLeads: async (thumbtackIds?: string[], savedAccountId?: string): Promise<{ ok: boolean; deletedCount: number }> => {
    const { data } = await api.delete('/integrations/thumbtack/leads', {
      data: {
        ...(thumbtackIds?.length ? { thumbtackIds } : {}),
        ...(savedAccountId ? { savedAccountId } : {}),
      },
    });
    return data;
  },
  deleteBudgetSnapshots: async (): Promise<{ ok: boolean; deletedCount: number }> => {
    const { data } = await api.delete('/integrations/thumbtack/snapshots');
    return data;
  },
  // Persist a budget snapshot. Used for both Thumbtack (weekly, via Chrome ext)
  // and Yelp (monthly, manually entered, per calendar month).
  // For Yelp, pass cadence:'monthly' which routes through snapshotType='budget_monthly'.
  // Optional periodMonth ('YYYY-MM') tags the snapshot to a specific calendar month
  // so each month gets its own independent history.
  saveBudgetSnapshot: async (params: {
    savedAccountId: string;
    provider: 'thumbtack' | 'yelp';
    amount: number;
    cadence: 'weekly' | 'monthly';
    periodMonth?: string;
    currency?: string;
  }): Promise<{ ok: boolean; snapshotId: string }> => {
    const { data } = await api.post('/integrations/thumbtack/snapshots/budget', {
      savedAccountId: params.savedAccountId,
      provider: params.provider,
      snapshotType: params.cadence === 'monthly' ? 'budget_monthly' : 'budget',
      capturedAt: new Date().toISOString(),
      source: 'manual',
      budget: { weekly: params.amount, currency: params.currency || 'USD' },
      ...(params.periodMonth ? { scope: { period: params.periodMonth } } : {}),
    });
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
};

// Conversation Sync API (Isolated BYO Phone for AI)
export const conversationSyncApi = {
  getStatus: async (savedAccountId: string): Promise<{
    connected: boolean;
    status: string;
    provider: string | null;
    connectedNumbers: Array<{ id: string; phoneNumber: string; name?: string }>;
    lastError: string | null;
  }> => {
    const { data } = await api.get(`/v1/conversation-sync/status/${savedAccountId}`);
    return data;
  },

  connect: async (
    savedAccountId: string,
    apiKey: string,
  ): Promise<{ success: boolean; phoneNumbers?: Array<{ id: string; phoneNumber: string; name?: string }>; error?: string }> => {
    const { data } = await api.post(`/v1/conversation-sync/connect/${savedAccountId}`, { apiKey });
    return data;
  },

  disconnect: async (savedAccountId: string): Promise<{ success: boolean; error?: string }> => {
    const { data } = await api.delete(`/v1/conversation-sync/disconnect/${savedAccountId}`);
    return data;
  },

  syncOpenPhone: async (
    savedAccountId: string,
  ): Promise<{ success: boolean; error?: string }> => {
    const { data } = await api.post(`/v1/conversation-sync/sync-openphone/${savedAccountId}`);
    return data;
  },

  getSyncStatus: async (
    savedAccountId: string,
  ): Promise<{ status: string; progress?: number; total?: number; error?: string }> => {
    const { data } = await api.get(`/v1/conversation-sync/sync-status/${savedAccountId}`);
    return data;
  },

  matchLeads: async (
    savedAccountId: string,
  ): Promise<{ success: boolean; synced: number; totalConversations: number; totalLeads: number; error?: string }> => {
    const { data } = await api.post(`/v1/conversation-sync/match-leads/${savedAccountId}`);
    return data;
  },

  getLeadActivity: async (leadId: string): Promise<{ data: any[] }> => {
    const { data } = await api.get(`/v1/conversation-sync/lead/${leadId}/activity`);
    return data;
  },
};

// Follow-Up Engine
export const followUpApi = {
  getSuggestions: async (): Promise<{ success: boolean; count: number; suggestions: any[] }> => {
    const { data } = await api.get('/v1/follow-ups/suggestions');
    return data;
  },
  approveSuggestion: async (id: string): Promise<{ success: boolean; messageId?: string; error?: string }> => {
    const { data } = await api.post(`/v1/follow-ups/suggestions/${id}/approve`);
    return data;
  },
  editAndApprove: async (id: string, message: string): Promise<{ success: boolean; messageId?: string; error?: string }> => {
    const { data } = await api.post(`/v1/follow-ups/suggestions/${id}/edit`, { message });
    return data;
  },
  skipSuggestion: async (id: string): Promise<{ success: boolean; error?: string }> => {
    const { data } = await api.post(`/v1/follow-ups/suggestions/${id}/skip`);
    return data;
  },
  getEnrollments: async (status?: string): Promise<{ success: boolean; count: number; enrollments: any[] }> => {
    const { data } = await api.get('/v1/follow-ups/enrollments', { params: status ? { status } : {} });
    return data;
  },
  getEnrollmentInfo: async (conversationId: string): Promise<{ success: boolean; enrollment: any }> => {
    const { data } = await api.get(`/v1/follow-ups/enrollment-info/${conversationId}`);
    return data;
  },
  generatePreview: async (conversationId: string): Promise<{ success: boolean; message?: string; strategyUsed?: string; error?: string }> => {
    const { data } = await api.post(`/v1/follow-ups/enrollment-info/${conversationId}/preview`);
    return data;
  },
  restartFollowUp: async (conversationId: string): Promise<{ success: boolean; enrollmentId?: string; error?: string }> => {
    const { data } = await api.post(`/v1/follow-ups/restart/${conversationId}`);
    return data;
  },
  stopEnrollment: async (id: string, reason?: string): Promise<{ success: boolean }> => {
    const { data } = await api.post(`/v1/follow-ups/enrollments/${id}/stop`, { reason });
    return data;
  },
  pauseEnrollment: async (id: string): Promise<{ success: boolean }> => {
    const { data } = await api.post(`/v1/follow-ups/enrollments/${id}/pause`);
    return data;
  },
  seed: async (params: { savedAccountId?: string; platform?: string; activeHoursStart?: string; activeHoursEnd?: string; activeHoursTimezone?: string }): Promise<{ success: boolean; seeded: number }> => {
    const { data } = await api.post('/v1/follow-ups/seed', params);
    return data;
  },
  getSettings: async (savedAccountId: string): Promise<{
    success: boolean;
    settings?: {
      followUpMode: string | null;
      followUpPreset: string | null;
      followUpReplyType: string | null;
      followUpActiveHoursStart: string | null;
      followUpActiveHoursEnd: string | null;
      followUpTimezone: string | null;
    };
  }> => {
    const { data } = await api.get(`/v1/follow-ups/settings/${savedAccountId}`);
    return data;
  },
  saveSettings: async (savedAccountId: string, settings: {
    mode: string;
    preset: string;
    replyType: string;
    activeHoursStart: string;
    activeHoursEnd: string;
    timezone: string;
    platform?: string;
  }): Promise<{ success: boolean; seeded: number }> => {
    const { data } = await api.post(`/v1/follow-ups/settings/${savedAccountId}`, settings);
    return data;
  },
  // Wizard-flavored save that accepts the broader set of keys the
  // backend already merges into followUpSettingsJson (mode + AI stop
  // flags + handoff triggers + re-engagement). The narrowly-typed
  // saveSettings above keeps the existing Services UI honest; this one
  // is opt-in for the onboarding wizard so we don't have to widen the
  // existing call sites.
  saveWizardSettings: async (
    savedAccountId: string,
    settings: Record<string, unknown>,
  ): Promise<{ success: boolean; seeded?: number }> => {
    const { data } = await api.post(`/v1/follow-ups/settings/${savedAccountId}`, settings);
    return data;
  },
};

export const onboardingApi = {
  getProfile: async (): Promise<{ success: boolean; profile: import('../types').OnboardingProfile | null }> => {
    const { data } = await api.get('/v1/onboarding/profile');
    return data;
  },
  saveStep1: async (input: {
    primaryLeadSource: string;
    secondaryLeadSources?: string[];
    weeklyLeadVolume: string;
    serviceType: string;
    serviceTypeOther?: string;
  }): Promise<{ success: boolean; profile: import('../types').OnboardingProfile }> => {
    const { data } = await api.post('/v1/onboarding/step1', input);
    return data;
  },
  saveStep2: async (input: {
    responseSpeed?: string;
    missedLeadOutcome?: string;
    avgJobValue?: string;
    userGoal?: string;
  }): Promise<{ success: boolean; profile: import('../types').OnboardingProfile }> => {
    const { data } = await api.post('/v1/onboarding/step2', input);
    return data;
  },
  skipStep2: async (): Promise<{ success: boolean; profile: import('../types').OnboardingProfile }> => {
    const { data } = await api.post('/v1/onboarding/step2/skip');
    return data;
  },
  skipStep1: async (): Promise<{ success: boolean; profile: import('../types').OnboardingProfile }> => {
    const { data } = await api.post('/v1/onboarding/step1/skip');
    return data;
  },
  // 8-step guided setup wizard. The /profile endpoint returns the full
  // OnboardingProfile (wizard fields included); patchWizard is the only
  // mutation — advance the current step, mark one step done/skipped, and
  // optionally flag the wizard complete in one round trip.
  patchWizard: async (input: {
    currentStep?: import('../types').WizardStep;
    markStep?: { step: import('../types').WizardStep; status: import('../types').WizardStatus };
    completed?: boolean;
    reset?: boolean;
  }): Promise<{ success: boolean; profile: import('../types').OnboardingProfile }> => {
    const { data } = await api.patch('/v1/onboarding/wizard', input);
    return data;
  },
};

export default api;
