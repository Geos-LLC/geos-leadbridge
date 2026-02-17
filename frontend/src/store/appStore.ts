import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Lead, Business, Platform, SavedAccount } from '../types';

export interface DashboardStats {
  leadsToday: number;
  automatedReplies: number;
  avgResponseTime: string;
  conversionRate: number;
  weeklyLeads: number;
  engagement: number;
  lifetimeReplies: number;
  messagesSent: number;
}

interface AppState {
  // Platform connection
  platforms: Platform[];
  setPlatforms: (platforms: Platform[]) => void;
  isThumbtackConnected: () => boolean;

  // Businesses
  businesses: Business[];
  selectedBusiness: Business | null;
  configuredBusinessId: string | null; // Currently connected business ID
  setBusinesses: (businesses: Business[]) => void;
  setSelectedBusiness: (business: Business | null) => void;
  setConfiguredBusinessId: (id: string | null) => void;

  // Saved accounts for multi-account switching
  savedAccounts: SavedAccount[];
  setSavedAccounts: (accounts: SavedAccount[]) => void;
  addSavedAccount: (account: SavedAccount) => void;
  removeSavedAccount: (id: string) => void;

  // Cached dashboard stats (persisted for instant load)
  dashboardStats: DashboardStats | null;
  setDashboardStats: (stats: DashboardStats) => void;

  // Leads
  leads: Lead[];
  selectedLead: Lead | null;
  setLeads: (leads: Lead[]) => void;
  setSelectedLead: (lead: Lead | null) => void;
  updateLead: (lead: Lead) => void;

  // Helper to check if a lead belongs to the currently connected account
  isLeadAccessible: (lead: Lead) => boolean;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Platforms
      platforms: [],
      setPlatforms: (platforms) => set({ platforms }),
      isThumbtackConnected: () => {
        const { platforms } = get();
        const thumbtack = platforms.find((p) => p.platformName === 'thumbtack');
        return thumbtack?.connected ?? false;
      },

      // Businesses
      businesses: [],
      selectedBusiness: null,
      configuredBusinessId: null,
      setBusinesses: (businesses) => set({ businesses }),
      setSelectedBusiness: (business) => set({ selectedBusiness: business }),
      setConfiguredBusinessId: (id) => set({ configuredBusinessId: id }),

      // Saved accounts
      savedAccounts: [],
      setSavedAccounts: (accounts) => set({ savedAccounts: accounts }),
      addSavedAccount: (account) =>
        set((state) => ({
          savedAccounts: [account, ...state.savedAccounts.filter((a) => a.id !== account.id)],
        })),
      removeSavedAccount: (id) =>
        set((state) => ({
          savedAccounts: state.savedAccounts.filter((a) => a.id !== id),
        })),

      // Dashboard stats cache
      dashboardStats: null,
      setDashboardStats: (stats) => set({ dashboardStats: stats }),

      // Leads (not persisted - loaded fresh each session)
      leads: [],
      selectedLead: null,
      setLeads: (leads) => set({ leads }),
      setSelectedLead: (lead) => set({ selectedLead: lead }),
      updateLead: (updatedLead) =>
        set((state) => ({
          leads: state.leads.map((lead) => (lead.id === updatedLead.id ? updatedLead : lead)),
          selectedLead: state.selectedLead?.id === updatedLead.id ? updatedLead : state.selectedLead,
        })),

      // Helper to check if a lead belongs to the currently connected account
      isLeadAccessible: (lead) => {
        const { configuredBusinessId } = get();
        if (!lead.businessId || !configuredBusinessId) return true;
        return lead.businessId === configuredBusinessId;
      },
    }),
    {
      name: 'leadbridge-app-cache',
      // Only persist the data that should survive page reload
      partialize: (state) => ({
        savedAccounts: state.savedAccounts,
        dashboardStats: state.dashboardStats,
        configuredBusinessId: state.configuredBusinessId,
      }),
    }
  )
);
