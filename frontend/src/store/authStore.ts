import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '../types';
import { setAnalyticsUserId, setAnalyticsUserProperties, resetAnalyticsSession } from '../services/analytics';

function userPropsFrom(user: User): Record<string, string | number | boolean | undefined | null> {
  const profile = user.onboardingProfile ?? null;
  return {
    plan_type: user.subscriptionTier ?? 'none',
    trial_status: user.trialUsed ? 'used' : user.subscriptionStatus === 'TRIALING' ? 'active' : 'none',
    primary_lead_source: profile?.primaryLeadSource ?? undefined,
    weekly_lead_volume: profile?.weeklyLeadVolume ?? undefined,
    service_type: profile?.serviceType ?? undefined,
    response_speed: profile?.responseSpeed ?? undefined,
    avg_job_value: profile?.avgJobValue ?? undefined,
    user_goal: profile?.userGoal ?? undefined,
  };
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;

  // Admin impersonation
  impersonatingUser: { id: string; name: string | null; email: string } | null;
  startImpersonation: (target: { id: string; name: string | null; email: string }) => void;
  stopImpersonation: () => void;

  setAuth: (user: User, token: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      impersonatingUser: null,

      startImpersonation: (target) => {
        console.log('[AuthStore] Impersonating:', target.email);
        set({ impersonatingUser: target });
      },
      stopImpersonation: () => {
        console.log('[AuthStore] Stopped impersonation');
        set({ impersonatingUser: null });
      },

      setAuth: (user, token) => {
        console.log('[AuthStore] Setting auth - User:', user);
        console.log('[AuthStore] User role:', user.role);
        localStorage.setItem('token', token);
        set({ user, token, isAuthenticated: true });
        setAnalyticsUserId(user.id);
        setAnalyticsUserProperties(userPropsFrom(user));
      },
      logout: () => {
        localStorage.removeItem('token');
        set({ user: null, token: null, isAuthenticated: false, impersonatingUser: null });
        resetAnalyticsSession();
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ user: state.user, token: state.token, isAuthenticated: state.isAuthenticated, impersonatingUser: state.impersonatingUser }),
    }
  )
);
