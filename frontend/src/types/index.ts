export interface User {
  id: string;
  email: string;
  name: string | null;
  role: 'USER' | 'ADMIN';
  subscriptionTier?: 'STARTER' | 'PRO' | 'ENTERPRISE';
  subscriptionStatus?: 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'TRIALING' | 'INCOMPLETE';
  subscriptionPeriodEnd?: string;
  hasOwnNumber?: boolean;
  phoneNumber?: string | null;
  businessPhone?: string | null;
  trialStartDate?: string;
  trialEndDate?: string;
  trialUsed?: boolean;
}

export interface AuthResponse {
  user: User;
  token: string;
}

export interface Lead {
  id: string;
  platform: string;
  businessId?: string; // Platform's business ID (for multi-account filtering)
  externalRequestId: string;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  message: string;
  budget?: number;
  postcode?: string;
  city?: string;
  state?: string;
  category?: string;
  status: string;
  threadId: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string; // Timestamp of last message in conversation
  raw?: any;
}

export interface Business {
  businessID: string;
  name: string;
  imageURL?: string;
  ownedByOtherUser?: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  platform: string;
  externalMessageId: string;
  sender: 'customer' | 'pro' | 'system';
  content: string;
  isRead: boolean;
  sentAt: string;
  deliveredAt?: string;
  notificationLogId?: string;
}

export interface CustomerTextingSettings {
  enabled: boolean;
  autoReplyTemplate: string;
}

export interface Platform {
  platformName: string;
  connected: boolean;
  expiresAt?: string;
}

export interface SavedAccount {
  id: string;
  platform: string;
  businessId: string;
  businessName: string;
  emailHint?: string;
  imageUrl?: string;
  webhookId?: string | null; // Webhook subscription ID (null = disconnected)
  lastUsedAt: string;
  createdAt: string;
}

export interface AccountDiagnostics {
  healthy: boolean;
  issues: string[];
  notificationIssues: string[];
  platform: {
    connected: boolean;
  };
  account: {
    hasWebhook: boolean;
  };
  notifications: {
    settingsExist: boolean;
    hasSigcoreApiKey: boolean;
    newLeadRules: number;
    customerReplyRules: number;
    rules: { name: string }[];
  };
  automation: {
    totalRules: number;
  };
  recentLogs: {
    ruleName: string | null;
    status: string;
    error: string | null;
  }[];
}

