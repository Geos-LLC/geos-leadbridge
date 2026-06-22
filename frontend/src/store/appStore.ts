import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Lead, Business, Platform, SavedAccount, AccountDiagnostics } from '../types';
import { thumbtackApi, platformsApi, analyticsApi, monitoringApi, type AnalyticsData } from '../services/api';

export interface PlatformDashboardStats {
  leadsToday: number;
  automatedReplies: number;
  avgResponseTime: string;
  conversionRate: number;
  weeklyLeads: number;
  engagement: number;
  lifetimeReplies: number;
  messagesSent: number;
  hasAccounts: boolean;
}

/**
 * Per-platform dashboard stats. The Dashboard renders Yelp and Thumbtack
 * side-by-side, with each platform contributing its own 7-day snapshot and
 * top-line summary. Platforms with no connected accounts render with
 * hasAccounts=false so the UI can hide their column.
 */
export interface DashboardStats {
  yelp: PlatformDashboardStats;
  thumbtack: PlatformDashboardStats;
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

  // Cross-page account scope. null = "All accounts" (default). Drives the
  // sidebar account switcher, AI Playbook, Automation filters, etc.
  // Persisted so the choice survives full reload + page navigation.
  selectedAccountId: string | null;
  setSelectedAccountId: (id: string | null) => void;

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

  // System Health (cached, shared by Layout + Dashboard)
  systemHealth: {
    healthy: boolean;
    status: 'healthy' | 'warning' | 'critical';
    lastCheckedAt: string | null;
    summary: { critical: number; warning: number };
    issues: any[];
  } | null;
  systemHealthLoading: boolean;
  loadSystemHealth: (force?: boolean) => Promise<void>;

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
          // If the removed account was the active one, drop the pin so
          // downstream pages fall back to "All accounts" instead of
          // pinning to a ghost id.
          selectedAccountId: state.selectedAccountId === id ? null : state.selectedAccountId,
        })),

      selectedAccountId: null,
      setSelectedAccountId: (id) => set({ selectedAccountId: id }),

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
        if (!force && accounts.length > 0 && accounts.every(a => existing[a.id])) {
          return;
        }
        set({ diagnosticsLoading: true });
        const diagnosticsMap: Record<string, AccountDiagnostics> = {};
        await Promise.allSettled(accounts.map(async (account) => {
          try {
            const diag = account.platform === 'yelp'
              ? await platformsApi.getYelpAccountHealth(account.id)
              : await thumbtackApi.getAccountHealth(account.id);
            diagnosticsMap[account.id] = diag;
          } catch (err) {
            console.error(`Failed to load diagnostics for ${account.id}:`, err);
            // Record an unhealthy stub so the card stops spinning and shows "Needs attention"
            diagnosticsMap[account.id] = {
              healthy: false,
              issues: ['Health check failed — refresh to retry'],
              notificationIssues: [],
              platform: { connected: false },
              account: { hasWebhook: false },
              notifications: { settingsExist: false, hasSigcoreApiKey: false, newLeadRules: 0, customerReplyRules: 0, rules: [] },
              automation: { totalRules: 0 },
              recentLogs: [],
            } as unknown as AccountDiagnostics;
          }
          set({ accountDiagnostics: { ...diagnosticsMap } });
        }));
        set({ diagnosticsLoading: false });
      },

      // System Health (cached, shared by Layout + Dashboard)
      systemHealth: null,
      systemHealthLoading: false,
      loadSystemHealth: async (force = false) => {
        const { systemHealth, systemHealthLoading } = get();
        if (systemHealthLoading) return;
        if (!force && systemHealth) return;
        set({ systemHealthLoading: true });
        try {
          // Trigger a fresh server-side check, then read results
          const data = await monitoringApi.runHealthCheck();
          set({ systemHealth: data });
        } catch {
          // Fall back to cached read if run fails
          try {
            const data = await monitoringApi.getSystemHealth();
            set({ systemHealth: data });
          } catch {}
        } finally {
          set({ systemHealthLoading: false });
        }
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
        selectedAccountId: state.selectedAccountId,
      }),
    }
  )
);
