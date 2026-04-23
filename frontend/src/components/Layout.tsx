import { useState, useEffect } from 'react';
import { Outlet, Link as RouterLink, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  Settings, LogOut, Shield, FlaskConical, Menu, GraduationCap,
  AlertTriangle, Workflow, LayoutGrid, Smartphone, Inbox, FileText,
  BarChart3, ChevronsUpDown,
} from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { useAppStore } from '../store/appStore';
import TrialBanner from './TrialBanner';
import TrialExpiredModal from './TrialExpiredModal';
import CancelledSubscriptionBanner from './CancelledSubscriptionBanner';
import ImpersonationBanner from './ImpersonationBanner';
import OnboardingStep1Modal from './OnboardingStep1Modal';
import OnboardingStep2Modal from './OnboardingStep2Modal';

function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="shrink-0">
      <rect x="1" y="1" width="22" height="22" rx="6" fill="var(--lb-ink-1)" />
      <circle cx="7" cy="15" r="2.2" fill="var(--lb-accent)" />
      <circle cx="17" cy="15" r="2.2" fill="var(--lb-accent)" />
      <path d="M5 15 Q 12 5, 19 15" stroke="var(--lb-accent)" strokeWidth="1.8" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, impersonatingUser } = useAuthStore();
  const savedAccounts = useAppStore(state => state.savedAccounts);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const loadAnalytics = useAppStore(state => state.loadAnalytics);
  const systemHealth = useAppStore(state => state.systemHealth);
  const loadSystemHealth = useAppStore(state => state.loadSystemHealth);

  useEffect(() => {
    loadAnalytics(true);
    loadSystemHealth(true);
  }, []);

  const hasCriticalIssues = systemHealth && !systemHealth.healthy && systemHealth.summary.critical > 0;
  const hasWarningIssues = systemHealth && !systemHealth.healthy && systemHealth.summary.warning > 0 && !hasCriticalIssues;

  useEffect(() => {
    console.log('[Layout] savedAccounts updated:', savedAccounts);
    console.log('[Layout] Banner state:', systemHealth ? `healthy=${systemHealth.healthy} critical=${systemHealth.summary.critical}` : 'loading');
  }, [savedAccounts, systemHealth]);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const NAV_ITEMS = [
    { icon: <LayoutGrid size={15} />,  label: 'Overview',      path: '/dashboard' },
    { icon: <Inbox size={15} />,       label: 'Lead Activity', path: '/messages' },
    { icon: <Workflow size={15} />,    label: 'Automation',    path: '/services' },
    { icon: <FileText size={15} />,    label: 'Templates',     path: '/message-settings' },
    { icon: <BarChart3 size={15} />,   label: 'Insights',      path: '/analytics' },
  ];

  const getPageName = () => {
    const path = location.pathname;
    const navItem = NAV_ITEMS.find(item => item.path === path);
    if (navItem) return navItem.label;
    if (path === '/sms-history') return 'SMS History';
    if (path === '/settings') return 'Settings';
    if (path === '/pricing') return 'Pricing';
    if (path === '/admin') return 'Admin Dashboard';
    if (path === '/admin/tenant-numbers') return 'Tenant Numbers';
    if (path === '/api-test') return 'API Test';
    if (path.startsWith('/admin/users/')) return 'User Details';
    return 'Leadbridge';
  };

  const initials = (user?.name?.[0] || user?.email?.[0] || 'U').toUpperCase();
  const businessName = (user as any)?.businessName || user?.name || 'Leadbridge';
  const connectedCount = savedAccounts?.length ?? 0;

  // Shared nav-item renderer — dense, active state uses ink-10 bg + accent-colored icon
  const renderNavItem = (item: { icon: React.ReactNode; label: string; path: string }) => (
    <NavLink
      key={item.path}
      to={item.path}
      className={({ isActive }) =>
        `group flex items-center gap-2.5 px-2.5 py-[7px] rounded-md transition-colors mb-[1px] ` +
        (isActive
          ? 'bg-[var(--lb-ink-10)] text-[var(--lb-ink-1)] font-semibold'
          : 'text-[var(--lb-ink-4)] hover:bg-[var(--lb-ink-10)]/60 font-medium')
      }
      onClick={() => setMobileMenuOpen(false)}
      style={{ fontSize: 13 }}
    >
      {({ isActive }) => (
        <>
          <span
            className="shrink-0 inline-flex items-center justify-center"
            style={{ color: isActive ? 'var(--lb-accent)' : 'var(--lb-ink-5)' }}
          >
            {item.icon}
          </span>
          <span className="flex-1 truncate">{item.label}</span>
        </>
      )}
    </NavLink>
  );

  const profile = user?.onboardingProfile ?? null;
  const needsStep1 = !impersonatingUser && !!user && !profile?.step1CompletedAt && !profile?.step1SkippedAt;
  const needsStep2 =
    !impersonatingUser &&
    !!user &&
    !!profile?.step1CompletedAt &&
    !profile?.step2CompletedAt &&
    !profile?.step2SkippedAt;

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--lb-bg)' }}>
      <TrialExpiredModal />
      {needsStep1 && <OnboardingStep1Modal onComplete={() => { /* authStore updated inside modal */ }} />}
      {!needsStep1 && needsStep2 && <OnboardingStep2Modal onComplete={() => { /* authStore updated inside modal */ }} />}

      {/* Mobile Navigation Overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 lg:hidden" onClick={() => setMobileMenuOpen(false)} />
      )}

      {/* Sidebar — 232px, dense, utility-first */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 transform transition-transform duration-300 ease-in-out ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}
        style={{
          width: 232,
          background: 'var(--lb-surface)',
          borderRight: '1px solid var(--lb-line)',
        }}
      >
        <div className="flex flex-col h-full" style={{ padding: '14px 10px' }}>
          {/* Brand block */}
          <RouterLink
            to="/"
            className="flex items-center gap-[9px] hover:opacity-90 transition-opacity"
            style={{
              padding: '4px 8px 10px',
              borderBottom: '1px solid var(--lb-line-soft)',
              marginBottom: 4,
            }}
          >
            <BrandMark size={22} />
            <div style={{ lineHeight: 1.1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--lb-ink-1)' }}>Leadbridge</div>
              <div
                style={{
                  fontSize: 10,
                  fontFamily: 'var(--lb-font-mono)',
                  color: 'var(--lb-ink-5)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.06,
                }}
              >
                {user?.role === 'ADMIN' ? 'Admin' : 'Pro'}
              </div>
            </div>
          </RouterLink>

          {/* Account selector */}
          <button
            className="flex items-center gap-[9px] w-full text-left"
            style={{
              padding: '8px 10px',
              margin: '6px 0',
              background: 'var(--lb-ink-10)',
              border: '1px solid var(--lb-line-soft)',
              borderRadius: 'var(--lb-radius)',
              cursor: 'pointer',
            }}
            onClick={() => navigate('/settings')}
            title="Account settings"
          >
            <div
              style={{
                width: 22,
                height: 22,
                borderRadius: 4,
                background: 'oklch(0.9 0.1 145)',
                color: '#0c4a2b',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {(businessName[0] || '?').toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div
                className="truncate"
                style={{ fontSize: 12, fontWeight: 500, color: 'var(--lb-ink-1)' }}
              >
                {businessName}
              </div>
              <div style={{ fontSize: 10, color: 'var(--lb-ink-5)' }}>
                {connectedCount} {connectedCount === 1 ? 'source' : 'sources'}
              </div>
            </div>
            <ChevronsUpDown size={13} style={{ color: 'var(--lb-ink-5)' }} />
          </button>

          {/* Primary nav */}
          <nav className="flex-1 sidebar-scroll overflow-y-auto" style={{ marginTop: 4 }}>
            {NAV_ITEMS.map(renderNavItem)}

            {user?.role === 'ADMIN' && !impersonatingUser && (
              <>
                <div
                  style={{
                    margin: '14px 10px 6px',
                    fontSize: 10,
                    fontFamily: 'var(--lb-font-mono)',
                    color: 'var(--lb-ink-6)',
                    textTransform: 'uppercase',
                    letterSpacing: 0.08,
                    fontWeight: 600,
                  }}
                >
                  Admin
                </div>
                {renderNavItem({ icon: <Shield size={15} />, label: 'Admin Dashboard', path: '/admin' })}
                {renderNavItem({ icon: <Smartphone size={15} />, label: 'Tenant Numbers', path: '/admin/tenant-numbers' })}
                {renderNavItem({ icon: <Inbox size={15} />, label: 'SMS History', path: '/sms-history' })}
                {renderNavItem({ icon: <FlaskConical size={15} />, label: 'API Test', path: '/api-test' })}
              </>
            )}
          </nav>

          {/* Secondary nav + user card */}
          <div className="mt-auto">
            {renderNavItem({ icon: <Settings size={15} />, label: 'Settings', path: '/settings' })}

            <div
              className="flex items-center gap-[9px]"
              style={{
                padding: '8px 8px',
                marginTop: 6,
                borderTop: '1px solid var(--lb-line-soft)',
              }}
            >
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 99,
                  background: 'oklch(0.92 0.04 200)',
                  color: 'oklch(0.35 0.1 200)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: 0.03,
                  flexShrink: 0,
                }}
              >
                {initials}
              </div>
              <div className="flex-1 min-w-0">
                <div
                  className="truncate"
                  style={{ fontSize: 12, fontWeight: 500, color: 'var(--lb-ink-1)' }}
                >
                  {user?.name || 'User'}
                </div>
                <div
                  className="truncate"
                  style={{ fontSize: 10, color: 'var(--lb-ink-5)' }}
                >
                  {user?.email}
                </div>
              </div>
              <button
                onClick={handleLogout}
                title="Logout"
                className="hover:text-[var(--lb-danger)] transition-colors"
                style={{ color: 'var(--lb-ink-5)', background: 'transparent', border: 0, padding: 2, cursor: 'pointer' }}
              >
                <LogOut size={13} />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 min-h-screen" style={{ marginLeft: 0 }}>
        <div className="lg:ml-[232px]">
          <ImpersonationBanner />

          {/* Top page header — utility-first, minimal decoration */}
          {location.pathname !== '/messages' && (
            <header
              className="sticky top-0 z-30"
              style={{
                background: 'var(--lb-surface)',
                borderBottom: '1px solid var(--lb-line)',
                padding: '14px 24px',
              }}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                    className="lg:hidden"
                    style={{ color: 'var(--lb-ink-4)', background: 'transparent', border: 0, padding: 6, cursor: 'pointer' }}
                  >
                    <Menu size={20} />
                  </button>
                  <RouterLink to="/" className="flex items-center gap-2 lg:hidden hover:opacity-80 transition-opacity">
                    <BrandMark size={22} />
                    <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--lb-ink-1)' }}>
                      Leadbridge
                    </span>
                  </RouterLink>
                  <h1
                    className="hidden lg:block"
                    style={{ fontSize: 20, fontWeight: 600, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em', margin: 0 }}
                  >
                    {getPageName()}
                  </h1>
                </div>
                <div className="flex items-center gap-3" />
              </div>
            </header>
          )}

          {/* Mobile menu button for Messages page (no top navbar) */}
          {location.pathname === '/messages' && (
            <div
              className="lg:hidden sticky top-0 z-30"
              style={{
                background: 'var(--lb-surface)',
                borderBottom: '1px solid var(--lb-line)',
                padding: '8px 16px',
              }}
            >
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                  style={{ color: 'var(--lb-ink-4)', background: 'transparent', border: 0, padding: 6, cursor: 'pointer' }}
                >
                  <Menu size={20} />
                </button>
                <RouterLink to="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
                  <BrandMark size={20} />
                  <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--lb-ink-1)' }}>
                    Leadbridge
                  </span>
                </RouterLink>
              </div>
            </div>
          )}

          <TrialBanner />

          {/* System Health Banner */}
          {(hasCriticalIssues || hasWarningIssues) && (
            <div
              style={{
                padding: '10px 24px',
                background: hasCriticalIssues ? 'oklch(0.96 0.04 27)' : 'oklch(0.96 0.05 75)',
                borderBottom: `1px solid ${hasCriticalIssues ? 'oklch(0.88 0.08 27)' : 'oklch(0.88 0.1 75)'}`,
              }}
            >
              <div className="flex items-center gap-3">
                <AlertTriangle
                  size={18}
                  style={{ color: hasCriticalIssues ? 'var(--lb-danger)' : 'var(--lb-warn)' }}
                />
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: hasCriticalIssues ? '#7a1a14' : '#5e3b0a',
                  }}
                >
                  {systemHealth!.issues.length === 1
                    ? `${systemHealth!.issues[0].accountName} — ${systemHealth!.issues[0].message}`
                    : `${systemHealth!.issues.length} account issue${systemHealth!.issues.length > 1 ? 's' : ''} detected`}
                </span>
                <RouterLink
                  to="/dashboard"
                  className="ml-auto hover:underline"
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: hasCriticalIssues ? 'var(--lb-danger)' : 'var(--lb-warn)',
                  }}
                >
                  Review in Dashboard →
                </RouterLink>
              </div>
            </div>
          )}

          <CancelledSubscriptionBanner />

          <Outlet />

          {/* Floating tour button — accent-colored, consistent with design */}
          <button
            onClick={() => window.dispatchEvent(new Event('lb:start-tour'))}
            className="fixed bottom-6 right-6 z-30 flex items-center justify-center hover:scale-105 transition-all"
            style={{
              width: 44,
              height: 44,
              borderRadius: 999,
              background: 'var(--lb-accent)',
              color: 'var(--lb-accent-fg)',
              border: 0,
              cursor: 'pointer',
              boxShadow: 'var(--lb-shadow-md)',
            }}
            title="Quick tour"
          >
            <GraduationCap size={18} />
          </button>
        </div>
      </main>
    </div>
  );
}