// Message Templates for bulk follow-up messages
export interface MessageTemplate {
  id: string;
  name: string;
  content: string;
  isDefault: boolean;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface BulkMessagePreview {
  leadId: string;
  customerName: string;
  personalizedMessage: string;
  canSend: boolean;
  error?: string;
}

export interface BulkSendResult {
  total: number;
  successful: number;
  failed: number;
  results: { leadId: string; success: boolean; error?: string }[];
}

// Automation Rules
export interface AutomationRule {
  id: string;
  savedAccountId: string;
  name: string;
  triggerType: 'new_lead' | 'customer_reply';
  replyTriggerMode?: 'first_only' | 'every_reply';
  templateId: string;
  delayMinutes: number;
  enabled: boolean;
  triggerCount: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  savedAccount?: {
    id: string;
    businessId: string;
    businessName: string;
  };
  template?: {
    id: string;
    name: string;
    content: string;
  };
}

export interface PendingAutomatedMessage {
  id: string;
  scheduledFor: string;
  status: 'pending' | 'sent' | 'cancelled' | 'failed';
  failureReason?: string;
  sentAt?: string | null;
  lead?: {
    customerName: string;
    category?: string;
  };
}

// SMS Notification Settings (Sigcore Integration)
export interface NotificationSettings {
  id: string;
  savedAccountId: string;
  enabled: boolean;
  destinationPhone: string | null;
  sigcoreApiKey: string | null; // Masked in response
  sigcoreFromPhone: string | null;
  sigcoreWorkspaceId: string | null;
  sigcoreConnected: boolean;
  sigcoreProvisioned: boolean;
  template: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursTimezone: string | null;
  requirePhone: boolean;
  createdAt: string;
  updatedAt: string;
}

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

export interface AvailablePhoneNumber {
  phoneNumber: string;
  locality?: string;
  region?: string;
  country?: string;
  capabilities?: string[];
  totalMonthlyPrice?: number;
  setupFee?: number;
}

export interface NotificationLog {
  id: string;
  leadId: string | null;
  notificationRuleId: string | null;
  ruleName: string | null;
  toPhone: string;
  fromPhone: string | null;
  provider: string | null;
  status: 'pending' | 'queued' | 'sent' | 'delivered' | 'failed';
  error: string | null;
  messageBody: string;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
}

// SMS Notification Rules
export interface NotificationRule {
  id: string;
  notificationSettingsId: string;
  name: string;
  triggerType: 'new_lead' | 'customer_reply';
  replyTriggerMode?: 'first_only' | 'every_reply' | null;
  fromPhone: string | null;  // Sigcore phone to send FROM
  toPhone: string | null;    // Destination phone to send TO
  sendToCustomer?: boolean;  // If true, send to lead's phone instead of toPhone
  template: string;
  templateId?: string | null;
  delayMinutes?: number;
  stopOnCustomerReply?: boolean;
  stopOnLeadClosed?: boolean;
  stopOnOptOut?: boolean;
  messageTemplate?: { id: string; name: string; content: string } | null;
  enabled: boolean;
  triggerCount: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Last SMS delivery status
  lastSmsStatus: string | null;
  lastSmsError: string | null;
  lastSmsAt: string | null;
  // Account info (included when fetching all rules)
  savedAccountId?: string;
  savedAccount?: {
    id: string;
    businessId: string;
    businessName: string;
  };
}

// Billing & Subscription Types
export interface SubscriptionDetails {
  tier: 'STARTER' | 'PRO' | 'ENTERPRISE' | null;
  status: 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'TRIALING' | 'INCOMPLETE' | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasOwnNumber: boolean;
  features: string[];
  trial: {
    isOnTrial: boolean;
    trialDaysRemaining: number;
    trialExpired: boolean;
    trialExpiredByTime: boolean;
    trialExpiredByUsage: boolean;
    trialEndDate: string | null;
    trialLeadsHandled: number;
    trialLeadsLimit: number;
    trialLeadsRemaining: number;
  };
}

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: 'USER' | 'ADMIN';
  subscriptionTier: 'STARTER' | 'PRO' | 'ENTERPRISE' | null;
  subscriptionStatus: 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'TRIALING' | 'INCOMPLETE' | null;
  subscriptionPeriodEnd: string | null;
  stripeSubscriptionId: string | null;
  hasOwnNumber: boolean;
  trialLeadsHandled: number;
  trialLeadsLimit: number;
  trialEndDate: string | null;
  leadsCount: number;
  connectedAccounts: { id: string; businessName: string; platform: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface AdminUserDetails extends AdminUser {
  leadsCount: number;
  conversationsCount: number;
  subscriptionHistory: {
    id: string;
    tier: 'STARTER' | 'PRO' | 'ENTERPRISE';
    status: 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'TRIALING' | 'INCOMPLETE';
    eventType: string;
    createdAt: string;
  }[];
}

export interface AdminStats {
  totalUsers: number;
  activeSubscriptions: number;
  monthlyRevenue: number;
  churnRate: number;
  totalConnectedAccounts: number;
  usersByTier: {
    tier: 'STARTER' | 'PRO' | 'ENTERPRISE';
    count: number;
  }[];
}

export interface AdminLog {
  id: string;
  action: string;
  targetUserId: string | null;
  details: any;
  createdAt: string;
  admin: {
    id: string;
    email: string;
    name: string | null;
  };
}

// Phone Pool (Admin)
export interface PhonePoolAssignment {
  id: string;
  phonePoolId: string;
  userId: string;
  assignedAt: string;
  user: {
    id: string;
    email: string;
    name: string | null;
  };
}

export interface PhonePoolEntry {
  id: string;
  phoneNumber: string;
  provider: string;
  areaCode: string | null;
  state: string | null;
  friendlyName: string | null;
  sigcoreAllocationId: string | null;
  status: 'AVAILABLE' | 'ASSIGNED' | 'RESERVED' | 'RELEASED';
  smsApproved: boolean;
  smsCapable: boolean;
  voiceCapable: boolean;
  assignments?: PhonePoolAssignment[];
  provisionedAt: string;
  createdAt: string;
}

export interface PhonePoolStats {
  total: number;
  available: number;
  assigned: number;
  reserved: number;
  byAreaCode: { areaCode: string; count: number }[];
}

// Unified Timeline (Messages page)
export type TimelineChannel = 'platform' | 'sms' | 'call' | 'automation';

export interface TimelineEvent {
  id: string;
  channel: TimelineChannel;
  direction: 'outbound' | 'inbound';
  content: string;
  timestamp: Date;
  sender?: 'pro' | 'customer' | 'system';
  externalId?: string;
  attachments?: { url: string; mimeType?: string; fileName?: string }[];
  smsStatus?: 'pending' | 'queued' | 'sent' | 'delivered' | 'failed';
  smsError?: string | null;
  toPhone?: string;
  fromPhone?: string | null;
  ruleName?: string | null;
  deliveredAt?: string | null;
}

export interface CommunicationSummary {
  platformMessages: number;
  smsSent: number;
  smsDelivered: number;
  smsFailed: number;
  calls: number;
}

// ─── Instant Call Connect ────────────────────────────────────────────────────

export type CallConnectMode = 'AGENT_FIRST' | 'PARALLEL';
export type AgentStrategy = 'owner' | 'round_robin' | 'on_duty';

export type CallConnectStatus =
  | 'CREATED'
  | 'CALLING_AGENT'
  | 'AGENT_ANSWERED'
  | 'AGENT_ACCEPTED'
  | 'CALLING_LEAD'
  | 'BRIDGED'
  | 'VOICEMAIL_DROP'
  | 'ENDED'
  | 'FAILED'
  | 'CANCELED'
  // legacy values
  | 'RINGING_AGENT'
  | 'RINGING_LEAD'
  | 'CANCELLED';

export interface CallConnectSettings {
  id: string;
  savedAccountId: string;
  enabled: boolean;
  mode: CallConnectMode;
  agentStrategy: AgentStrategy;
  agentPhoneE164: string | null;
  botNumberE164: string | null;
  maxAgentAttempts: number;
  quietHoursEnabled: boolean;
  quietHoursTimezone: string | null;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  agentAcceptDigits: string | null;
  agentWhisperMessage: string | null;
  leadGreetingMessage: string | null;
  leadVoicemailEnabled: boolean;
  leadVoicemailMessage: string | null;
  leadVoicemailRecordingUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CallConnectTimelineEntry {
  event: string;
  timestamp: string;
  data: Record<string, any>;
}

export interface LeadCallConnect {
  id: string;
  leadId: string;
  businessId: string | null;
  sigcoreSessionId: string;
  status: CallConnectStatus;
  attempt: number;
  lastEventAt: string;
  failureReason: string | null;
  recordingUrl: string | null;
  timeline: CallConnectTimelineEntry[];
  createdAt: string;
  updatedAt: string;
}
