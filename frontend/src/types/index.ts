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
