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
  // Snapshot of the admin's own user object taken at startImpersonation.
  // Restored verbatim on stopImpersonation so Exit lands the admin back
  // in THEIR account — without this, any setAuth call during impersonation
  // (e.g. Services.tsx and settings/General.tsx refresh /auth/profile on
  // mount and the interceptor adds X-Impersonate-User, so the response is
  // the TENANT'S profile) would corrupt the persisted admin user.
  adminUserSnapshot: User | null;
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
      adminUserSnapshot: null,

      startImpersonation: (target) => {
        console.log('[AuthStore] Impersonating:', target.email);
        // Capture the current (admin) user so we can restore it on Exit.
        // Without this, mid-impersonation refreshes of /auth/profile
        // (Services, General Settings, etc.) overwrite `user` with the
        // tenant's profile because the request interceptor stamps
        // X-Impersonate-User on those calls — and the admin lands in
        // the tenant's account after reload. Idempotent: nested
        // impersonations (unlikely but defensible) reuse the earliest
        // snapshot rather than overwriting it with a tenant user.
        set((state) => ({
          impersonatingUser: target,
          adminUserSnapshot: state.adminUserSnapshot ?? state.user,
        }));
      },
      stopImpersonation: () => {
        console.log('[AuthStore] Stopped impersonation');
        set((state) => {
          const restored = state.adminUserSnapshot;
          if (restored) {
            // Restore analytics identity to the admin too — otherwise
            // analytics events after exit still attribute to the tenant.
            setAnalyticsUserId(restored.id);
            setAnalyticsUserProperties(userPropsFrom(restored));
          }
          return {
            impersonatingUser: null,
            adminUserSnapshot: null,
            user: restored ?? state.user,
          };
        });
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
        set({
          user: null, token: null, isAuthenticated: false,
          impersonatingUser: null, adminUserSnapshot: null,
        });
        resetAnalyticsSession();
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        user: state.user,
        token: state.token,
        isAuthenticated: state.isAuthenticated,
        impersonatingUser: state.impersonatingUser,
        adminUserSnapshot: state.adminUserSnapshot,
      }),
    }
  )
);
