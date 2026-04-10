import { useState, useEffect } from 'react';
import { Outlet, Link as RouterLink, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  MessageSquare, BarChart3, Settings, LogOut, Shield, FlaskConical,
  Menu, GraduationCap, Zap, AlertTriangle, Workflow, LayoutGrid, Smartphone
} from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { useAppStore } from '../store/appStore';
import TrialBanner from './TrialBanner';
import TrialExpiredModal from './TrialExpiredModal';
import CancelledSubscriptionBanner from './CancelledSubscriptionBanner';
import ImpersonationBanner from './ImpersonationBanner';

export function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout, impersonatingUser } = useAuthStore();
  const savedAccounts = useAppStore(state => state.savedAccounts);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const loadAnalytics = useAppStore(state => state.loadAnalytics);
  const systemHealth = useAppStore(state => state.systemHealth);
  const loadSystemHealth = useAppStore(state => state.loadSystemHealth);

  // Preload analytics + system health on app start
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
    { icon: <LayoutGrid size={20} />, label: 'Overview', path: '/dashboard' },
    { icon: <Workflow size={20} />, label: 'Automation', path: '/services' },
    { icon: <Settings size={20} />, label: 'Templates', path: '/message-settings' },
    { icon: <MessageSquare size={20} />, label: 'Lead Activity', path: '/messages' },
{ icon: <BarChart3 size={20} />, label: 'Insights', path: '/analytics' },
  ];

  // Get current page name from route
  const getPageName = () => {
    const path = location.pathname;
    const navItem = NAV_ITEMS.find(item => item.path === path);
    if (navItem) return navItem.label;

    // Handle other routes
    if (path === '/sms-history') return 'SMS History';
    if (path === '/settings') return 'Settings';
    if (path === '/pricing') return 'Pricing';
    if (path === '/admin') return 'Admin Dashboard';
    if (path === '/admin/tenant-numbers') return 'Tenant Numbers';
    if (path === '/api-test') return 'API Test';
    if (path.startsWith('/admin/users/')) return 'User Details';

    return 'LeadBridge';
  };

  return (
    <div className="flex min-h-screen">
      <TrialExpiredModal />

      {/* Mobile Navigation Overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 lg:hidden" onClick={() => setMobileMenuOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-72 bg-white border-r border-slate-100 transform transition-transform duration-300 ease-in-out ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}>
        <div className="flex flex-col h-full p-6">
          {/* Brand */}
          <RouterLink to="/" className="flex items-center gap-3 mb-10 px-2 hover:opacity-80 transition-opacity">
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-blue-200">
              <Zap className="w-6 h-6" />
            </div>
            <span className="text-xl font-bold tracking-tight">LeadBridge</span>
          </RouterLink>

          {/* Navigation Links */}
          <nav className="flex-1 space-y-1 sidebar-scroll overflow-y-auto">
            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-4 px-2">Main Menu</div>
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) => `flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${isActive ? 'nav-item-active' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}
                onClick={() => setMobileMenuOpen(false)}
              >
                {item.icon}
                <span>{item.label}</span>
              </NavLink>
            ))}

            <div className="pt-8 mb-4 px-2 text-[11px] font-bold text-slate-400 uppercase tracking-widest">Account</div>
            <NavLink
              to="/settings"
              className={({ isActive }) => `flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${isActive ? 'nav-item-active' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}
              onClick={() => setMobileMenuOpen(false)}
            >
              <Settings size={20} />
              <span>Settings</span>
            </NavLink>

            {user?.role === 'ADMIN' && !impersonatingUser && (
              <>
                <div className="pt-8 mb-4 px-2 text-[11px] font-bold text-slate-400 uppercase tracking-widest">Admin</div>
                <NavLink
                  to="/admin"
                  end
                  className={({ isActive }) => `flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${isActive ? 'nav-item-active' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}
                  onClick={() => setMobileMenuOpen(false)}
                >
                  <Shield size={20} />
                  <span>Admin Dashboard</span>
                </NavLink>
                <NavLink
                  to="/admin/tenant-numbers"
                  className={({ isActive }) => `flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${isActive ? 'nav-item-active' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}
                  onClick={() => setMobileMenuOpen(false)}
                >
                  <Smartphone size={20} />
                  <span>Tenant Numbers</span>
                </NavLink>
                <NavLink
                  to="/sms-history"
                  className={({ isActive }) => `flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${isActive ? 'nav-item-active' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}
                  onClick={() => setMobileMenuOpen(false)}
                >
                  <MessageSquare size={20} />
                  <span>SMS History</span>
                </NavLink>
                <NavLink
                  to="/api-test"
                  className={({ isActive }) => `flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${isActive ? 'nav-item-active' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}
                  onClick={() => setMobileMenuOpen(false)}
                >
                  <FlaskConical size={20} />
                  <span>API Test</span>
                </NavLink>
              </>
            )}
          </nav>

          {/* Profile Footer */}
          <div className="mt-auto pt-6 border-t border-slate-100">
            <div className="flex items-center gap-4 px-2">
              <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-blue-100 to-indigo-100 flex items-center justify-center text-blue-700 font-bold border-2 border-white shadow-sm">
                {(user?.name?.[0] || user?.email?.[0] || 'U').toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-900 truncate">{user?.name || 'User'}</p>
                <p className="text-xs text-slate-500 truncate">{user?.email}</p>
              </div>
              <button onClick={handleLogout} className="text-slate-400 hover:text-red-500 transition-colors" title="Logout">
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 lg:ml-72 min-h-screen">
        <ImpersonationBanner />
        {/* Top Navbar — hidden on Messages page (has its own lead header) */}
        {location.pathname !== '/messages' && (
          <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-slate-100 px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="lg:hidden p-2 text-slate-600">
                  <Menu className="w-6 h-6" />
                </button>
                <RouterLink to="/" className="flex items-center gap-2 lg:hidden hover:opacity-80 transition-opacity">
                  <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white shadow-sm shadow-blue-200">
                    <Zap className="w-4 h-4" />
                  </div>
                  <span className="text-lg font-bold tracking-tight text-slate-900">LeadBridge</span>
                </RouterLink>
                <h1 className="text-xl font-bold text-slate-900 lg:block hidden">{getPageName()}</h1>
              </div>
              <div className="flex items-center gap-3">
              </div>
            </div>
          </header>
        )}
        {/* Mobile menu button for Messages page (no top navbar) */}
        {location.pathname === '/messages' && (
          <div className="lg:hidden sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-slate-100 px-4 py-2">
            <div className="flex items-center gap-2">
              <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="p-2 text-slate-600">
                <Menu className="w-5 h-5" />
              </button>
              <RouterLink to="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
                <div className="w-7 h-7 bg-blue-600 rounded-lg flex items-center justify-center text-white shadow-sm shadow-blue-200">
                  <Zap className="w-3.5 h-3.5" />
                </div>
                <span className="text-base font-bold tracking-tight text-slate-900">LeadBridge</span>
              </RouterLink>
            </div>
          </div>
        )}

        {/* Trial Banner - sits below the header, overlays the top of page content */}
        <TrialBanner />

        {/* System Health Banner */}
        {(hasCriticalIssues || hasWarningIssues) && (
          <div className={`px-6 py-3 ${hasCriticalIssues ? 'bg-red-50 border-b border-red-100' : 'bg-amber-50 border-b border-amber-100'}`}>
            <div className="flex items-center gap-3">
              <AlertTriangle className={`w-5 h-5 ${hasCriticalIssues ? 'text-red-600' : 'text-amber-600'}`} />
              <span className={`text-sm font-semibold ${hasCriticalIssues ? 'text-red-900' : 'text-amber-900'}`}>
                {systemHealth!.issues.length === 1
                  ? `${systemHealth!.issues[0].accountName} — ${systemHealth!.issues[0].message}`
                  : `${systemHealth!.issues.length} account issue${systemHealth!.issues.length > 1 ? 's' : ''} detected`}
              </span>
              <RouterLink to="/dashboard" className={`ml-auto text-sm font-bold ${hasCriticalIssues ? 'text-red-600 hover:text-red-700' : 'text-amber-600 hover:text-amber-700'}`}>
                Review in Dashboard →
              </RouterLink>
            </div>
          </div>
        )}
        <CancelledSubscriptionBanner />

        {/* Page Content */}
        <Outlet />

        {/* Floating tour button */}
        <button
          onClick={() => window.dispatchEvent(new Event('lb:start-tour'))}
          className="fixed bottom-6 right-6 z-30 w-12 h-12 bg-blue-600 text-white rounded-full shadow-lg shadow-blue-200 hover:bg-blue-700 hover:scale-105 transition-all flex items-center justify-center"
          title="Quick tour"
        >
          <GraduationCap className="w-5 h-5" />
        </button>
      </main>
    </div>
  );
}
