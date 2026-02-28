import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Users, DollarSign, Activity, TrendingDown, Eye, Trash2, Plus, Minus, ChevronRight, AlertTriangle } from 'lucide-react';
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

  // Tenant error feed
  const [tenantErrors, setTenantErrors] = useState<any[]>([]);
  const [tenantErrorsTotal, setTenantErrorsTotal] = useState(0);
  const [failedCount24h, setFailedCount24h] = useState(0);
  const [errorsLoading, setErrorsLoading] = useState(true);
  const [errorsLimit] = useState(10);
  const [errorsOffset, setErrorsOffset] = useState(0);
  const [errorStatusFilter, setErrorStatusFilter] = useState('failed');
  const [expandedErrorId, setExpandedErrorId] = useState<string | null>(null);

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

  const loadTenantErrors = async () => {
    try {
      setErrorsLoading(true);
      const result = await adminApi.getTenantErrors({
        status: errorStatusFilter,
        limit: errorsLimit,
        offset: errorsOffset,
      });
      setTenantErrors(result.logs);
      setTenantErrorsTotal(result.total);
      setFailedCount24h(result.failedCount24h);
    } catch {
      console.error('Failed to load tenant errors');
    } finally {
      setErrorsLoading(false);
    }
  };

  useEffect(() => {
    if (user?.role === 'ADMIN') {
      loadTenantErrors();
    }
  }, [errorsOffset, errorStatusFilter]);

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
        <section className="grid grid-cols-2 lg:grid-cols-5 gap-4 md:gap-6">
          <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
            <div className="w-10 h-10 md:w-12 md:h-12 bg-blue-50 text-blue-600 rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
              <Users className="w-5 h-5 md:w-6 md:h-6" />
            </div>
            <p className="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-wide">Total Users</p>
            <h3 className="text-2xl md:text-3xl font-bold text-slate-900 mt-1">{stats.totalUsers}</h3>
          </div>

          <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
            <div className="w-10 h-10 md:w-12 md:h-12 bg-emerald-50 text-emerald-600 rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
              <DollarSign className="w-5 h-5 md:w-6 md:h-6" />
            </div>
            <p className="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-wide">MRR</p>
            <h3 className="text-2xl md:text-3xl font-bold text-slate-900 mt-1">${stats.monthlyRevenue.toLocaleString()}</h3>
          </div>

          <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
            <div className="w-10 h-10 md:w-12 md:h-12 bg-indigo-50 text-indigo-600 rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
              <Activity className="w-5 h-5 md:w-6 md:h-6" />
            </div>
            <p className="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-wide">Active Subs</p>
            <h3 className="text-2xl md:text-3xl font-bold text-slate-900 mt-1">{stats.activeSubscriptions}</h3>
          </div>

          <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
            <div className="w-10 h-10 md:w-12 md:h-12 bg-amber-50 text-amber-600 rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
              <TrendingDown className="w-5 h-5 md:w-6 md:h-6" />
            </div>
            <p className="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-wide">Churn (30d)</p>
            <h3 className="text-2xl md:text-3xl font-bold text-slate-900 mt-1">{stats.churnRate}%</h3>
          </div>

          <div className={`bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border shadow-sm hover:shadow-md transition-all ${failedCount24h > 0 ? 'border-red-200' : 'border-slate-100'}`}>
            <div className={`w-10 h-10 md:w-12 md:h-12 rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4 ${failedCount24h > 0 ? 'bg-red-50 text-red-600' : 'bg-slate-50 text-slate-400'}`}>
              <AlertTriangle className="w-5 h-5 md:w-6 md:h-6" />
            </div>
            <p className="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-wide">Failed SMS (24h)</p>
            <h3 className={`text-2xl md:text-3xl font-bold mt-1 ${failedCount24h > 0 ? 'text-red-600' : 'text-slate-900'}`}>{failedCount24h}</h3>
          </div>
        </section>
      )}

      {/* SMS Error Feed */}
      <section className="bg-white rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm p-4 md:p-8">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <div>
            <h2 className="text-xl md:text-2xl font-bold text-slate-900">SMS Error Feed</h2>
            <p className="text-sm text-slate-500 mt-1">{tenantErrorsTotal} total {errorStatusFilter === 'all' ? 'entries' : errorStatusFilter}</p>
          </div>
          <select
            value={errorStatusFilter}
            onChange={(e) => { setErrorStatusFilter(e.target.value); setErrorsOffset(0); }}
            className="px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-sm"
          >
            <option value="failed">Failed Only</option>
            <option value="all">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="sent">Sent</option>
            <option value="delivered">Delivered</option>
          </select>
        </div>

        {errorsLoading ? (
          <div className="flex items-center justify-center py-12">
            <p className="text-slate-500">Loading...</p>
          </div>
        ) : tenantErrors.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-slate-500">No {errorStatusFilter === 'all' ? 'notifications' : errorStatusFilter + ' notifications'} found</p>
          </div>
        ) : (
          <div className="space-y-2">
            {tenantErrors.map((log: any) => (
              <div
                key={log.id}
                className="border border-slate-100 rounded-xl p-4 hover:bg-slate-50 transition-colors cursor-pointer"
                onClick={() => setExpandedErrorId(expandedErrorId === log.id ? null : log.id)}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase shrink-0 ${
                      log.status === 'failed' ? 'bg-red-100 text-red-700' :
                      log.status === 'delivered' ? 'bg-green-100 text-green-700' :
                      log.status === 'sent' ? 'bg-blue-100 text-blue-700' :
                      'bg-yellow-100 text-yellow-700'
                    }`}>
                      {log.status}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900 truncate">
                        {log.savedAccount?.businessName || 'Unknown Account'}
                      </p>
                      <p className="text-xs text-slate-500 truncate">
                        {log.savedAccount?.user?.email || 'Unknown user'} &middot; {log.ruleName || 'Manual SMS'}
                      </p>
                    </div>
                  </div>
                  <div className="text-right shrink-0 ml-4">
                    <p className="text-xs text-slate-500">
                      {new Date(log.createdAt).toLocaleDateString()}{' '}
                      {new Date(log.createdAt).toLocaleTimeString()}
                    </p>
                    <p className="text-xs font-mono text-slate-400">{log.toPhone}</p>
                  </div>
                </div>
                {expandedErrorId === log.id && (
                  <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
                    {log.error && (
                      <div className="bg-red-50 border border-red-100 rounded-lg p-3">
                        <p className="text-xs font-semibold text-red-700">Error</p>
                        <p className="text-xs text-red-600 mt-1">{log.error}</p>
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-slate-500">From:</span>{' '}
                        <span className="font-mono text-slate-700">{log.fromPhone || 'N/A'}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">To:</span>{' '}
                        <span className="font-mono text-slate-700">{log.toPhone}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Provider:</span>{' '}
                        <span className="text-slate-700">{log.provider || 'N/A'}</span>
                      </div>
                      <div>
                        <span className="text-slate-500">Rule:</span>{' '}
                        <span className="text-slate-700">{log.ruleName || 'N/A'}</span>
                      </div>
                    </div>
                    {log.messageBody && (
                      <div className="bg-slate-50 rounded-lg p-3">
                        <p className="text-xs font-semibold text-slate-600">Message</p>
                        <p className="text-xs text-slate-500 mt-1 whitespace-pre-wrap line-clamp-4">{log.messageBody}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {tenantErrorsTotal > errorsLimit && (
          <div className="flex items-center justify-between mt-6 pt-6 border-t border-slate-100">
            <button
              onClick={() => setErrorsOffset(Math.max(0, errorsOffset - errorsLimit))}
              disabled={errorsOffset === 0}
              className="px-4 md:px-6 py-2 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              Previous
            </button>
            <span className="text-xs md:text-sm text-slate-600">
              {errorsOffset + 1}–{Math.min(errorsOffset + errorsLimit, tenantErrorsTotal)} of {tenantErrorsTotal}
            </span>
            <button
              onClick={() => setErrorsOffset(errorsOffset + errorsLimit)}
              disabled={errorsOffset + errorsLimit >= tenantErrorsTotal}
              className="px-4 md:px-6 py-2 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              Next
            </button>
          </div>
        )}
      </section>

      {/* Users Section */}
      <section className="bg-white rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm p-4 md:p-8">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <h2 className="text-xl md:text-2xl font-bold text-slate-900">Users</h2>
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              placeholder="Search by email or name..."
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
              className="px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-sm"
            />
            <select
              value={tierFilter}
              onChange={(e) => handleTierFilter(e.target.value)}
              className="px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all text-sm"
            >
              <option value="">All Tiers</option>
              <option value="FREE">Free (Trial)</option>
              <option value="STARTER">Instant Reply</option>
              <option value="PRO">Call Assist</option>
              <option value="ENTERPRISE">AI Conversations</option>
            </select>
          </div>
        </div>

        {/* Mobile: Card list */}
        <div className="md:hidden space-y-2">
          {users.map((u) => {
            const tier = getTierDisplay(u);
            return (
              <Link
                key={u.id}
                to={`/admin/users/${u.id}`}
                className="flex items-center gap-3 p-3 rounded-xl hover:bg-slate-50 transition-colors border border-slate-100"
              >
                <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-blue-100 to-indigo-100 flex items-center justify-center text-blue-700 font-bold text-sm shrink-0">
                  {(u.name?.[0] || u.email[0]).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-900 truncate">{u.name || u.email.split('@')[0]}</p>
                  <p className="text-xs text-slate-500 truncate">{u.email}</p>
                </div>
                <span className={tier.className}>{tier.label}</span>
                <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
              </Link>
            );
          })}
        </div>

        {/* Desktop: Full table */}
        <div className="hidden md:block overflow-x-auto">
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
        </div>

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
              className="px-4 md:px-6 py-2 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              Previous
            </button>
            <span className="text-xs md:text-sm text-slate-600">
              {offset + 1}–{Math.min(offset + limit, total)} of {total}
            </span>
            <button
              onClick={() => setOffset(offset + limit)}
              disabled={offset + limit >= total}
              className="px-4 md:px-6 py-2 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              Next
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
