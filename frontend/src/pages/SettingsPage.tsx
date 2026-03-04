import { useState, useEffect, useRef } from 'react';
import { Settings, CheckCircle, AlertCircle, Rocket, Zap, Lock, Download, ChevronDown, ChevronUp, Loader2, X, Pencil, Check, RefreshCw, Info, Eye, EyeOff, DollarSign, Clock, ArrowUpRight, List, Trash2, AlertTriangle } from 'lucide-react';
import { authApi, billingApi, thumbtackApi, leadsApi, usersApi, integrationsApi } from '../services/api';
import { notify } from '../store/notificationStore';
import { useAuthStore } from '../store/authStore';
import { useAppStore } from '../store/appStore';
import type { SubscriptionDetails, SavedAccount } from '../types';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
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

// Module-level cache — survives navigation unmounts
let _settingsCache: { subscription: SubscriptionDetails | null; accounts: SavedAccount[] } | null = null;

export default function SettingsPage() {
  const navigate = useNavigate();
  const user = useAuthStore(state => state.user);
  const setAuth = useAuthStore(state => state.setAuth);
  const logout = useAuthStore(state => state.logout);
  const setSavedAccounts = useAppStore(state => state.setSavedAccounts);
  const accountDiagnostics = useAppStore(state => state.accountDiagnostics);
  const loadDiagnostics = useAppStore(state => state.loadDiagnostics);
  const [subscription, setSubscription] = useState<SubscriptionDetails | null>(_settingsCache?.subscription ?? null);
  const [accounts, setAccounts] = useState<SavedAccount[]>(_settingsCache?.accounts ?? []);
  const [loading, setLoading] = useState(!_settingsCache);
  const [portalLoading, setPortalLoading] = useState(false);
  const [selectedAccountForInfo, setSelectedAccountForInfo] = useState<string | null>(null);
  const [connectionModalOpen, setConnectionModalOpen] = useState(false);
  const [accountToReconnect, setAccountToReconnect] = useState<SavedAccount | null>(null);

  // Name editing
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [savingName, setSavingName] = useState(false);

  // Change password state
  const [changingPassword, setChangingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');

  // Import negotiations state
  const [searchParams] = useSearchParams();
  const [importCollapsed, setImportCollapsed] = useState(() => searchParams.get('import') !== 'open');
  const [importAccountId, setImportAccountId] = useState<string | null>(() => localStorage.getItem('lb_importAccountId'));
  const [importing, setImporting] = useState(false);
  const [importResults, setImportResults] = useState<{ id: string; success: boolean; isNew?: boolean; error?: string }[]>([]);
  const [importTotal, setImportTotal] = useState(0);
  const [showImportResults, setShowImportResults] = useState(false);
  const [importError, setImportError] = useState('');
  const [reimporting, setReimporting] = useState(false);
  const [reimportResult, setReimportResult] = useState<string | null>(null);
  const [missingCount, setMissingCount] = useState<number | null>(null);
  const [needsScrapeCount, setNeedsScrapeCount] = useState<number | null>(null);

  // Extension-collected leads
  const [extensionPendingCount, setExtensionPendingCount] = useState(0);
  const [extensionPendingIds, setExtensionPendingIds] = useState<string[]>([]);
  const [extensionImportedCount, setExtensionImportedCount] = useState(0);
  const [extensionTotalCount, setExtensionTotalCount] = useState(0);

  // Collected leads modal
  const [showCollectedModal, setShowCollectedModal] = useState(false);
  const [collectedLeads, setCollectedLeads] = useState<any[]>([]);
  const [collectedLoading, setCollectedLoading] = useState(false);
  const [collectedSelected, setCollectedSelected] = useState<Set<string>>(new Set());
  const [collectedDeleting, setCollectedDeleting] = useState(false);
  const [collectedDeleteConfirm, setCollectedDeleteConfirm] = useState<{
    message: string;
    onConfirm: () => void;
  } | null>(null);

  // Budget snapshots
  const [budgetSnapshots, setBudgetSnapshots] = useState<Array<{ id: string; weeklyBudget: string; currency: string; capturedAt: string; effectiveFrom: string; effectiveTo: string | null; active: boolean; scopeCategory: string | null; scopeLocation: string | null }>>([]);
  const [showBudgetModal, setShowBudgetModal] = useState(false);

  // Delete account
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState('');
  const [deletingAccount, setDeletingAccount] = useState(false);

  // Extension detection
  const [extensionInstalled, setExtensionInstalled] = useState<boolean | null>(null);
  const prevExtensionRef = useRef<boolean | null>(null);

  // Auto-expand Import Negotiations when user returns after installing the extension
  useEffect(() => {
    if (extensionInstalled === true) {
      if (localStorage.getItem('lb_expectingExtension') || prevExtensionRef.current === false) {
        localStorage.removeItem('lb_expectingExtension');
        setImportCollapsed(false);
      }
    }
    prevExtensionRef.current = extensionInstalled;
  }, [extensionInstalled]);

  useEffect(() => {
    // Always force-refresh diagnostics on mount so stale data doesn't persist
    loadData(true);
  }, []);

  // Detect Chrome extension — recheck on tab focus and when the attribute is set
  useEffect(() => {
    const check = () => {
      const installed = document.documentElement.getAttribute('data-leadbridge-extension') === 'true';
      setExtensionInstalled(installed);
    };
    check();
    const timer = setTimeout(check, 1500);
    // Recheck when user returns to this tab (e.g. after installing the extension)
    const onVisibility = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisibility);
    // Watch for the attribute being set by the content script
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-leadbridge-extension'] });
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); observer.disconnect(); };
  }, []);

  // Listen for extension refresh event (avoids full page reload when returning from extension)
  useEffect(() => {
    const handleRefresh = () => {
      if (importAccountId) {
        integrationsApi.getCollectedLeads({ accountId: importAccountId }).then((res) => {
          const allLeads = res.leads || [];
          const pending = allLeads.filter((l: any) => !l.imported);
          const imported = allLeads.filter((l: any) => l.imported);
          setExtensionPendingCount(pending.length);
          setExtensionPendingIds(pending.map((l: any) => l.thumbtackId));
          setExtensionImportedCount(imported.length);
          setExtensionTotalCount(allLeads.length);
        }).catch(() => {});
        integrationsApi.getBudgetSnapshots(importAccountId).then((res) => {
          setBudgetSnapshots(res.snapshots || []);
        }).catch(() => {});
      }
    };
    document.addEventListener('leadbridge-refresh-import', handleRefresh);
    return () => document.removeEventListener('leadbridge-refresh-import', handleRefresh);
  }, [importAccountId]);

  // Load extension pending leads + budget snapshots when import account changes
  useEffect(() => {
    if (!importAccountId) {
      setExtensionPendingCount(0);
      setExtensionPendingIds([]);
      setExtensionImportedCount(0);
      setExtensionTotalCount(0);
      setMissingCount(null);
      setBudgetSnapshots([]);
      return;
    }
    integrationsApi.getCollectedLeads({ accountId: importAccountId }).then((res) => {
      const allLeads = res.leads || [];
      const pending = allLeads.filter((l: any) => !l.imported);
      const imported = allLeads.filter((l: any) => l.imported);
      setExtensionPendingCount(pending.length);
      setExtensionPendingIds(pending.map((l: any) => l.thumbtackId));
      setExtensionImportedCount(imported.length);
      setExtensionTotalCount(allLeads.length);
    }).catch(() => {
      setExtensionPendingCount(0);
      setExtensionPendingIds([]);
      setExtensionImportedCount(0);
      setExtensionTotalCount(0);
    });
    integrationsApi.getMissingCount(importAccountId).then((res) => {
      setMissingCount(res.missingCount);
    }).catch(() => setMissingCount(null));
    integrationsApi.getNeedsScrape(importAccountId).then((res) => {
      setNeedsScrapeCount(res.count);
    }).catch(() => setNeedsScrapeCount(null));
    integrationsApi.getBudgetSnapshots(importAccountId).then((res) => {
      setBudgetSnapshots(res.snapshots || []);
    }).catch(() => setBudgetSnapshots([]));
  }, [importAccountId]);

  const loadData = async (forceDiagnostics = false) => {
    try {
      if (!_settingsCache) setLoading(true);
      const [subResult, acctResult] = await Promise.all([
        billingApi.getSubscription().catch(() => null),
        thumbtackApi.getSavedAccounts().catch(() => ({ accounts: [] as SavedAccount[], count: 0 })),
      ]);
      setSubscription(subResult);
      setAccounts(acctResult.accounts);
      setSavedAccounts(acctResult.accounts); // Update app store
      _settingsCache = { subscription: subResult, accounts: acctResult.accounts };

      // Auto-select the first account if none is selected (or if saved selection no longer exists)
      if (acctResult.accounts.length > 0) {
        const saved = localStorage.getItem('lb_importAccountId');
        const stillExists = saved && acctResult.accounts.some((a: SavedAccount) => a.id === saved);
        if (!stillExists) {
          const firstId = acctResult.accounts[0].id;
          setImportAccountId(firstId);
          localStorage.setItem('lb_importAccountId', firstId);
        }
      }

      // Load diagnostics via shared store (skips if already loaded unless forced)
      if (acctResult.accounts.length > 0) {
        loadDiagnostics(acctResult.accounts, forceDiagnostics);
      }
    } catch (error: any) {
      console.error('Failed to load settings data:', error);
    } finally {
      setLoading(false);
    }
  };

  const openCollectedModal = async () => {
    setShowCollectedModal(true);
    setCollectedLoading(true);
    try {
      const res = await integrationsApi.getCollectedLeads(importAccountId ? { accountId: importAccountId } : {});
      setCollectedLeads(res.leads || []);
    } catch {
      setCollectedLeads([]);
    } finally {
      setCollectedLoading(false);
    }
  };

  const refreshExtensionCounts = () => {
    if (!importAccountId) {
      setExtensionPendingCount(0); setExtensionPendingIds([]); setExtensionImportedCount(0); setExtensionTotalCount(0);
      return;
    }
    integrationsApi.getCollectedLeads({ accountId: importAccountId }).then((res) => {
      const allLeads = res.leads || [];
      const pending = allLeads.filter((l: any) => !l.imported);
      const imported = allLeads.filter((l: any) => l.imported);
      setExtensionPendingCount(pending.length);
      setExtensionPendingIds(pending.map((l: any) => l.thumbtackId));
      setExtensionImportedCount(imported.length);
      setExtensionTotalCount(allLeads.length);
    }).catch(() => {
      setExtensionPendingCount(0); setExtensionPendingIds([]); setExtensionImportedCount(0); setExtensionTotalCount(0);
    });
  };

  const handleReconnect = (account?: SavedAccount) => {
    if (account) {
      setAccountToReconnect(account);
    }
    setConnectionModalOpen(true);
  };

  const handleConnectionSuccess = () => {
    // Force reload diagnostics after reconnection
    loadData(true);
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

  const handleChangePassword = async () => {
    setPasswordError('');
    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError('All fields are required');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match');
      return;
    }
    setSavingPassword(true);
    try {
      await authApi.changePassword(currentPassword, newPassword);
      notify.success('Updated', 'Password changed successfully');
      setChangingPassword(false);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setShowCurrentPassword(false);
      setShowNewPassword(false);
      setShowConfirmPassword(false);
    } catch (error: any) {
      setPasswordError(error.response?.data?.message || 'Failed to change password');
    } finally {
      setSavingPassword(false);
    }
  };

  const handleImportFromExtension = async () => {
    if (!importAccountId || extensionPendingIds.length === 0) return;

    setImporting(true);
    setImportError('');
    setImportResults([]);

    // Validate token first
    try {
      const validation = await thumbtackApi.validateToken(importAccountId);
      if (!validation.valid) {
        setAccountToReconnect(accounts.find(a => a.id === importAccountId) || null);
        setConnectionModalOpen(true);
        setImporting(false);
        return;
      }
    } catch {
      setAccountToReconnect(accounts.find(a => a.id === importAccountId) || null);
      setConnectionModalOpen(true);
      setImporting(false);
      return;
    }

    setImportTotal(extensionPendingIds.length);
    setShowImportResults(true);

    const results: typeof importResults = [];
    const successIds: string[] = [];

    for (const id of extensionPendingIds) {
      try {
        const result = await leadsApi.importNegotiation(id, importAccountId);
        results.push({ id, success: true, isNew: result.isNew });
        successIds.push(id);
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || err.response?.data?.error || err.message || 'Failed to import';
        results.push({ id, success: false, error: errorMsg });
      }
      setImportResults([...results]);
    }

    // Mark successful ones as imported in extension sync table
    if (successIds.length > 0) {
      try {
        await integrationsApi.markLeadsImported(successIds);
      } catch { /* best effort */ }
    }

    setImporting(false);

    // Reload extension counts for selected account
    integrationsApi.getCollectedLeads({ accountId: importAccountId }).then((res) => {
      const allLeads = res.leads || [];
      const pending = allLeads.filter((l: any) => !l.imported);
      const imported = allLeads.filter((l: any) => l.imported);
      setExtensionPendingCount(pending.length);
      setExtensionPendingIds(pending.map((l: any) => l.thumbtackId));
      setExtensionImportedCount(imported.length);
      setExtensionTotalCount(allLeads.length);
    }).catch(() => {
      setExtensionPendingCount(0);
      setExtensionPendingIds([]);
      setExtensionImportedCount(0);
      setExtensionTotalCount(0);
    });

    const newCount = results.filter(r => r.success && r.isNew).length;
    const failCount = results.filter(r => !r.success).length;
    if (newCount > 0 && failCount === 0) {
      notify.success('Import Complete', `Imported ${newCount} lead(s) from extension`);
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

          {/* Change Password */}
          <div className="mt-8 pt-8 border-t border-slate-100">
            {!changingPassword ? (
              <button
                onClick={() => setChangingPassword(true)}
                className="flex items-center gap-2 px-4 py-2.5 bg-slate-100 text-slate-700 rounded-xl text-sm font-semibold hover:bg-slate-200 transition-all"
              >
                <Lock className="w-4 h-4" />
                Change Password
              </button>
            ) : (
              <div className="max-w-md space-y-4">
                <h4 className="text-sm font-bold text-slate-900">Change Password</h4>
                {passwordError && (
                  <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{passwordError}</span>
                  </div>
                )}
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-widest">Current Password</label>
                  <div className="relative">
                    <input
                      type={showCurrentPassword ? 'text' : 'password'}
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      placeholder="Enter current password"
                      className="w-full px-4 pr-12 py-3 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                      className="absolute inset-y-0 right-0 pr-4 flex items-center text-slate-400 hover:text-slate-600 transition-colors"
                    >
                      {showCurrentPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-widest">New Password</label>
                  <div className="relative">
                    <input
                      type={showNewPassword ? 'text' : 'password'}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="At least 8 characters"
                      className="w-full px-4 pr-12 py-3 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword(!showNewPassword)}
                      className="absolute inset-y-0 right-0 pr-4 flex items-center text-slate-400 hover:text-slate-600 transition-colors"
                    >
                      {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-widest">Confirm New Password</label>
                  <div className="relative">
                    <input
                      type={showConfirmPassword ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter new password"
                      className="w-full px-4 pr-12 py-3 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      className="absolute inset-y-0 right-0 pr-4 flex items-center text-slate-400 hover:text-slate-600 transition-colors"
                    >
                      {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-3 pt-2">
                  <button
                    onClick={handleChangePassword}
                    disabled={savingPassword}
                    className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all disabled:opacity-50 flex items-center gap-2"
                  >
                    {savingPassword ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    {savingPassword ? 'Saving...' : 'Update Password'}
                  </button>
                  <button
                    onClick={() => {
                      setChangingPassword(false);
                      setCurrentPassword('');
                      setNewPassword('');
                      setConfirmPassword('');
                      setPasswordError('');
                      setShowCurrentPassword(false);
                      setShowNewPassword(false);
                      setShowConfirmPassword(false);
                    }}
                    className="px-5 py-2.5 bg-slate-100 text-slate-700 rounded-xl text-sm font-semibold hover:bg-slate-200 transition-all"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
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
                const isCheckingDiag = !diag;
                const hasConnectionIssues = !isCheckingDiag && (!account.webhookId || (diag && !diag.healthy));
                const notifIssuesArr = diag?.notificationIssues || [];
                const isJustDisabled = !isCheckingDiag && !hasConnectionIssues && notifIssuesArr.length > 0 && notifIssuesArr.every((i: string) => i.toLowerCase().includes('disabled'));
                const hasConfigIssues = !isCheckingDiag && !hasConnectionIssues && notifIssuesArr.length > 0 && !isJustDisabled;
                const hasIssues = hasConnectionIssues || hasConfigIssues;

                return (
                  <div
                    key={account.id}
                    className={`p-3 rounded-2xl border transition-all ${
                      isCheckingDiag
                        ? 'bg-slate-50 border-slate-200'
                        : hasConnectionIssues
                          ? 'bg-amber-50/50 border-amber-200 hover:border-amber-300 cursor-pointer'
                          : hasConfigIssues
                            ? 'bg-orange-50/50 border-orange-200 hover:border-orange-300 cursor-pointer'
                            : 'bg-slate-50 border-slate-100 hover:border-slate-200'
                    }`}
                    onClick={() => hasIssues && setSelectedAccountForInfo(account.id)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-slate-900 truncate">{account.businessName}</p>
                        <p className="text-[10px] text-slate-400 font-medium uppercase">ID: {account.businessId}</p>
                        {isCheckingDiag && (
                          <p className="text-[10px] text-slate-400 mt-1 flex items-center gap-1">
                            <Loader2 size={10} className="animate-spin" /> Checking health...
                          </p>
                        )}
                        {hasConnectionIssues && diag && diag.issues.length > 0 && (
                          <p className="text-[10px] text-amber-700 mt-1 flex items-center gap-1">
                            <Info size={10} /> Click for details
                          </p>
                        )}
                        {hasConfigIssues && diag && (
                          <p className="text-[10px] text-orange-700 mt-1 flex items-center gap-1">
                            <Info size={10} /> {diag.notificationIssues[0]}
                          </p>
                        )}
                        {isJustDisabled && (
                          <p className="text-[10px] text-slate-400 mt-1">Lead alerts off</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {isCheckingDiag ? (
                          <Loader2 className="w-5 h-5 text-slate-300 animate-spin" />
                        ) : hasConnectionIssues ? (
                          <AlertCircle className="w-5 h-5 text-amber-500" />
                        ) : hasConfigIssues ? (
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
                        onChange={(e) => {
                          const val = e.target.value || null;
                          setImportAccountId(val);
                          if (val) localStorage.setItem('lb_importAccountId', val);
                          else localStorage.removeItem('lb_importAccountId');
                        }}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                      >
                        <option value="">Choose account...</option>
                        {accounts.map(a => (
                          <option key={a.id} value={a.id}>{a.businessName}</option>
                        ))}
                      </select>
                    </div>

                    {/* Extension Sync Buttons */}
                    {importAccountId && (
                      <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                        {extensionInstalled === null ? (
                          <div className="flex items-center gap-2 text-slate-400 text-sm">
                            <Loader2 size={14} className="animate-spin" />
                            <span>Checking for extension...</span>
                          </div>
                        ) : extensionInstalled ? (
                          <>
                            <div className="flex items-center gap-2 mb-2">
                              <CheckCircle size={14} className="text-green-600" />
                              <span className="text-xs font-semibold text-green-700">Extension installed</span>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                onClick={() => {
                                  const acc = accounts.find(a => a.id === importAccountId);
                                  document.dispatchEvent(new CustomEvent('leadbridge-launch', {
                                    detail: { action: 'collect-leads', accountId: acc?.id || null, accountName: acc?.businessName || null, emailHint: acc?.emailHint || null },
                                  }));
                                }}
                                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 inline-flex items-center gap-1.5"
                              >
                                <Download size={13} /> Get IDs
                              </button>
                              <button
                                onClick={() => {
                                  const acc = accounts.find(a => a.id === importAccountId);
                                  document.dispatchEvent(new CustomEvent('leadbridge-launch', {
                                    detail: { action: 'sync-budget', accountId: acc?.id || null, accountName: acc?.businessName || null, emailHint: acc?.emailHint || null },
                                  }));
                                }}
                                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 inline-flex items-center gap-1.5"
                              >
                                <DollarSign size={13} /> Get Budget
                              </button>
                            </div>
                          </>
                        ) : (
                          <div className="flex items-center justify-between gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                            <div>
                              <p className="text-sm font-semibold text-amber-900">Extension not detected</p>
                              <p className="text-xs text-amber-700 mt-0.5">Install the LeadBridge Sync extension to collect IDs automatically.</p>
                            </div>
                            <a
                              href="https://chromewebstore.google.com/detail/leadbridge-sync-thumbtack/mkhkooldgglhnpkjfgmpkneongipfhnm"
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={() => localStorage.setItem('lb_expectingExtension', '1')}
                              className="px-3 py-2 rounded-xl text-xs font-semibold bg-amber-600 text-white hover:bg-amber-700 whitespace-nowrap inline-flex items-center gap-1.5 shrink-0"
                            >
                              Install Extension
                            </a>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Sync Info: Collected Leads + Budget */}
                    {importAccountId && (
                      <div className="space-y-2">
                        {/* Collected Leads Info */}
                        <div className="flex items-center justify-between px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs">
                          <div className="flex items-center gap-1.5">
                            <Download size={13} className="text-slate-400" />
                            <span className="font-semibold text-slate-700">Leads:</span>
                            {extensionTotalCount > 0 ? (
                              <div className="flex items-center gap-3 ml-1">
                                <span className="text-slate-500">
                                  <span className="font-bold text-slate-900">{extensionTotalCount}</span> collected
                                </span>
                                <span className="text-emerald-600">
                                  <span className="font-bold">{extensionImportedCount}</span> imported
                                </span>
                                <span className={extensionPendingCount > 0 ? 'text-amber-600' : 'text-slate-400'}>
                                  <span className="font-bold">{extensionPendingCount}</span> pending
                                </span>
                              </div>
                            ) : (
                              <span className="text-slate-400 ml-1">No leads collected yet</span>
                            )}
                          </div>
                          {extensionTotalCount > 0 && (
                            <button
                              onClick={openCollectedModal}
                              className="text-blue-600 hover:text-blue-700 font-semibold hover:underline inline-flex items-center gap-1"
                            >
                              <List size={12} /> View
                            </button>
                          )}
                        </div>

                        {/* Budget Info */}
                        <div className="flex items-center justify-between px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs">
                          <div className="flex items-center gap-1.5">
                            <DollarSign size={13} className="text-slate-400" />
                            <span className="font-semibold text-slate-700">Budget:</span>
                            {budgetSnapshots.length > 0 ? (
                              <div className="flex items-center gap-2 ml-1">
                                {Number(budgetSnapshots[0].weeklyBudget) === 0 ? (
                                  <span className="font-bold text-indigo-600">Unlimited</span>
                                ) : (
                                  <span className="text-slate-900">
                                    <span className="font-bold">${Number(budgetSnapshots[0].weeklyBudget).toFixed(0)}</span>
                                    <span className="text-slate-400">/{budgetSnapshots[0].currency}/wk</span>
                                  </span>
                                )}
                                {budgetSnapshots[0].active && (
                                  <span className="px-1.5 py-0.5 bg-green-100 text-green-700 rounded-full text-[10px] font-bold">Active</span>
                                )}
                                <span className="text-slate-400">
                                  · {budgetSnapshots.length} snapshot{budgetSnapshots.length !== 1 ? 's' : ''}
                                </span>
                              </div>
                            ) : (
                              <span className="text-slate-400 ml-1">No budget data yet</span>
                            )}
                          </div>
                          {budgetSnapshots.length > 0 && (
                            <button
                              onClick={() => setShowBudgetModal(true)}
                              className="text-blue-600 hover:text-blue-700 font-semibold hover:underline inline-flex items-center gap-1"
                            >
                              <Clock size={12} /> History
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Extension-collected leads: Import action */}
                    {importAccountId && extensionPendingCount > 0 && (
                      <div className="flex items-center justify-between p-3 bg-green-50 border border-green-100 rounded-xl">
                        <div>
                          <p className="text-sm font-semibold text-green-800">{extensionPendingCount} pending from extension</p>
                          <p className="text-xs text-green-600">Collected lead IDs ready to import</p>
                        </div>
                        <button
                          onClick={handleImportFromExtension}
                          disabled={importing}
                          className="px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
                        >
                          {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                          Import All
                        </button>
                      </div>
                    )}

                    {/* Re-import only failed/skipped leads */}
                    {importAccountId && missingCount !== null && missingCount > 0 && (
                      <div className="flex items-center justify-between p-3 bg-amber-50 border border-amber-200 rounded-xl">
                        <div>
                          <p className="text-sm font-semibold text-amber-800">
                            {missingCount} lead{missingCount !== 1 ? 's' : ''} not imported yet
                          </p>
                          <p className="text-xs text-amber-600">Collected but missing from your leads list</p>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <button
                            onClick={async () => {
                              if (!confirm(`Import ${missingCount} missing lead(s)? This may take a while.`)) return;
                              setReimporting(true);
                              setReimportResult(null);
                              try {
                                const res = await integrationsApi.reimportFailed(importAccountId);
                                setReimportResult(`Done: ${res.imported} imported, ${res.failed} failed`);
                                integrationsApi.getMissingCount(importAccountId).then((r) => setMissingCount(r.missingCount)).catch(() => {});
                              } catch {
                                setReimportResult('Import failed');
                              } finally {
                                setReimporting(false);
                              }
                            }}
                            disabled={reimporting || importing}
                            className="px-3 py-1.5 bg-amber-600 text-white rounded-xl text-xs font-semibold hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                          >
                            {reimporting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                            Import Missing
                          </button>
                          {reimportResult && (
                            <span className="text-xs text-slate-500">{reimportResult}</span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Leads needing page scrape */}
                    {importAccountId && needsScrapeCount !== null && needsScrapeCount > 0 && (
                      <div className="flex items-center justify-between p-3 bg-orange-50 border border-orange-200 rounded-xl">
                        <div>
                          <p className="text-sm font-semibold text-orange-800">
                            {needsScrapeCount} lead{needsScrapeCount !== 1 ? 's' : ''} missing details
                          </p>
                          <p className="text-xs text-orange-600">Re-run the extension to scrape missing data from Thumbtack pages</p>
                        </div>
                        <button
                          onClick={() => {
                            document.dispatchEvent(new CustomEvent('leadbridge-scrape-missing', {
                              detail: {
                                accountId: importAccountId,
                                apiUrl: import.meta.env.VITE_API_URL?.replace('/api', '') || '',
                              },
                            }));
                          }}
                          className="px-3 py-1.5 bg-orange-600 text-white rounded-xl text-xs font-semibold hover:bg-orange-700 inline-flex items-center gap-1.5"
                        >
                          <RefreshCw className="w-3 h-3" />
                          Re-run Extension
                        </button>
                      </div>
                    )}

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

      {/* Danger Zone */}
      {user?.role !== 'ADMIN' && (
        <div className="bg-white rounded-3xl shadow-sm border border-red-100 overflow-hidden">
          <div className="p-8">
            <h2 className="text-xl font-bold text-red-600 mb-1">Danger Zone</h2>
            <p className="text-sm text-slate-500 mb-6">
              Permanently delete your account and all associated data. This action cannot be undone.
            </p>

            {!showDeleteConfirm ? (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="px-6 py-3 bg-red-50 text-red-600 border border-red-200 rounded-xl font-semibold hover:bg-red-100 transition-colors"
              >
                <span className="flex items-center gap-2">
                  <Trash2 size={16} />
                  Delete Account
                </span>
              </button>
            ) : (
              <div className="p-6 bg-red-50 border border-red-200 rounded-2xl space-y-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-red-900">This will permanently delete:</p>
                    <ul className="text-sm text-red-700 mt-1 list-disc list-inside space-y-0.5">
                      <li>Your account and profile</li>
                      <li>All connected business accounts</li>
                      <li>All leads, messages, and automation rules</li>
                      <li>Phone numbers and notification settings</li>
                      <li>Active subscriptions will be cancelled</li>
                    </ul>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-red-900 mb-1.5">
                    Type your email <span className="font-bold">{user?.email}</span> to confirm
                  </label>
                  <input
                    type="text"
                    value={deleteConfirmEmail}
                    onChange={(e) => setDeleteConfirmEmail(e.target.value)}
                    placeholder={user?.email || ''}
                    className="w-full px-4 py-2.5 border border-red-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 bg-white"
                    autoComplete="off"
                  />
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={async () => {
                      setDeletingAccount(true);
                      try {
                        await usersApi.deleteOwnAccount();
                        logout();
                        navigate('/');
                      } catch (err: any) {
                        notify.error('Error', err.message || 'Failed to delete account');
                      } finally {
                        setDeletingAccount(false);
                      }
                    }}
                    disabled={deleteConfirmEmail !== user?.email || deletingAccount}
                    className="px-6 py-2.5 bg-red-600 text-white rounded-xl font-semibold hover:bg-red-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {deletingAccount ? (
                      <span className="flex items-center gap-2"><Loader2 size={16} className="animate-spin" /> Deleting...</span>
                    ) : (
                      'Permanently Delete Account'
                    )}
                  </button>
                  <button
                    onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmEmail(''); }}
                    className="px-6 py-2.5 bg-white text-slate-600 border border-slate-200 rounded-xl font-semibold hover:bg-slate-50 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

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
                    const modalNotifs = diag.notificationIssues || [];
                    const connIssues = diag.issues.filter((i: string) => !modalNotifs.includes(i));
                    const realNotifs = modalNotifs.filter((i: string) => !i.toLowerCase().includes('disabled'));
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
                        {realNotifs.length > 0 && (
                          <div className="mb-4 space-y-2">
                            <h4 className="text-sm font-bold text-orange-900 uppercase tracking-wider">SMS Configuration:</h4>
                            {realNotifs.map((issue: string, i: number) => (
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
                      {diag.notifications.hasSigcoreApiKey ? <CheckCircle size={14} className="text-emerald-600" /> : <span className="text-slate-400">-</span>}
                      <span>Sigcore API key {!diag.notifications.hasSigcoreApiKey && <span className="text-slate-400">(optional)</span>}</span>
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

                  {(() => {
                    const modalNotifIssues = diag.notificationIssues || [];
                    const connIssues = diag.issues.filter((i: string) => !modalNotifIssues.includes(i));
                    const hasConnIssues = connIssues.length > 0;
                    const onlyDisabled = modalNotifIssues.length > 0 && modalNotifIssues.every((i: string) => i.toLowerCase().includes('disabled'));
                    const hasRealNotifIssues = modalNotifIssues.length > 0 && !onlyDisabled;

                    return (
                      <div className="flex gap-3">
                        {hasConnIssues && (
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
                        )}
                        {hasRealNotifIssues && !hasConnIssues && (
                          <button
                            onClick={() => {
                              setSelectedAccountForInfo(null);
                              navigate('/services?expand=lead-alerts');
                            }}
                            className="flex-1 px-6 py-3 bg-orange-600 text-white rounded-xl font-semibold hover:bg-orange-700 shadow-lg shadow-orange-200 transition-all flex items-center justify-center gap-2"
                          >
                            Configure Lead Alerts
                          </button>
                        )}
                        <button
                          onClick={() => setSelectedAccountForInfo(null)}
                          className="px-6 py-3 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all"
                        >
                          Close
                        </button>
                      </div>
                    );
                  })()}
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Collected Leads Modal */}
      {showCollectedModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => { setShowCollectedModal(false); setCollectedSelected(new Set()); }}>
          <div className="relative bg-white rounded-3xl p-6 max-w-3xl w-full shadow-2xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-slate-900">Collected Leads</h3>
                {!collectedLoading && collectedLeads.length > 0 && (
                  <p className="text-sm text-slate-500 mt-0.5">
                    {collectedLeads.filter(l => l.imported).length} imported · {collectedLeads.filter(l => !l.imported).length} pending · {collectedLeads.length} total
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {collectedSelected.size > 0 && (
                  <button
                    disabled={collectedDeleting}
                    onClick={() => {
                      const count = collectedSelected.size;
                      setCollectedDeleteConfirm({
                        message: `Delete ${count} selected lead${count !== 1 ? 's' : ''}? This cannot be undone.`,
                        onConfirm: async () => {
                          setCollectedDeleteConfirm(null);
                          setCollectedDeleting(true);
                          try {
                            await integrationsApi.deleteCollectedLeads(Array.from(collectedSelected));
                            setCollectedLeads(prev => prev.filter(l => !collectedSelected.has(l.thumbtackId)));
                            setCollectedSelected(new Set());
                            refreshExtensionCounts();
                            notify.success('Deleted', `Deleted ${count} leads`);
                          } catch { notify.error('Error', 'Delete failed'); }
                          setCollectedDeleting(false);
                        },
                      });
                    }}
                    className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    {collectedDeleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    Delete ({collectedSelected.size})
                  </button>
                )}
                {!collectedLoading && collectedLeads.length > 0 && (
                  <button
                    disabled={collectedDeleting}
                    onClick={() => {
                      const count = collectedLeads.length;
                      setCollectedDeleteConfirm({
                        message: `Delete all ${count} collected lead${count !== 1 ? 's' : ''}? This cannot be undone.`,
                        onConfirm: async () => {
                          setCollectedDeleteConfirm(null);
                          setCollectedDeleting(true);
                          try {
                            const res = await integrationsApi.deleteCollectedLeads();
                            setCollectedLeads([]);
                            setCollectedSelected(new Set());
                            refreshExtensionCounts();
                            notify.success('Deleted', `Deleted ${res.deletedCount} leads`);
                          } catch { notify.error('Error', 'Delete failed'); }
                          setCollectedDeleting(false);
                        },
                      });
                    }}
                    className="px-3 py-1.5 rounded-xl text-xs font-semibold text-red-600 bg-white border border-red-200 hover:bg-red-50 disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    <Trash2 size={13} /> Delete All
                  </button>
                )}
                <button
                  className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-all"
                  onClick={() => { setShowCollectedModal(false); setCollectedSelected(new Set()); }}
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="overflow-y-auto flex-1">
              {collectedLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : collectedLeads.length === 0 ? (
                <div className="text-center py-12 text-slate-400">No collected leads yet</div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-100">
                      <th className="py-2.5 px-2 w-8">
                        <input
                          type="checkbox"
                          checked={collectedSelected.size > 0 && collectedSelected.size === collectedLeads.length}
                          onChange={() => {
                            if (collectedSelected.size === collectedLeads.length) {
                              setCollectedSelected(new Set());
                            } else {
                              setCollectedSelected(new Set(collectedLeads.map(l => l.thumbtackId)));
                            }
                          }}
                          className="rounded border-slate-300"
                        />
                      </th>
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">Customer</th>
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">Thumbtack ID</th>
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">Lead Date</th>
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">TT Status</th>
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {collectedLeads.map((lead: any) => (
                      <tr key={lead.id} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                        <td className="py-2.5 px-2">
                          <input
                            type="checkbox"
                            checked={collectedSelected.has(lead.thumbtackId)}
                            onChange={() => {
                              setCollectedSelected(prev => {
                                const next = new Set(prev);
                                if (next.has(lead.thumbtackId)) next.delete(lead.thumbtackId);
                                else next.add(lead.thumbtackId);
                                return next;
                              });
                            }}
                            className="rounded border-slate-300"
                          />
                        </td>
                        <td className="py-2.5 px-3 text-sm font-medium text-slate-900">{lead.customerName || '-'}</td>
                        <td className="py-2.5 px-3">
                          <code className="text-xs font-mono text-slate-700 bg-slate-50 px-2 py-0.5 rounded">{lead.thumbtackId}</code>
                        </td>
                        <td className="py-2.5 px-3 text-sm text-slate-600">
                          {lead.leadDate || new Date(lead.collectedAt || lead.capturedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </td>
                        <td className="py-2.5 px-3 text-sm text-slate-500">{lead.thumbtackStatus || '-'}</td>
                        <td className="py-2.5 px-3">
                          {lead.imported ? (
                            <span className="px-2.5 py-1 bg-green-100 text-green-700 rounded-full text-xs font-bold inline-flex items-center gap-1">
                              <CheckCircle size={12} /> Imported
                            </span>
                          ) : lead.needsRefetch ? (
                            <span className="px-2.5 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-bold inline-flex items-center gap-1">
                              <ArrowUpRight size={12} /> Needs Refetch
                            </span>
                          ) : (
                            <span className="px-2.5 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-bold inline-flex items-center gap-1">
                              <Clock size={12} /> Pending
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Delete Confirm Dialog */}
            {collectedDeleteConfirm && (
              <div className="absolute inset-0 bg-black/40 backdrop-blur-sm rounded-3xl flex items-center justify-center z-10">
                <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full mx-4 p-5 space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-red-100 rounded-full">
                      <AlertTriangle className="w-5 h-5 text-red-600" />
                    </div>
                    <h4 className="text-base font-bold text-slate-900">Delete Leads</h4>
                  </div>
                  <p className="text-sm text-slate-600">{collectedDeleteConfirm.message}</p>
                  <div className="flex justify-end gap-3">
                    <button
                      onClick={() => setCollectedDeleteConfirm(null)}
                      className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={collectedDeleteConfirm.onConfirm}
                      className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-red-600 hover:bg-red-700 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Budget History Modal */}
      {showBudgetModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowBudgetModal(false)}>
          <div className="bg-white rounded-3xl p-6 max-w-2xl w-full shadow-2xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-slate-900">Budget History</h3>
                <p className="text-sm text-slate-500 mt-0.5">
                  {budgetSnapshots.length} snapshot{budgetSnapshots.length !== 1 ? 's' : ''}
                </p>
              </div>
              <button
                className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-all"
                onClick={() => setShowBudgetModal(false)}
              >
                <X size={18} />
              </button>
            </div>

            <div className="overflow-y-auto flex-1">
              {budgetSnapshots.length === 0 ? (
                <div className="text-center py-12 text-slate-400">No budget snapshots yet</div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-100">
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">Budget</th>
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">Category</th>
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">Captured</th>
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">Effective</th>
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {budgetSnapshots.map((snap) => (
                      <tr key={snap.id} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                        <td className="py-2.5 px-3">
                          {Number(snap.weeklyBudget) === 0 ? (
                            <span className="text-sm font-bold text-indigo-600">Unlimited</span>
                          ) : (
                            <span className="text-sm font-bold text-slate-900">
                              ${Number(snap.weeklyBudget).toFixed(0)}
                              <span className="text-xs text-slate-400 ml-0.5 font-normal">/{snap.currency}/wk</span>
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-sm text-slate-600">{snap.scopeCategory || '-'}</td>
                        <td className="py-2.5 px-3 text-sm text-slate-500">
                          {new Date(snap.capturedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </td>
                        <td className="py-2.5 px-3 text-sm text-slate-500">
                          {new Date(snap.effectiveFrom).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                          {snap.effectiveTo ? ` – ${new Date(snap.effectiveTo).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ' – now'}
                        </td>
                        <td className="py-2.5 px-3">
                          {snap.active ? (
                            <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs font-bold">Active</span>
                          ) : (
                            <span className="px-2 py-0.5 bg-slate-100 text-slate-500 rounded-full text-xs font-bold">Closed</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
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
        savedAccounts={accounts}
        onSuccess={handleConnectionSuccess}
      />
    </div>
  );
}
