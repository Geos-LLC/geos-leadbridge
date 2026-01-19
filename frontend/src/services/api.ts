import axios, { AxiosError } from 'axios';
import type { AuthResponse, Lead, Business, Platform, SavedAccount } from '../types';
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

  // Token/Auth errors
  if (errorMessage?.toLowerCase().includes('token') ||
      errorMessage?.toLowerCase().includes('expired') ||
      errorMessage?.toLowerCase().includes('refresh')) {
    return {
      title: 'Authentication Error',
      message: 'Your session may have expired. Please reconnect your Thumbtack account.',
    };
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
    return data;
  },
  login: async (email: string, password: string): Promise<AuthResponse> => {
    const { data } = await api.post('/auth/login', { email, password });
    return data;
  },
  getProfile: async () => {
    const { data } = await api.get('/auth/profile');
    return data;
  },
};

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
  getAuthUrl: async (): Promise<{ authUrl: string }> => {
    const { data } = await api.get('/v1/thumbtack/auth/url');
    return data;
  },
  disconnect: async (): Promise<void> => {
    await api.post('/v1/thumbtack/auth/disconnect');
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
  disconnectAccount: async (id: string): Promise<{ success: boolean }> => {
    const { data } = await api.post(`/v1/thumbtack/saved-accounts/${id}/disconnect`);
    return data;
  },
  reconnectAccount: async (id: string): Promise<{ success: boolean; webhookId: string }> => {
    const { data } = await api.post(`/v1/thumbtack/saved-accounts/${id}/reconnect`);
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
  importNegotiation: async (negotiationId: string): Promise<{ lead: Lead; isNew: boolean; message: string }> => {
    const { data } = await api.post(`/v1/thumbtack/negotiations/${negotiationId}/import`);
    return data;
  },
  syncLead: async (leadId: string): Promise<{ success: boolean; lead: Lead }> => {
    const { data } = await api.post(`/v1/leads/${leadId}/sync`);
    return data;
  },
  resyncMessages: async (leadId: string): Promise<{ success: boolean; cleaned: number; imported: number }> => {
    const { data } = await api.post(`/v1/leads/${leadId}/resync-messages`);
    return data;
  },
};

export default api;
