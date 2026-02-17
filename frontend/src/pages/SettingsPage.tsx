import { useState, useEffect } from 'react';
import { Settings, CheckCircle, AlertCircle, Rocket, Zap, Lock, Download, ChevronDown, ChevronUp, Loader2, X, Pencil, Check, RefreshCw, Info } from 'lucide-react';
import { billingApi, thumbtackApi, leadsApi, usersApi } from '../services/api';
import { notify } from '../store/notificationStore';
import { useAuthStore } from '../store/authStore';
import { useAppStore } from '../store/appStore';
import type { SubscriptionDetails, SavedAccount, AccountDiagnostics } from '../types';
import { Link } from 'react-router-dom';
import ConnectionModal from '../components/ConnectionModal';

const tierNames: Record<string, string> = {
  STARTER: 'Instant Reply',
  PRO: 'Call Assist',
  ENTERPRISE: 'AI Conversations',
};

const tierPrices: Record<string, number> = {
  STARTER: 49,
  PRO: 99,
  ENTERPRISE: 129,
};

export default function SettingsPage() {
  const user = useAuthStore(state => state.user);
  const setAuth = useAuthStore(state => state.setAuth);
  const setSavedAccounts = useAppStore(state => state.setSavedAccounts);
  const [subscription, setSubscription] = useState<SubscriptionDetails | null>(null);
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);
  const [accountDiagnostics, setAccountDiagnostics] = useState<Record<string, AccountDiagnostics>>({});
  const [selectedAccountForInfo, setSelectedAccountForInfo] = useState<string | null>(null);
  const [connectionModalOpen, setConnectionModalOpen] = useState(false);
  const [accountToReconnect, setAccountToReconnect] = useState<SavedAccount | null>(null);

  // Name editing
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [savingName, setSavingName] = useState(false);

  // Import negotiations state
  const [importCollapsed, setImportCollapsed] = useState(true);
  const [importAccountId, setImportAccountId] = useState<string | null>(null);
  const [importIds, setImportIds] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResults, setImportResults] = useState<{ id: string; success: boolean; isNew?: boolean; error?: string }[]>([]);
  const [importTotal, setImportTotal] = useState(0);
  const [showImportResults, setShowImportResults] = useState(false);
  const [importError, setImportError] = useState('');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [subResult, acctResult] = await Promise.all([
        billingApi.getSubscription().catch(() => null),
        thumbtackApi.getSavedAccounts().catch(() => ({ accounts: [] as SavedAccount[], count: 0 })),
      ]);
      setSubscription(subResult);
      setAccounts(acctResult.accounts);
      setSavedAccounts(acctResult.accounts); // Update app store

      // Load diagnostics for accounts with issues
      if (acctResult.accounts.length > 0) {
        loadDiagnostics(acctResult.accounts);
      }
    } catch (error: any) {
      console.error('Failed to load settings data:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadDiagnostics = async (accountsList: SavedAccount[]) => {
    const diagnosticsMap: Record<string, AccountDiagnostics> = {};

    for (const account of accountsList) {
      try {
        const diag = await thumbtackApi.getAccountHealth(account.id);
        diagnosticsMap[account.id] = diag;
      } catch (err) {
        console.error(`Failed to load diagnostics for ${account.id}:`, err);
      }
    }

    setAccountDiagnostics(diagnosticsMap);
  };

  const handleReconnect = (account?: SavedAccount) => {
    if (account) {
      setAccountToReconnect(account);
    }
    setConnectionModalOpen(true);
  };

  const handleConnectionSuccess = () => {
    // Reload data after successful connection
    loadData();
    setAccountToReconnect(null);
  };

  const handleManageSubscription = async () => {
    try {
      setPortalLoading(true);
      const { portalUrl } = await billingApi.createPortalSession();
      window.location.href = portalUrl;
    } catch (error: any) {
      console.error('Failed to open billing portal:', error);
      notify.error('Error', 'Failed to open billing portal');
      setPortalLoading(false);
    }
  };

  const handleSaveName = async () => {
    if (!nameValue.trim() || nameValue === user?.name) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    try {
      await usersApi.updateProfile({ name: nameValue.trim() });
      if (user) {
        const token = localStorage.getItem('token');
        if (token) {
          setAuth({ ...user, name: nameValue.trim() }, token);
        }
      }
      notify.success('Updated', 'Name updated successfully');
      setEditingName(false);
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to update name');
    } finally {
      setSavingName(false);
    }
  };

  const handleImportNegotiations = async () => {
    if (!importAccountId) { setImportError('Select an account first'); return; }
    const ids = importIds.split(/[,\n\t\s]+/).map(id => id.trim()).filter(id => id.length > 0);
    if (ids.length === 0) { setImportError('Enter at least one negotiation ID'); return; }

    setImporting(true);
    setImportError('');
    setImportResults([]);

    // Validate token first
    try {
      const validation = await thumbtackApi.validateToken(importAccountId);
      if (!validation.valid) {
        setImportError('Session expired. Please reconnect this account from the Overview page, then try again.');
        setImporting(false);
        return;
      }
    } catch {
      setImportError('Session expired. Please reconnect this account from the Overview page, then try again.');
      setImporting(false);
      return;
    }

    setImportTotal(ids.length);
    setShowImportResults(true);

    const results: typeof importResults = [];
    for (const id of ids) {
      try {
        const result = await leadsApi.importNegotiation(id, importAccountId);
        results.push({ id, success: true, isNew: result.isNew });
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || err.response?.data?.error || err.message || 'Failed to import';
        results.push({ id, success: false, error: errorMsg });
      }
      setImportResults([...results]);
    }

    setImporting(false);
    const newCount = results.filter(r => r.success && r.isNew).length;
    const failCount = results.filter(r => !r.success).length;
    if (newCount > 0 && failCount === 0) {
      notify.success('Import Complete', `Successfully imported ${newCount} negotiation(s)`);
      setImportIds('');
    } else if (failCount > 0 && newCount > 0) {
      notify.warning('Import Partial', `${newCount} imported, ${failCount} failed`);
    } else if (failCount > 0) {
      setImportError(`Failed to import all ${failCount} negotiation(s)`);
    }
  };

  if (loading) {
    return (
      <div className="p-6 lg:p-10 max-w-5xl mx-auto space-y-10">
        <div className="flex items-center gap-4 mb-2">
          <div className="w-12 h-12 bg-slate-100 rounded-2xl flex items-center justify-center text-slate-600">
            <Settings className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight">Account <span className="gradient-text">Settings</span></h2>
            <p className="text-slate-500">Manage your business profile, marketplace connections, and billing.</p>
          </div>
        </div>
        <div className="bg-white rounded-[2.5rem] border border-slate-100 shadow-sm p-8">
          <div className="flex items-center justify-center h-32">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        </div>
      </div>
    );
  }

  const hasSubscription = Boolean(subscription?.tier && subscription?.status);
  const isCancelled = subscription?.status === 'CANCELLED';
  const isActivePaid = hasSubscription && !isCancelled && subscription?.status !== 'TRIALING';
  const trial = subscription?.trial;
  const isTrialActive = trial?.isOnTrial && !trial?.trialExpired;
  const isTrialExpired = trial?.trialExpired;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="p-6 lg:p-10 max-w-5xl mx-auto space-y-10">
      {/* Header */}
      <div className="flex items-center gap-4 mb-2">
        <div className="w-12 h-12 bg-slate-100 rounded-2xl flex items-center justify-center text-slate-600">
          <Settings className="w-6 h-6" />
        </div>
        <div>
          <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight">Account <span className="gradient-text">Settings</span></h2>
          <p className="text-slate-500">Manage your business profile, marketplace connections, and billing.</p>
        </div>
      </div>

      {/* Section 1: Account Info */}
      <div className="bg-white rounded-[2.5rem] border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-8 py-6 border-b border-slate-50">
          <h3 className="text-lg font-bold text-slate-900">Business Profile</h3>
        </div>
        <div className="p-8">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          <div className="space-y-1">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Name</p>
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveName();
                    if (e.key === 'Escape') setEditingName(false);
                  }}
                  autoFocus
                  className="flex-1 px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                />
                <button className="p-2 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors" onClick={handleSaveName} disabled={savingName} title="Save">
                  {savingName ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check size={16} />}
                </button>
                <button className="p-2 text-slate-400 hover:bg-slate-50 rounded-lg transition-colors" onClick={() => setEditingName(false)} title="Cancel">
                  <X size={16} />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 cursor-pointer group" onClick={() => { setNameValue(user?.name || ''); setEditingName(true); }}>
                <p className="text-slate-900 font-semibold text-lg">{user?.name || 'Not set'}</p>
                <Pencil size={14} className="text-slate-300 group-hover:text-slate-500 transition-colors" />
              </div>
            )}
          </div>
          <div className="space-y-1">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Email Address</p>
            <p className="text-slate-900 font-semibold text-lg">{user?.email || 'Not set'}</p>
          </div>
          {user?.phoneNumber && (
            <div className="space-y-1">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Phone Number</p>
              <p className="text-slate-900 font-semibold text-lg font-mono">{user.phoneNumber}</p>
            </div>
          )}
          <div className="space-y-1">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Time Zone</p>
            <p className="text-slate-900 font-semibold text-lg">{timeZone}</p>
          </div>
          </div>
        </div>
      </div>

      {/* Section 2: Marketplace Connections */}
      <div className="space-y-4">
        <h3 className="text-xl font-bold text-slate-900 px-2">Marketplace Connections</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Thumbtack */}
          <div className="bg-white rounded-[2rem] border border-slate-100 shadow-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white font-bold text-xs shadow-lg shadow-blue-100">TT</div>
                <span className="font-bold text-slate-900">Thumbtack</span>
              </div>
              {accounts.length > 0 && (
                <span className="bg-emerald-50 text-emerald-600 text-[10px] font-bold px-2 py-1 rounded-full border border-emerald-100 uppercase tracking-tighter">Active</span>
              )}
            </div>
            {accounts.length > 0 ? (
              <div className="space-y-3">
              {accounts.map(account => {
                const diag = accountDiagnostics[account.id];
                const hasConnectionIssues = !account.webhookId || (diag && !diag.healthy);
                const hasSmsIssues = !hasConnectionIssues && diag && (diag.notificationIssues?.length ?? 0) > 0;
                const hasIssues = hasConnectionIssues || hasSmsIssues;

                return (
                  <div
                    key={account.id}
                    className={`p-3 rounded-2xl border transition-all ${
                      hasConnectionIssues
                        ? 'bg-amber-50/50 border-amber-200 hover:border-amber-300 cursor-pointer'
                        : hasSmsIssues
                          ? 'bg-orange-50/50 border-orange-200 hover:border-orange-300 cursor-pointer'
                          : 'bg-slate-50 border-slate-100 hover:border-slate-200'
                    }`}
                    onClick={() => hasIssues && setSelectedAccountForInfo(account.id)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-slate-900 truncate">{account.businessName}</p>
                        <p className="text-[10px] text-slate-400 font-medium uppercase">ID: {account.businessId}</p>
                        {hasConnectionIssues && diag && diag.issues.length > 0 && (
                          <p className="text-[10px] text-amber-700 mt-1 flex items-center gap-1">
                            <Info size={10} /> Click for details
                          </p>
                        )}
                        {hasSmsIssues && diag && (
                          <p className="text-[10px] text-orange-700 mt-1 flex items-center gap-1">
                            <Info size={10} /> {diag.notificationIssues[0]}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {hasConnectionIssues ? (
                          <AlertCircle className="w-5 h-5 text-amber-500" />
                        ) : hasSmsIssues ? (
                          <AlertCircle className="w-5 h-5 text-orange-400" />
                        ) : (
                          <CheckCircle className="w-5 h-5 text-emerald-500" />
                        )}
                        {hasConnectionIssues && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleReconnect(account);
                            }}
                            className="p-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                            title="Reconnect account"
                          >
                            <RefreshCw size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              </div>
            ) : (
              <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 border-dashed text-center">
                <p className="text-sm text-slate-400">No accounts connected yet</p>
                <p className="text-xs text-slate-400 mt-1">Connect from the Dashboard</p>
              </div>
            )}

            {/* Import Negotiations - collapsible */}
            {accounts.length > 0 && (
              <div className="mt-3 bg-blue-50/50 rounded-2xl border border-blue-100 overflow-hidden">
                <div
                  className="flex items-center justify-between p-3 cursor-pointer hover:bg-blue-50 transition-colors"
                  onClick={() => setImportCollapsed(!importCollapsed)}
                >
                  <div className="flex items-center gap-2">
                    <Download className="w-4 h-4 text-blue-600" />
                    <h4 className="text-sm font-bold text-slate-900">Import Negotiations</h4>
                  </div>
                  {importCollapsed ? <ChevronDown className="w-5 h-5 text-slate-400" /> : <ChevronUp className="w-5 h-5 text-slate-400" />}
                </div>

                {!importCollapsed && (
                  <div className="p-4 pt-0 space-y-3">
                    {importError && (
                      <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        <span className="flex-1">{importError}</span>
                        <button
                          className="p-1 hover:bg-red-100 rounded transition-colors"
                          onClick={() => setImportError('')}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    )}

                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-2">
                        Select Account
                      </label>
                      <select
                        value={importAccountId || ''}
                        onChange={(e) => setImportAccountId(e.target.value || null)}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                      >
                        <option value="">Choose account...</option>
                        {accounts.map(a => (
                          <option key={a.id} value={a.id}>{a.businessName}</option>
                        ))}
                      </select>
                    </div>

                    <textarea
                      placeholder="Paste negotiation IDs here (comma or newline separated)&#10;&#10;Example: abc123, def456, ghi789"
                      value={importIds}
                      onChange={(e) => setImportIds(e.target.value)}
                      disabled={importing}
                      rows={4}
                      className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 disabled:bg-slate-50 disabled:text-slate-400"
                    />

                    <div className="flex gap-2">
                      <button
                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        onClick={handleImportNegotiations}
                        disabled={importing || !importIds.trim() || !importAccountId}
                      >
                        {importing ? (
                          <><Loader2 className="w-4 h-4 animate-spin" /> Importing...</>
                        ) : (
                          <><Download className="w-4 h-4" /> Import</>
                        )}
                      </button>
                      {importIds && !importing && (
                        <button
                          className="flex items-center gap-2 px-4 py-2 bg-slate-100 text-slate-700 rounded-xl text-sm font-semibold hover:bg-slate-200 transition-colors"
                          onClick={() => { setImportIds(''); setImportResults([]); setShowImportResults(false); setImportError(''); }}
                        >
                          <X className="w-4 h-4" /> Clear
                        </button>
                      )}
                    </div>

                    {/* Import Progress */}
                    {importing && importTotal > 0 && (
                      <div className="space-y-2">
                        <div className="flex justify-between text-sm">
                          <span className="font-medium text-slate-700">Importing...</span>
                          <span className="text-slate-500">
                            {importResults.length} / {importTotal}
                          </span>
                        </div>
                        <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-600 rounded-full transition-all duration-300"
                            style={{ width: `${(importResults.length / importTotal) * 100}%` }}
                          />
                        </div>
                      </div>
                    )}

                    {/* Import Results */}
                    {showImportResults && importResults.length > 0 && !importing && (
                      <div className="space-y-2">
                        <h4 className="text-sm font-bold text-slate-700">Results ({importResults.length} / {importTotal})</h4>
                        <div className="space-y-2 max-h-48 overflow-y-auto">
                          {importResults.map((result, idx) => (
                            <div key={idx} className="flex items-center justify-between p-2 rounded-xl bg-white border border-slate-100 text-sm">
                              <span className="font-mono text-xs text-slate-600">{result.id}</span>
                              {result.success ? (
                                <span className="flex items-center gap-1.5">
                                  <CheckCircle className={`w-4 h-4 ${result.isNew ? 'text-emerald-500' : 'text-blue-500'}`} />
                                  <span className={`text-xs font-medium ${result.isNew ? 'text-emerald-600' : 'text-blue-600'}`}>
                                    {result.isNew ? 'New' : 'Exists'}
                                  </span>
                                </span>
                              ) : (
                                <span className="flex items-center gap-1.5">
                                  <AlertCircle className="w-4 h-4 text-red-500" />
                                  <span className="text-xs text-red-600 max-w-[200px] truncate" title={result.error}>
                                    {result.error}
                                  </span>
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Yelp */}
          <div className="bg-slate-50 rounded-[2rem] border border-slate-200 border-dashed p-6 flex flex-col items-center justify-center text-center">
            <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center text-slate-300 font-bold mb-3 border border-slate-100 text-lg">Y</div>
            <h4 className="font-bold text-slate-400">Yelp Integration</h4>
            <p className="text-xs text-slate-400 mb-4">Coming very soon to LeadBridge</p>
            <span className="px-4 py-1.5 bg-white text-slate-400 text-[10px] font-bold rounded-full border border-slate-200 uppercase tracking-widest">Waitlist Only</span>
          </div>
        </div>
      </div>

      {/* Section 3: Subscription & Billing */}
      <div className="space-y-4">
        <h3 className="text-xl font-bold text-slate-900 px-2">Subscription & Billing</h3>

        {/* STATE 1: Free Trial Active */}
        {isTrialActive && !isActivePaid && trial && (
          <div className="bg-white rounded-[2.5rem] border border-slate-100 shadow-sm p-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-600">
                <Rocket className="w-5 h-5" />
              </div>
              <span className="text-lg font-bold text-slate-900">Free Trial Active</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
              <div className="p-4 bg-slate-50 rounded-2xl text-center">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">Days Remaining</p>
                <p className="text-3xl font-bold text-slate-900">{trial.trialDaysRemaining}</p>
              </div>
              <div className="p-4 bg-slate-50 rounded-2xl text-center">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">Leads Used</p>
                <p className="text-3xl font-bold text-slate-900">{trial.trialLeadsHandled} / {trial.trialLeadsLimit}</p>
              </div>
              {trial.trialEndDate && (
                <div className="p-4 bg-slate-50 rounded-2xl text-center">
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2">Trial Ends</p>
                  <p className="text-lg font-bold text-slate-900">
                    {new Date(trial.trialEndDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}
                  </p>
                </div>
              )}
            </div>
            <p className="text-sm text-slate-600 mb-4">
              After your trial, choose a plan starting at ${tierPrices.STARTER}/month.
            </p>
            <Link to="/pricing" className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 transition-colors">
              <Zap className="w-4 h-4" /> Choose a Plan
            </Link>
          </div>
        )}

        {/* STATE 2: Trial Expired / No Plan */}
        {isTrialExpired && !isActivePaid && (
          <div className="bg-amber-50 rounded-[2.5rem] border border-amber-200 shadow-sm p-8">
            <div className="flex items-center gap-3 mb-4">
              <AlertCircle className="w-6 h-6 text-amber-600" />
              <h3 className="text-lg font-bold text-amber-900">Subscription Required</h3>
            </div>
            <p className="text-slate-700 mb-6">Your trial has ended. Upgrade to continue using automation.</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              <div className="flex items-center gap-2 p-3 bg-amber-100/50 rounded-xl border border-amber-200 text-amber-700">
                <Lock className="w-4 h-4 shrink-0" />
                <span className="text-sm font-medium">Auto Reply</span>
              </div>
              <div className="flex items-center gap-2 p-3 bg-amber-100/50 rounded-xl border border-amber-200 text-amber-700">
                <Lock className="w-4 h-4 shrink-0" />
                <span className="text-sm font-medium">Follow-Ups</span>
              </div>
              <div className="flex items-center gap-2 p-3 bg-amber-100/50 rounded-xl border border-amber-200 text-amber-700">
                <Lock className="w-4 h-4 shrink-0" />
                <span className="text-sm font-medium">Customer SMS</span>
              </div>
              <div className="flex items-center gap-2 p-3 bg-amber-100/50 rounded-xl border border-amber-200 text-amber-700">
                <Lock className="w-4 h-4 shrink-0" />
                <span className="text-sm font-medium">Call Connect</span>
              </div>
            </div>
            <Link to="/pricing" className="inline-flex items-center gap-2 px-6 py-3 bg-amber-600 text-white rounded-xl font-semibold hover:bg-amber-700 transition-colors">
              <Zap className="w-4 h-4" /> View Plans
            </Link>
          </div>
        )}

        {/* STATE 2b: No trial data at all, no subscription */}
        {!isTrialActive && !isTrialExpired && !isActivePaid && !isCancelled && (
          <div className="bg-blue-50 rounded-[2.5rem] border border-blue-200 shadow-sm p-8">
            <div className="flex items-center gap-3 mb-4">
              <Rocket className="w-6 h-6 text-blue-600" />
              <h3 className="text-lg font-bold text-blue-900">Start Your Plan</h3>
            </div>
            <p className="text-slate-700 mb-6">Unlock powerful features for lead management and automation.</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              <div className="flex items-center gap-2 p-3 bg-blue-100/50 rounded-xl border border-blue-200 text-blue-700">
                <CheckCircle className="w-4 h-4 shrink-0" />
                <span className="text-sm font-medium">Auto Reply</span>
              </div>
              <div className="flex items-center gap-2 p-3 bg-blue-100/50 rounded-xl border border-blue-200 text-blue-700">
                <CheckCircle className="w-4 h-4 shrink-0" />
                <span className="text-sm font-medium">Follow-Ups</span>
              </div>
              <div className="flex items-center gap-2 p-3 bg-blue-100/50 rounded-xl border border-blue-200 text-blue-700">
                <CheckCircle className="w-4 h-4 shrink-0" />
                <span className="text-sm font-medium">Customer SMS</span>
              </div>
              <div className="flex items-center gap-2 p-3 bg-blue-100/50 rounded-xl border border-blue-200 text-blue-700">
                <CheckCircle className="w-4 h-4 shrink-0" />
                <span className="text-sm font-medium">Call Connect</span>
              </div>
            </div>
            <Link to="/pricing" className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 transition-colors">
              <Zap className="w-4 h-4" /> View Plans
            </Link>
          </div>
        )}

        {/* STATE 3: Active Paid Subscription */}
        {isActivePaid && subscription && (
          <div className="bg-slate-900 rounded-[2.5rem] p-8 text-white relative overflow-hidden">
            <div className="relative z-10">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-8 pb-8 border-b border-white/10">
                <div>
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-2xl font-bold">{subscription.tier ? tierNames[subscription.tier] : 'Unknown'} Plan</h3>
                    <span className="px-3 py-1 bg-emerald-500/20 text-emerald-400 text-xs font-bold rounded-full border border-emerald-500/30 uppercase">
                      {subscription.status}
                    </span>
                  </div>
                  <p className="text-slate-400 text-sm">
                    {subscription.periodEnd && !subscription.cancelAtPeriodEnd
                      ? `Next billing: ${new Date(subscription.periodEnd).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`
                      : 'Manage your subscription'}
                  </p>
                </div>
                <div className="text-left md:text-right">
                  <div className="text-4xl font-black">${subscription.tier ? tierPrices[subscription.tier] : 0}<span className="text-lg text-slate-500 font-medium">/mo</span></div>
                  {subscription.hasOwnNumber && (
                    <p className="text-slate-400 text-xs mt-1">+ Business Number ($29/mo)</p>
                  )}
                </div>
              </div>

              {subscription.cancelAtPeriodEnd && subscription.periodEnd && (
                <div className="mb-6 p-4 bg-amber-500/10 border border-amber-500/30 rounded-2xl">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                    <div>
                      <strong className="text-amber-400 font-bold">Subscription Ending</strong>
                      <p className="text-slate-300 text-sm mt-1">
                        You'll continue to have access until {new Date(subscription.periodEnd).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}. Reactivate anytime.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <button
                  className="flex-1 py-3 bg-white text-slate-900 rounded-xl font-bold text-sm hover:bg-slate-100 transition-colors disabled:opacity-50"
                  onClick={handleManageSubscription}
                  disabled={portalLoading}
                >
                  {portalLoading ? 'Opening...' : 'Manage Subscription'}
                </button>
                <Link to="/pricing" className="px-6 py-3 bg-white/10 text-white rounded-xl font-bold text-sm hover:bg-white/20 transition-colors">
                  View Plans
                </Link>
              </div>
            </div>
            {/* Background decoration */}
            <div className="absolute -right-20 -bottom-20 w-80 h-80 bg-blue-600/10 rounded-full blur-[100px]"></div>
          </div>
        )}

        {/* STATE 3b: Cancelled subscription */}
        {isCancelled && subscription && (
          <div className="bg-slate-100 rounded-[2.5rem] border border-slate-200 shadow-sm p-8">
            <div className="flex items-start gap-3 mb-6 p-4 bg-slate-200/50 rounded-2xl">
              <AlertCircle className="w-5 h-5 text-slate-600 shrink-0 mt-0.5" />
              <div>
                <strong className="text-slate-900 font-bold">Subscription Cancelled</strong>
                <p className="text-slate-600 text-sm mt-1">
                  Your subscription has been cancelled. {subscription.periodEnd && `Access continues until ${new Date(subscription.periodEnd).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.`} Reactivate anytime.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                className="px-6 py-3 bg-slate-900 text-white rounded-xl font-semibold hover:bg-slate-800 transition-colors disabled:opacity-50"
                onClick={handleManageSubscription}
                disabled={portalLoading}
              >
                {portalLoading ? 'Opening...' : 'Reactivate'}
              </button>
              <Link to="/pricing" className="px-6 py-3 bg-white text-slate-700 rounded-xl font-semibold border border-slate-200 hover:bg-slate-50 transition-colors">
                View Plans
              </Link>
            </div>
          </div>
        )}
      </div>

      {/* Section 4: Payment Method */}
      <div className="bg-white rounded-[2.5rem] border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-8 py-6 border-b border-slate-50">
          <h3 className="text-lg font-bold text-slate-900">Payment Method</h3>
        </div>
        <div className="p-8">
          <div className="flex items-center gap-6">
            <div className="w-16 h-12 bg-indigo-600 rounded-lg flex items-center justify-center text-white font-bold shadow-lg shadow-indigo-100">
              <svg width="40" height="26" viewBox="0 0 40 26" fill="none">
                <text x="20" y="16" textAnchor="middle" fill="white" fontSize="10" fontWeight="600">STRIPE</text>
              </svg>
            </div>
            <div className="flex-1">
              <p className="text-sm text-slate-600">
                {isActivePaid ? 'Manage your payment method through the billing portal.' : 'Add a payment method to subscribe to a plan.'}
              </p>
            </div>
            <button
              className="px-6 py-3 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-colors disabled:opacity-50 shrink-0"
              onClick={handleManageSubscription}
              disabled={portalLoading}
            >
              {portalLoading ? 'Opening...' : isActivePaid ? 'Update Card' : 'Add Card'}
            </button>
          </div>
        </div>
      </div>

      {/* Section 5: Invoices */}
      <div className="bg-white rounded-[2.5rem] border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-8 py-6 border-b border-slate-50">
          <h3 className="text-lg font-bold text-slate-900">Invoices</h3>
        </div>
        <div className="p-8">
          {isActivePaid || isCancelled ? (
            <div className="space-y-4">
              <div className="p-8 bg-slate-50 rounded-2xl text-center">
                <p className="text-sm text-slate-500">
                  View and manage invoices through the billing portal.
                </p>
              </div>
              <button
                className="px-6 py-3 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-colors disabled:opacity-50"
                onClick={handleManageSubscription}
                disabled={portalLoading}
              >
                {portalLoading ? 'Opening...' : 'View Invoices in Stripe'}
              </button>
            </div>
          ) : (
            <div className="p-8 bg-slate-50 rounded-2xl text-center">
              <p className="text-sm text-slate-500">
                No invoices yet. Invoices will appear here once you subscribe to a plan.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Account Diagnostics Modal */}
      {selectedAccountForInfo && accountDiagnostics[selectedAccountForInfo] && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setSelectedAccountForInfo(null)}>
          <div className="bg-white rounded-3xl p-8 max-w-2xl w-full shadow-2xl" onClick={e => e.stopPropagation()}>
            {(() => {
              const account = accounts.find(a => a.id === selectedAccountForInfo);
              const diag = accountDiagnostics[selectedAccountForInfo];
              if (!account || !diag) return null;

              return (
                <>
                  <div className="flex items-center justify-between mb-6">
                    <div>
                      <h3 className="text-2xl font-bold text-slate-900">{account.businessName}</h3>
                      <p className="text-sm text-slate-500 mt-1">Account Diagnostics</p>
                    </div>
                    <button
                      className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-all"
                      onClick={() => setSelectedAccountForInfo(null)}
                    >
                      <X size={18} />
                    </button>
                  </div>

                  {(() => {
                    const notifIssues = diag.notificationIssues || [];
                    const connIssues = diag.issues.filter((i: string) => !notifIssues.includes(i));
                    return (
                      <>
                        {connIssues.length > 0 && (
                          <div className="mb-4 space-y-2">
                            <h4 className="text-sm font-bold text-red-900 uppercase tracking-wider">Connection Issues:</h4>
                            {connIssues.map((issue: string, i: number) => (
                              <div key={i} className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
                                <AlertCircle size={16} className="shrink-0 mt-0.5" />
                                <span>{issue}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {notifIssues.length > 0 && (
                          <div className="mb-4 space-y-2">
                            <h4 className="text-sm font-bold text-orange-900 uppercase tracking-wider">SMS Configuration:</h4>
                            {notifIssues.map((issue: string, i: number) => (
                              <div key={i} className="flex items-start gap-2 p-3 bg-orange-50 border border-orange-200 rounded-xl text-sm text-orange-700">
                                <AlertCircle size={16} className="shrink-0 mt-0.5" />
                                <span>{issue}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    );
                  })()}

                  <div className="grid grid-cols-2 gap-3 mb-6">
                    <div className="flex items-center gap-2 text-sm">
                      {diag.platform.connected ? <CheckCircle size={14} className="text-emerald-600" /> : <AlertCircle size={14} className="text-red-600" />}
                      <span>Thumbtack connected</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      {diag.account.hasWebhook ? <CheckCircle size={14} className="text-emerald-600" /> : <AlertCircle size={14} className="text-red-600" />}
                      <span>Webhook registered</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      {diag.notifications.settingsExist ? <CheckCircle size={14} className="text-emerald-600" /> : <AlertCircle size={14} className="text-red-600" />}
                      <span>Notification settings</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      {diag.notifications.hasSigcoreApiKey ? <CheckCircle size={14} className="text-emerald-600" /> : <AlertCircle size={14} className="text-red-600" />}
                      <span>Sigcore API key</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      {diag.notifications.newLeadRules > 0 ? <CheckCircle size={14} className="text-emerald-600" /> : <AlertCircle size={14} className="text-red-600" />}
                      <span>{diag.notifications.newLeadRules} SMS alert(s)</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      {diag.automation.totalRules > 0 ? <CheckCircle size={14} className="text-emerald-600" /> : <span className="text-slate-400">-</span>}
                      <span>{diag.automation.totalRules} auto-reply rule(s)</span>
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <button
                      onClick={() => {
                        setSelectedAccountForInfo(null);
                        handleReconnect(account);
                      }}
                      className="flex-1 px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all flex items-center justify-center gap-2"
                    >
                      <RefreshCw size={16} />
                      Reconnect Account
                    </button>
                    <button
                      onClick={() => setSelectedAccountForInfo(null)}
                      className="px-6 py-3 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all"
                    >
                      Close
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Connection Modal */}
      <ConnectionModal
        isOpen={connectionModalOpen}
        onClose={() => {
          setConnectionModalOpen(false);
          setAccountToReconnect(null);
        }}
        accountToReconnect={accountToReconnect}
        onSuccess={handleConnectionSuccess}
      />
    </div>
  );
}
