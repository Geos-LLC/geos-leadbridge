/**
 * Normalized Data Transfer Objects
 * These are the unified formats that all platform adapters convert to
 */

import { IsString, IsOptional, IsNumber, IsDate, IsEnum, IsBoolean } from 'class-validator';

// LeadStatus enum removed 2026-06-08 — was stale (only 5 of the 10 canonical
// values, included pre-simplification `contacted`) and had zero call sites.
// Canonical statuses live in src/leads/canonical-status.ts; see also
// src/integrations/{thumbtack,yelp,service-flow/sf}-status-map.ts.

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

  // Human-readable business/account name, joined from SavedAccount.businessName.
  // Populated by LeadsService.enrichLeadsWithAccountInfo for list endpoints —
  // not stored on Lead and absent on cache-only paths. Stable sync key is
  // businessId; this is for display only.
  @IsOptional()
  @IsString()
  businessName?: string;

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

  // Raw platform-side billing state. Thumbtack exposes this on every
  // negotiation as `chargeState` with values 'Charged' | 'Pending' |
  // 'Refunded'. The scheduler's send-time 404 enrichment path reads this
  // to decide whether a vanished thread is a refund (mark Lead.refundedAt
  // + budgetVoidedAt) vs an unrelated removal. Yelp doesn't expose this
  // (subscription billing model), so the field is undefined for Yelp.
  @IsOptional()
  @IsString()
  platformChargeState?: string;

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

  // True when the only outbound activity on the conversation has been AI sends
  // (senderType='ai') with no human send and no customer reply. Drives the
  // "Hide auto-handled" sidebar filter so the inbox surfaces leads that need
  // human attention (new leads, customer-responded leads, human-touched leads).
  isAutoHandled?: boolean;

  // Lead activity badge — derived at query time from
  // ThreadContext.conversationState + Lead.status. See
  // src/conversation-context/activity-bucket.ts for the mapping.
  // Null when Lead.status is terminal (booked/completed/lost/cancelled/...) —
  // no secondary badge in those cases.
  //
  // 'engagement'      first contact / no customer reply yet
  // 'ai_conversation' AI is actively replying
  // 'follow_up'       waiting for the customer; sequence active
  // 'human_handoff'   customer waiting on a human (visually urgent in UI)
  activityBucket?: 'engagement' | 'ai_conversation' | 'follow_up' | 'human_handoff' | null;

  // SF-connected mode signals. Derived (`isSfLinked`) computed via
  // `isSfLinkedLead` so the API contract uses the same predicate as the
  // status-write guards in LeadStatusService — single source of truth, no
  // chance for the UI to diverge from server-side rules.
  isSfLinked?: boolean;
  sfJobId?: string | null;
  sfCustomerId?: string | null;
  syncStatus?: string | null;
  sfJobOutcome?: string | null;
  sfJobOutcomeAt?: Date | null;
  // SF Lead identity (PR B 2026-06-04). Populated when SF's historical
  // reconciliation found a matching SF Lead record but no SF Customer/Job
  // yet (syncStatus='lead_linked'). Exposed for UI badge rendering only;
  // does NOT affect isSfLinked (lead-only matches behave like LB-only
  // operationally per the 2026-06-04 architecture lock-in).
  sfLeadId?: string | null;
  sfLeadStageName?: string | null;
  sfLeadMatchedAt?: Date | null;

  // Refund / billing state. refundedAt drives the "Refunded" badge on
  // Messages page lead cards + the new 'refunded' filter option in the
  // status dropdown. chargeStateRaw carries the raw platform value
  // ('Refunded' | 'Charged' | 'Pending' | 'Gone' = TT API returned 404).
  // Yelp leaves these undefined — no per-lead refund concept.
  refundedAt?: Date | null;
  chargeStateRaw?: string | null;
  budgetVoidedAt?: Date | null;

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
