import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { useState, useEffect, useRef } from 'react';
import { billingApi } from '../services/api';
import { PageSkeleton } from './PageSkeleton';

// Routes that should be accessible even with expired trial
const TRIAL_EXEMPT_ROUTES = ['/pricing', '/billing', '/settings'];

export function ProtectedRoute() {
  const location = useLocation();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const [trialChecked, setTrialChecked] = useState(false);
  const [shouldBlockAccess, setShouldBlockAccess] = useState(false);
  const hasEverChecked = useRef(false);

  useEffect(() => {
    async function checkTrialStatus() {
      // Skip trial check for exempt routes — always allow access
      if (TRIAL_EXEMPT_ROUTES.includes(location.pathname)) {
        setShouldBlockAccess(false);
        setTrialChecked(true);
        hasEverChecked.current = true;
        return;
      }

      try {
        const subscription = await billingApi.getSubscription();

        // Block access if trial is expired and no active subscription
        const hasActiveSubscription = subscription.tier &&
          ['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(subscription.status || '');

        const trialExpired = subscription.trial?.trialExpired;

        setShouldBlockAccess(!!(trialExpired && !hasActiveSubscription));
      } catch (error) {
        console.error('Failed to check trial status:', error);
        setShouldBlockAccess(false);
      } finally {
        setTrialChecked(true);
        hasEverChecked.current = true;
      }
    }

    if (isAuthenticated) {
      checkTrialStatus();
    }
  }, [isAuthenticated, location.pathname]);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  // First-render gate: show a loading skeleton (not a blank screen) while the
  // initial billing check is in flight. Returning null here meant a brand-new
  // signup landed on white nothingness until the Stripe call resolved — long
  // enough that customers reloaded thinking the page broke, which delayed
  // the onboarding quiz from appearing.
  if (!trialChecked && !hasEverChecked.current) {
    return <PageSkeleton />;
  }

  // Redirect to pricing if trial expired and no subscription
  if (shouldBlockAccess) {
    return <Navigate to="/pricing" replace />;
  }

  return <Outlet />;
}
