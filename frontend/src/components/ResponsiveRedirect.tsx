import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

// Width at which the desktop layout becomes uncomfortably cramped and we
// hand off to the mobile shell at /m/*. Matches Tailwind's `md` breakpoint
// and the design's narrow-viewport target. Pure pixels, no media-query
// hookup — we drive navigation, not styling.
const NARROW_BREAKPOINT_PX = 768;

// Desktop → mobile route mapping. Only routes with a real mobile twin are
// listed. Surfaces without one (admin, partner-network, /templates,
// /sms-history, /pricing, /onboarding/setup, /runtime/debug, /api-test,
// /automation-classic, /automation-legacy) stay on the desktop shell at
// any width — they're operator-grade screens, not phone-targeted.
function targetFor(pathname: string): string | null {
  if (pathname === '/overview' || pathname === '/dashboard') return '/m/today';
  if (pathname === '/lead-activity' || pathname === '/messages') return '/m/leads';
  if (pathname === '/automation' || pathname === '/services') return '/m/automation';
  if (pathname === '/automation/respond') return '/m/automation/respond';
  if (pathname === '/automation/engage') return '/m/automation/engage';
  if (pathname === '/automation/convert') return '/m/automation/convert';
  if (pathname === '/insights' || pathname === '/analytics') return '/m/insights';
  // Settings + adjacent single-tenant config surfaces all funnel to the
  // mobile "More" tab — that's where notifications, billing, account, and
  // the settings sub-tabs live in the mobile design.
  if (pathname === '/notifications'
      || pathname === '/phone-settings'
      || pathname === '/billing'
      || pathname.startsWith('/settings')) return '/m/more';
  return null;
}

function isNarrow(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < NARROW_BREAKPOINT_PX;
}

// One-way responsive redirect: narrow viewport on a desktop route → mobile
// twin. Never bounces back on resize-up — mobile shell still renders fine
// at wider widths and mid-session URL flips are jarring. Mounts once near
// the router root; renders nothing.
export function ResponsiveRedirect() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  useEffect(() => {
    if (!isNarrow()) return;
    if (pathname.startsWith('/m/') || pathname === '/m') return;
    const target = targetFor(pathname);
    if (target) navigate(target, { replace: true });
  }, [pathname, navigate]);

  useEffect(() => {
    const onResize = () => {
      if (!isNarrow()) return;
      const current = window.location.pathname;
      if (current.startsWith('/m/') || current === '/m') return;
      const target = targetFor(current);
      if (target) navigate(target, { replace: true });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [navigate]);

  return null;
}
