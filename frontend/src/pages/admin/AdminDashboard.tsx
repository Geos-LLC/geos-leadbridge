import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Users, DollarSign, Activity, TrendingDown, Eye, Trash2, Plus, Minus } from 'lucide-react';
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
    return { label: 'Admin', className: 'px-3 py-1 bg-purple-100 text-purple-700 rounded-full text-xs font-bold uppercase' };
  }
  if (u.subscriptionTier) {
    const colors = {
      STARTER: 'bg-blue-100 text-blue-700',
      PRO: 'bg-indigo-100 text-indigo-700',
      ENTERPRISE: 'bg-purple-100 text-purple-700',
    };
    return {
      label: tierNames[u.subscriptionTier] || u.subscriptionTier,
      className: `px-3 py-1 ${colors[u.subscriptionTier as keyof typeof colors] || 'bg-slate-100 text-slate-700'} rounded-full text-xs font-bold uppercase`,
    };
  }
  return { label: 'Free', className: 'px-3 py-1 bg-slate-100 text-slate-500 rounded-full text-xs font-bold uppercase' };
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
      <div className="p-6 lg:p-10 max-w-7xl mx-auto">
        <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight">Admin Dashboard</h1>
        <div className="flex items-center justify-center py-20">
          <p className="text-slate-500">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-10 max-w-7xl mx-auto space-y-10">
      {/* Header */}
      <section>
        <h1 className="text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight">
          Admin <span className="gradient-text">Dashboard</span>
        </h1>
        <p className="text-slate-500 mt-2 text-lg">Manage users and subscriptions</p>
      </section>

      {/* Stats Grid */}
      {stats && (
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
            <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mb-4">
              <Users className="w-6 h-6" />
            </div>
            <p className="text-slate-500 text-sm font-medium uppercase tracking-wide">Total Users</p>
            <h3 className="text-3xl font-bold text-slate-900 mt-1">{stats.totalUsers}</h3>
          </div>

          <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
            <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center mb-4">
              <DollarSign className="w-6 h-6" />
            </div>
            <p className="text-slate-500 text-sm font-medium uppercase tracking-wide">Monthly Revenue (MRR)</p>
            <h3 className="text-3xl font-bold text-slate-900 mt-1">${stats.monthlyRevenue.toLocaleString()}</h3>
          </div>

          <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
            <div className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center mb-4">
              <Activity className="w-6 h-6" />
            </div>
            <p className="text-slate-500 text-sm font-medium uppercase tracking-wide">Active Subscriptions</p>
            <h3 className="text-3xl font-bold text-slate-900 mt-1">{stats.activeSubscriptions}</h3>
          </div>

          <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
            <div className="w-12 h-12 bg-amber-50 text-amber-600 rounded-2xl flex items-center justify-center mb-4">
              <TrendingDown className="w-6 h-6" />
            </div>
            <p className="text-slate-500 text-sm font-medium uppercase tracking-wide">Churn Rate (30d)</p>
            <h3 className="text-3xl font-bold text-slate-900 mt-1">{stats.churnRate}%</h3>
          </div>
        </section>
      )}

      {/* Users Section */}
      <section className="bg-white rounded-3xl border border-slate-100 shadow-sm p-8">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <h2 className="text-2xl font-bold text-slate-900">Users</h2>
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              placeholder="Search by email or name..."
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              className="px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
            />
            <select
              value={tierFilter}
              onChange={(e) => handleTierFilter(e.target.value)}
              className="px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
            >
              <option value="">All Tiers</option>
              <option value="FREE">Free (Trial)</option>
              <option value="STARTER">Instant Reply</option>
              <option value="PRO">Call Assist</option>
              <option value="ENTERPRISE">AI Conversations</option>
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="text-left py-3 px-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Email</th>
                <th className="text-left py-3 px-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Name</th>
                <th className="text-left py-3 px-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Tier</th>
                <th className="text-left py-3 px-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Leads</th>
                <th className="text-left py-3 px-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Status</th>
                <th className="text-left py-3 px-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Created</th>
                <th className="text-left py-3 px-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const tier = getTierDisplay(u);
                const free = isFreeTier(u);
                return (
                  <tr key={u.id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                    <td className="py-4 px-4 text-sm text-slate-900">{u.email}</td>
                    <td className="py-4 px-4 text-sm text-slate-700">{u.name || '—'}</td>
                    <td className="py-4 px-4">
                      <span className={tier.className}>{tier.label}</span>
                    </td>
                    <td className="py-4 px-4">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-slate-900">{u.leadsCount}</span>
                        {free && (
                          <span className="text-xs text-slate-400">
                            ({u.trialLeadsHandled}/{u.trialLeadsLimit})
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-4 px-4">
                      {u.role === 'ADMIN' ? (
                        <span className="px-3 py-1 bg-purple-100 text-purple-700 rounded-full text-xs font-bold uppercase">ADMIN</span>
                      ) : u.subscriptionStatus ? (
                        <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase ${
                          u.subscriptionStatus === 'ACTIVE' ? 'bg-emerald-100 text-emerald-700' :
                          u.subscriptionStatus === 'TRIALING' ? 'bg-blue-100 text-blue-700' :
                          u.subscriptionStatus === 'PAST_DUE' ? 'bg-amber-100 text-amber-700' :
                          'bg-slate-100 text-slate-700'
                        }`}>
                          {u.subscriptionStatus}
                        </span>
                      ) : free ? (
                        <span className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-bold uppercase">FREE TRIAL</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-4 px-4 text-sm text-slate-700">{new Date(u.createdAt).toLocaleDateString()}</td>
                    <td className="py-4 px-4">
                      <div className="flex items-center gap-2">
                        {free && (
                          <>
                            <button
                              onClick={() => handleAddTrialLeads(u, -1)}
                              className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg transition-all disabled:opacity-50"
                              title="Remove 1 trial lead"
                              disabled={u.trialLeadsHandled <= 0}
                            >
                              <Minus className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleAddTrialLeads(u, 1)}
                              className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-all"
                              title="Add 1 trial lead"
                            >
                              <Plus className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleResetTrialLeads(u)}
                              className="px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all font-medium"
                              title="Reset trial leads to 0"
                            >
                              Reset
                            </button>
                          </>
                        )}
                        <Link
                          to={`/admin/users/${u.id}`}
                          className="p-1.5 text-slate-600 hover:bg-slate-100 rounded-lg transition-all"
                          title="View Details"
                        >
                          <Eye className="w-4 h-4" />
                        </Link>
                        <button
                          onClick={() => handleDeleteUser(u.id, u.email)}
                          className="p-1.5 text-red-600 hover:bg-red-50 rounded-lg transition-all"
                          title="Delete User"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {users.length === 0 && !loading && (
            <div className="text-center py-12">
              <p className="text-slate-500">No users found</p>
            </div>
          )}

          {total > limit && (
            <div className="flex items-center justify-between mt-6 pt-6 border-t border-slate-100">
              <button
                onClick={() => setOffset(Math.max(0, offset - limit))}
                disabled={offset === 0}
                className="px-6 py-2 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="text-sm text-slate-600">
                Showing {offset + 1} to {Math.min(offset + limit, total)} of {total}
              </span>
              <button
                onClick={() => setOffset(offset + limit)}
                disabled={offset + limit >= total}
                className="px-6 py-2 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
