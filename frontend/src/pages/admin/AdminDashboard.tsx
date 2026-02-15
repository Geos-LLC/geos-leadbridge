import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { adminApi } from '../../services/api';
import { notify } from '../../store/notificationStore';
import { useAuthStore } from '../../store/authStore';
import type { AdminUser, AdminStats } from '../../types';

const tierNames: Record<string, string> = {
  STARTER: 'Instant Reply',
  PRO: 'Call Assist',
  ENTERPRISE: 'AI Conversations',
};

function getTierDisplay(u: AdminUser): { label: string; className: string } {
  if (u.role === 'ADMIN') {
    return { label: 'Admin', className: 'tier-badge tier-admin' };
  }
  if (u.subscriptionTier) {
    return {
      label: tierNames[u.subscriptionTier] || u.subscriptionTier,
      className: `tier-badge tier-${u.subscriptionTier.toLowerCase()}`,
    };
  }
  return { label: 'Free', className: 'tier-badge tier-free' };
}

export default function AdminDashboard() {
  const user = useAuthStore((state) => state.user);
  const navigate = useNavigate();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState<string>('');
  const [total, setTotal] = useState(0);
  const [limit] = useState(50);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    if (user?.role !== 'ADMIN') {
      notify.error('Access Denied', 'You must be an admin to access this page');
      navigate('/');
      return;
    }

    loadData();
  }, [user, offset, tierFilter, search]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [statsData, usersData] = await Promise.all([
        adminApi.getStats(),
        adminApi.listUsers({ search, tier: tierFilter || undefined, offset, limit }),
      ]);
      setStats(statsData);
      setUsers(usersData.users);
      setTotal(usersData.total);
    } catch (error: any) {
      console.error('Failed to load admin data:', error);
      notify.error('Error', 'Failed to load admin dashboard');
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (value: string) => {
    setSearch(value);
    setOffset(0);
  };

  const handleTierFilter = (value: string) => {
    setTierFilter(value);
    setOffset(0);
  };

  const handleDeleteUser = async (userId: string, email: string) => {
    if (!confirm(`Are you sure you want to delete user ${email}? This action cannot be undone.`)) {
      return;
    }

    try {
      await adminApi.deleteUser(userId);
      notify.success('User Deleted', `Successfully deleted user ${email}`);
      loadData();
    } catch (error: any) {
      console.error('Failed to delete user:', error);
      notify.error('Error', 'Failed to delete user');
    }
  };

  const handleAddTrialLeads = async (u: AdminUser, amount: number) => {
    try {
      const newCount = Math.max(0, u.trialLeadsHandled + amount);
      await adminApi.updateTrialLeads(u.id, { trialLeadsHandled: newCount });
      notify.success('Updated', `Trial leads set to ${newCount}/${u.trialLeadsLimit}`);
      loadData();
    } catch (error: any) {
      console.error('Failed to update trial leads:', error);
      notify.error('Error', 'Failed to update trial leads');
    }
  };

  const handleResetTrialLeads = async (u: AdminUser) => {
    try {
      await adminApi.updateTrialLeads(u.id, { trialLeadsHandled: 0 });
      notify.success('Reset', 'Trial leads reset to 0');
      loadData();
    } catch (error: any) {
      console.error('Failed to reset trial leads:', error);
      notify.error('Error', 'Failed to reset trial leads');
    }
  };

  const isFreeTier = (u: AdminUser) => !u.subscriptionTier && u.role !== 'ADMIN';

  if (loading && !stats) {
    return (
      <div className="admin-dashboard">
        <div className="admin-header">
          <h1>Admin Dashboard</h1>
        </div>
        <div className="loading-state">
          <p>Loading dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-dashboard">
      <div className="admin-header">
        <h1>Admin Dashboard</h1>
        <p>Manage users and subscriptions</p>
      </div>

      {stats && (
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" strokeWidth="2" strokeLinecap="round" />
                <circle cx="9" cy="7" r="4" strokeWidth="2" />
                <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
            <div className="stat-content">
              <div className="stat-value">{stats.totalUsers}</div>
              <div className="stat-label">Total Users</div>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
            <div className="stat-content">
              <div className="stat-value">${stats.monthlyRevenue.toLocaleString()}</div>
              <div className="stat-label">Monthly Revenue (MRR)</div>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div className="stat-content">
              <div className="stat-value">{stats.activeSubscriptions}</div>
              <div className="stat-label">Active Subscriptions</div>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path d="M3 3v18h18" strokeWidth="2" strokeLinecap="round" />
                <path d="M18 17l-3-3-4 4-5-5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div className="stat-content">
              <div className="stat-value">{stats.churnRate}%</div>
              <div className="stat-label">Churn Rate (30d)</div>
            </div>
          </div>
        </div>
      )}

      <div className="users-section">
        <div className="section-header">
          <h2>Users</h2>
          <div className="section-actions">
            <input
              type="text"
              placeholder="Search by email or name..."
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              className="search-input"
            />
            <select
              value={tierFilter}
              onChange={(e) => handleTierFilter(e.target.value)}
              className="filter-select"
            >
              <option value="">All Tiers</option>
              <option value="FREE">Free (Trial)</option>
              <option value="STARTER">Instant Reply</option>
              <option value="PRO">Call Assist</option>
              <option value="ENTERPRISE">AI Conversations</option>
            </select>
          </div>
        </div>

        <div className="users-table-container">
          <table className="users-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Tier</th>
                <th>Leads</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const tier = getTierDisplay(u);
                const free = isFreeTier(u);
                return (
                  <tr key={u.id}>
                    <td>{u.email}</td>
                    <td>{u.name || '—'}</td>
                    <td>
                      <span className={tier.className}>{tier.label}</span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontWeight: 600, fontSize: '13px' }}>{u.leadsCount}</span>
                        {free && (
                          <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                            ({u.trialLeadsHandled}/{u.trialLeadsLimit})
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      {u.role === 'ADMIN' ? (
                        <span className="status-badge status-active">ADMIN</span>
                      ) : u.subscriptionStatus ? (
                        <span className={`status-badge status-${u.subscriptionStatus.toLowerCase()}`}>
                          {u.subscriptionStatus}
                        </span>
                      ) : free ? (
                        <span className="status-badge status-trialing">FREE TRIAL</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                    <td>
                      <div className="action-buttons">
                        {free && (
                          <>
                            <button
                              onClick={() => handleAddTrialLeads(u, -1)}
                              className="btn-icon"
                              title="Remove 1 trial lead"
                              disabled={u.trialLeadsHandled <= 0}
                              style={{ fontSize: '16px', fontWeight: 700, color: '#ef4444' }}
                            >
                              &minus;
                            </button>
                            <button
                              onClick={() => handleAddTrialLeads(u, 1)}
                              className="btn-icon"
                              title="Add 1 trial lead"
                              style={{ fontSize: '16px', fontWeight: 700, color: '#059669' }}
                            >
                              +
                            </button>
                            <button
                              onClick={() => handleResetTrialLeads(u)}
                              className="btn-icon"
                              title="Reset trial leads to 0"
                              style={{ fontSize: '11px', color: '#6366f1' }}
                            >
                              Reset
                            </button>
                          </>
                        )}
                        <Link to={`/admin/users/${u.id}`} className="btn-icon" title="View Details">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" strokeWidth="2" />
                            <circle cx="12" cy="12" r="3" strokeWidth="2" />
                          </svg>
                        </Link>
                        <button
                          onClick={() => handleDeleteUser(u.id, u.email)}
                          className="btn-icon btn-danger"
                          title="Delete User"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" strokeWidth="2" strokeLinecap="round" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {users.length === 0 && !loading && (
            <div className="empty-state">
              <p>No users found</p>
            </div>
          )}

          {total > limit && (
            <div className="pagination">
              <button
                onClick={() => setOffset(Math.max(0, offset - limit))}
                disabled={offset === 0}
                className="btn-secondary"
              >
                Previous
              </button>
              <span className="pagination-info">
                Showing {offset + 1} to {Math.min(offset + limit, total)} of {total}
              </span>
              <button
                onClick={() => setOffset(offset + limit)}
                disabled={offset + limit >= total}
                className="btn-secondary"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
