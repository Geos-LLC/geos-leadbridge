import { create } from 'zustand';
import type { Lead, Business, Platform } from '../types';

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

  // Leads
  leads: Lead[];
  selectedLead: Lead | null;
  setLeads: (leads: Lead[]) => void;
  setSelectedLead: (lead: Lead | null) => void;
  updateLead: (lead: Lead) => void;

  // Helper to check if a lead belongs to the currently connected account
  isLeadAccessible: (lead: Lead) => boolean;
}

export const useAppStore = create<AppState>((set, get) => ({
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

  // Leads
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
    // If no businessId on lead or no configured business, assume accessible
    if (!lead.businessId || !configuredBusinessId) return true;
    return lead.businessId === configuredBusinessId;
  },
}));
