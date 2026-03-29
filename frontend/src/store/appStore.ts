import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Lead, Business, Platform, SavedAccount, AccountDiagnostics } from '../types';
import { thumbtackApi, platformsApi, analyticsApi, type AnalyticsData } from '../services/api';

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
  setDashboardStats: (stats: DashboardStats | null) => void;

  // Cached analytics data (persisted for instant load)
  analyticsCache: Partial<AnalyticsData> | null;
  analyticsLoading: boolean;
  setAnalyticsCache: (data: Partial<AnalyticsData> | null) => void;
  loadAnalytics: (force?: boolean) => Promise<void>;

  // Account diagnostics (shared across pages, not persisted)
  accountDiagnostics: Record<string, AccountDiagnostics>;
  diagnosticsLoading: boolean;
  setAccountDiagnostics: (diag: Record<string, AccountDiagnostics>) => void;
  loadDiagnostics: (accounts: SavedAccount[], force?: boolean) => Promise<void>;

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

      // Analytics cache
      analyticsCache: null,
      analyticsLoading: false,
      setAnalyticsCache: (data) => set({ analyticsCache: data }),
      loadAnalytics: async (force = false) => {
        const existing = get().analyticsCache;
        if (!force && existing) return;
        set({ analyticsLoading: true });
        try {
          // Load basic (fast) analytics first
          const { data: basicData } = await analyticsApi.getBasicAnalytics({});
          set({ analyticsCache: basicData as Partial<AnalyticsData> });
          // Then load full analytics in background
          const { data: fullData } = await analyticsApi.getAnalytics({});
          set({ analyticsCache: fullData });
        } catch (err) {
          console.error('Failed to preload analytics:', err);
        } finally {
          set({ analyticsLoading: false });
        }
      },

      // Account diagnostics
      accountDiagnostics: {},
      diagnosticsLoading: false,
      setAccountDiagnostics: (diag) => set({ accountDiagnostics: diag }),
      loadDiagnostics: async (accounts, force = false) => {
        const existing = get().accountDiagnostics;
        // Skip if we already have diagnostics for all accounts (unless forced)
        if (!force && accounts.length > 0 && accounts.every(a => existing[a.id])) {
          return;
        }
        set({ diagnosticsLoading: true });
        const diagnosticsMap: Record<string, AccountDiagnostics> = {};
        for (const account of accounts) {
          try {
            const diag = account.platform === 'yelp'
              ? await platformsApi.getYelpAccountHealth(account.id)
              : await thumbtackApi.getAccountHealth(account.id);
            diagnosticsMap[account.id] = diag;
            // Update incrementally so UI updates as each completes
            set({ accountDiagnostics: { ...diagnosticsMap } });
          } catch (err) {
            console.error(`Failed to load diagnostics for ${account.id}:`, err);
          }
        }
        set({ diagnosticsLoading: false });
      },

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
        analyticsCache: state.analyticsCache,
        configuredBusinessId: state.configuredBusinessId,
      }),
    }
  )
);
