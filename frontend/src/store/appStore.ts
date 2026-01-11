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
  setBusinesses: (businesses: Business[]) => void;
  setSelectedBusiness: (business: Business | null) => void;

  // Leads
  leads: Lead[];
  selectedLead: Lead | null;
  setLeads: (leads: Lead[]) => void;
  setSelectedLead: (lead: Lead | null) => void;
  updateLead: (lead: Lead) => void;
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
  setBusinesses: (businesses) => set({ businesses }),
  setSelectedBusiness: (business) => set({ selectedBusiness: business }),

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
}));
