import axios from 'axios';
import type { AuthResponse, Lead, Business, Platform } from '../types';

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

// Handle 401 errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
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
  setupWebhook: async (businessId: string): Promise<{ webhookId: string }> => {
    const { data } = await api.post(`/v1/thumbtack/businesses/${businessId}/webhooks/setup`);
    return data;
  },
  getWebhooks: async (businessId: string): Promise<{ webhooks: any[] }> => {
    const { data } = await api.get(`/v1/thumbtack/businesses/${businessId}/webhooks`);
    return data;
  },
};

// Message type for API responses
export interface ApiMessage {
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
  importNegotiation: async (negotiationId: string): Promise<{ lead: Lead }> => {
    const { data } = await api.post(`/v1/thumbtack/negotiations/${negotiationId}/import`);
    return data;
  },
};

export default api;
