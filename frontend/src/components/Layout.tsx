import { useState, useEffect } from 'react';
import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { Home, MessageSquare, BarChart3, Settings, LogOut, Phone, Shield, FlaskConical, Briefcase, Menu, X } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import TrialBanner from './TrialBanner';
import TrialExpiredModal from './TrialExpiredModal';
import CancelledSubscriptionBanner from './CancelledSubscriptionBanner';
import '../styles/TrialBanner.css';

export function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuthStore();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const isActive = (path: string) => location.pathname === path;
  const closeMenu = () => setMobileMenuOpen(false);

  return (
    <div className="app-layout">
      <TrialExpiredModal />
      <nav className={`sidebar-nav ${mobileMenuOpen ? 'open' : ''}`}>
        <div className="nav-brand">
          <img src="/LeadBridge_Logo.png" alt="LeadBridge" className="nav-logo" />
        </div>

        <div className="nav-links">
          <Link to="/dashboard" className={`nav-link ${isActive('/dashboard') ? 'active' : ''}`} onClick={closeMenu}>
            <Home size={20} />
            <span>Overview</span>
          </Link>
          <Link to="/services" className={`nav-link ${isActive('/services') ? 'active' : ''}`} onClick={closeMenu}>
            <Briefcase size={20} />
            <span>Automation</span>
          </Link>
          <Link to="/message-settings" className={`nav-link ${isActive('/message-settings') ? 'active' : ''}`} onClick={closeMenu}>
            <Settings size={20} />
            <span>Templates</span>
          </Link>
          <Link to="/messages" className={`nav-link ${isActive('/messages') ? 'active' : ''}`} onClick={closeMenu}>
            <MessageSquare size={20} />
            <span>Lead Activity</span>
          </Link>
          <Link to="/phone-settings" className={`nav-link ${isActive('/phone-settings') ? 'active' : ''}`} onClick={closeMenu}>
            <Phone size={20} />
            <span>Business Line</span>
          </Link>
          <Link to="/analytics" className={`nav-link ${isActive('/analytics') ? 'active' : ''}`} onClick={closeMenu}>
            <BarChart3 size={20} />
            <span>Insights</span>
          </Link>

          <div className="nav-separator"></div>

          <div className="nav-section-label">Account</div>
          <Link to="/settings" className={`nav-link ${isActive('/settings') ? 'active' : ''}`} onClick={closeMenu}>
            <Settings size={20} />
            <span>Settings</span>
          </Link>

          {user?.role === 'ADMIN' && (
            <>
              <div className="nav-separator"></div>
              <Link to="/admin" className={`nav-link ${isActive('/admin') || (location.pathname.startsWith('/admin/') && !location.pathname.startsWith('/admin/phone-pool')) ? 'active' : ''}`} onClick={closeMenu}>
                <Shield size={20} />
                <span>Admin</span>
              </Link>
              <Link to="/admin/phone-pool" className={`nav-link ${isActive('/admin/phone-pool') ? 'active' : ''}`} onClick={closeMenu}>
                <Phone size={20} />
                <span>Phone Pool</span>
              </Link>
              <Link to="/api-test" className={`nav-link ${isActive('/api-test') ? 'active' : ''}`} onClick={closeMenu}>
                <FlaskConical size={20} />
                <span>API Test</span>
              </Link>
            </>
          )}
        </div>

        <div className="nav-footer">
          <div className="user-info">
            <div className="user-avatar">
              {(user?.name?.[0] || user?.email?.[0] || 'U').toUpperCase()}
            </div>
            <div className="user-details">
              <span className="user-name">{user?.name || 'User'}</span>
              <span className="user-email">{user?.email}</span>
            </div>
          </div>
          <button className="btn-icon logout-btn" onClick={handleLogout} title="Logout">
            <LogOut size={20} />
          </button>
        </div>
      </nav>

      {mobileMenuOpen && <div className="sidebar-backdrop" onClick={closeMenu} />}

      <main className="main-content">
        <div className="mobile-header">
          <button className="mobile-menu-btn" onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
            {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
          <div className="mobile-header-brand">
            <img src="/LeadBridge_Logo.png" alt="LeadBridge" className="mobile-header-logo" />
            <span className="mobile-header-name">LeadBridge</span>
          </div>
        </div>
        <TrialBanner />
        <CancelledSubscriptionBanner />
        <Outlet />
      </main>
    </div>
  );
}
