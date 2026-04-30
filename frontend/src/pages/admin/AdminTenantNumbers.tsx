import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Smartphone, Search, Loader2, RefreshCw, UserPlus, X, ShieldCheck,
} from 'lucide-react';
import { adminApi, isSupportAccessDenied } from '../../services/api';
import { notify } from '../../store/notificationStore';
import { useAuthStore } from '../../store/authStore';
import { SupportAccessRequired } from '../../components/SupportAccessRequired';

// ── Types ──────────────────────────────────────────────────────────────────────

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
  tenantName: string | null;
  notificationSettings: { senderMode: string | null } | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const formatPhone = (phone: string) => {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return phone;
};

const formatDate = (dateStr: string) =>
  new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const tenantStatusBadge = (status: TenantPhone['status']) => {
  const styles: Record<TenantPhone['status'], string> = {
    ACTIVE: 'bg-emerald-100 text-emerald-700',
    GRACE_PERIOD: 'bg-amber-100 text-amber-700',
    RELEASED: 'bg-slate-100 text-slate-600',
  };
  return <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${styles[status]}`}>{status.replace('_', ' ')}</span>;
};

// ── Main Component ─────────────────────────────────────────────────────────────

export default function AdminTenantNumbers() {
  const user = useAuthStore((state) => state.user);
  const navigate = useNavigate();

  // Tenant data
  const [tenantPhones, setTenantPhones] = useState<TenantPhone[]>([]);
  const [tenantTotal, setTenantTotal] = useState(0);
  const [tenantLoading, setTenantLoading] = useState(true);
  const [tenantSearch, setTenantSearch] = useState('');
  const [tenantStatusFilter, setTenantStatusFilter] = useState('');
  const [tenantOffset, setTenantOffset] = useState(0);
  const tenantLimit = 50;

  // SupportGrant gate — true when /v1/admin/tenant-numbers returns the
  // SupportGrantGuard 404. Cleared on successful (re)load.
  const [tenantAccessDenied, setTenantAccessDenied] = useState(false);

  // Twilio health
  const [twilioHealth, setTwilioHealth] = useState<{
    status: 'connected' | 'disconnected' | 'error';
    phoneCount: number;
    message: string;
    checkedAt: string;
  } | null>(null);
  const [healthChecking, setHealthChecking] = useState(false);

  // Messaging Service SID (A2P 10DLC)
  const [messagingServiceSid, setMessagingServiceSid] = useState('');
  const [messagingServiceSaved, setMessagingServiceSaved] = useState('');
  const [messagingServiceSaving, setMessagingServiceSaving] = useState(false);

  // Reassign modal
  const [reassigningTenantId, setReassigningTenantId] = useState<string | null>(null);
  const [reassigningTenantPhone, setReassigningTenantPhone] = useState('');
  const [reassignUserSearch, setReassignUserSearch] = useState('');
  const [reassignUserResults, setReassignUserResults] = useState<{ id: string; email: string; name: string | null }[]>([]);
  const [searchingReassignUsers, setSearchingReassignUsers] = useState(false);
  const [reassigning, setReassigning] = useState(false);

  useEffect(() => {
    if (user?.role !== 'ADMIN') {
      notify.error('Access Denied', 'Admin access required');
      navigate('/');
      return;
    }
    loadTenantData();
    loadMessagingServiceSid();
    checkTwilioHealth();
  }, [user]);

  useEffect(() => {
    if (user?.role === 'ADMIN') loadTenantData();
  }, [tenantStatusFilter, tenantOffset]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setTenantOffset(0);
      if (user?.role === 'ADMIN') loadTenantData();
    }, 300);
    return () => clearTimeout(timer);
  }, [tenantSearch]);

  const loadTenantData = async () => {
    try {
      setTenantLoading(true);
      const result = await adminApi.getTenantNumbers({
        search: tenantSearch || undefined,
        status: tenantStatusFilter || undefined,
        limit: tenantLimit,
        offset: tenantOffset,
      });
      setTenantPhones(result.phones);
      setTenantTotal(result.total);
      setTenantAccessDenied(false);
    } catch (err: any) {
      if (isSupportAccessDenied(err)) {
        setTenantAccessDenied(true);
        setTenantPhones([]);
        setTenantTotal(0);
      } else {
        notify.error('Error', 'Failed to load tenant numbers');
      }
    } finally {
      setTenantLoading(false);
    }
  };

  const loadMessagingServiceSid = async () => {
    try {
      const pricing = await adminApi.getPhonePricing();
      if (pricing.messagingServiceSid) {
        setMessagingServiceSid(pricing.messagingServiceSid);
        setMessagingServiceSaved(pricing.messagingServiceSid);
      }
    } catch { /* keep default */ }
  };

  const handleSaveMessagingService = async () => {
    if (!messagingServiceSid.startsWith('MG')) {
      notify.error('Invalid', 'Messaging Service SID must start with MG');
      return;
    }
    try {
      setMessagingServiceSaving(true);
      const result = await adminApi.updateMessagingService(messagingServiceSid);
      setMessagingServiceSaved(messagingServiceSid);
      notify.success('Saved', result.synced ? 'Messaging Service SID saved and synced to Sigcore' : 'Saved locally but Sigcore sync failed — check logs');
    } catch (err: any) {
      notify.error('Error', err.response?.data?.message || 'Failed to save Messaging Service SID');
    } finally {
      setMessagingServiceSaving(false);
    }
  };

  const checkTwilioHealth = async () => {
    try {
      setHealthChecking(true);
      const result = await adminApi.checkTwilioHealth();
      setTwilioHealth(result);
    } catch {
      setTwilioHealth({ status: 'error', phoneCount: 0, message: 'Failed to check Twilio connection', checkedAt: new Date().toISOString() });
    } finally {
      setHealthChecking(false);
    }
  };

  const searchReassignUsers = async (query: string) => {
    if (!query || query.length < 2) {
      setReassignUserResults([]);
      return;
    }
    try {
      setSearchingReassignUsers(true);
      const result = await adminApi.listUsers({ search: query, limit: 10, offset: 0 });
      setReassignUserResults(result.users.map(u => ({ id: u.id, email: u.email, name: u.name })));
    } catch {
      setReassignUserResults([]);
    } finally {
      setSearchingReassignUsers(false);
    }
  };

  const handleReassign = async (targetUserId: string) => {
    if (!reassigningTenantId) return;
    try {
      setReassigning(true);
      await adminApi.reassignTenantPhone(reassigningTenantId, targetUserId);
      notify.success('Reassigned', `${reassigningTenantPhone} reassigned`);
      setReassigningTenantId(null);
      setReassigningTenantPhone('');
      setReassignUserSearch('');
      setReassignUserResults([]);
      loadTenantData();
    } catch (err: any) {
      notify.error('Error', err.response?.data?.message || 'Failed to reassign number');
    } finally {
      setReassigning(false);
    }
  };

  const tenantActiveCount = tenantPhones.filter(p => p.status === 'ACTIVE').length;
  const tenantGraceCount = tenantPhones.filter(p => p.status === 'GRACE_PERIOD').length;

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

  return (
    <div className="p-4 md:p-6 lg:p-10 max-w-7xl mx-auto space-y-6 md:space-y-10">
      {/* Header */}
      <div className="space-y-1 md:space-y-2">
        <h1 className="text-2xl md:text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight flex items-center gap-3">
          <Smartphone size={24} /> <span className="gradient-text">Tenant Numbers</span>
        </h1>
        <p className="text-slate-600 text-sm md:text-lg">Dedicated Twilio numbers assigned to tenants via Sigcore</p>
      </div>

      {/* Twilio Health Check */}
      <div className={`rounded-2xl md:rounded-3xl border shadow-sm p-4 md:p-5 ${
        twilioHealth?.status === 'connected' ? 'bg-emerald-50 border-emerald-200' :
        twilioHealth?.status === 'error' ? 'bg-red-50 border-red-200' :
        twilioHealth?.status === 'disconnected' ? 'bg-amber-50 border-amber-200' :
        'bg-white border-slate-100'
      }`}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full shrink-0 ${
              twilioHealth?.status === 'connected' ? 'bg-emerald-500' :
              twilioHealth?.status === 'disconnected' ? 'bg-amber-500' :
              twilioHealth?.status === 'error' ? 'bg-red-500' :
              'bg-slate-300 animate-pulse'
            }`} />
            <div>
              <h3 className="text-sm font-bold text-slate-900">Twilio Connection</h3>
              <p className={`text-xs mt-0.5 ${
                twilioHealth?.status === 'connected' ? 'text-emerald-700' :
                twilioHealth?.status === 'error' ? 'text-red-700' :
                twilioHealth?.status === 'disconnected' ? 'text-amber-700' :
                'text-slate-500'
              }`}>{twilioHealth?.message || 'Checking connection...'}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {twilioHealth?.status === 'connected' && (
              <span className="px-2.5 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold">
                {twilioHealth.phoneCount} number{twilioHealth.phoneCount !== 1 ? 's' : ''}
              </span>
            )}
            <button onClick={checkTwilioHealth} disabled={healthChecking} className="px-3 py-1.5 bg-white/80 border border-slate-200 text-slate-700 rounded-lg text-xs font-semibold hover:bg-white transition-all flex items-center gap-1.5 disabled:opacity-50">
              {healthChecking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Check
            </button>
          </div>
        </div>
      </div>

      {/* A2P Messaging Service SID */}
      {twilioHealth?.status === 'connected' && (
        <div className="px-4 py-3 bg-white rounded-2xl border border-slate-100 shadow-sm space-y-2">
          <div className="flex items-center gap-3">
            <label className="text-xs font-bold text-slate-600 whitespace-nowrap flex items-center gap-2">
              Messaging Service SID
              {messagingServiceSaved ? (
                <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full text-[10px] font-bold uppercase flex items-center gap-1">
                  <ShieldCheck size={10} /> Synced
                </span>
              ) : (
                <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full text-[10px] font-bold uppercase">Not configured</span>
              )}
            </label>
            <input
              type="text"
              value={messagingServiceSid}
              onChange={e => setMessagingServiceSid(e.target.value)}
              placeholder="MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              className="flex-1 px-3 py-1.5 rounded-lg border border-slate-200 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none min-w-0"
            />
            <button
              onClick={handleSaveMessagingService}
              disabled={messagingServiceSaving || !messagingServiceSid}
              className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap"
            >
              {messagingServiceSaving ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
              Save & Sync
            </button>
          </div>
          <p className="text-[11px] text-slate-400">
            Required for A2P 10DLC compliance. Find it in{' '}
            <a href="https://console.twilio.com/us1/develop/sms/services" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-600 underline">
              Twilio Console → Messaging → Services
            </a>
            {' '}— copy the SID (starts with MG) of your registered Messaging Service.
          </p>
        </div>
      )}

      {/* Tenant Dedicated Numbers */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg md:text-xl font-bold text-slate-900 flex items-center gap-2">
            <Smartphone size={20} /> Tenant Dedicated Numbers
            <span className="text-sm font-normal text-slate-500">({tenantTotal})</span>
          </h2>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="rounded-2xl bg-white border border-slate-100 shadow-sm p-4">
            <p className="text-xs font-semibold text-slate-500 mb-1">Active</p>
            <p className="text-2xl font-extrabold text-slate-900">{tenantActiveCount}</p>
          </div>
          <div className="rounded-2xl bg-white border border-slate-100 shadow-sm p-4">
            <p className="text-xs font-semibold text-slate-500 mb-1">Grace Period</p>
            <p className="text-2xl font-extrabold text-amber-600">{tenantGraceCount}</p>
          </div>
        </div>

        {/* Search */}
        <div className="flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input
              type="text"
              placeholder="Search by phone, email, or business name..."
              value={tenantSearch}
              onChange={(e) => setTenantSearch(e.target.value)}
              className="w-full pl-11 pr-4 py-3 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 outline-none transition-all"
            />
          </div>
          <select
            value={tenantStatusFilter}
            onChange={(e) => { setTenantStatusFilter(e.target.value); setTenantOffset(0); }}
            className="px-4 py-3 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 outline-none bg-white"
          >
            <option value="">All Statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="GRACE_PERIOD">Grace Period</option>
            <option value="RELEASED">Released</option>
          </select>
          <button onClick={loadTenantData} disabled={tenantLoading} className="px-4 py-3 bg-slate-100 text-slate-700 rounded-xl text-sm font-semibold hover:bg-slate-200 transition-all flex items-center gap-2 disabled:opacity-50">
            {tenantLoading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            Refresh
          </button>
        </div>

        {/* Table */}
        {tenantAccessDenied ? (
          <SupportAccessRequired
            scope="phones:read"
            sectionLabel="tenant phone numbers"
            onGranted={loadTenantData}
          />
        ) : (
        <div className="rounded-2xl md:rounded-3xl bg-white border border-slate-100 shadow-sm overflow-hidden">
          {tenantPhones.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-slate-500">{tenantSearch || tenantStatusFilter ? 'No matching numbers found' : 'No tenant numbers yet.'}</p>
            </div>
          ) : (
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-100 text-left">
                    <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Phone Number</th>
                    <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Tenant</th>
                    <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Owner</th>
                    <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Status</th>
                    <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Purchased</th>
                    <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider w-20">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {tenantPhones.map((phone) => (
                    <tr key={phone.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="px-5 py-3.5 font-mono text-sm font-bold text-slate-900">{formatPhone(phone.phoneNumber)}</td>
                      <td className="px-5 py-3.5 text-sm text-slate-700 font-medium">{phone.tenantName || '—'}</td>
                      <td className="px-5 py-3.5 text-sm text-slate-500">{phone.user?.email || '—'}</td>
                      <td className="px-5 py-3.5">{tenantStatusBadge(phone.status)}</td>
                      <td className="px-5 py-3.5 text-sm text-slate-500">{formatDate(phone.purchasedAt)}</td>
                      <td className="px-5 py-3.5">
                        {phone.status === 'ACTIVE' && (
                          <button
                            onClick={() => {
                              setReassigningTenantId(phone.id);
                              setReassigningTenantPhone(phone.phoneNumber);
                              setReassignUserSearch('');
                              setReassignUserResults([]);
                            }}
                            className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                            title="Reassign to different user"
                          >
                            <UserPlus size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Mobile cards */}
          <div className="md:hidden divide-y divide-slate-100">
            {tenantPhones.map((phone) => (
              <div key={phone.id} className="p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-900 font-mono">{formatPhone(phone.phoneNumber)}</span>
                  {tenantStatusBadge(phone.status)}
                </div>
                {phone.tenantName && <p className="text-xs text-slate-600">{phone.tenantName}</p>}
                <p className="text-[11px] text-slate-400">{phone.user?.email} · {formatDate(phone.purchasedAt)}</p>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {tenantTotal > tenantLimit && (
            <div className="flex items-center justify-between px-5 py-4 border-t border-slate-100">
              <button onClick={() => setTenantOffset(Math.max(0, tenantOffset - tenantLimit))} disabled={tenantOffset === 0} className="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-sm">Previous</button>
              <span className="text-sm text-slate-600">{tenantOffset + 1}–{Math.min(tenantOffset + tenantLimit, tenantTotal)} of {tenantTotal}</span>
              <button onClick={() => setTenantOffset(tenantOffset + tenantLimit)} disabled={tenantOffset + tenantLimit >= tenantTotal} className="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-sm">Next</button>
            </div>
          )}
        </div>
        )}
      </div>

      {/* Reassign Modal */}
      {reassigningTenantId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setReassigningTenantId(null)}>
          <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-6 relative" onClick={e => e.stopPropagation()}>
            <button onClick={() => setReassigningTenantId(null)} className="absolute top-5 right-5 text-slate-400 hover:text-slate-600">
              <X size={20} />
            </button>
            <h3 className="text-lg font-bold text-slate-900 mb-1">Reassign Number</h3>
            <p className="text-sm text-slate-500 mb-4 font-mono">{formatPhone(reassigningTenantPhone)}</p>
            <div className="space-y-3">
              <input
                type="text"
                placeholder="Search user by email or name..."
                value={reassignUserSearch}
                onChange={(e) => {
                  setReassignUserSearch(e.target.value);
                  searchReassignUsers(e.target.value);
                }}
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 outline-none"
              />
              {searchingReassignUsers && (
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <Loader2 size={14} className="animate-spin" /> Searching…
                </div>
              )}
              {reassignUserResults.length > 0 && (
                <div className="border border-slate-200 rounded-xl divide-y divide-slate-100 max-h-60 overflow-y-auto">
                  {reassignUserResults.map((u) => (
                    <button
                      key={u.id}
                      onClick={() => handleReassign(u.id)}
                      disabled={reassigning}
                      className="w-full text-left px-4 py-2.5 hover:bg-slate-50 transition-colors disabled:opacity-50"
                    >
                      <p className="text-sm font-medium text-slate-900">{u.name || u.email}</p>
                      {u.name && <p className="text-xs text-slate-500">{u.email}</p>}
                    </button>
                  ))}
                </div>
              )}
              {reassigning && (
                <div className="flex items-center gap-2 text-sm text-blue-600">
                  <Loader2 size={14} className="animate-spin" /> Reassigning…
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
