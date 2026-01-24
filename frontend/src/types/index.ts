export interface User {
  id: string;
  email: string;
  name: string | null;
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
}

export interface Message {
  id: string;
  conversationId: string;
  platform: string;
  externalMessageId: string;
  sender: 'customer' | 'pro';
  content: string;
  isRead: boolean;
  sentAt: string;
  deliveredAt?: string;
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

// SMS Notification Settings (Callio Integration)
export interface NotificationSettings {
  id: string;
  savedAccountId: string;
  enabled: boolean;
  destinationPhone: string | null;
  senderMode: 'shared' | 'dedicated' | 'openphone';
  callioApiKey: string | null; // Masked in response
  callioFromPhone: string | null;
  callioWorkspaceId: string | null;
  callioConnected: boolean;
  template: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursTimezone: string | null;
  requirePhone: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CallioPhoneNumber {
  id: string;
  phoneNumber: string;
  provider: 'twilio' | 'openphone';
  friendlyName?: string;
  capabilities?: string[];
}

export interface NotificationLog {
  id: string;
  leadId: string | null;
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
