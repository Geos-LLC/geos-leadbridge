import { useState, useEffect } from 'react';
import { Phone, Loader2, X, ChevronDown, AlertCircle, PhoneCall, Building2, Key, Unplug, CheckCircle2, ExternalLink, Link2, Hash, ShieldCheck, ShieldAlert, MessageSquare } from 'lucide-react';
import { usersApi, thumbtackApi, notificationsApi } from '../services/api';
import type { TenantPhoneNumber } from '../services/api';
import type { SavedAccount, PhonePoolEntry, SigcorePhoneNumber, AvailablePhoneNumber } from '../types';
import { useAppStore } from '../store/appStore';
import { useAuthStore } from '../store/authStore';
import AdminNoAccountsState from '../components/AdminNoAccountsState';
import NoAccountsOverlay from '../components/NoAccountsOverlay';

// Module-level cache — survives navigation unmounts
let _phoneCache: Record<string, any> | null = null;

export function PhoneSettings() {
  const storedAccounts = useAppStore(state => state.savedAccounts);
  const setSavedAccounts = useAppStore(state => state.setSavedAccounts);
  const pc = _phoneCache; // cached phone settings data
  // Seed from Zustand store to avoid loading flash / health-status flicker
  const [accounts, setAccounts] = useState<SavedAccount[]>(storedAccounts);
  const [selectedAccountId, setSelectedAccountId] = useState<string>(storedAccounts[0]?.id || '');
  const [loading, setLoading] = useState(storedAccounts.length === 0 && !pc);
  const [error, setError] = useState<string | null>(null);

  // Pool phone state
  const [poolPhones, setPoolPhones] = useState<PhonePoolEntry[]>(pc?.poolPhones ?? []);
  const [loadingPoolPhone, setLoadingPoolPhone] = useState(!pc);

  // Own provider connection state
  const [openPhoneApiKey, setOpenPhoneApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [sigcoreConnected, setSigcoreConnected] = useState(pc?.sigcoreConnected ?? false);
  const [ownPhoneNumbers, setOwnPhoneNumbers] = useState<SigcorePhoneNumber[]>(pc?.ownPhoneNumbers ?? []);
  const [loadingConnectionStatus, setLoadingConnectionStatus] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [sigcoreProvisioned, setSigcoreProvisioned] = useState(pc?.sigcoreProvisioned ?? false);
  const [provisioning, setProvisioning] = useState(false);

  // Option 3: provisioned Twilio number
  const [, setSigcoreFromPhone] = useState<string | null>(null);
  const [, setSigcoreProvider] = useState<string | null>(null);
  const [searchAreaCode, setSearchAreaCode] = useState('');
  const [searchLocality, setSearchLocality] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [availableNumbers, setAvailableNumbers] = useState<AvailablePhoneNumber[]>([]);
  const [purchasingNumber, setPurchasingNumber] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Tenant purchased numbers
  const [tenantPhones, setTenantPhones] = useState<TenantPhoneNumber[]>(pc?.tenantPhones ?? []);
  const [, setLoadingTenantPhones] = useState(false);
  const [cancellingPhoneId, setCancellingPhoneId] = useState<string | null>(null);
  const [claimingPoolId, setClaimingPoolId] = useState<string | null>(null);
  const [phonePriceMonthly, setPhonePriceMonthly] = useState<number | null>(null);
  const [smsConsentAccepted, setSmsConsentAccepted] = useState(false);


  useEffect(() => {
    loadAccounts();
    loadPoolPhone();
    loadTenantPhones();
    loadPhonePricing();
  }, []);

  useEffect(() => {
    if (selectedAccountId) {
      loadConnectionStatus(selectedAccountId);
    }
  }, [selectedAccountId]);

  async function loadPoolPhone() {
    try {
      if (!_phoneCache) setLoadingPoolPhone(true);
      const result = await usersApi.getMyPoolPhone();
      const phones = result.poolPhones || (result.poolPhone ? [result.poolPhone] : []);
      setPoolPhones(phones);
      _phoneCache = { ..._phoneCache, poolPhones: phones };
    } catch (err) {
      console.error('Failed to load pool phone:', err);
    } finally {
      setLoadingPoolPhone(false);
    }
  }

  async function loadAccounts() {
    try {
      const { accounts: fresh } = await thumbtackApi.getSavedAccounts();
      setAccounts(fresh);
      setSavedAccounts(fresh); // Update global app store
      if (!selectedAccountId && fresh.length > 0) {
        setSelectedAccountId(fresh[0].id);
      }
    } catch (err: any) {
      // Silent fail if we already have store data
      if (accounts.length === 0) {
        setError(err.message || 'Failed to load accounts');
      }
    } finally {
      setLoading(false);
    }
  }

  async function loadConnectionStatus(accountId: string) {
    setLoadingConnectionStatus(true);
    setConnectError(null);
    try {
      const settingsRes = await notificationsApi.getSettings(accountId);
      const connected = !!settingsRes.settings?.sigcoreConnected;
      const provisioned = !!settingsRes.settings?.sigcoreProvisioned;
      setSigcoreConnected(connected);
      setSigcoreProvisioned(provisioned);
      setSigcoreFromPhone(settingsRes.settings?.sigcoreFromPhone || null);
      setSigcoreProvider(settingsRes.settings?.sigcoreProvider || null);
      let phones: SigcorePhoneNumber[] = [];
      if (connected) {
        const { phoneNumbers } = await notificationsApi.getSigcorePhoneNumbers(accountId);
        phones = phoneNumbers;
      }
      setOwnPhoneNumbers(phones);
      _phoneCache = { ..._phoneCache, sigcoreConnected: connected, sigcoreProvisioned: provisioned, ownPhoneNumbers: phones };
    } catch (err) {
      console.error('Failed to load connection status:', err);
    } finally {
      setLoadingConnectionStatus(false);
    }
  }

  async function handleConnect() {
    if (!openPhoneApiKey.trim()) {
      setConnectError('Please enter your QUO API key');
      return;
    }
    setConnecting(true);
    setConnectError(null);
    try {
      const result = await notificationsApi.connectSigcore(
        selectedAccountId,
        'openphone',
        { apiKey: openPhoneApiKey },
      );
      if (result.success) {
        setSigcoreConnected(true);
        setOwnPhoneNumbers(result.phoneNumbers);
        setOpenPhoneApiKey('');
      } else {
        setConnectError(result.error || 'Failed to connect QUO');
      }
    } catch (err: any) {
      setConnectError(err.message || 'Failed to connect QUO');
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    setConnectError(null);
    try {
      await notificationsApi.disconnectSigcore(selectedAccountId);
      setSigcoreConnected(false);
      setOwnPhoneNumbers([]);
    } catch (err: any) {
      setConnectError(err.message || 'Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleProvision() {
    setProvisioning(true);
    setConnectError(null);
    try {
      await notificationsApi.provisionSigcoreWorkspace(selectedAccountId);
      setSigcoreProvisioned(true);
    } catch (err: any) {
      setConnectError(err.message || 'Failed to enable phone workspace');
    } finally {
      setProvisioning(false);
    }
  }

  async function handleSearchNumbers() {
    setSearchLoading(true);
    setSearchError(null);
    setAvailableNumbers([]);
    try {
      const result = await notificationsApi.searchAvailableNumbers(
        selectedAccountId, 'US', searchAreaCode || undefined, searchLocality || undefined,
      );
      setAvailableNumbers(result.data || []);
      if ((result.data || []).length === 0) {
        setSearchError('No numbers found. Try a different area code.');
      }
    } catch (err: any) {
      setSearchError(err.message || 'Failed to search numbers');
    } finally {
      setSearchLoading(false);
    }
  }

  async function loadTenantPhones() {
    try {
      setLoadingTenantPhones(true);
      const result = await notificationsApi.listTenantPhones();
      if (result.success) {
        setTenantPhones(result.data);
        _phoneCache = { ..._phoneCache, tenantPhones: result.data };
      }
    } catch {
      console.error('Failed to load tenant phones');
    } finally {
      setLoadingTenantPhones(false);
    }
  }

  async function loadPhonePricing() {
    try {
      const result = await notificationsApi.getPhonePricing();
      if (result.success) setPhonePriceMonthly(result.data.priceMonthly);
    } catch {
      // keep null
    }
  }

  async function handlePurchaseNumber(phoneNumber: string) {
    setPurchasingNumber(phoneNumber);
    setSearchError(null);
    try {
      const result = await notificationsApi.purchaseTenantPhone(selectedAccountId, phoneNumber);
      if (result.success) {
        setSigcoreFromPhone(phoneNumber);
        setSigcoreProvider('twilio');
        setAvailableNumbers([]);
        await loadTenantPhones(); // Refresh list
      } else {
        setSearchError(result.error || 'Failed to purchase number');
      }
    } catch (err: any) {
      setSearchError(err.message || 'Failed to purchase number');
    } finally {
      setPurchasingNumber(null);
    }
  }

  async function handleCancelTenantPhone(tenantPhoneId: string) {
    if (!confirm('Cancel this phone number? Billing will stop immediately. The number will be kept during the grace period.')) return;
    setCancellingPhoneId(tenantPhoneId);
    try {
      const result = await notificationsApi.cancelTenantPhone(tenantPhoneId);
      if (result.success) {
        await loadTenantPhones();
      } else {
        setSearchError(result.error || 'Failed to cancel number');
      }
    } catch (err: any) {
      setSearchError(err.message || 'Failed to cancel number');
    } finally {
      setCancellingPhoneId(null);
    }
  }

  async function handleClaimPoolAsDedicated(poolId: string, phoneNumber: string) {
    if (!confirm(`Claim ${phoneNumber} as your dedicated number? It will be removed from the shared pool and assigned exclusively to you.`)) return;
    setClaimingPoolId(poolId);
    try {
      await usersApi.claimPoolAsDedicated(poolId);
      await Promise.all([loadTenantPhones(), loadPoolPhone()]);
    } catch (err: any) {
      setSearchError(err.response?.data?.message || err.message || 'Failed to claim number');
    } finally {
      setClaimingPoolId(null);
    }
  }


  if (loading && accounts.length === 0) {
    return (
      <div className="p-6 lg:p-10">
        <div className="flex items-center gap-3 mb-6">
          <Phone className="w-6 h-6 text-blue-600" />
          <h1 className="text-2xl font-bold text-slate-900">Business Line</h1>
        </div>
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 size={32} className="animate-spin text-blue-600" />
          <p className="mt-4 text-slate-500">Loading...</p>
        </div>
      </div>
    );
  }

  if (accounts.length === 0 && useAuthStore.getState().user?.role === 'ADMIN') {
    return (
      <div className="p-6 lg:p-10">
        <div className="flex items-center gap-3 mb-6">
          <Phone className="w-6 h-6 text-blue-600" />
          <h1 className="text-2xl font-bold text-slate-900">Business Line</h1>
        </div>
        <AdminNoAccountsState />
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-10 max-w-5xl mx-auto space-y-10">
      {accounts.length === 0 && <NoAccountsOverlay />}
      {error && (
        <div className="bg-red-50 border border-red-100 rounded-2xl p-4 flex items-center gap-3 text-red-600 text-sm font-medium">
          <AlertCircle size={16} className="shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="p-1 hover:bg-red-100 rounded-lg transition-colors">
            <X size={16} />
          </button>
        </div>
      )}

      {/* Welcome Section */}
      <section className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <p className="text-blue-600 font-semibold mb-1 uppercase tracking-wider text-xs">Communication Hub</p>
          <h2 className="text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight">
            Business <span className="gradient-text">Line.</span>
          </h2>
          <p className="text-slate-500 mt-2 text-lg">Manage phone numbers for SMS notifications and customer communication.</p>
        </div>
      </section>

      {/* Account Selector */}
      <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-1">Select Account</h2>
          <p className="text-slate-600 text-sm">View phone numbers for your business profile.</p>
        </div>
        <div className="relative min-w-[240px]">
          <select
            value={selectedAccountId}
            onChange={e => setSelectedAccountId(e.target.value)}
            className="w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl focus:ring-blue-500 focus:border-blue-500 block p-3 appearance-none font-semibold"
          >
            {accounts.map(acc => (
              <option key={acc.id} value={acc.id}>
                {acc.businessName}
              </option>
            ))}
          </select>
          <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-slate-400">
            <ChevronDown className="w-4 h-4" />
          </div>
        </div>
      </div>

      {/* Options Info */}
      <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 text-blue-700 text-sm">
        <p className="font-medium">
          You have three options for sending SMS: use a phone number assigned by your administrator, connect your own QUO account, or get a dedicated Twilio number.
        </p>
      </div>

      {/* Option 1: Admin-Assigned Phone */}
      <section className="space-y-6">
        <div className="flex items-center gap-3 px-2">
          <PhoneCall className="w-5 h-5 text-blue-600" />
          <h3 className="text-xl font-bold text-slate-900">Option 1: Admin-Assigned Phone</h3>
        </div>

        {loadingPoolPhone ? (
          <div className="flex justify-center py-10">
            <Loader2 size={24} className="animate-spin text-blue-600" />
          </div>
        ) : poolPhones.length > 0 ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {poolPhones.map(phone => (
                <div key={phone.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 hover:border-blue-200 transition-all">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 bg-emerald-50 text-emerald-600 rounded-xl flex items-center justify-center">
                      <Phone className="w-5 h-5" />
                    </div>
                    <div className="flex-1">
                      <div className="font-bold text-slate-900 text-sm">{phone.phoneNumber}</div>
                      <div className="text-xs text-slate-400">{phone.areaCode ? `Area: ${phone.areaCode}` : 'LeadBridge Pool'}</div>
                    </div>
                  </div>
                  {phone.friendlyName && (
                    <div className="text-xs text-slate-500 mt-2">{phone.friendlyName}</div>
                  )}
                  <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-2 flex-wrap">
                    <span className="px-2 py-1 bg-blue-50 text-blue-600 text-[10px] font-bold rounded uppercase">LeadBridge</span>
                    {phone.smsApproved ? (
                      <span className="px-2 py-1 bg-green-50 text-green-700 text-[10px] font-bold rounded uppercase flex items-center gap-1">
                        <ShieldCheck size={10} /> SMS OK
                      </span>
                    ) : (
                      <span className="px-2 py-1 bg-red-50 text-red-600 text-[10px] font-bold rounded uppercase flex items-center gap-1">
                        <ShieldAlert size={10} /> No SMS
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="bg-slate-50 rounded-2xl p-4 text-sm text-slate-600">
              <p>✓ Assigned by administrator • Used as default sender for SMS alerts</p>
            </div>
          </div>
        ) : (
          <div className="bg-slate-50 border-2 border-dashed border-slate-200 rounded-3xl p-10 text-center">
            <Building2 className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <h3 className="text-lg font-bold text-slate-600 mb-2">No Phone Assigned</h3>
            <p className="text-slate-500 max-w-md mx-auto">
              Your administrator can assign a phone number from the pool to enable SMS functionality.
            </p>
          </div>
        )}
      </section>

      {/* Option 2: Connect Your Own Provider */}
      <section className="space-y-6">
        <div className="flex items-center gap-3 px-2">
          <Phone className="w-5 h-5 text-blue-600" />
          <h3 className="text-xl font-bold text-slate-900">Option 2: Connect Your Own QUO</h3>
          {sigcoreConnected && (
            <span className="px-2 py-1 bg-emerald-50 text-emerald-600 text-[10px] font-bold rounded uppercase">Connected</span>
          )}
        </div>

        {connectError && (
          <div className="bg-red-50 border border-red-100 rounded-2xl p-4 flex items-center gap-3 text-red-600 text-sm font-medium">
            <AlertCircle size={16} className="shrink-0" />
            <span className="flex-1">{connectError}</span>
            <button onClick={() => setConnectError(null)} className="p-1 hover:bg-red-100 rounded-lg transition-colors">
              <X size={16} />
            </button>
          </div>
        )}

        {loadingConnectionStatus ? (
          <div className="flex justify-center py-10">
            <Loader2 size={24} className="animate-spin text-blue-600" />
          </div>
        ) : sigcoreConnected ? (
          <div className="space-y-4">
            <div className="bg-emerald-50 border border-emerald-100 rounded-2xl p-4 flex items-center gap-3 text-emerald-700 text-sm">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>QUO account connected. Your phone numbers are available for customer texting.</span>
            </div>
            {ownPhoneNumbers.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {ownPhoneNumbers.map(phone => (
                  <div key={phone.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 hover:border-blue-200 transition-all">
                    <div className="flex items-center gap-3 mb-3">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${phone.smsEnabled ? 'bg-blue-50 text-blue-600' : 'bg-red-50 text-red-500'}`}>
                        <Phone className="w-5 h-5" />
                      </div>
                      <div className="flex-1">
                        <div className="font-bold text-slate-900 text-sm">{phone.phoneNumber}</div>
                        <div className="text-xs text-slate-400">{phone.friendlyName || 'QUO'}</div>
                      </div>
                    </div>
                    <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-2 flex-wrap">
                      <span className="px-2 py-1 bg-blue-50 text-blue-600 text-[10px] font-bold rounded uppercase">QUO</span>
                      {phone.smsEnabled ? (
                        <span className="px-2 py-1 bg-green-50 text-green-700 text-[10px] font-bold rounded uppercase flex items-center gap-1">
                          <ShieldCheck size={10} /> SMS OK
                        </span>
                      ) : (
                        <span className="px-2 py-1 bg-red-50 text-red-600 text-[10px] font-bold rounded uppercase flex items-center gap-1" title="SMS not available on this number">
                          <ShieldAlert size={10} /> No SMS
                        </span>
                      )}
                      {phone.voiceEnabled && (
                        <span className="px-2 py-1 bg-slate-50 text-slate-500 text-[10px] font-bold rounded uppercase flex items-center gap-1">
                          <PhoneCall size={10} /> Voice
                        </span>
                      )}
                      {phone.mmsEnabled && (
                        <span className="px-2 py-1 bg-slate-50 text-slate-500 text-[10px] font-bold rounded uppercase flex items-center gap-1">
                          <MessageSquare size={10} /> MMS
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <button
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 border border-red-200 rounded-xl transition-all disabled:opacity-50"
            >
              {disconnecting ? <Loader2 size={16} className="animate-spin" /> : <Unplug size={16} />}
              {disconnecting ? 'Disconnecting...' : 'Disconnect QUO'}
            </button>
          </div>
        ) : !sigcoreProvisioned ? (
          <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-6 space-y-4">
            <div>
              <h4 className="font-semibold text-slate-900 mb-1">Enable Phone Workspace</h4>
              <p className="text-slate-500 text-sm">Set up your isolated phone workspace before connecting QUO.</p>
            </div>
            <button
              onClick={handleProvision}
              disabled={provisioning}
              className="px-5 py-3 bg-blue-600 text-white rounded-xl font-semibold text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 shadow-lg shadow-blue-200 transition-all"
            >
              {provisioning ? <Loader2 size={16} className="animate-spin" /> : <Building2 size={16} />}
              {provisioning ? 'Setting up...' : 'Enable Phone Workspace'}
            </button>
          </div>
        ) : (
          <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-6 space-y-4">
            <div>
              <h4 className="font-semibold text-slate-900 mb-1">Connect your QUO account</h4>
              <p className="text-slate-500 text-sm">
                Enter your QUO API key to use your own phone numbers for customer texting.{' '}
                <a
                  href="https://my.quo.com/settings/api"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline inline-flex items-center gap-1"
                >
                  Get your API key <ExternalLink size={12} />
                </a>
              </p>
            </div>
            <div className="flex gap-3">
              <div className="relative flex-1">
                <Key size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="password"
                  value={openPhoneApiKey}
                  onChange={e => setOpenPhoneApiKey(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleConnect()}
                  placeholder="QUO API key"
                  className="w-full pl-9 pr-4 py-3 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
                />
              </div>
              <button
                onClick={handleConnect}
                disabled={connecting || !openPhoneApiKey.trim()}
                className="px-5 py-3 bg-blue-600 text-white rounded-xl font-semibold text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-lg shadow-blue-200 transition-all"
              >
                {connecting ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}
                {connecting ? 'Connecting...' : 'Connect'}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Option 3: Get a Dedicated Twilio Number */}
      <section className="space-y-6">
        <div className="flex items-center gap-3 px-2">
          <Hash className="w-5 h-5 text-blue-600" />
          <h3 className="text-xl font-bold text-slate-900">Option 3: Get a Dedicated Number</h3>
          {tenantPhones.filter(t => t.status === 'ACTIVE').length > 0 && (
            <span className="px-2 py-1 bg-emerald-50 text-emerald-600 text-[10px] font-bold rounded uppercase">
              {tenantPhones.filter(t => t.status === 'ACTIVE').length} Active
            </span>
          )}
        </div>

        {searchError && (
          <div className="bg-red-50 border border-red-100 rounded-2xl p-4 flex items-center gap-3 text-red-600 text-sm font-medium">
            <AlertCircle size={16} className="shrink-0" />
            <span className="flex-1">{searchError}</span>
            <button onClick={() => setSearchError(null)} className="p-1 hover:bg-red-100 rounded-lg transition-colors">
              <X size={16} />
            </button>
          </div>
        )}

        {!sigcoreProvisioned ? (
          <div className="bg-slate-50 border-2 border-dashed border-slate-200 rounded-3xl p-8 text-center">
            <Hash className="w-10 h-10 text-slate-300 mx-auto mb-3" />
            <p className="text-slate-500 text-sm">Enable your Phone Workspace (Option 2 above) first to get a dedicated number.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Existing tenant phone numbers */}
            {tenantPhones.length > 0 && (
              <div className="space-y-3">
                <h4 className="font-semibold text-slate-900 text-sm">Your Dedicated Numbers</h4>
                {tenantPhones.map(tp => (
                  <div key={tp.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-center gap-4">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${tp.status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                      <Phone className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-slate-900 font-mono text-sm">{tp.phoneNumber}</div>
                      <div className="text-xs text-slate-400 flex items-center gap-2 flex-wrap">
                        <span>Twilio · Dedicated</span>
                        {tp.status === 'ACTIVE' && (
                          <span className="px-1.5 py-0.5 bg-emerald-50 text-emerald-600 rounded text-[10px] font-bold uppercase">Active</span>
                        )}
                        {tp.status === 'ACTIVE' && (
                          <span className="px-1.5 py-0.5 bg-green-50 text-green-700 rounded text-[10px] font-bold uppercase flex items-center gap-0.5">
                            <ShieldCheck size={9} /> SMS OK
                          </span>
                        )}
                        {tp.status === 'GRACE_PERIOD' && (
                          <span className="px-1.5 py-0.5 bg-amber-50 text-amber-600 rounded text-[10px] font-bold uppercase">
                            Grace Period{tp.gracePeriodEndsAt ? ` — expires ${new Date(tp.gracePeriodEndsAt).toLocaleDateString()}` : ''}
                          </span>
                        )}
                        {phonePriceMonthly != null && tp.status === 'ACTIVE' && (
                          <span className="text-slate-300">·</span>
                        )}
                        {phonePriceMonthly != null && tp.status === 'ACTIVE' && (
                          <span>${phonePriceMonthly.toFixed(2)}/mo</span>
                        )}
                      </div>
                    </div>
                    {tp.status === 'ACTIVE' && (
                      <button
                        onClick={() => handleCancelTenantPhone(tp.id)}
                        disabled={cancellingPhoneId === tp.id}
                        className="px-3 py-1.5 text-red-600 bg-red-50 hover:bg-red-100 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                      >
                        {cancellingPhoneId === tp.id ? <Loader2 size={12} className="animate-spin" /> : 'Cancel'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}


            {/* Claim from Pool */}
            {poolPhones.filter(p => p.status === 'AVAILABLE').length > 0 && (
              <div className="space-y-3">
                <div>
                  <h4 className="font-semibold text-slate-900 text-sm">Claim from Pool</h4>
                  <p className="text-xs text-slate-500 mt-0.5">Make one of your assigned pool numbers your exclusive dedicated number — no charge.</p>
                </div>
                {poolPhones.filter(p => p.status === 'AVAILABLE').map(phone => (
                  <div key={phone.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-center gap-4">
                    <div className="w-10 h-10 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center">
                      <Phone className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-slate-900 font-mono text-sm">{phone.phoneNumber}</div>
                      <div className="text-xs text-slate-400">{phone.friendlyName || 'Shared Pool'}{phone.areaCode ? ` · ${phone.areaCode}` : ''}</div>
                    </div>
                    <button
                      onClick={() => handleClaimPoolAsDedicated(phone.id, phone.phoneNumber)}
                      disabled={claimingPoolId === phone.id}
                      className="px-3 py-1.5 text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 whitespace-nowrap"
                    >
                      {claimingPoolId === phone.id ? <Loader2 size={12} className="animate-spin" /> : 'Claim as Dedicated'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* SMS Consent */}
            <div className={`rounded-2xl border p-4 ${smsConsentAccepted ? 'bg-emerald-50/50 border-emerald-200' : 'bg-amber-50/50 border-amber-200'}`}>
              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={smsConsentAccepted}
                  onChange={e => setSmsConsentAccepted(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-xs text-slate-600 leading-relaxed">
                  I agree to receive SMS notifications from Geos LLC regarding account alerts and new leads. Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe or HELP for assistance.
                </span>
              </label>
              {!smsConsentAccepted && (
                <div className="mt-2 ml-7 flex items-center gap-1.5 text-amber-600 text-xs font-medium">
                  <AlertCircle size={12} className="shrink-0" />
                  You must accept the SMS consent to purchase a phone number.
                </div>
              )}
            </div>

            {/* Search & purchase new numbers */}
            <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-6 space-y-6">
              <div>
                <h4 className="font-semibold text-slate-900 mb-1">
                  {tenantPhones.filter(t => t.status === 'ACTIVE').length > 0 ? 'Get Another Number' : 'Search Available Numbers'}
                </h4>
                <p className="text-slate-500 text-sm">
                  Pick a dedicated US phone number for your account.
                  {phonePriceMonthly != null && <span className="font-medium"> ${phonePriceMonthly.toFixed(2)}/mo per number.</span>}
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <input
                  type="text"
                  value={searchAreaCode}
                  onChange={e => setSearchAreaCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
                  onKeyDown={e => e.key === 'Enter' && handleSearchNumbers()}
                  placeholder="Area code (e.g. 415)"
                  maxLength={3}
                  className="w-36 px-4 py-3 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono tracking-widest"
                />
                <input
                  type="text"
                  value={searchLocality}
                  onChange={e => setSearchLocality(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSearchNumbers()}
                  placeholder="City (e.g. San Francisco)"
                  className="flex-1 min-w-40 px-4 py-3 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
                <button
                  onClick={handleSearchNumbers}
                  disabled={searchLoading}
                  className="px-5 py-3 bg-blue-600 text-white rounded-xl font-semibold text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 shadow-lg shadow-blue-200 transition-all"
                >
                  {searchLoading ? <Loader2 size={16} className="animate-spin" /> : <Hash size={16} />}
                  {searchLoading ? 'Searching...' : 'Search Numbers'}
                </button>
              </div>

              {availableNumbers.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {availableNumbers.map(num => (
                    <div key={num.phoneNumber} className="bg-slate-50 rounded-2xl border border-slate-200 p-4 flex flex-col gap-3 hover:border-blue-200 transition-all">
                      <div>
                        <div className="font-bold text-slate-900 font-mono text-sm">{num.phoneNumber}</div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {[num.locality, num.region].filter(Boolean).join(', ') || 'US'}
                        </div>
                        {phonePriceMonthly != null && (
                          <div className="text-xs text-slate-400 mt-1">${phonePriceMonthly.toFixed(2)}/mo</div>
                        )}
                      </div>
                      <button
                        onClick={() => handlePurchaseNumber(num.phoneNumber)}
                        disabled={purchasingNumber !== null || !smsConsentAccepted}
                        className="w-full px-4 py-2 bg-blue-600 text-white rounded-xl font-semibold text-xs hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2 transition-all"
                      >
                        {purchasingNumber === num.phoneNumber ? (
                          <><Loader2 size={14} className="animate-spin" /> Getting...</>
                        ) : 'Get this number'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
