import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '../types';

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
      },
      logout: () => {
        localStorage.removeItem('token');
        set({ user: null, token: null, isAuthenticated: false, impersonatingUser: null });
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ user: state.user, token: state.token, isAuthenticated: state.isAuthenticated, impersonatingUser: state.impersonatingUser }),
    }
  )
);
