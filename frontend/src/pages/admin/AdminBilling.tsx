import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  DollarSign, CreditCard, Clock, TrendingDown, UserX, Search, Loader2, RefreshCw,
  Eye, ChevronRight, AlertCircle, CheckCircle2,
} from 'lucide-react';
import { adminApi, isSupportAccessDenied } from '../../services/api';
import { notify } from '../../store/notificationStore';
import { useAuthStore } from '../../store/authStore';
import { SupportAccessRequired } from '../../components/SupportAccessRequired';
import type { AdminBillingOverview, AdminBillingUser, BillingBucket } from '../../types';

const tierNames: Record<string, string> = {
  STARTER: 'Respond',
  PRO: 'Engage',
  ENTERPRISE: 'Convert',
};

const bucketLabels: Record<BillingBucket, string> = {
  paying: 'Paying',
  trialing: 'Trialing',
  trial_ended: 'Trial Ended',
  cancelled: 'Cancelled',
  past_due: 'Past Due',
  free: 'Free',
};

const bucketStyles: Record<BillingBucket, string> = {
  paying: 'bg-emerald-100 text-emerald-700',
  trialing: 'bg-blue-100 text-blue-700',
  trial_ended: 'bg-amber-100 text-amber-700',
  cancelled: 'bg-slate-200 text-slate-600',
  past_due: 'bg-red-100 text-red-700',
  free: 'bg-slate-100 text-slate-500',
};

const FILTER_TABS: { value: 'all' | BillingBucket; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'paying', label: 'Paying' },
  { value: 'trialing', label: 'Trialing' },
  { value: 'trial_ended', label: 'Trial Ended' },
  { value: 'past_due', label: 'Past Due' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'free', label: 'Free' },
];

