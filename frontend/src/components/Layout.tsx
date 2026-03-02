import { useState, useEffect } from 'react';
import { Outlet, Link as RouterLink, NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  MessageSquare, BarChart3, Settings, LogOut, Phone, Shield, FlaskConical,
  Menu, Bell, Zap, AlertTriangle, Workflow, LayoutGrid, Smartphone
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
  const { user, logout } = useAuthStore();
  const savedAccounts = useAppStore(state => state.savedAccounts);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const loadAnalytics = useAppStore(state => state.loadAnalytics);
  const hasAccounts = savedAccounts.length > 0;
  const allDisconnected = hasAccounts && savedAccounts.every(a => !a.webhookId);
  const someDisconnected = hasAccounts && !allDisconnected && savedAccounts.some(a => !a.webhookId);

  // Preload analytics data on app start — always force-refresh so cache stays current
  useEffect(() => {
    loadAnalytics(true);
  }, []);

  // Track when savedAccounts changes to debug banner visibility
  useEffect(() => {
    console.log('[Layout] savedAccounts updated:', savedAccounts.map(a => ({ id: a.id, name: a.businessName, webhookId: a.webhookId })));
    console.log('[Layout] Banner state: allDisconnected=', allDisconnected, 'someDisconnected=', someDisconnected);
  }, [savedAccounts]);

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
    { icon: <Phone size={20} />, label: 'Business Line', path: '/phone-settings' },
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
    if (path === '/admin/phone-pool') return 'Phone Pool';
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

            {user?.role === 'ADMIN' && (
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
                  to="/admin/phone-pool"
                  className={({ isActive }) => `flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${isActive ? 'nav-item-active' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}
                  onClick={() => setMobileMenuOpen(false)}
                >
                  <Phone size={20} />
                  <span>Phone Pool</span>
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
        {/* Top Navbar */}
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
              <button className="relative p-2 text-slate-400 hover:text-slate-600 transition-colors">
                <Bell className="w-6 h-6" />
              </button>
            </div>
          </div>
        </header>

        {/* Trial Banner - sits below the header, overlays the top of page content */}
        <TrialBanner />

        {/* Banners */}
        {(allDisconnected || someDisconnected) && (
          <div className={`px-6 py-3 ${allDisconnected ? 'bg-red-50 border-b border-red-100' : 'bg-amber-50 border-b border-amber-100'}`}>
            <div className="flex items-center gap-3">
              <AlertTriangle className={`w-5 h-5 ${allDisconnected ? 'text-red-600' : 'text-amber-600'}`} />
              <span className={`text-sm font-semibold ${allDisconnected ? 'text-red-900' : 'text-amber-900'}`}>
                {allDisconnected
                  ? 'Thumbtack Disconnected – Automation Paused'
                  : `${savedAccounts.filter(a => !a.webhookId).length} account${savedAccounts.filter(a => !a.webhookId).length > 1 ? 's' : ''} disconnected`}
              </span>
              <RouterLink to="/dashboard?reconnect=1" className={`ml-auto text-sm font-bold ${allDisconnected ? 'text-red-600 hover:text-red-700' : 'text-amber-600 hover:text-amber-700'}`}>
                Reconnect Now →
              </RouterLink>
            </div>
          </div>
        )}
        <CancelledSubscriptionBanner />

        {/* Page Content */}
        <Outlet />
      </main>
    </div>
  );
}
