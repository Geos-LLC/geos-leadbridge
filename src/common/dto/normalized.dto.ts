/**
 * Normalized Data Transfer Objects
 * These are the unified formats that all platform adapters convert to
 */

import { IsString, IsOptional, IsNumber, IsDate, IsEnum, IsBoolean } from 'class-validator';

// ==========================================
// Lead Status Enum
// ==========================================

export enum LeadStatus {
  NEW = 'new',
  CONTACTED = 'contacted',
  QUOTED = 'quoted',
  BOOKED = 'booked',
  LOST = 'lost',
}

// ==========================================
// Normalized Lead
// ==========================================

export class NormalizedLead {
  @IsString()
  id: string; // Internal ID

  @IsString()
  platform: string; // "thumbtack" | "yelp" | etc.

  @IsOptional()
  @IsString()
  businessId?: string; // Platform's business ID (for multi-account filtering)

  @IsString()
  externalRequestId: string; // Platform's request/lead ID

  @IsString()
  customerName: string;

  @IsOptional()
  @IsString()
  customerPhone?: string;

  @IsOptional()
  @IsString()
  customerEmail?: string;

  @IsString()
  message: string;

  @IsOptional()
  @IsNumber()
  budget?: number;

  @IsOptional()
  @IsString()
  postcode?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  category?: string; // Service category

  @IsString()
  status: string; // Raw status from platform (e.g., "Open", "Canceled", "Picked" for Thumbtack)

  @IsOptional()
  @IsString()
  thumbtackStatus?: string; // Platform job status (Hired, Scheduled, Done, etc.)

  @IsOptional()
  @IsString()
  threadId?: string; // Universal conversation ID

  @IsDate()
  createdAt: Date;

  @IsDate()
  updatedAt: Date;

  @IsOptional()
  @IsDate()
  lastMessageAt?: Date; // Timestamp of last message in conversation

  // Most recent message on the lead's conversation. Used by the Messages
  // sidebar so the preview shows the latest reply instead of the original
  // lead body. Optional — leads created before any conversation activity
  // (or with no linked thread) will be undefined.
  lastMessage?: {
    content: string;
    sender: string; // 'pro' | 'customer' | 'system'
    sentAt: Date;
  };

  raw?: any; // Original platform payload for debugging
}

// ==========================================
// Normalized Conversation
// ==========================================

export enum ConversationStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
  CLOSED = 'closed',
}

export class NormalizedConversation {
  @IsString()
  id: string; // Internal ID

  @IsString()
  platform: string;

  @IsString()
  externalThreadId: string; // Platform's thread/conversation ID

  @IsString()
  customerName: string;

  @IsDate()
  lastMessageAt: Date;

  @IsNumber()
  unreadCount: number;

  @IsEnum(ConversationStatus)
  status: ConversationStatus;

  @IsDate()
  createdAt: Date;

  metadata?: Record<string, any>;
}

// ==========================================
// Normalized Message
// ==========================================

export enum MessageSender {
  PRO = 'pro',
  CUSTOMER = 'customer',
  SYSTEM = 'system',
}

export interface MessageAttachment {
  url: string;
  mimeType?: string;
  fileName?: string;
}

export class NormalizedMessage {
  @IsString()
  id: string; // Internal ID

  @IsString()
  conversationId: string;

  @IsString()
  platform: string;

  @IsOptional()
  @IsString()
  externalMessageId?: string; // Platform's message ID

  @IsEnum(MessageSender)
  sender: MessageSender;

  @IsString()
  content: string;

  @IsOptional()
  attachments?: MessageAttachment[]; // Image/file attachments

  @IsBoolean()
  isRead: boolean;

  @IsDate()
  sentAt: Date;

  @IsOptional()
  @IsDate()
  deliveredAt?: Date;

  raw?: any;
}

// ==========================================
// Normalized Quote
// ==========================================

export enum QuoteStatus {
  PENDING = 'pending',
  ACCEPTED = 'accepted',
  REJECTED = 'rejected',
  EXPIRED = 'expired',
}

export class NormalizedQuote {
  @IsString()
  id: string;

  @IsString()
  platform: string;

  @IsOptional()
  @IsString()
  externalQuoteId?: string;

  @IsOptional()
  @IsString()
  leadId?: string;

  @IsNumber()
  amount: number;

  @IsString()
  currency: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(QuoteStatus)
  status: QuoteStatus;

  @IsOptional()
  @IsDate()
  validUntil?: Date;

  @IsDate()
  createdAt: Date;

  @IsDate()
  updatedAt: Date;

  raw?: any;
}