const formatDate = (dateStr: string | null) => {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const formatMoney = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

const tierBadge = (tier: AdminBillingUser['subscriptionTier']) => {
  if (!tier) return <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-100 text-slate-500">—</span>;
  const colors: Record<string, string> = {
    STARTER: 'bg-blue-100 text-blue-700',
    PRO: 'bg-indigo-100 text-indigo-700',
    ENTERPRISE: 'bg-purple-100 text-purple-700',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${colors[tier]}`}>
      {tierNames[tier] || tier}
    </span>
  );
};

const statusBadge = (status: AdminBillingUser['subscriptionStatus']) => {
  if (!status) return <span className="text-xs text-slate-400">—</span>;
  const colors: Record<string, string> = {
    ACTIVE: 'bg-emerald-50 text-emerald-700',
    TRIALING: 'bg-blue-50 text-blue-700',
    PAST_DUE: 'bg-red-50 text-red-700',
    CANCELLED: 'bg-slate-100 text-slate-600',
    INCOMPLETE: 'bg-amber-50 text-amber-700',
  };
  return (
    <span className={`px-2 py-0.5 rounded-md text-[11px] font-semibold ${colors[status] || 'bg-slate-100 text-slate-600'}`}>
      {status}
    </span>
  );
};

export default function AdminBilling() {
  const user = useAuthStore((state) => state.user);
  const navigate = useNavigate();

  const [overview, setOverview] = useState<AdminBillingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);

  const [statusFilter, setStatusFilter] = useState<'all' | BillingBucket>('all');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 50;

  useEffect(() => {
    if (user?.role !== 'ADMIN') {
      notify.error('Access Denied', 'You must be an admin to access this page');
      navigate('/');
      return;
    }
    load();
  }, [user, statusFilter, search, offset]);

  const load = async () => {
    setLoading(true);
    try {
      const data = await adminApi.getBillingOverview({
        status: statusFilter,
        search: search || undefined,
        limit,
        offset,
      });
      setOverview(data);
      setAccessDenied(false);
    } catch (err: any) {
      if (isSupportAccessDenied(err)) {
        setAccessDenied(true);
      } else {
        console.error('Failed to load billing overview', err);
        notify.error('Error', 'Failed to load billing overview');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    load();
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput.trim());
    setOffset(0);
  };

  const handleFilterChange = (value: 'all' | BillingBucket) => {
    setStatusFilter(value);
    setOffset(0);
  };

  if (user?.role !== 'ADMIN') {
    return (
      <div className="p-10 max-w-7xl mx-auto">
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="animate-spin text-blue-600 mr-3" />
          <p className="text-slate-500">Loading...</p>
        </div>
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className="p-4 md:p-6 lg:p-10 max-w-7xl mx-auto">
        <div className="space-y-1 md:space-y-2 mb-6">
          <h1 className="text-2xl md:text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight flex items-center gap-3">
            <DollarSign size={24} /> <span className="gradient-text">Subscriptions & Billing</span>
          </h1>
          <p className="text-slate-600 text-sm md:text-lg">Real revenue, trials, churn — at a glance</p>
        </div>
        <SupportAccessRequired
          scope="user:list"
          sectionLabel="Subscriptions & Billing"
          onGranted={load}
        />
      </div>
    );
  }

  const stats = overview?.stats;
  const users = overview?.users ?? [];
  const total = overview?.total ?? 0;
  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <div className="p-4 md:p-6 lg:p-10 max-w-7xl mx-auto space-y-6 md:space-y-10">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1 md:space-y-2">
          <h1 className="text-2xl md:text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight flex items-center gap-3">
            <DollarSign size={24} /> <span className="gradient-text">Subscriptions & Billing</span>
          </h1>
          <p className="text-slate-600 text-sm md:text-lg">Real revenue, trials, churn — at a glance</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing || loading}
          className="px-3 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg text-sm font-semibold hover:bg-slate-50 transition-all flex items-center gap-2 disabled:opacity-50"
        >
          {refreshing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh
        </button>
      </div>

      {/* Top stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard
          icon={<DollarSign size={16} className="text-emerald-600" />}
          label="MRR"
          value={stats ? formatMoney(stats.monthlyRevenue) : '—'}
          accent="emerald"
          subtitle="Active paid subs"
        />
        <StatCard
          icon={<CreditCard size={16} className="text-emerald-600" />}
          label="Paying"
          value={stats?.paying ?? '—'}
          accent="emerald"
          subtitle="Real money in"
        />
        <StatCard
          icon={<Clock size={16} className="text-blue-600" />}
          label="Trialing"
          value={stats?.trialing ?? '—'}
          accent="blue"
          subtitle="In active trial"
        />
        <StatCard
          icon={<UserX size={16} className="text-amber-600" />}
          label="Trial Ended"
          value={stats?.trialEnded ?? '—'}
          accent="amber"
          subtitle="Not converted"
        />
        <StatCard
          icon={<CheckCircle2 size={16} className="text-indigo-600" />}
          label="Conversion"
          value={stats ? `${stats.trialConversionRate.toFixed(1)}%` : '—'}
          accent="indigo"
          subtitle="Trial → Paid"
        />
        <StatCard
          icon={<TrendingDown size={16} className="text-red-600" />}
          label="Churn (30d)"
          value={stats ? `${stats.churnRate.toFixed(1)}%` : '—'}
          accent="red"
          subtitle={`${stats?.cancelledLast30d ?? 0} cancelled`}
        />
      </div>

      {/* Filter tabs + search */}
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {FILTER_TABS.map((tab) => {
            const isActive = statusFilter === tab.value;
            const count =
              tab.value === 'all'
                ? (stats ? stats.paying + stats.trialing + stats.trialEnded + stats.cancelled + stats.pastDue + stats.free : null)
                : tab.value === 'past_due'
                  ? stats?.pastDue
                  : tab.value === 'trial_ended'
                    ? stats?.trialEnded
                    : (stats as any)?.[tab.value];
            return (
              <button
                key={tab.value}
                onClick={() => handleFilterChange(tab.value)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${
                  isActive
                    ? 'bg-slate-900 text-white border-slate-900'
                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {tab.label}
                {count !== undefined && count !== null && (
                  <span className={`ml-1.5 ${isActive ? 'text-white/70' : 'text-slate-400'}`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <form onSubmit={handleSearchSubmit} className="flex gap-2">
          <div className="relative flex-1 max-w-md">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by email or name…"
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
          </div>
          <button
            type="submit"
            className="px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700"
          >
            Search
          </button>
          {search && (
            <button
              type="button"
              onClick={() => { setSearchInput(''); setSearch(''); setOffset(0); }}
              className="px-3 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg text-sm font-semibold hover:bg-slate-50"
            >
              Clear
            </button>
          )}
        </form>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <div className="text-sm text-slate-600">
            <span className="font-semibold text-slate-900">{total}</span> {total === 1 ? 'user' : 'users'}
            {statusFilter !== 'all' && <span className="ml-1.5">in <span className="font-semibold">{bucketLabels[statusFilter as BillingBucket]}</span></span>}
          </div>
          {loading && <Loader2 size={14} className="animate-spin text-slate-400" />}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-4 py-2.5 font-semibold">User</th>
                <th className="text-left px-3 py-2.5 font-semibold">Bucket</th>
                <th className="text-left px-3 py-2.5 font-semibold">Tier</th>
                <th className="text-left px-3 py-2.5 font-semibold">Status</th>
                <th className="text-right px-3 py-2.5 font-semibold">MRR</th>
                <th className="text-left px-3 py-2.5 font-semibold">Trial Usage</th>
                <th className="text-left px-3 py-2.5 font-semibold">Trial End</th>
                <th className="text-left px-3 py-2.5 font-semibold">Period End</th>
                <th className="text-left px-3 py-2.5 font-semibold">Stripe</th>
                <th className="px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 && !loading && (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center text-slate-400">
                    <AlertCircle size={20} className="inline-block mr-2 align-middle" />
                    No users match this filter
                  </td>
                </tr>
              )}
              {users.map((u) => (
                <tr key={u.id} className="border-t border-slate-100 hover:bg-slate-50/40">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-slate-900 truncate max-w-[220px]">{u.name || '—'}</div>
                    <div className="text-xs text-slate-500 truncate max-w-[220px]">{u.email}</div>
                  </td>
                  <td className="px-3 py-3">
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${bucketStyles[u.bucket]}`}>
                      {bucketLabels[u.bucket]}
                    </span>
                    {u.cancelAtPeriodEnd && (
                      <span className="ml-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-amber-50 text-amber-700">
                        cancels
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3">{tierBadge(u.subscriptionTier)}</td>
                  <td className="px-3 py-3">{statusBadge(u.subscriptionStatus)}</td>
                  <td className="px-3 py-3 text-right font-semibold text-slate-900">
                    {u.mrr > 0 ? formatMoney(u.mrr) : <span className="text-slate-300">—</span>}
                    {u.hasOwnNumber && u.mrr > 0 && (
                      <div className="text-[10px] font-normal text-slate-400">incl. $29 phone</div>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <span className="font-mono text-xs text-slate-700">
                      {u.trialLeadsHandled}/{u.trialLeadsLimit}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-xs text-slate-600">{formatDate(u.trialEndDate)}</td>
                  <td className="px-3 py-3 text-xs text-slate-600">{formatDate(u.subscriptionPeriodEnd)}</td>
                  <td className="px-3 py-3">
                    {u.stripeCustomerId ? (
                      <a
                        href={`https://dashboard.stripe.com/customers/${u.stripeCustomerId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:text-blue-800 underline font-mono"
                        title={u.stripeCustomerId}
                      >
                        {u.stripeCustomerId.slice(0, 12)}…
                      </a>
                    ) : (
                      <span className="text-xs text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <Link
                      to={`/admin/users/${u.id}`}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-slate-600 hover:text-slate-900"
                    >
                      <Eye size={12} /> View
                      <ChevronRight size={12} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-between text-sm">
            <span className="text-slate-500">
              Page {currentPage} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setOffset(Math.max(0, offset - limit))}
                disabled={offset === 0 || loading}
                className="px-3 py-1.5 bg-white border border-slate-200 text-slate-700 rounded-lg text-xs font-semibold hover:bg-slate-50 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                onClick={() => setOffset(offset + limit)}
                disabled={offset + limit >= total || loading}
                className="px-3 py-1.5 bg-white border border-slate-200 text-slate-700 rounded-lg text-xs font-semibold hover:bg-slate-50 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  subtitle,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  subtitle?: string;
  accent: 'emerald' | 'blue' | 'amber' | 'red' | 'indigo';
}) {
  const accentBg: Record<string, string> = {
    emerald: 'bg-emerald-50',
    blue: 'bg-blue-50',
    amber: 'bg-amber-50',
    red: 'bg-red-50',
    indigo: 'bg-indigo-50',
  };
  return (
    <div className="rounded-2xl bg-white border border-slate-100 shadow-sm p-4">
      <div className="flex items-center gap-2 mb-2">
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${accentBg[accent]}`}>
          {icon}
        </div>
        <p className="text-xs font-semibold text-slate-500">{label}</p>
      </div>
      <p className="text-xl md:text-2xl font-extrabold text-slate-900 leading-tight">{value}</p>
      {subtitle && <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>}
    </div>
  );
}
