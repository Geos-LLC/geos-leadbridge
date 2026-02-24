import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, Search, Loader2, UserPlus, UserMinus, Trash2, RefreshCw, X, Link, Unlink, Download, Users } from 'lucide-react';
import { adminApi } from '../../services/api';
import { notify } from '../../store/notificationStore';
import { useAuthStore } from '../../store/authStore';
import type { PhonePoolEntry, PhonePoolStats } from '../../types';

export default function AdminPhonePool() {
  const user = useAuthStore((state) => state.user);
  const navigate = useNavigate();

  const [stats, setStats] = useState<PhonePoolStats | null>(null);
  const [phones, setPhones] = useState<PhonePoolEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  // Config
  const [tenantKeyConfigured, setTenantKeyConfigured] = useState<boolean | null>(null);

  // Connect provider form
  const [showConnect, setShowConnect] = useState(false);
  const [connectProvider, setConnectProvider] = useState<'openphone' | 'twilio'>('openphone');
  const [connectFields, setConnectFields] = useState({ apiKey: '', accountSid: '', authToken: '', phoneNumber: '' });
  const [connecting, setConnecting] = useState(false);

  // Sync
  const [syncing, setSyncing] = useState(false);

  // Assign modal
  const [assigningPhoneId, setAssigningPhoneId] = useState<string | null>(null);
  const [userSearch, setUserSearch] = useState('');
  const [userResults, setUserResults] = useState<{ id: string; email: string; name: string | null }[]>([]);
  const [searchingUsers, setSearchingUsers] = useState(false);

  useEffect(() => {
    if (user?.role !== 'ADMIN') {
      notify.error('Access Denied', 'You must be an admin to access this page');
      navigate('/');
      return;
    }
    loadData();
    loadConfig();
  }, [user, statusFilter, searchQuery]);

  const loadConfig = async () => {
    try {
      const config = await adminApi.getPoolConfig();
      setTenantKeyConfigured(config.configured);
    } catch {
      setTenantKeyConfigured(false);
    }
  };

  const loadData = async () => {
    try {
      setLoading(true);
      const [statsData, poolData] = await Promise.all([
        adminApi.getPhonePoolStats(),
        adminApi.getPhonePool({ status: statusFilter || undefined, search: searchQuery || undefined, limit: 100 }),
      ]);
      setStats(statsData);
      setPhones(poolData.phones);
      setTotal(poolData.total);
    } catch (error: any) {
      console.error('Failed to load phone pool data:', error);
      notify.error('Error', 'Failed to load phone pool');
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async () => {
    try {
      setConnecting(true);
      const credentials = connectProvider === 'openphone'
        ? { apiKey: connectFields.apiKey }
        : { accountSid: connectFields.accountSid, authToken: connectFields.authToken, phoneNumber: connectFields.phoneNumber };

      const result = await adminApi.connectPoolProvider(connectProvider, credentials);
      if (result.success) {
        notify.success('Connected', `${connectProvider === 'openphone' ? 'OpenPhone' : 'Twilio'} connected successfully`);
        setShowConnect(false);
        setConnectFields({ apiKey: '', accountSid: '', authToken: '', phoneNumber: '' });
        // Auto-sync after connecting
        await handleSync();
      } else {
        notify.error('Connection Failed', result.error || 'Failed to connect provider');
      }
    } catch (error: any) {
      console.error('Failed to connect provider:', error);
      notify.error('Error', error.response?.data?.message || error.response?.data?.error || 'Failed to connect provider');
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async (provider: 'openphone' | 'twilio') => {
    if (!confirm(`Disconnect ${provider === 'openphone' ? 'OpenPhone' : 'Twilio'}? All pool numbers from this provider will be released.`)) return;
    try {
      const result = await adminApi.disconnectPoolProvider(provider);
      if (result.success) {
        notify.success('Disconnected', `${provider === 'openphone' ? 'OpenPhone' : 'Twilio'} disconnected`);
        loadData();
      } else {
        notify.error('Error', result.error || 'Failed to disconnect');
      }
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to disconnect provider');
    }
  };

  const handleSync = async () => {
    try {
      setSyncing(true);
      const result = await adminApi.syncPoolNumbers();
      if (result.success) {
        const totalSynced = result.data.results.reduce((sum: number, r: any) => sum + r.synced, 0);
        const errors = result.data.results.flatMap((r: any) => r.errors);
        const details = result.data.results.map((r: any) => `${r.provider}: ${r.synced} synced${r.errors.length ? ` (${r.errors.join(', ')})` : ''}`).join(' | ');
        if (totalSynced > 0) {
          notify.success('Synced', `${totalSynced} number(s) synced to pool. ${details}`);
        } else if (errors.length > 0) {
          notify.error('Sync Issues', details);
        } else {
          notify.success('Up to date', `No new numbers to sync. ${details}`);
        }
      }
    } catch (error: any) {
      console.error('Failed to sync:', error);
      notify.error('Error', error.response?.data?.message || 'Failed to sync numbers');
    } finally {
      setSyncing(false);
      await loadData();
    }
  };

  const searchUsers = useCallback(async (query: string) => {
    if (!query.trim()) {
      setUserResults([]);
      return;
    }
    try {
      setSearchingUsers(true);
      const result = await adminApi.getPhonePoolUsers(query);
      setUserResults(result.data);
    } catch (error) {
      console.error('Failed to search users:', error);
    } finally {
      setSearchingUsers(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (assigningPhoneId) {
        searchUsers(userSearch);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [userSearch, assigningPhoneId, searchUsers]);

  const handleAssign = async (phonePoolId: string, userId: string) => {
    try {
      await adminApi.assignPhone(phonePoolId, userId);
      notify.success('Assigned', 'Phone assigned to user');
      setAssigningPhoneId(null);
      setUserSearch('');
      setUserResults([]);
      loadData();
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to assign phone');
    }
  };

  const handleAssignAll = async (phonePoolId: string) => {
    if (!confirm('Assign this phone number to ALL tenants?')) return;
    try {
      await adminApi.assignPhoneToAll(phonePoolId);
      notify.success('Assigned', 'Phone assigned to all tenants');
      setAssigningPhoneId(null);
      setUserSearch('');
      setUserResults([]);
      loadData();
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to assign phone to all');
    }
  };

  const handleUnassign = async (phonePoolId: string, userId: string, userEmail: string) => {
    if (!confirm(`Unassign this phone from ${userEmail}?`)) return;
    try {
      await adminApi.unassignPhone(phonePoolId, userId);
      notify.success('Unassigned', `Phone unassigned from ${userEmail}`);
      loadData();
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to unassign phone');
    }
  };

  const handleRelease = async (phonePoolId: string, phoneNumber: string) => {
    if (!confirm(`Remove ${phoneNumber} from the pool?`)) return;
    try {
      await adminApi.releasePhone(phonePoolId);
      notify.success('Removed', 'Phone removed from pool');
      loadData();
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to remove phone');
    }
  };

  if (loading && !stats) {
    return (
      <div className="p-4 md:p-6 lg:p-10 max-w-7xl mx-auto space-y-6 md:space-y-10">
        <div className="space-y-1 md:space-y-2">
          <h1 className="text-2xl md:text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight flex items-center gap-3">
            <Phone size={24} /> Phone Pool
          </h1>
        </div>
        <div className="flex items-center justify-center py-20">
          <p className="text-slate-500">Loading phone pool...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-10 max-w-7xl mx-auto space-y-6 md:space-y-10">
      <div className="space-y-1 md:space-y-2">
        <h1 className="text-2xl md:text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight flex items-center gap-3">
          <Phone size={24} /> <span className="gradient-text">Phone Pool</span>
        </h1>
        <p className="text-slate-600 text-sm md:text-lg">Connect providers, sync numbers, and manage assignments</p>
      </div>

      {/* Tenant Key Warning */}
      {tenantKeyConfigured === false && (
        <div className="bg-yellow-50 border border-yellow-300 rounded-3xl p-6">
          <div className="text-yellow-800">
            <strong>SIGCORE_API_KEY not configured.</strong> Set the <code className="bg-yellow-200 px-2 py-1 rounded text-sm">SIGCORE_API_KEY</code> environment variable to enable provider connections.
          </div>
        </div>
      )}

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
          <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
            <div className="text-2xl md:text-3xl font-bold text-slate-900">{stats.total}</div>
            <div className="text-xs md:text-sm text-slate-600 mt-1 md:mt-2 font-medium">Total Numbers</div>
          </div>
          <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
            <div className="text-2xl md:text-3xl font-bold text-green-600">{stats.available}</div>
            <div className="text-xs md:text-sm text-slate-600 mt-1 md:mt-2 font-medium">Available</div>
          </div>
          <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
            <div className="text-2xl md:text-3xl font-bold text-blue-600">{stats.assigned}</div>
            <div className="text-xs md:text-sm text-slate-600 mt-1 md:mt-2 font-medium">Assigned</div>
          </div>
          <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
            <div className="text-2xl md:text-3xl font-bold text-yellow-600">{stats.reserved}</div>
            <div className="text-xs md:text-sm text-slate-600 mt-1 md:mt-2 font-medium">Reserved</div>
          </div>
        </div>
      )}

      {/* Actions Bar */}
      <div className="bg-white rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm p-4 md:p-6 space-y-4">
        {/* Top Row: Search and Filter */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex items-center min-w-0 flex-1">
            <Search size={16} className="absolute left-4 text-slate-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search phone numbers..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-11 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
            />
          </div>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="w-full sm:w-auto px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all min-w-[160px]"
          >
            <option value="">All Status</option>
            <option value="AVAILABLE">Available</option>
            <option value="ASSIGNED">Assigned</option>
            <option value="RESERVED">Reserved</option>
            <option value="RELEASED">Released</option>
          </select>
        </div>

        {/* Bottom Row: Action Buttons */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-2 border-t border-slate-100">
          <div className="flex items-center gap-2 flex-1">
            <button
              className="flex-1 sm:flex-none px-4 py-2.5 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => setShowConnect(true)}
              disabled={tenantKeyConfigured === false}
            >
              <Link size={16} />
              <span>Connect Provider</span>
            </button>
            <button
              className="px-4 py-2.5 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleSync}
              disabled={syncing || tenantKeyConfigured === false}
              title="Sync numbers from connected providers"
            >
              {syncing ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
              <span>Sync</span>
            </button>
            <button
              className="px-3 py-2.5 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all flex items-center justify-center"
              onClick={loadData}
              title="Refresh"
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="flex-1 sm:flex-none px-4 py-2.5 bg-red-50 text-red-600 border border-red-200 rounded-xl font-semibold hover:bg-red-100 transition-all flex items-center justify-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => handleDisconnect('openphone')}
              disabled={tenantKeyConfigured === false}
              title="Disconnect OpenPhone"
            >
              <Unlink size={14} />
              <span>OpenPhone</span>
            </button>
            <button
              className="flex-1 sm:flex-none px-4 py-2.5 bg-red-50 text-red-600 border border-red-200 rounded-xl font-semibold hover:bg-red-100 transition-all flex items-center justify-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => handleDisconnect('twilio')}
              disabled={tenantKeyConfigured === false}
              title="Disconnect Twilio"
            >
              <Unlink size={14} />
              <span>Twilio</span>
            </button>
          </div>
        </div>
      </div>

      {/* Connect Provider Form */}
      {showConnect && (
        <div className="bg-white rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm p-4 md:p-8">
          <div className="flex items-center justify-between mb-4 md:mb-6">
            <h3 className="text-lg md:text-xl font-bold text-slate-900">Connect Provider</h3>
            <button className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-all" onClick={() => setShowConnect(false)}>
              <X size={18} />
            </button>
          </div>
          <div className="space-y-6">
            {/* Provider Tabs */}
            <div className="flex gap-2">
              <button
                className={`px-6 py-2 rounded-xl font-semibold transition-all ${connectProvider === 'openphone' ? 'bg-blue-600 text-white shadow-lg shadow-blue-200' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
                onClick={() => setConnectProvider('openphone')}
              >
                OpenPhone
              </button>
              <button
                className={`px-6 py-2 rounded-xl font-semibold transition-all ${connectProvider === 'twilio' ? 'bg-blue-600 text-white shadow-lg shadow-blue-200' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
                onClick={() => setConnectProvider('twilio')}
              >
                Twilio
              </button>
            </div>

            {connectProvider === 'openphone' ? (
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-slate-700">OpenPhone API Key</label>
                <input
                  type="password"
                  placeholder="Enter your OpenPhone API key"
                  value={connectFields.apiKey}
                  onChange={e => setConnectFields({ ...connectFields, apiKey: e.target.value })}
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                />
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <label className="block text-sm font-semibold text-slate-700">Account SID</label>
                  <input
                    type="text"
                    placeholder="AC..."
                    value={connectFields.accountSid}
                    onChange={e => setConnectFields({ ...connectFields, accountSid: e.target.value })}
                    className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                  />
                </div>
                <div className="space-y-2">
                  <label className="block text-sm font-semibold text-slate-700">Auth Token</label>
                  <input
                    type="password"
                    placeholder="Enter your Twilio auth token"
                    value={connectFields.authToken}
                    onChange={e => setConnectFields({ ...connectFields, authToken: e.target.value })}
                    className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                  />
                </div>
                <div className="space-y-2">
                  <label className="block text-sm font-semibold text-slate-700">Phone Number</label>
                  <input
                    type="text"
                    placeholder="+1234567890"
                    value={connectFields.phoneNumber}
                    onChange={e => setConnectFields({ ...connectFields, phoneNumber: e.target.value })}
                    className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                  />
                </div>
              </>
            )}

            <div className="flex gap-2 pt-4">
              <button
                className="px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleConnect}
                disabled={connecting || (connectProvider === 'openphone' ? !connectFields.apiKey : (!connectFields.accountSid || !connectFields.authToken))}
              >
                {connecting ? (
                  <><Loader2 size={16} className="animate-spin" /> Connecting...</>
                ) : (
                  <><Link size={16} /> Connect {connectProvider === 'openphone' ? 'OpenPhone' : 'Twilio'}</>
                )}
              </button>
              <button className="px-6 py-2 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all" onClick={() => setShowConnect(false)}>Cancel</button>
            </div>

          </div>
        </div>
      )}

      {/* Phone Pool */}
      <div className="bg-white rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
        {/* Mobile: Card list */}
        <div className="md:hidden divide-y divide-slate-100">
          {phones.length === 0 ? (
            <div className="px-4 py-12 text-center text-slate-500 text-sm">
              {loading ? 'Loading...' : 'No phone numbers in pool. Connect a provider and sync to get started.'}
            </div>
          ) : (
            phones.map(phone => (
              <div key={phone.id} className="p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm font-semibold text-slate-900">{phone.phoneNumber}</span>
                  <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ${
                    phone.status === 'AVAILABLE' ? 'bg-green-100 text-green-700' :
                    phone.status === 'ASSIGNED' ? 'bg-blue-100 text-blue-700' :
                    phone.status === 'RESERVED' ? 'bg-yellow-100 text-yellow-700' :
                    'bg-slate-100 text-slate-700'
                  }`}>
                    {phone.status}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full font-bold uppercase">{phone.provider}</span>
                  {phone.areaCode && <span>Area {phone.areaCode}</span>}
                  <span>· {new Date(phone.provisionedAt).toLocaleDateString()}</span>
                </div>
                {phone.assignments && phone.assignments.length > 0 && (
                  <div className="space-y-1">
                    {phone.assignments.map(assignment => (
                      <div key={assignment.id} className="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-slate-900 truncate">{assignment.user.email}</p>
                          {assignment.user.name && <p className="text-[10px] text-slate-500">{assignment.user.name}</p>}
                        </div>
                        <button
                          className="p-1.5 text-slate-500 hover:bg-slate-200 rounded-lg transition-all shrink-0"
                          onClick={() => handleUnassign(phone.id, assignment.user.id, assignment.user.email)}
                        >
                          <UserMinus size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {phone.status !== 'RELEASED' && (
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      className="px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold hover:bg-slate-200 transition-all flex items-center gap-1.5"
                      onClick={() => {
                        setAssigningPhoneId(phone.id);
                        setUserSearch('');
                        setUserResults([]);
                      }}
                    >
                      <UserPlus size={12} /> Assign
                    </button>
                    <button
                      className="px-3 py-1.5 bg-red-50 text-red-600 rounded-lg text-xs font-semibold hover:bg-red-100 transition-all flex items-center gap-1.5"
                      onClick={() => handleRelease(phone.id, phone.phoneNumber)}
                    >
                      <Trash2 size={12} /> Remove
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Desktop: Full table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="px-6 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Phone Number</th>
                <th className="px-6 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Area Code</th>
                <th className="px-6 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Provider</th>
                <th className="px-6 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Status</th>
                <th className="px-6 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Assigned To</th>
                <th className="px-6 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Added</th>
                <th className="px-6 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {phones.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-slate-500">
                    {loading ? 'Loading...' : 'No phone numbers in pool. Connect a provider and sync to get started.'}
                  </td>
                </tr>
              ) : (
                phones.map(phone => (
                  <tr key={phone.id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4 font-mono text-slate-900">{phone.phoneNumber}</td>
                    <td className="px-6 py-4 text-slate-700">{phone.areaCode || '-'}</td>
                    <td className="px-6 py-4">
                      <span className="px-3 py-1 bg-slate-100 text-slate-700 rounded-full text-xs font-bold uppercase">
                        {phone.provider}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase ${
                        phone.status === 'AVAILABLE' ? 'bg-green-100 text-green-700' :
                        phone.status === 'ASSIGNED' ? 'bg-blue-100 text-blue-700' :
                        phone.status === 'RESERVED' ? 'bg-yellow-100 text-yellow-700' :
                        'bg-slate-100 text-slate-700'
                      }`}>
                        {phone.status}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      {phone.assignments && phone.assignments.length > 0 ? (
                        <div className="space-y-2">
                          {phone.assignments.map(assignment => (
                            <div key={assignment.id} className="flex items-center gap-2">
                              <div className="flex flex-col">
                                <span className="text-sm font-medium text-slate-900">{assignment.user.email}</span>
                                {assignment.user.name && (
                                  <span className="text-xs text-slate-500">{assignment.user.name}</span>
                                )}
                              </div>
                              <button
                                className="p-1 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-all"
                                onClick={() => handleUnassign(phone.id, assignment.user.id, assignment.user.email)}
                                title={`Unassign from ${assignment.user.email}`}
                              >
                                <UserMinus size={12} />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="text-slate-400 italic">Unassigned</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-slate-700">{new Date(phone.provisionedAt).toLocaleDateString()}</td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        {phone.status !== 'RELEASED' && (
                          <button
                            className="p-2 bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all"
                            onClick={() => {
                              setAssigningPhoneId(phone.id);
                              setUserSearch('');
                              setUserResults([]);
                            }}
                            title="Assign to user"
                          >
                            <UserPlus size={14} />
                          </button>
                        )}
                        {phone.status !== 'RELEASED' && (
                          <button
                            className="p-2 bg-red-100 text-red-700 rounded-xl hover:bg-red-200 transition-all"
                            onClick={() => handleRelease(phone.id, phone.phoneNumber)}
                            title="Remove from pool"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {total > 0 && (
          <div className="px-4 md:px-6 py-3 md:py-4 border-t border-slate-100 text-xs md:text-sm text-slate-600">
            Showing {phones.length} of {total} numbers
          </div>
        )}
      </div>

      {/* Assign Modal */}
      {assigningPhoneId && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setAssigningPhoneId(null)}>
          <div className="bg-white rounded-2xl md:rounded-3xl p-4 md:p-8 max-w-2xl w-full shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4 md:mb-6">
              <h3 className="text-lg md:text-xl font-bold text-slate-900">Assign Phone</h3>
              <button className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-all" onClick={() => setAssigningPhoneId(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="space-y-6">
              {/* Assign to All */}
              <button
                className="w-full px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all flex items-center justify-center gap-2"
                onClick={() => handleAssignAll(assigningPhoneId)}
              >
                <Users size={16} />
                Assign to All Tenants
              </button>

              <div className="relative text-center">
                <hr className="border-t border-slate-200" />
                <span className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white px-3 text-xs text-slate-500">
                  or assign to a specific tenant
                </span>
              </div>

              {/* Search for specific user */}
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-slate-700">Search Users</label>
                <div className="relative flex items-center">
                  <Search size={16} className="absolute left-4 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search by email or name..."
                    value={userSearch}
                    onChange={e => setUserSearch(e.target.value)}
                    autoFocus
                    className="w-full pl-11 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                  />
                </div>
              </div>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {searchingUsers ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 size={20} className="animate-spin text-blue-600" />
                  </div>
                ) : userResults.length > 0 ? (
                  userResults.map(u => (
                    <button
                      key={u.id}
                      className="w-full flex items-center justify-between p-4 bg-slate-50 hover:bg-slate-100 rounded-xl transition-all"
                      onClick={() => handleAssign(assigningPhoneId, u.id)}
                    >
                      <div className="flex flex-col items-start">
                        <span className="font-medium text-slate-900">{u.email}</span>
                        {u.name && <span className="text-sm text-slate-500">{u.name}</span>}
                      </div>
                      <UserPlus size={16} className="text-blue-600" />
                    </button>
                  ))
                ) : userSearch.trim() ? (
                  <p className="text-center py-8 text-slate-500">No users found</p>
                ) : (
                  <p className="text-center py-8 text-slate-500">Type to search for users</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
