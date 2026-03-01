import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Smartphone, Search, Loader2, RefreshCw } from 'lucide-react';
import { adminApi } from '../../services/api';
import { notify } from '../../store/notificationStore';
import { useAuthStore } from '../../store/authStore';

interface TenantPhone {
  id: string;
  phoneNumber: string;
  friendlyName: string | null;
  areaCode: string | null;
  status: 'ACTIVE' | 'GRACE_PERIOD' | 'RELEASED';
  purchasedAt: string;
  cancelledAt: string | null;
  gracePeriodEndsAt: string | null;
  user: { id: string; email: string; name: string | null } | null;
  savedAccount: { id: string; businessId: string; businessName: string } | null;
  notificationSettings: { sigcoreProvider: string | null; sigcoreFromPhone: string | null; senderMode: string | null } | null;
}

export default function AdminTenantNumbers() {
  const user = useAuthStore((state) => state.user);
  const navigate = useNavigate();

  const [phones, setPhones] = useState<TenantPhone[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 50;

  useEffect(() => {
    if (user?.role !== 'ADMIN') {
      notify.error('Access Denied', 'Admin access required');
      navigate('/');
      return;
    }
    loadData();
  }, [user, statusFilter, offset]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      setOffset(0);
      loadData();
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const loadData = async () => {
    try {
      setLoading(true);
      const result = await adminApi.getTenantNumbers({
        search: searchQuery || undefined,
        status: statusFilter || undefined,
        limit,
        offset,
      });
      setPhones(result.phones);
      setTotal(result.total);
    } catch {
      notify.error('Error', 'Failed to load tenant numbers');
    } finally {
      setLoading(false);
    }
  };

  const activeCount = phones.filter(p => p.status === 'ACTIVE').length;
  const graceCount = phones.filter(p => p.status === 'GRACE_PERIOD').length;
  const twilioCount = phones.filter(p => p.notificationSettings?.sigcoreProvider === 'twilio').length;
  const openphoneCount = phones.filter(p => p.notificationSettings?.sigcoreProvider === 'openphone').length;

  const statusBadge = (status: string) => {
    switch (status) {
      case 'ACTIVE':
        return <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full text-[11px] font-bold">Active</span>;
      case 'GRACE_PERIOD':
        return <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full text-[11px] font-bold">Grace Period</span>;
      case 'RELEASED':
        return <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-[11px] font-bold">Released</span>;
      default:
        return <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full text-[11px] font-bold">{status}</span>;
    }
  };

  const providerBadge = (provider: string | null | undefined) => {
    switch (provider) {
      case 'twilio':
        return <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-[11px] font-bold">Twilio</span>;
      case 'openphone':
        return <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full text-[11px] font-bold">OpenPhone</span>;
      default:
        return <span className="px-2 py-0.5 bg-slate-100 text-slate-500 rounded-full text-[11px] font-bold">—</span>;
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  };

  const formatPhone = (phone: string) => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) {
      return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    return phone;
  };

  if (loading && phones.length === 0) {
    return (
      <div className="p-4 md:p-6 lg:p-10 max-w-7xl mx-auto space-y-6 md:space-y-10">
        <div className="space-y-1 md:space-y-2">
          <h1 className="text-2xl md:text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight flex items-center gap-3">
            <Smartphone size={24} /> Tenant Numbers
          </h1>
        </div>
        <div className="flex items-center justify-center py-20">
          <p className="text-slate-500">Loading tenant numbers...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-10 max-w-7xl mx-auto space-y-6 md:space-y-10">
      <div className="space-y-1 md:space-y-2">
        <h1 className="text-2xl md:text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight flex items-center gap-3">
          <Smartphone size={24} /> <span className="gradient-text">Tenant Numbers</span>
        </h1>
        <p className="text-slate-600 text-sm md:text-lg">Dedicated phone numbers owned by individual tenants</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
        <div className="rounded-2xl md:rounded-3xl bg-white border border-slate-100 shadow-sm p-4 md:p-5">
          <p className="text-xs md:text-sm font-semibold text-slate-500 mb-1">Total Active</p>
          <p className="text-2xl md:text-3xl font-extrabold text-slate-900">{activeCount}</p>
        </div>
        <div className="rounded-2xl md:rounded-3xl bg-white border border-slate-100 shadow-sm p-4 md:p-5">
          <p className="text-xs md:text-sm font-semibold text-slate-500 mb-1">Twilio</p>
          <p className="text-2xl md:text-3xl font-extrabold text-blue-600">{twilioCount}</p>
        </div>
        <div className="rounded-2xl md:rounded-3xl bg-white border border-slate-100 shadow-sm p-4 md:p-5">
          <p className="text-xs md:text-sm font-semibold text-slate-500 mb-1">OpenPhone</p>
          <p className="text-2xl md:text-3xl font-extrabold text-purple-600">{openphoneCount}</p>
        </div>
        <div className="rounded-2xl md:rounded-3xl bg-white border border-slate-100 shadow-sm p-4 md:p-5">
          <p className="text-xs md:text-sm font-semibold text-slate-500 mb-1">Grace Period</p>
          <p className="text-2xl md:text-3xl font-extrabold text-amber-600">{graceCount}</p>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className="flex flex-col md:flex-row gap-3 md:gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input
            type="text"
            placeholder="Search by phone, email, or business name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-11 pr-4 py-3 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 outline-none transition-all"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setOffset(0); }}
          className="px-4 py-3 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 outline-none bg-white"
        >
          <option value="">All Statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="GRACE_PERIOD">Grace Period</option>
          <option value="RELEASED">Released</option>
        </select>
        <button
          onClick={loadData}
          disabled={loading}
          className="px-4 py-3 bg-slate-100 text-slate-700 rounded-xl text-sm font-semibold hover:bg-slate-200 transition-all flex items-center gap-2 disabled:opacity-50"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Refresh
        </button>
      </div>

      {/* Table */}
      <div className="rounded-2xl md:rounded-3xl bg-white border border-slate-100 shadow-sm overflow-hidden">
        {phones.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-slate-500">{searchQuery || statusFilter ? 'No matching numbers found' : 'No tenant numbers yet'}</p>
          </div>
        ) : (
          <>
            {/* Mobile Cards */}
            <div className="md:hidden divide-y divide-slate-100">
              {phones.map((phone) => (
                <div key={phone.id} className="p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-900 font-mono">{formatPhone(phone.phoneNumber)}</span>
                    {statusBadge(phone.status)}
                  </div>
                  {phone.friendlyName && (
                    <p className="text-xs text-slate-500">{phone.friendlyName}</p>
                  )}
                  <div className="flex items-center gap-2 flex-wrap">
                    {providerBadge(phone.notificationSettings?.sigcoreProvider)}
                    {phone.savedAccount && (
                      <span className="text-xs text-slate-600">{phone.savedAccount.businessName}</span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400">
                    {phone.user?.email} · {formatDate(phone.purchasedAt)}
                  </p>
                </div>
              ))}
            </div>

            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-100 text-left">
                    <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Phone Number</th>
                    <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Name</th>
                    <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Tenant</th>
                    <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Owner</th>
                    <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Provider</th>
                    <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Status</th>
                    <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Purchased</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {phones.map((phone) => (
                    <tr key={phone.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="px-5 py-3.5 font-mono text-sm font-bold text-slate-900">
                        {formatPhone(phone.phoneNumber)}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-slate-600">
                        {phone.friendlyName || '—'}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-slate-700 font-medium">
                        {phone.savedAccount?.businessName || '—'}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-slate-500">
                        {phone.user?.email || '—'}
                      </td>
                      <td className="px-5 py-3.5">
                        {providerBadge(phone.notificationSettings?.sigcoreProvider)}
                      </td>
                      <td className="px-5 py-3.5">
                        {statusBadge(phone.status)}
                      </td>
                      <td className="px-5 py-3.5 text-sm text-slate-500">
                        {formatDate(phone.purchasedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Pagination */}
        {total > limit && (
          <div className="flex items-center justify-between px-5 py-4 border-t border-slate-100">
            <button
              onClick={() => setOffset(Math.max(0, offset - limit))}
              disabled={offset === 0}
              className="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              Previous
            </button>
            <span className="text-sm text-slate-600">
              {offset + 1}–{Math.min(offset + limit, total)} of {total}
            </span>
            <button
              onClick={() => setOffset(offset + limit)}
              disabled={offset + limit >= total}
              className="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
