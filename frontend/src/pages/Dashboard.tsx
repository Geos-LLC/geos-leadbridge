import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Users, Send, Clock, TrendingUp, Plus, ChevronRight,
  Briefcase, Sparkles, AlertCircle, ExternalLink, Loader2, CheckCircle, BellOff,
  MoreVertical, Unlink, Trash2, RefreshCw,
} from 'lucide-react';
import { useAppStore } from '../store/appStore';
import type { DashboardStats } from '../store/appStore';
import { useAuthStore } from '../store/authStore';
import { thumbtackApi, analyticsApi, notificationsApi, platformsApi } from '../services/api';
import ConnectionModal from '../components/ConnectionModal';
import AdminNoAccountsState from '../components/AdminNoAccountsState';
import type { SavedAccount } from '../types';

export function Dashboard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, impersonatingUser } = useAuthStore();
  const { savedAccounts, setSavedAccounts, dashboardStats: cachedStats, setDashboardStats, accountDiagnostics, diagnosticsLoading: loadingDiagnostics, loadDiagnostics } = useAppStore();

  // Start with cached stats (instant) — zeros only if nothing cached yet
  const [stats, setStats] = useState<DashboardStats>(
    cachedStats ?? {
      leadsToday: 0,
      automatedReplies: 0,
      avgResponseTime: '—',
      conversionRate: 0,
      weeklyLeads: 0,
      engagement: 0,
      lifetimeReplies: 0,
      messagesSent: 0,
    }
  );
  // Only show skeleton loading on very first load (no cache)
  const [loading, setLoading] = useState(!cachedStats);
  const [refreshing, setRefreshing] = useState(false);
  const [connectionModalOpen, setConnectionModalOpen] = useState(false);
  const [accountToReconnect, setAccountToReconnect] = useState<SavedAccount | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!menuOpenId) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-account-menu]')) setMenuOpenId(null);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menuOpenId]);

  useEffect(() => {
    // Always force-refresh diagnostics on mount so stale warnings don't persist
    // (e.g. after setting up alerts on Services page and navigating back)
    loadAccounts(true);
    loadDashboardStats();
  }, []);

  // Auto-redirect to Yelp OAuth after user logs in and returns to dashboard
  useEffect(() => {
    // Don't redirect if this is already a callback from OAuth
    if (searchParams.get('connected') || searchParams.get('error')) return;

    const stored = sessionStorage.getItem('yelp_oauth_url');
    if (stored) {
      try {
        const { url, exp } = JSON.parse(stored);
        sessionStorage.removeItem('yelp_oauth_url');
        if (Date.now() < exp) {
          window.location.href = url;
          return;
        }
      } catch {
        sessionStorage.removeItem('yelp_oauth_url');
      }
    }
  }, []);

  // Handle Yelp OAuth success (callback redirects here with ?connected=yelp)
  useEffect(() => {
    const connected = searchParams.get('connected');
    if (connected === 'yelp') {
      const warning = searchParams.get('warning');
      if (warning === 'no_businesses') {
        setOauthError('Yelp authorization succeeded but no businesses were found. Please add a business manually or contact support.');
      }
      // Reload accounts to show the newly connected Yelp business
      loadAccounts(true);
      setSearchParams({}, { replace: true });
    }
  }, []);

  // Handle OAuth callback params and auto-open reconnect modal
  useEffect(() => {
    const webhookError = searchParams.get('webhook_error');
    const reconnect = searchParams.get('reconnect');
    const error = searchParams.get('error');

    if (webhookError) {
      console.log('[Dashboard] Webhook setup failed after OAuth:', webhookError);
      setOauthError(`Thumbtack authorization succeeded but webhook setup failed: ${webhookError}. Please try reconnecting again.`);
    } else if (error) {
      const desc = searchParams.get('error_description') || error;
      // "consent verifier already used" = user double-clicked the authorize button on Thumbtack.
      // The first click usually succeeded, so ignore this error silently.
      if (desc.toLowerCase().includes('consent verifier')) {
        console.log('[Dashboard] Ignoring consent-verifier error (likely double-click):', desc);
      } else {
        console.log('[Dashboard] OAuth error:', error, desc);
        setOauthError(desc);
      }
    }

    if (reconnect === '1' && savedAccounts.length > 0) {
      const unhealthy = savedAccounts.find(a => a.platform === 'thumbtack' && !a.webhookId);
      if (unhealthy) {
        setAccountToReconnect(unhealthy);
        setConnectionModalOpen(true);
      }
      setSearchParams({}, { replace: true });
    } else if (webhookError || error) {
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, savedAccounts]);

  async function loadAccounts(forceDiagnostics = false) {
    try {
      const { accounts } = await thumbtackApi.getSavedAccounts();
      console.log('[Dashboard] Loaded accounts:', accounts.map(a => ({ id: a.id, name: a.businessName, webhookId: a.webhookId })));
      setSavedAccounts(accounts);

      // Load diagnostics for all accounts (shared store)
      if (accounts.length > 0) {
        loadDiagnostics(accounts, forceDiagnostics);
      }
    } catch (err) {
      console.error('Failed to load accounts:', err);
    }
  }

  async function loadDashboardStats() {
    try {
      // If we have cached data, show refresh indicator instead of full skeleton
      if (cachedStats) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      // Calculate date ranges
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const sevenDaysAgo = new Date(now);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      // Load analytics data + real notification counts in parallel
      const [todayData, weekData, allTimeData, allRules] = await Promise.all([
        // Today's leads
        analyticsApi.getBasicAnalytics({
          startDate: todayStart.toISOString(),
          endDate: now.toISOString(),
        }).catch(() => ({ data: { totalLeads: 0 } })),

        // Last 7 days
        analyticsApi.getBasicAnalytics({
          startDate: sevenDaysAgo.toISOString(),
          endDate: now.toISOString(),
        }).catch(() => ({ data: { totalLeads: 0, customerEngagement: { engagementRate: 0 } } })),

        // All time stats
        analyticsApi.getAnalytics({}).catch(() => ({
          data: {
            totalLeads: 0,
            connectionTime: { averageMinutes: 0 },
            customerEngagement: { engagementRate: 0 },
            messagesPerLead: { average: 0 },
          },
        })),

        // Real notification rule trigger counts
        notificationsApi.getAllRules().catch(() => ({ success: false, count: 0, rules: [] as any[] })),
      ]);

      // Format average response time
      const formatDuration = (minutes: number): string => {
        if (!minutes || minutes <= 0) return '—';
        if (minutes < 1) {
          const seconds = Math.round(minutes * 60);
          return `${seconds}s`;
        }
        if (minutes < 60) {
          return `${Math.round(minutes)}m`;
        }
        const hours = Math.floor(minutes / 60);
        const mins = Math.round(minutes % 60);
        return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
      };

      // Real counts from notification rules triggerCount
      const rules = allRules.rules || [];
      const autoReplyRules = rules.filter((r: any) => r.sendToCustomer === true);
      const alertRules = rules.filter((r: any) => !r.sendToCustomer);
      const totalAutoReplies = autoReplyRules.reduce((sum: number, r: any) => sum + (r.triggerCount || 0), 0);
      const totalAlertsSent = alertRules.reduce((sum: number, r: any) => sum + (r.triggerCount || 0), 0);
      const totalMessagesSent = totalAutoReplies + totalAlertsSent;

      const freshStats = {
        leadsToday: todayData.data.totalLeads || 0,
        automatedReplies: totalAutoReplies,
        avgResponseTime: formatDuration(allTimeData.data.connectionTime?.averageMinutes || 0),
        conversionRate: Math.round(allTimeData.data.customerEngagement?.engagementRate || 0),
        weeklyLeads: weekData.data.totalLeads || 0,
        engagement: Math.round(weekData.data.customerEngagement?.engagementRate || 0),
        lifetimeReplies: totalAutoReplies,
        messagesSent: totalMessagesSent,
      };

      setStats(freshStats);
      setDashboardStats(freshStats); // Persist to localStorage for next visit
    } catch (err) {
      console.error('Failed to load dashboard stats:', err);
      // Keep cached/existing stats on error
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  const handleAccountClick = (account: SavedAccount) => {
    const diag = accountDiagnostics[account.id];
    const hasConnectionIssues = (account.platform === 'thumbtack' && !account.webhookId) || (diag && !diag.healthy);
    const hasSmsIssues = diag && (diag.notificationIssues?.length ?? 0) > 0;

    if (hasConnectionIssues) {
      setAccountToReconnect(account);
      setConnectionModalOpen(true);
    } else if (hasSmsIssues) {
      navigate('/services?expand=lead-alerts');
    } else {
      navigate(`/messages?account=${account.businessId}`);
    }
  };

  const handleDisconnectWebhook = async (account: SavedAccount) => {
    if (!confirm(`Disconnect "${account.businessName}"? This will stop receiving new leads from this account.`)) return;
    setActionLoading(account.id);
    setMenuOpenId(null);
    try {
      await thumbtackApi.disconnectAccount(account.id);
      await loadAccounts(true);
    } catch (err) {
      console.error('Failed to disconnect:', err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleReconnectWebhook = async (account: SavedAccount) => {
    setActionLoading(account.id);
    setMenuOpenId(null);
    try {
      await thumbtackApi.reconnectAccount(account.id);
      await loadAccounts(true);
    } catch (err: any) {
      console.error('Failed to reconnect:', err);
      // If reconnect fails, open the connection modal
      setAccountToReconnect(account);
      setConnectionModalOpen(true);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemoveAccount = async (account: SavedAccount) => {
    const deleteLeads = confirm(
      `Remove "${account.businessName}" entirely?\n\nClick OK to also delete all leads from this account, or Cancel to keep leads.`
    );
    // Second confirm for the actual removal
    if (!confirm(`Are you sure you want to remove "${account.businessName}"? This cannot be undone.`)) return;
    setActionLoading(account.id);
    setMenuOpenId(null);
    try {
      await thumbtackApi.removeSavedAccount(account.id, deleteLeads);
      await loadAccounts(true);
    } catch (err) {
      console.error('Failed to remove account:', err);
    } finally {
      setActionLoading(null);
    }
  };

  const handleConnectionSuccess = async () => {
    console.log('[Dashboard] handleConnectionSuccess called - reloading accounts');
    setAccountToReconnect(null);

    // Wait a moment for backend to process the reconnection
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Reload accounts and diagnostics (force refresh after reconnection)
    await loadAccounts(true);
  };

  const isAdmin = user?.role === 'ADMIN';
  const hasNoAccounts = savedAccounts.length === 0;

  // Admin with no accounts and not impersonating — show empty state
  if (isAdmin && hasNoAccounts && !impersonatingUser && !loading) {
    return (
      <div className="p-6 lg:p-10 max-w-7xl mx-auto">
        <section className="mb-8">
          <p className="text-blue-600 font-semibold mb-1 uppercase tracking-wider text-xs">
            Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, {user?.name || 'Admin'}
          </p>
          <h2 className="text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight">
            Admin Dashboard
          </h2>
        </section>
        <AdminNoAccountsState onConnectAccount={() => setConnectionModalOpen(true)} />
        <ConnectionModal
          isOpen={connectionModalOpen}
          onClose={() => setConnectionModalOpen(false)}
          savedAccounts={savedAccounts}
          onSuccess={() => { setConnectionModalOpen(false); loadAccounts(true); }}
        />
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-10 max-w-7xl mx-auto flex flex-col gap-6 md:gap-10">
      {/* OAuth error banner */}
      {oauthError && (
        <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-2xl text-red-800">
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-red-600" />
          <div className="flex-1 text-sm">{oauthError}</div>
          <button onClick={() => setOauthError(null)} className="text-red-400 hover:text-red-600 transition-colors">×</button>
        </div>
      )}

      {/* Welcome Section */}
      <section className="order-1">
        <p className="text-blue-600 font-semibold mb-1 uppercase tracking-wider text-xs">
          Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, {user?.name || 'User'}
        </p>
        <h2 className="text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight">
          Your business is <span className="gradient-text">growing.</span>
        </h2>
        <p className="text-slate-500 mt-2 text-lg">
          LeadBridge captured {stats.leadsToday} new lead{stats.leadsToday !== 1 ? 's' : ''} from Thumbtack today.
        </p>
      </section>

      {/* Core Metrics */}
      <section className="order-4 lg:order-2 grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 relative">
        {refreshing && (
          <div className="absolute -top-6 right-0 flex items-center gap-1.5 text-xs text-slate-400">
            <Loader2 className="w-3 h-3 animate-spin" />
            Updating...
          </div>
        )}
        <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
          <div className="w-10 h-10 md:w-12 md:h-12 bg-blue-50 text-blue-600 rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
            <Users className="w-5 h-5 md:w-6 md:h-6" />
          </div>
          <p className="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-wide">Leads Today</p>
          <div className="flex items-baseline gap-1 md:gap-2 mt-1">
            <h3 className={`text-2xl md:text-3xl font-bold text-slate-900 transition-opacity ${loading ? 'opacity-30' : 'opacity-100'}`}>
              {loading ? '0' : stats.leadsToday}
            </h3>
          </div>
        </div>

        <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
          <div className="w-10 h-10 md:w-12 md:h-12 bg-emerald-50 text-emerald-600 rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
            <Send className="w-5 h-5 md:w-6 md:h-6" />
          </div>
          <p className="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-wide">Auto Replies</p>
          <div className="flex items-baseline gap-1 md:gap-2 mt-1">
            <h3 className={`text-2xl md:text-3xl font-bold text-slate-900 transition-opacity ${loading ? 'opacity-30' : 'opacity-100'}`}>
              {loading ? '0' : stats.automatedReplies}
            </h3>
          </div>
        </div>

        <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
          <div className="w-10 h-10 md:w-12 md:h-12 bg-orange-50 text-orange-600 rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
            <Clock className="w-5 h-5 md:w-6 md:h-6" />
          </div>
          <p className="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-wide">Avg Response</p>
          <div className="flex items-baseline gap-1 md:gap-2 mt-1">
            <h3 className={`text-2xl md:text-3xl font-bold text-slate-900 transition-opacity ${loading ? 'opacity-30' : 'opacity-100'}`}>
              {loading ? '—' : stats.avgResponseTime}
            </h3>
          </div>
        </div>

        <div className="bg-indigo-600 p-4 md:p-6 rounded-2xl md:rounded-3xl shadow-xl shadow-indigo-100 text-white">
          <div className="w-10 h-10 md:w-12 md:h-12 bg-white/20 text-white rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
            <TrendingUp className="w-5 h-5 md:w-6 md:h-6" />
          </div>
          <p className="text-indigo-100 text-xs md:text-sm font-medium uppercase tracking-wide">Engagement</p>
          <div className="flex items-baseline gap-1 md:gap-2 mt-1">
            <h3 className={`text-2xl md:text-3xl font-bold transition-opacity ${loading ? 'opacity-30' : 'opacity-100'}`}>
              {loading ? '0' : stats.conversionRate}%
            </h3>
            <span className="text-indigo-200 text-xs md:text-sm">of leads replied</span>
          </div>
        </div>
      </section>

      <div className="contents lg:grid lg:grid-cols-3 lg:gap-8 lg:items-start lg:order-3">
        {/* Accounts & Platforms */}
        <div className="contents lg:block lg:col-span-2 lg:space-y-6">
          <div className="order-2 lg:order-none space-y-6">
          <div className="flex items-center justify-between px-2">
            <h3 className="text-xl font-bold text-slate-900">Connected Platforms</h3>
            {savedAccounts.length > 0 && (
              <button
                onClick={() => setConnectionModalOpen(true)}
                className="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span className="hidden sm:inline">New Account</span>
                <span className="sm:hidden">Add</span>
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {savedAccounts.length > 0 ? (
              (() => {
                return savedAccounts.map((account) => {
                  const diag = accountDiagnostics[account.id];
                  const isCheckingDiag = !diag;
                  const hasConnectionIssues = account.tokenDead || (!isCheckingDiag && (diag && !diag.healthy));
                  const notifIssues = diag?.notificationIssues || [];
                  // "disabled" = rule exists but toggled off; everything else = real config problem
                  const isJustDisabled = !isCheckingDiag && !hasConnectionIssues && notifIssues.length > 0 && notifIssues.every((i: string) => i.toLowerCase().includes('disabled'));
                  const hasConfigIssues = !isCheckingDiag && !hasConnectionIssues && notifIssues.length > 0 && !isJustDisabled;

                  const platformBorder = account.platform === 'yelp' ? 'border-[#FF1A1A]/30' : 'border-[#41B1E1]/30';
                  const borderClass = isCheckingDiag
                    ? 'border-slate-200'
                    : hasConnectionIssues
                      ? 'border-amber-200 hover:border-amber-300'
                      : hasConfigIssues
                        ? 'border-orange-200 hover:border-orange-300'
                        : `${platformBorder} hover:border-[${account.platform === 'yelp' ? '#FF1A1A' : '#41B1E1'}]/50`;

                  return (
                    <div
                      key={account.id}
                      className={`bg-white border-2 rounded-3xl p-5 flex items-center gap-5 transition-all cursor-pointer group shadow-sm ${borderClass}`}
                      onClick={() => handleAccountClick(account)}
                    >
                      {account.imageUrl ? (
                        <img
                          src={account.imageUrl}
                          alt={account.businessName}
                          className="w-14 h-14 rounded-2xl object-cover"
                        />
                      ) : (
                        <div className="w-14 h-14 bg-slate-50 rounded-2xl flex items-center justify-center text-slate-400 group-hover:bg-blue-50 group-hover:text-blue-500 transition-colors">
                          <Briefcase className="w-7 h-7" />
                        </div>
                      )}
                      <div className="flex-1">
                        <h4 className="font-bold text-slate-900">{account.businessName}</h4>
                        <div className="flex items-center gap-2 mt-1">
                          {/* Platform badge — always visible */}
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-md text-white ${account.platform === 'yelp' ? 'bg-[#FF1A1A]' : 'bg-[#41B1E1]'}`}>
                            {account.platform === 'yelp' ? 'Yelp' : 'TT'}
                          </span>
                          {isCheckingDiag ? (
                            <>
                              <Loader2 className="w-3 h-3 animate-spin text-slate-400" />
                              <span className="text-xs text-slate-400 font-medium">Checking...</span>
                            </>
                          ) : hasConnectionIssues ? (
                            <>
                              <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                              <span className="text-xs text-slate-500 font-medium">
                                {account.tokenDead ? 'Token expired — reconnect' : diag && !diag.healthy ? 'Needs attention' : 'Disconnected'}
                              </span>
                            </>
                          ) : hasConfigIssues ? (
                            <>
                              <span className="w-2 h-2 rounded-full bg-orange-400"></span>
                              <span className="text-xs text-slate-500 font-medium">SMS not configured</span>
                            </>
                          ) : isJustDisabled ? (
                            <>
                              <span className="w-2 h-2 rounded-full bg-slate-300"></span>
                              <span className="text-xs text-slate-400 font-medium">Lead alerts off</span>
                            </>
                          ) : (
                            <>
                              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                              <span className="text-xs text-slate-500 font-medium">Synced</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {/* Status icon */}
                        {isCheckingDiag ? (
                          <div className="w-5 h-5" />
                        ) : hasConnectionIssues ? (
                          <AlertCircle className="w-5 h-5 text-amber-500 group-hover:text-amber-600" />
                        ) : hasConfigIssues ? (
                          <BellOff className="w-5 h-5 text-orange-400 group-hover:text-orange-500" />
                        ) : (
                          <ExternalLink className="w-5 h-5 text-slate-300 group-hover:text-blue-500" />
                        )}

                        {/* Actions menu */}
                        <div className="relative" data-account-menu>
                          <button
                            onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === account.id ? null : account.id); }}
                            className="w-8 h-8 flex items-center justify-center text-slate-300 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-all"
                            disabled={actionLoading === account.id}
                          >
                            {actionLoading === account.id ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <MoreVertical className="w-4 h-4" />
                            )}
                          </button>
                          {menuOpenId === account.id && (
                            <div className="absolute right-0 top-full mt-1 bg-white border border-slate-200 rounded-xl shadow-lg py-1 z-20 min-w-[180px]">
                              {account.platform === 'yelp' ? (
                                <button
                                  onClick={async (e) => { e.stopPropagation(); await platformsApi.disconnectYelp(account.id); loadAccounts(); setMenuOpenId(null); }}
                                  className="w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2.5 transition-colors"
                                >
                                  <Unlink className="w-4 h-4 text-slate-400" />
                                  Disconnect Yelp
                                </button>
                              ) : account.webhookId ? (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleDisconnectWebhook(account); }}
                                  className="w-full px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2.5 transition-colors"
                                >
                                  <Unlink className="w-4 h-4 text-slate-400" />
                                  Disconnect
                                </button>
                              ) : (
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleReconnectWebhook(account); }}
                                  className="w-full px-4 py-2.5 text-left text-sm text-blue-600 hover:bg-blue-50 flex items-center gap-2.5 transition-colors"
                                >
                                  <RefreshCw className="w-4 h-4" />
                                  Reconnect
                                </button>
                              )}
                              <button
                                onClick={(e) => { e.stopPropagation(); handleRemoveAccount(account); }}
                                className="w-full px-4 py-2.5 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2.5 transition-colors"
                              >
                                <Trash2 className="w-4 h-4" />
                                Remove Account
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                });
              })()
            ) : (
              <div className="col-span-2 bg-slate-50 border-2 border-dashed border-slate-200 rounded-3xl p-8 text-center">
                <p className="text-slate-600 font-medium mb-4">No accounts connected yet</p>
                <button
                  onClick={() => setConnectionModalOpen(true)}
                  className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all"
                >
                  <Plus className="w-5 h-5" />
                  Connect Account
                </button>
              </div>
            )}
          </div>
          </div>

          {/* System Health */}
          {(() => {
            const hasAccounts = savedAccounts.length > 0;
            const healthyAccounts = savedAccounts.filter(a => {
              const diag = accountDiagnostics[a.id];
              if (a.platform === 'yelp') return diag?.healthy !== false;
              return a.webhookId && diag?.healthy;
            });

            // Account connected = at least one account with a working webhook
            const accountConnected = healthyAccounts.length > 0;

            // SMS alerts configured = healthy account whose notification issues are all "disabled"
            // (rules exist but toggled off) or empty (fully configured and on)
            const smsConfigured = accountConnected && healthyAccounts.some(a => {
              const issues = accountDiagnostics[a.id]?.notificationIssues || [];
              return issues.length === 0 || issues.every((i: string) => i.toLowerCase().includes('disabled'));
            });

            // Automation enabled = healthy account with zero notification issues (rules exist and are on)
            const automationEnabled = accountConnected && healthyAccounts.some(a => {
              const issues = accountDiagnostics[a.id]?.notificationIssues || [];
              return issues.length === 0;
            });

            const subtitle = !hasAccounts
              ? 'Connect a Thumbtack account to get started.'
              : !accountConnected
              ? 'Your account connection needs attention.'
              : !smsConfigured
              ? 'Account connected. Configure SMS alerts to enable automation.'
              : !automationEnabled
              ? 'SMS alerts configured but automation is currently off.'
              : 'All systems connected and running.';

            return (
              <div className="order-5 lg:order-none bg-slate-900 rounded-[2rem] p-6 md:p-8 text-white relative overflow-hidden">
                <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-6 md:gap-8">
                  <div className="md:max-w-xs">
                    <h3 className="text-xl md:text-2xl font-bold mb-2">Account Status</h3>
                    <p className="text-slate-400 text-sm">{subtitle}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 md:gap-4 flex-1">
                    <div className="bg-white/10 rounded-2xl p-3 md:p-4 flex items-center gap-2 md:gap-3">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${accountConnected ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-slate-500'}`}></div>
                      <span className="text-xs md:text-sm font-medium">Accounts: {accountConnected ? 'Connected' : 'Not Connected'}</span>
                    </div>
                    <div className="bg-white/10 rounded-2xl p-3 md:p-4 flex items-center gap-2 md:gap-3">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${smsConfigured ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-slate-500'}`}></div>
                      <span className="text-xs md:text-sm font-medium">SMS Alerts: {smsConfigured ? 'Configured' : 'Not Set Up'}</span>
                    </div>
                    <div className="bg-white/10 rounded-2xl p-3 md:p-4 flex items-center gap-2 md:gap-3">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${automationEnabled ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-slate-500'}`}></div>
                      <span className="text-xs md:text-sm font-medium">Automation: {automationEnabled ? 'Enabled' : 'Off'}</span>
                    </div>
                    <div className="bg-white/10 rounded-2xl p-3 md:p-4 flex items-center gap-2 md:gap-3">
                      <div className="w-2 h-2 rounded-full bg-amber-400 shrink-0"></div>
                      <span className="text-xs md:text-sm font-medium opacity-60 italic">Voice: Beta</span>
                    </div>
                  </div>
                </div>
                <div className="absolute -right-20 -bottom-20 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl"></div>
              </div>
            );
          })()}
        </div>

        {/* Alerts & Quick Actions */}
        <div className="contents lg:block lg:space-y-6">
          <div className="order-3 lg:order-none flex flex-col gap-6">
          {(() => {
            const isCheckingHealth = loadingDiagnostics || (savedAccounts.length > 0 && Object.keys(accountDiagnostics).length === 0);
            const disconnectedAccounts = savedAccounts.filter(a => {
              const diag = accountDiagnostics[a.id];
              if (a.platform === 'yelp') return diag && !diag.healthy;
              return !a.webhookId || (diag && !diag.healthy);
            });
            const configIssueAccounts = savedAccounts.filter(a => {
              const diag = accountDiagnostics[a.id];
              if (a.platform === 'yelp') {
                const issues = diag?.notificationIssues || [];
                return diag?.healthy && issues.length > 0 && !issues.every((i: string) => i.toLowerCase().includes('disabled'));
              }
              const hasConnIssue = !a.webhookId || (diag && !diag.healthy);
              const issues = diag?.notificationIssues || [];
              return !hasConnIssue && issues.length > 0 && !issues.every((i: string) => i.toLowerCase().includes('disabled'));
            });
            const hasConnectionIssues = disconnectedAccounts.length > 0;
            const hasConfigIssues = configIssueAccounts.length > 0;

            return (
              <>
                <div className="flex items-center justify-between px-2">
                  <h3 className="text-xl font-bold text-slate-900">System Status</h3>
                  {isCheckingHealth ? (
                    <span className="bg-slate-100 text-slate-500 text-xs font-bold px-2 py-1 rounded-md flex items-center gap-1.5">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      CHECKING
                    </span>
                  ) : hasConnectionIssues ? (
                    <span className="bg-red-50 text-red-600 text-xs font-bold px-2 py-1 rounded-md">
                      {disconnectedAccounts.length} URGENT
                    </span>
                  ) : hasConfigIssues ? (
                    <span className="bg-orange-50 text-orange-600 text-xs font-bold px-2 py-1 rounded-md">
                      SETUP NEEDED
                    </span>
                  ) : (
                    <span className="bg-emerald-50 text-emerald-600 text-xs font-bold px-2 py-1 rounded-md">
                      ALL GOOD
                    </span>
                  )}
                </div>

                {isCheckingHealth ? (
                  <div className="bg-slate-50/50 border border-slate-200 rounded-3xl p-5 relative overflow-hidden flex items-center">
                    <div className="flex items-start gap-4 w-full">
                      <div className="w-10 h-10 bg-slate-100 text-slate-400 rounded-xl flex items-center justify-center shrink-0">
                        <Loader2 className="w-5 h-5 animate-spin" />
                      </div>
                      <div className="flex-1">
                        <h5 className="font-bold text-slate-900">Checking Systems...</h5>
                        <p className="text-sm text-slate-500 mt-1 leading-relaxed">
                          Verifying account connections and notification settings.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : hasConnectionIssues ? (
                  <div className="bg-rose-50/50 border border-rose-100 rounded-3xl p-5 relative overflow-hidden group hover:bg-rose-50 transition-colors cursor-pointer flex items-center"
                    onClick={() => {
                      const unhealthy = disconnectedAccounts[0];
                      if (unhealthy) {
                        setAccountToReconnect(unhealthy);
                        setConnectionModalOpen(true);
                      }
                    }}
                  >
                    <div className="flex items-start gap-4 w-full">
                      <div className="w-10 h-10 bg-rose-100 text-rose-600 rounded-xl flex items-center justify-center shrink-0">
                        <AlertCircle className="w-5 h-5" />
                      </div>
                      <div className="flex-1">
                        <h5 className="font-bold text-slate-900">Action Required</h5>
                        <p className="text-sm text-slate-600 mt-1 leading-relaxed">
                          {disconnectedAccounts.length} account{disconnectedAccounts.length !== 1 ? 's need' : ' needs'} attention to resume full automation.
                        </p>
                        <div className="mt-4 text-xs font-bold text-rose-600 uppercase tracking-wider flex items-center gap-1 hover:text-rose-700 transition-colors">
                          Fix Now <ChevronRight className="w-3 h-3" />
                        </div>
                      </div>
                    </div>
                  </div>
                ) : hasConfigIssues ? (
                  <Link to="/services?expand=lead-alerts" className="bg-orange-50/50 border border-orange-100 rounded-3xl p-5 relative overflow-hidden group hover:bg-orange-50 transition-colors cursor-pointer flex items-center block">
                    <div className="flex items-start gap-4 w-full">
                      <div className="w-10 h-10 bg-orange-100 text-orange-600 rounded-xl flex items-center justify-center shrink-0">
                        <BellOff className="w-5 h-5" />
                      </div>
                      <div className="flex-1">
                        <h5 className="font-bold text-slate-900">Lead Alerts Not Configured</h5>
                        <p className="text-sm text-slate-600 mt-1 leading-relaxed">
                          {(() => {
                            const firstIssue = accountDiagnostics[configIssueAccounts[0]?.id]?.notificationIssues?.[0];
                            return firstIssue || `${configIssueAccounts.length} account${configIssueAccounts.length !== 1 ? 's are' : ' is'} missing SMS alert setup.`;
                          })()}
                        </p>
                        <div className="mt-4 text-xs font-bold text-orange-600 uppercase tracking-wider flex items-center gap-1 hover:text-orange-700 transition-colors">
                          Fix in Automation <ChevronRight className="w-3 h-3" />
                        </div>
                      </div>
                    </div>
                  </Link>
                ) : savedAccounts.length > 0 ? (
                  <div className="bg-emerald-50/50 border border-emerald-100 rounded-3xl p-5 relative overflow-hidden flex items-center">
                    <div className="flex items-start gap-4 w-full">
                      <div className="w-10 h-10 bg-emerald-100 text-emerald-600 rounded-xl flex items-center justify-center shrink-0">
                        <CheckCircle className="w-5 h-5" />
                      </div>
                      <div className="flex-1">
                        <h5 className="font-bold text-slate-900">All Systems Operational</h5>
                        <p className="text-sm text-slate-600 mt-1 leading-relaxed">
                          All accounts are connected and automation is running smoothly.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : null}
              </>
            );
          })()}
          </div>

          <div className="order-6 lg:order-none bg-gradient-to-br from-indigo-500 to-purple-600 rounded-[2rem] p-8 text-white shadow-lg shadow-indigo-100 relative overflow-hidden">
            <div className="relative z-10 flex flex-col items-center justify-center text-center h-full">
              <div className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-6">
                <Sparkles className="w-8 h-8" />
              </div>
              <h3 className="text-2xl font-bold mb-3">AI Templates</h3>
              <p className="text-indigo-100 text-sm mb-6 leading-relaxed max-w-xs">
                AI-powered response templates are coming soon. Stay tuned!
              </p>
              <span className="px-8 py-3 bg-white/20 text-white rounded-xl font-bold text-sm cursor-default">
                Coming Soon
              </span>
            </div>
            <div className="absolute -right-20 -bottom-20 w-64 h-64 bg-purple-600/20 rounded-full blur-3xl"></div>
          </div>
        </div>
      </div>

      {/* 7-Day Snapshot */}
      <section className="order-7 lg:order-4 space-y-6">
        <div className="flex items-center justify-between px-2">
          <h3 className="text-xl font-bold text-slate-900">7-Day Snapshot</h3>
        </div>
        <div className="bg-white border border-slate-100 rounded-[2.5rem] overflow-hidden shadow-sm">
          <div className="p-8 border-b border-slate-50 flex flex-wrap items-center gap-8 justify-around">
            <div className="text-center">
              <p className="text-slate-400 text-sm font-medium mb-1">Weekly Leads</p>
              <p className="text-3xl font-extrabold text-slate-900">{loading ? '...' : stats.weeklyLeads}</p>
            </div>
            <div className="w-px h-12 bg-slate-100 hidden md:block"></div>
            <div className="text-center">
              <p className="text-slate-400 text-sm font-medium mb-1">Engagement</p>
              <p className="text-3xl font-extrabold text-slate-900">{loading ? '...' : stats.engagement}%</p>
            </div>
            <div className="w-px h-12 bg-slate-100 hidden md:block"></div>
            <div className="text-center">
              <p className="text-slate-400 text-sm font-medium mb-1">Lifetime Replies</p>
              <p className="text-3xl font-extrabold text-slate-900">{loading ? '...' : stats.lifetimeReplies}</p>
            </div>
            <div className="w-px h-12 bg-slate-100 hidden md:block"></div>
            <div className="text-center">
              <p className="text-slate-400 text-sm font-medium mb-1">Messages Sent</p>
              <p className="text-3xl font-extrabold text-slate-900">{loading ? '...' : stats.messagesSent}</p>
            </div>
          </div>
          <div className="bg-slate-50/50 p-6 flex items-center justify-center">
            <Link to="/analytics" className="px-6 py-3 bg-white border border-slate-200 rounded-xl font-semibold text-slate-700 hover:bg-slate-50 shadow-sm transition-all flex items-center gap-2">
              View Full Reports <ChevronRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* Connection Modal */}
      <ConnectionModal
        isOpen={connectionModalOpen}
        onClose={() => {
          setConnectionModalOpen(false);
          setAccountToReconnect(null);
        }}
        accountToReconnect={accountToReconnect}
        savedAccounts={savedAccounts}
        onSuccess={handleConnectionSuccess}
      />
    </div>
  );
}
