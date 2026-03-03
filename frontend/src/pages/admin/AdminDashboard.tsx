import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Users, DollarSign, Activity, TrendingDown, Eye, Trash2, Plus, Minus, ChevronRight, Loader2 } from 'lucide-react';
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

  // Phone pricing config
  const [phonePriceMonthly, setPhonePriceMonthly] = useState<string>('');
  const [phoneGracePeriodDays, setPhoneGracePeriodDays] = useState<string>('30');
  const [phonePricingSaving, setPhonePricingSaving] = useState(false);
  const [currentStripePriceId, setCurrentStripePriceId] = useState<string | null>(null);

  // Test customer setup
  const [testData, setTestData] = useState<Record<string, string>>({
    customerName: 'Test Customer', firstName: 'Test', accountName: 'Test Business',
    category: 'House Cleaning', city: 'Tampa', state: 'FL', location: 'Tampa, FL', zip: '33601',
    message: 'Looking for reliable cleaning services', serviceDescription: 'Standard home cleaning',
    addons: '', frequency: 'Weekly', bedrooms: '3', bathrooms: '2',
    price: '$120', pets: 'None', estimate: '$120', dates: 'Flexible',
  });
  const [testConfigSaving, setTestConfigSaving] = useState(false);

  useEffect(() => {
    if (user?.role !== 'ADMIN') {
      notify.error('Access Denied', 'You must be an admin to access this page');
      navigate('/');
      return;
    }

    loadData();
    loadPhonePricing();
    loadAdminConfig();
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


  const loadPhonePricing = async () => {
    try {
      const pricing = await adminApi.getPhonePricing();
      if (pricing.priceMonthly != null) setPhonePriceMonthly(pricing.priceMonthly.toString());
      setPhoneGracePeriodDays(pricing.gracePeriodDays.toString());
      setCurrentStripePriceId(pricing.stripePriceId);
    } catch {
      // keep defaults
    }
  };

  const handleSavePhonePricing = async () => {
    const price = parseFloat(phonePriceMonthly);
    const grace = parseInt(phoneGracePeriodDays, 10);
    if (isNaN(price) || price <= 0) {
      notify.error('Invalid', 'Price must be a positive number');
      return;
    }
    if (isNaN(grace) || grace < 0) {
      notify.error('Invalid', 'Grace period must be 0 or more days');
      return;
    }
    try {
      setPhonePricingSaving(true);
      const result = await adminApi.updatePhonePricing(price, grace);
      setCurrentStripePriceId(result.stripePriceId);
      notify.success('Saved', `Phone pricing updated: $${result.priceMonthly}/mo, ${result.gracePeriodDays}d grace`);
    } catch (err: any) {
      notify.error('Error', err.response?.data?.message || 'Failed to save phone pricing');
    } finally {
      setPhonePricingSaving(false);
    }
  };

  const loadAdminConfig = async () => {
    try {
      const cfg = await adminApi.getAdminConfig();
      if (cfg?.testData) setTestData(prev => ({ ...prev, ...cfg.testData }));
    } catch {
      // keep defaults
    }
  };

  const handleSaveTestConfig = async () => {
    try {
      setTestConfigSaving(true);
      const updated = await adminApi.updateAdminConfig(testData);
      if (updated?.testData) setTestData(prev => ({ ...prev, ...updated.testData }));
      notify.success('Saved', 'Test customer settings updated');
    } catch {
      notify.error('Error', 'Failed to save test customer settings');
    } finally {
      setTestConfigSaving(false);
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

        </section>
      )}

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

      {/* Phone Number Pricing */}
      <div className="bg-white rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="p-4 md:p-6 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-emerald-600" />
            <h2 className="text-lg md:text-xl font-bold text-slate-900">Phone Number Pricing</h2>
          </div>
          <p className="text-sm text-slate-500 mt-1">Set the monthly price and grace period for tenant dedicated phone numbers.</p>
        </div>
        <div className="p-4 md:p-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-700">Monthly Price ($)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={phonePriceMonthly}
                onChange={e => setPhonePriceMonthly(e.target.value)}
                placeholder="5.00"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-slate-700">Grace Period (days)</label>
              <input
                type="number"
                min="0"
                value={phoneGracePeriodDays}
                onChange={e => setPhoneGracePeriodDays(e.target.value)}
                placeholder="30"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              />
              <p className="text-xs text-slate-400">Days to keep number after tenant cancels</p>
            </div>
            <div>
              <button
                onClick={handleSavePhonePricing}
                disabled={phonePricingSaving}
                className="w-full px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {phonePricingSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <DollarSign className="w-4 h-4" />}
                Save Pricing
              </button>
            </div>
          </div>
          {currentStripePriceId && (
            <div className="mt-3 text-xs text-slate-400">
              Stripe Price ID: <code className="bg-slate-50 px-1.5 py-0.5 rounded">{currentStripePriceId}</code>
            </div>
          )}
        </div>
      </div>

      {/* Test Customer Setup */}
      <div className="bg-white rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="p-4 md:p-6 border-b border-slate-100">
          <h2 className="text-lg md:text-xl font-bold text-slate-900">Test Customer Setup</h2>
          <p className="text-sm text-slate-500 mt-1">Placeholder data injected into template variables when any tenant runs a test call.</p>
        </div>
        <div className="p-4 md:p-6 space-y-6">
          {(() => {
            const f = (key: string, label: string, vars: string[], placeholder: string) => (
              <div className="space-y-1.5">
                <div className="flex items-center flex-wrap gap-1.5">
                  <label className="text-xs font-bold text-slate-700">{label}</label>
                  {vars.map(v => (
                    <span key={v} className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded-lg text-[11px] font-mono border border-blue-100">{v}</span>
                  ))}
                </div>
                <input
                  type="text"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                  value={testData[key] ?? ''}
                  onChange={e => setTestData(prev => ({ ...prev, [key]: e.target.value }))}
                  placeholder={placeholder}
                />
              </div>
            );
            return (
              <>
                {/* Customer */}
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Customer</p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {f('customerName', 'Full Name',   ['{customerName}', '{lead.name}'], 'Test Customer')}
                    {f('firstName',    'First Name',  ['{firstName}'],                  'Test')}
                    {f('accountName',  'Business Name', ['{accountName}'],              'Test Business')}
                  </div>
                </div>

                {/* Location */}
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Location</p>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    {f('location', 'City, State', ['{location}', '{lead.location}'], 'Tampa, FL')}
                    {f('city',     'City',        ['{city}'],                        'Tampa')}
                    {f('state',    'State',       ['{state}'],                       'FL')}
                    {f('zip',      'ZIP',         ['{lead.zip}'],                    '33601')}
                  </div>
                </div>

                {/* Service */}
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Service</p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {f('category',           'Category',            ['{category}'],                    'House Cleaning')}
                    {f('serviceDescription', 'Service Description', ['{lead.serviceDescription}'],     'Standard home cleaning')}
                    {f('addons',             'Add-ons',             ['{lead.addons}'],                 '')}
                    {f('frequency',          'Frequency',           ['{lead.frequency}'],              'Weekly')}
                    {f('price',              'Price',               ['{lead.price}'],                  '$120')}
                    {f('estimate',           'Estimate',            ['{lead.estimate}'],               '$120')}
                    {f('dates',              'Dates',               ['{lead.dates}'],                  'Flexible')}
                  </div>
                </div>

                {/* Property */}
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Property</p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {f('bedrooms',  'Bedrooms',  ['{lead.bedrooms}'],  '3')}
                    {f('bathrooms', 'Bathrooms', ['{lead.bathrooms}'], '2')}
                    {f('pets',      'Pets',      ['{lead.pets}'],      'None')}
                  </div>
                </div>

                {/* Message */}
                <div>
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Message</p>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <label className="text-xs font-bold text-slate-700">Customer Message</label>
                      <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded-lg text-[11px] font-mono border border-blue-100">{'{lead.message}'}</span>
                    </div>
                    <textarea
                      rows={2}
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all resize-none"
                      value={testData['message'] ?? ''}
                      onChange={e => setTestData(prev => ({ ...prev, message: e.target.value }))}
                      placeholder="Looking for reliable cleaning services"
                    />
                  </div>
                </div>

                {/* Auto-built / read-only variables */}
                <div className="bg-slate-50 rounded-xl p-4">
                  <p className="text-xs font-bold text-slate-600 mb-3">Auto-built variables (read-only)</p>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { name: '{summary}', value: `${testData['customerName'] || 'Test Customer'} — ${testData['category'] || 'House Cleaning'} — ${testData['location'] || 'Tampa, FL'}` },
                      { name: '{phone}',   value: 'from test call input' },
                      { name: '{digit}',   value: 'from agent accept digits' },
                    ].map(v => (
                      <div key={v.name} className="flex items-center gap-1.5 px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-xs">
                        <span className="font-mono text-blue-700 font-semibold">{v.name}</span>
                        <span className="text-slate-300">→</span>
                        <span className="text-slate-500 italic">{v.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            );
          })()}

          <button
            className="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 shadow-sm shadow-blue-200 transition-all disabled:opacity-50 flex items-center gap-2"
            onClick={handleSaveTestConfig}
            disabled={testConfigSaving}
          >
            {testConfigSaving && <Loader2 size={14} className="animate-spin" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
