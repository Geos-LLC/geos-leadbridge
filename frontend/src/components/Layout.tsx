import { useState, useEffect } from 'react';
import { Outlet, Link as RouterLink, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  Settings, LogOut, Shield, FlaskConical, Menu, GraduationCap,
  AlertTriangle, Workflow, LayoutGrid, Smartphone, Inbox, FileText,
  BarChart3, ChevronsUpDown, ChevronRight, ChevronDown, ArrowLeft,
  DollarSign, Sparkles, Paperclip, Send, X,
} from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { useAppStore } from '../store/appStore';
import TrialBanner from './TrialBanner';
import TrialExpiredModal from './TrialExpiredModal';
import CancelledSubscriptionBanner from './CancelledSubscriptionBanner';
import ImpersonationBanner from './ImpersonationBanner';
// OnboardingStep1Modal and OnboardingStep2Modal (the legacy 2-step
// segmentation quiz) are intentionally NOT rendered anymore. The 8-step
// guided setup wizard at /onboarding/setup replaces them. The modal
// files + their backend endpoints are kept for historical data; do not
// re-import here without an explicit decision.

function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" className="shrink-0" style={{ borderRadius: size * 0.25 }}>
      <rect width="256" height="256" rx="48" fill="var(--lb-accent)" />
      <path
        d="M160 64L96 128H128L96 192L160 128H128L160 64Z"
        fill="white"
        stroke="white"
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, impersonatingUser } = useAuthStore();
  const savedAccounts = useAppStore(state => state.savedAccounts);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [aiChatOpen, setAiChatOpen] = useState(false);
  const [aiChatInput, setAiChatInput] = useState('');
  const [aiChatFiles, setAiChatFiles] = useState<File[]>([]);

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

  type NavChild = { label: string; path: string; hint: string; tone: 'green' | 'purple' | 'blue' | 'gray' };
  type NavItem = { icon: React.ReactNode; label: string; path: string; children?: NavChild[] };

  const NAV_ITEMS: NavItem[] = [
    { icon: <LayoutGrid size={15} />,  label: 'Overview',      path: '/overview' },
    { icon: <Inbox size={15} />,       label: 'Lead Activity', path: '/lead-activity' },
    {
      icon: <Workflow size={15} />,
      label: 'Automation',
      path: '/automation',
      children: [
        { label: 'When a Lead Arrives', path: '/automation/respond', hint: 'Respond',  tone: 'green' },
        { label: 'Follow-ups',          path: '/automation/engage',  hint: 'Engage',   tone: 'purple' },
        { label: 'AI Conversation',     path: '/automation/convert', hint: 'Convert',  tone: 'blue' },
      ],
    },
    { icon: <FileText size={15} />,    label: 'Templates',     path: '/templates' },
    { icon: <BarChart3 size={15} />,   label: 'Insights',      path: '/insights' },
    // Partner Network Beta lives under Settings → Partner Network (last tab)
    // while in beta. The top-level /partner-network/* routes remain available
    // for direct deep-links and for the public /r/:code page.
  ];

  const getPageName = () => {
    const path = location.pathname;
    const navItem = NAV_ITEMS.find(item => item.path === path);
    if (navItem) return navItem.label;
    if (path.startsWith('/automation')) return 'Automation';
    if (path === '/sms-history') return 'SMS History';
    if (path === '/settings') return 'Settings';
    if (path === '/pricing') return 'Pricing';
    if (path === '/admin') return 'Admin Dashboard';
    if (path === '/admin/billing') return 'Subscriptions & Billing';
    if (path === '/admin/tenant-numbers') return 'Tenant Numbers';
    if (path === '/api-test') return 'API Test';
    if (path.startsWith('/admin/users/')) return 'User Details';
    if (path.startsWith('/partner-network')) return 'Partner Network Beta';
    return 'Leadbridge';
  };

  // Top-bar back link — driven by location.state.from set by cross-surface
  // navigations (Edit Hours, Edit Template, Go to Alerts, etc). When state
  // is present, replaces the page title with `← Back to <Label>` so the
  // user can always get back to where they came from with one click.
  const navState = (location.state || null) as { from?: string; fromLabel?: string } | null;
  const backLabelFor = (path: string): string => {
    if (path.startsWith('/automation/respond')) return 'When a Lead Arrives';
    if (path.startsWith('/automation/engage')) return 'Follow-ups';
    if (path.startsWith('/automation/convert')) return 'AI Conversation';
    if (path.startsWith('/automation')) return 'Automation';
    if (path.startsWith('/settings/communication')) return 'Communication';
    if (path.startsWith('/settings')) return 'Settings';
    if (path.startsWith('/templates')) return 'Templates';
    return 'previous page';
  };
  const showBack = !!navState?.from;
  const backLabel = navState?.fromLabel || (navState?.from ? backLabelFor(navState.from) : '');
  const onBack = () => {
    if (navState?.from) navigate(navState.from, { replace: true });
    else navigate(-1);
  };

  const initials = (user?.name?.[0] || user?.email?.[0] || 'U').toUpperCase();
  const businessName = (user as any)?.businessName || user?.name || 'Leadbridge';
  const connectedCount = savedAccounts?.length ?? 0;

  // Shared nav-item renderer — rounded-pill active state with accent-tint + accent text
  const renderNavItem = (item: { icon: React.ReactNode; label: string; path: string }) => (
    <NavLink
      key={item.path}
      to={item.path}
      className={({ isActive }) =>
        `group flex items-center gap-2.5 px-3 py-[8px] rounded-full transition-colors mb-[2px] ` +
        (isActive
          ? 'bg-[var(--lb-accent-tint)] text-[var(--lb-accent)] font-bold'
          : 'text-[var(--lb-ink-4)] hover:bg-[var(--lb-ink-10)] font-medium')
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

  const HINT_TONES: Record<'green' | 'purple' | 'blue' | 'gray', { bg: string; fg: string }> = {
    green:  { bg: '#dcfce7', fg: '#15803d' },
    purple: { bg: '#ede9fe', fg: '#6d28d9' },
    blue:   { bg: '#dbeafe', fg: '#1d4ed8' },
    gray:   { bg: '#f1f5f9', fg: '#475569' },
  };

  // Render a primary nav item that may have nested children. Children show only
  // when the active route is inside the parent's path tree (e.g. /automation/*).
  const renderNavGroup = (item: NavItem) => {
    const parentActive = location.pathname === item.path || location.pathname.startsWith(item.path + '/');
    const hasChildren = !!item.children?.length;
    const showChildren = hasChildren && parentActive;
    const firstChildPath = hasChildren ? item.children![0].path : item.path;

    return (
      <div key={item.path}>
        <NavLink
          to={hasChildren ? firstChildPath : item.path}
          end={!hasChildren}
          className={({ isActive }) => {
            const active = hasChildren ? parentActive : isActive;
            return `group flex items-center gap-2.5 px-3 py-[8px] rounded-full transition-colors mb-[2px] ` +
              (active
                ? 'bg-[var(--lb-accent-tint)] text-[var(--lb-accent)] font-bold'
                : 'text-[var(--lb-ink-4)] hover:bg-[var(--lb-ink-10)] font-medium');
          }}
          onClick={() => setMobileMenuOpen(false)}
          style={{ fontSize: 13 }}
        >
          <span
            className="shrink-0 inline-flex items-center justify-center"
            style={{ color: parentActive ? 'var(--lb-accent)' : 'var(--lb-ink-5)' }}
          >
            {item.icon}
          </span>
          <span className="flex-1 truncate">{item.label}</span>
          {hasChildren && (
            showChildren
              ? <ChevronDown size={13} style={{ color: 'var(--lb-ink-5)', flexShrink: 0 }} />
              : <ChevronRight size={13} style={{ color: 'var(--lb-ink-6)', flexShrink: 0 }} />
          )}
        </NavLink>

        {showChildren && (
          <div
            style={{
              margin: '2px 0 6px 18px',
              paddingLeft: 10,
              borderLeft: '1px solid var(--lb-line)',
              display: 'flex', flexDirection: 'column', gap: 1,
            }}
          >
            {item.children!.map(c => {
              const tone = HINT_TONES[c.tone];
              return (
                <NavLink
                  key={c.path}
                  to={c.path}
                  className={({ isActive }) =>
                    `flex items-center gap-2 rounded-[6px] transition-colors ` +
                    (isActive
                      ? 'bg-[var(--lb-ink-10)] text-[var(--lb-ink-1)] font-semibold'
                      : 'text-[var(--lb-ink-4)] hover:bg-[var(--lb-ink-10)] font-medium')
                  }
                  onClick={() => setMobileMenuOpen(false)}
                  style={{ fontSize: 12.5, padding: '6px 10px' }}
                >
                  <span className="flex-1 truncate">{c.label}</span>
                  <span style={{
                    padding: '2px 7px', borderRadius: 99,
                    background: tone.bg, color: tone.fg,
                    fontSize: 10, fontWeight: 600, letterSpacing: 0.02,
                    flexShrink: 0,
                  }}>{c.hint}</span>
                </NavLink>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--lb-bg)' }}>
      <TrialExpiredModal />

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
            <BrandMark size={24} />
            <div style={{ lineHeight: 1.1 }}>
              <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--lb-ink-1)' }}>LeadBridge</div>
              <div
                style={{
                  fontSize: 9,
                  fontFamily: 'var(--lb-font-mono)',
                  color: 'var(--lb-ink-5)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.12,
                  marginTop: 2,
                }}
              >
                {user?.role === 'ADMIN' ? 'Admin' : 'Pro'}
              </div>
            </div>
          </RouterLink>

          {/* Account selector */}
          <button
            className="flex items-center gap-[10px] w-full text-left"
            style={{
              padding: '10px 12px',
              margin: '8px 0',
              background: 'var(--lb-surface)',
              border: '1px solid var(--lb-line)',
              borderRadius: 12,
              cursor: 'pointer',
              boxShadow: 'var(--lb-shadow-sm)',
            }}
            onClick={() => navigate('/settings')}
            title="Account settings"
          >
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                background: 'var(--lb-success-tint)',
                color: '#0c4a2b',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 800,
                flexShrink: 0,
              }}
            >
              {(businessName[0] || '?').toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div
                className="truncate"
                style={{ fontSize: 12, fontWeight: 700, color: 'var(--lb-ink-1)' }}
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
            {NAV_ITEMS.map(renderNavGroup)}

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
                {renderNavItem({ icon: <DollarSign size={15} />, label: 'Subscriptions', path: '/admin/billing' })}
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
                  background: 'var(--lb-accent-tint)',
                  color: 'var(--lb-accent)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 0.03,
                  flexShrink: 0,
                  border: '1px solid var(--lb-accent-line)',
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
          {location.pathname !== '/lead-activity' && (
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
                    <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--lb-ink-1)' }}>
                      LeadBridge
                    </span>
                  </RouterLink>
                  {showBack ? (
                    <button
                      type="button"
                      onClick={onBack}
                      className="hidden lg:inline-flex"
                      style={{
                        alignItems: 'center', gap: 8,
                        background: 'transparent', border: 0, padding: '4px 8px',
                        borderRadius: 8, cursor: 'pointer',
                        fontFamily: 'inherit',
                        fontSize: 14, fontWeight: 600,
                        color: 'var(--lb-ink-3)',
                        transition: 'background 120ms, color 120ms',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--lb-ink-10)'; e.currentTarget.style.color = 'var(--lb-accent)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--lb-ink-3)'; }}
                    >
                      <ArrowLeft size={16} />
                      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--lb-ink-5)' }}>Back to</span>
                      <span>{backLabel}</span>
                    </button>
                  ) : (
                    <h1
                      className="hidden lg:block"
                      style={{ fontSize: 22, fontWeight: 800, color: 'var(--lb-ink-1)', letterSpacing: '-0.025em', margin: 0 }}
                    >
                      {getPageName()}
                    </h1>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => navigate('/onboarding/setup')}
                    className="flex items-center justify-center hover:scale-105 transition-all"
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 999,
                      background: 'var(--lb-ink-10)',
                      color: 'var(--lb-ink-2)',
                      border: '1px solid var(--lb-line)',
                      cursor: 'pointer',
                    }}
                    title="Open setup guide"
                    aria-label="Open setup guide"
                  >
                    <GraduationCap size={17} />
                  </button>
                </div>
              </div>
            </header>
          )}

          {/* Mobile menu button for Messages page (no top navbar) */}
          {location.pathname === '/lead-activity' && (
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
                  <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--lb-ink-1)' }}>
                    LeadBridge
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
                background: hasCriticalIssues ? 'var(--lb-danger-tint)' : 'var(--lb-warn-tint)',
                borderBottom: `1px solid ${hasCriticalIssues ? 'var(--lb-danger-tint)' : 'var(--lb-warn-tint)'}`,
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
                    color: hasCriticalIssues ? '#991b1b' : '#92400e',
                  }}
                >
                  {systemHealth!.issues.length === 1
                    ? `${systemHealth!.issues[0].accountName} — ${systemHealth!.issues[0].message}`
                    : `${systemHealth!.issues.length} account issue${systemHealth!.issues.length > 1 ? 's' : ''} detected`}
                </span>
                <RouterLink
                  to="/overview"
                  className="ml-auto hover:underline"
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: hasCriticalIssues ? 'var(--lb-danger)' : 'var(--lb-warn)',
                  }}
                >
                  Review in Overview →
                </RouterLink>
              </div>
            </div>
          )}

          <CancelledSubscriptionBanner />

          <Outlet />

          {/* Floating AI assistant trigger — bottom-right. */}
          {!aiChatOpen && (
            <button
              type="button"
              onClick={() => setAiChatOpen(true)}
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
              title="Open AI assistant"
              aria-label="Open AI assistant"
            >
              <Sparkles size={18} />
            </button>
          )}

          {/* AI Assistant chat panel — UI only, no backend wiring yet. */}
          {aiChatOpen && (
            <>
              <div
                onClick={() => setAiChatOpen(false)}
                className="fixed inset-0 z-40"
                style={{ background: 'rgba(0,0,0,0.25)' }}
                aria-hidden
              />
              <div
                className="fixed z-50 flex flex-col"
                role="dialog"
                aria-label="AI assistant chat"
                style={{
                  bottom: 20,
                  right: 20,
                  height: 'min(620px, calc(100vh - 40px))',
                  width: 'min(440px, calc(100vw - 40px))',
                  background: 'var(--lb-surface)',
                  border: '1px solid var(--lb-line)',
                  borderRadius: 18,
                  boxShadow: '0 24px 60px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.06)',
                  overflow: 'hidden',
                }}
              >
                {/* Header */}
                <div
                  className="flex items-center justify-between"
                  style={{
                    padding: '12px 14px',
                    borderBottom: '1px solid var(--lb-line)',
                  }}
                >
                  <div className="flex items-center gap-2.5">
                    <div
                      className="flex items-center justify-center"
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 10,
                        background: 'var(--lb-accent)',
                        color: 'var(--lb-accent-fg)',
                      }}
                    >
                      <Sparkles size={15} />
                    </div>
                    <div className="flex items-center gap-2">
                      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
                        AI Assistant
                      </div>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          letterSpacing: '0.04em',
                          textTransform: 'uppercase',
                          color: 'var(--lb-accent)',
                          background: 'var(--lb-ink-10)',
                          padding: '2px 6px',
                          borderRadius: 999,
                        }}
                      >
                        Beta
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAiChatOpen(false)}
                    className="flex items-center justify-center hover:bg-[var(--lb-ink-10)] transition-colors"
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      background: 'transparent',
                      color: 'var(--lb-ink-4)',
                      border: 0,
                      cursor: 'pointer',
                    }}
                    aria-label="Close AI assistant"
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* Conversation area (empty state with suggested prompts) */}
                <div
                  className="flex-1"
                  style={{
                    overflowY: 'auto',
                    padding: '20px 16px 8px',
                  }}
                >
                  <div className="flex flex-col items-center" style={{ textAlign: 'center', marginBottom: 18 }}>
                    <div
                      className="flex items-center justify-center"
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 12,
                        background: 'var(--lb-ink-10)',
                        color: 'var(--lb-accent)',
                        marginBottom: 10,
                      }}
                    >
                      <Sparkles size={18} />
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
                      How can I help?
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--lb-ink-4)', marginTop: 4, maxWidth: 300, lineHeight: 1.45 }}>
                      Ask about your account, paste a screenshot, or describe what you want to do.
                    </div>
                  </div>

                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--lb-ink-5)', letterSpacing: '0.04em', textTransform: 'uppercase', padding: '0 2px 8px' }}>
                    Try asking
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {[
                      'How do I connect a new account?',
                      'Why did AI stop replying to this lead?',
                      'Draft a follow-up for unresponsive leads',
                    ].map((q, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setAiChatInput(q)}
                        className="text-left hover:border-[var(--lb-accent)] transition-colors"
                        style={{
                          fontSize: 13,
                          color: 'var(--lb-ink-2)',
                          background: 'var(--lb-surface)',
                          border: '1px solid var(--lb-line)',
                          borderRadius: 10,
                          padding: '10px 12px',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Composer */}
                <div
                  style={{
                    padding: '10px 12px 12px',
                    borderTop: '1px solid var(--lb-line)',
                    background: 'var(--lb-surface)',
                  }}
                >
                  {aiChatFiles.length > 0 && (
                    <div className="flex flex-wrap gap-1.5" style={{ marginBottom: 8 }}>
                      {aiChatFiles.map((f, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-1.5"
                          style={{
                            fontSize: 12,
                            padding: '4px 8px 4px 6px',
                            borderRadius: 8,
                            background: 'var(--lb-ink-10)',
                            color: 'var(--lb-ink-2)',
                            border: '1px solid var(--lb-line)',
                          }}
                        >
                          <Paperclip size={11} style={{ color: 'var(--lb-ink-4)' }} />
                          <span style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {f.name}
                          </span>
                          <button
                            type="button"
                            onClick={() => setAiChatFiles(prev => prev.filter((_, idx) => idx !== i))}
                            style={{
                              background: 'transparent',
                              border: 0,
                              padding: 0,
                              cursor: 'pointer',
                              color: 'var(--lb-ink-4)',
                              display: 'inline-flex',
                            }}
                            aria-label={`Remove ${f.name}`}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div
                    className="flex flex-col"
                    style={{
                      background: 'var(--lb-surface)',
                      border: '1px solid var(--lb-line)',
                      borderRadius: 14,
                      padding: '6px 8px 6px 10px',
                      transition: 'border-color 120ms, box-shadow 120ms',
                    }}
                    onFocusCapture={e => {
                      e.currentTarget.style.borderColor = 'var(--lb-accent)';
                      e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.12)';
                    }}
                    onBlurCapture={e => {
                      e.currentTarget.style.borderColor = 'var(--lb-line)';
                      e.currentTarget.style.boxShadow = 'none';
                    }}
                  >
                    <textarea
                      value={aiChatInput}
                      onChange={e => setAiChatInput(e.target.value)}
                      placeholder="Message AI assistant…"
                      rows={1}
                      style={{
                        width: '100%',
                        resize: 'none',
                        background: 'transparent',
                        border: 0,
                        outline: 'none',
                        fontSize: 14,
                        color: 'var(--lb-ink-1)',
                        fontFamily: 'inherit',
                        padding: '6px 2px',
                        maxHeight: 140,
                        lineHeight: 1.5,
                      }}
                    />
                    <div className="flex items-center justify-between" style={{ marginTop: 2 }}>
                      <label
                        className="flex items-center justify-center hover:bg-[var(--lb-ink-10)] transition-colors"
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: 8,
                          color: 'var(--lb-ink-4)',
                          cursor: 'pointer',
                        }}
                        title="Attach files"
                        aria-label="Attach files"
                      >
                        <Paperclip size={15} />
                        <input
                          type="file"
                          multiple
                          className="hidden"
                          onChange={e => {
                            const list = e.target.files;
                            if (!list) return;
                            setAiChatFiles(prev => [...prev, ...Array.from(list)]);
                            e.target.value = '';
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={!aiChatInput.trim() && aiChatFiles.length === 0}
                        className="flex items-center justify-center transition-all"
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: 8,
                          background: aiChatInput.trim() || aiChatFiles.length > 0 ? 'var(--lb-accent)' : 'var(--lb-ink-10)',
                          color: aiChatInput.trim() || aiChatFiles.length > 0 ? 'var(--lb-accent-fg)' : 'var(--lb-ink-5)',
                          border: 0,
                          cursor: aiChatInput.trim() || aiChatFiles.length > 0 ? 'pointer' : 'not-allowed',
                        }}
                        aria-label="Send message"
                      >
                        <Send size={14} />
                      </button>
                    </div>
                  </div>

                  <div style={{ fontSize: 10.5, color: 'var(--lb-ink-5)', textAlign: 'center', marginTop: 8 }}>
                    AI Assistant is in beta — answers may be incomplete.
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
