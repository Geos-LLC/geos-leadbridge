import { Outlet, Link, useNavigate, useLocation } from 'react-router-dom';
import { Home, MessageSquare, LogOut } from 'lucide-react';
import { useAuthStore } from '../store/authStore';

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
      <nav className="sidebar-nav">
        <div className="nav-brand">
          <span className="brand-icon">TB</span>
          <span className="brand-text">Thumbtack Bridge</span>
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
        <Outlet />
      </main>
    </div>
  );
}
