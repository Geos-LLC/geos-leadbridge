import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { Home, MessageSquare, BarChart3, Settings, LogOut, Zap, Bell, Phone, CreditCard, Shield } from 'lucide-react';
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
          <img src="/Thumbtack_Bridge_Logo.png" alt="Thumbtack Bridge" className="nav-logo" />
        </div>

        <div className="nav-links">
          <Link to="/dashboard" className={`nav-link ${isActive('/dashboard') ? 'active' : ''}`}>
            <Home size={20} />
            <span>Dashboard</span>
          </Link>
          <Link to="/messages" className={`nav-link ${isActive('/messages') ? 'active' : ''}`}>
            <MessageSquare size={20} />
            <span>Messages</span>
          </Link>
          <Link to="/analytics" className={`nav-link ${isActive('/analytics') ? 'active' : ''}`}>
            <BarChart3 size={20} />
            <span>Analytics</span>
          </Link>
          <Link to="/message-settings" className={`nav-link ${isActive('/message-settings') ? 'active' : ''}`}>
            <Settings size={20} />
            <span>Templates</span>
          </Link>
          <Link to="/automation" className={`nav-link ${isActive('/automation') ? 'active' : ''}`}>
            <Zap size={20} />
            <span>Automations</span>
          </Link>
          <Link to="/notifications" className={`nav-link ${isActive('/notifications') ? 'active' : ''}`}>
            <Bell size={20} />
            <span>SMS Alerts</span>
          </Link>
          <Link to="/phone-settings" className={`nav-link ${isActive('/phone-settings') ? 'active' : ''}`}>
            <Phone size={20} />
            <span>Phone Settings</span>
          </Link>

          <div className="nav-separator"></div>

          <Link to="/billing" className={`nav-link ${isActive('/billing') ? 'active' : ''}`}>
            <CreditCard size={20} />
            <span>Billing</span>
          </Link>
          {user?.role === 'ADMIN' && (
            <Link to="/admin" className={`nav-link ${isActive('/admin') || location.pathname.startsWith('/admin/') ? 'active' : ''}`}>
              <Shield size={20} />
              <span>Admin</span>
            </Link>
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
