import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { useState, useEffect } from 'react';
import { billingApi } from '../services/api';

// Routes that should be accessible even with expired trial
const TRIAL_EXEMPT_ROUTES = ['/pricing', '/billing', '/settings'];

export function ProtectedRoute() {
  const location = useLocation();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const [trialChecked, setTrialChecked] = useState(false);
  const [shouldBlockAccess, setShouldBlockAccess] = useState(false);

  useEffect(() => {
    // Reset state on every route change so stale values don't persist
    setTrialChecked(false);
    setShouldBlockAccess(false);

    async function checkTrialStatus() {
      // Skip trial check for exempt routes — always allow access
      if (TRIAL_EXEMPT_ROUTES.includes(location.pathname)) {
        setTrialChecked(true);
        return;
      }

      try {
        const subscription = await billingApi.getSubscription();

        // Block access if trial is expired and no active subscription
        const hasActiveSubscription = subscription.tier &&
          ['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(subscription.status || '');

        const trialExpired = subscription.trial?.trialExpired;

        if (trialExpired && !hasActiveSubscription) {
          setShouldBlockAccess(true);
        }
      } catch (error) {
        console.error('Failed to check trial status:', error);
        // Don't block access on API errors — let user through
      } finally {
        setTrialChecked(true);
      }
    }

    if (isAuthenticated) {
      checkTrialStatus();
    }
  }, [isAuthenticated, location.pathname]);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // Show loading state while checking trial
  if (!trialChecked) {
    return null;
  }

  // Redirect to pricing if trial expired and no subscription
  if (shouldBlockAccess) {
    return <Navigate to="/pricing" replace />;
  }

  return <Outlet />;
}
