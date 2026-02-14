import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { Home, MessageSquare, BarChart3, Settings, LogOut, Phone, CreditCard, Shield, FlaskConical, Briefcase } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import TrialBanner from './TrialBanner';
import TrialExpiredModal from './TrialExpiredModal';
import CancelledSubscriptionBanner from './CancelledSubscriptionBanner';
import '../styles/TrialBanner.css';

export function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuthStore();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const isActive = (path: string) => location.pathname === path;

  return (
    <div className="app-layout">
      <TrialExpiredModal />
      <nav className="sidebar-nav">
        <div className="nav-brand">
          <img src="/LeadBridge_Logo.png" alt="LeadBridge" className="nav-logo" />
        </div>

        <div className="nav-links">
          <Link to="/dashboard" className={`nav-link ${isActive('/dashboard') ? 'active' : ''}`}>
            <Home size={20} />
            <span>Overview</span>
          </Link>
          <Link to="/services" className={`nav-link ${isActive('/services') ? 'active' : ''}`}>
            <Briefcase size={20} />
            <span>Automation</span>
          </Link>
          <Link to="/message-settings" className={`nav-link ${isActive('/message-settings') ? 'active' : ''}`}>
            <Settings size={20} />
            <span>Templates</span>
          </Link>
          <Link to="/messages" className={`nav-link ${isActive('/messages') ? 'active' : ''}`}>
            <MessageSquare size={20} />
            <span>Lead Activity</span>
          </Link>
          <Link to="/phone-settings" className={`nav-link ${isActive('/phone-settings') ? 'active' : ''}`}>
            <Phone size={20} />
            <span>Business Line</span>
          </Link>
          <Link to="/analytics" className={`nav-link ${isActive('/analytics') ? 'active' : ''}`}>
            <BarChart3 size={20} />
            <span>Insights</span>
          </Link>

          <div className="nav-separator"></div>

          <div className="nav-section-label">Account</div>
          <Link to="/billing" className={`nav-link ${isActive('/billing') ? 'active' : ''}`}>
            <CreditCard size={20} />
            <span>Billing</span>
          </Link>

          {user?.role === 'ADMIN' && (
            <>
              <div className="nav-separator"></div>
              <Link to="/admin" className={`nav-link ${isActive('/admin') || (location.pathname.startsWith('/admin/') && !location.pathname.startsWith('/admin/phone-pool')) ? 'active' : ''}`}>
                <Shield size={20} />
                <span>Admin</span>
              </Link>
              <Link to="/admin/phone-pool" className={`nav-link ${isActive('/admin/phone-pool') ? 'active' : ''}`}>
                <Phone size={20} />
                <span>Phone Pool</span>
              </Link>
              <Link to="/api-test" className={`nav-link ${isActive('/api-test') ? 'active' : ''}`}>
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

      <main className="main-content">
        <TrialBanner />
        <CancelledSubscriptionBanner />
        <Outlet />
      </main>
    </div>
  );
}
