import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Users, Send, Clock, TrendingUp, Plus, ChevronRight,
  Briefcase, Sparkles, AlertCircle, ExternalLink, Loader2, CheckCircle, BellOff,
  MoreVertical, Unlink, Trash2, RefreshCw, Rocket,
} from 'lucide-react';
import { useAppStore } from '../store/appStore';
import type { DashboardStats } from '../store/appStore';
import { useAuthStore } from '../store/authStore';
import { thumbtackApi, analyticsApi, notificationsApi, platformsApi } from '../services/api';
import ConnectionModal from '../components/ConnectionModal';
import AdminNoAccountsState from '../components/AdminNoAccountsState';
import type { SavedAccount } from '../types';
import { Btn, Card, Kpi, PlatformBadge, StatusPill, EmptyState } from '../components/ui';

export function Dashboard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, impersonatingUser } = useAuthStore();
  const { savedAccounts, setSavedAccounts, dashboardStats: cachedStats, setDashboardStats, accountDiagnostics, loadDiagnostics, systemHealth, systemHealthLoading } = useAppStore();

  // Per-platform empty stats. The Dashboard splits Yelp and Thumbtack into
  // two independent summaries, each with its own top KPIs + 7-day snapshot.
  const EMPTY_PLATFORM_STATS = {
    leadsToday: 0,
    automatedReplies: 0,
    avgResponseTime: '—',
    conversionRate: 0,
    weeklyLeads: 0,
    engagement: 0,
    lifetimeReplies: 0,
    messagesSent: 0,
    hasAccounts: false,
  };
  // Tolerate older cached payloads that pre-date the split (flat shape) so a
  // mid-deploy refresh doesn't crash — fall through to the empty per-platform
  // shape and let loadDashboardStats re-populate on next tick.
  const seededStats: DashboardStats = (cachedStats && typeof cachedStats === 'object' && (cachedStats as any).yelp && (cachedStats as any).thumbtack)
    ? (cachedStats as DashboardStats)
    : { yelp: { ...EMPTY_PLATFORM_STATS }, thumbtack: { ...EMPTY_PLATFORM_STATS } };
  const [stats, setStats] = useState<DashboardStats>(seededStats);
  const [loading, setLoading] = useState(!cachedStats);
  const [refreshing, setRefreshing] = useState(false);
  const [connectionModalOpen, setConnectionModalOpen] = useState(false);
  const [accountToReconnect, setAccountToReconnect] = useState<SavedAccount | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

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
    loadAccounts(true);
    loadDashboardStats();
  }, []);

  useEffect(() => {
    console.log('[Yelp OAuth] Dashboard mount — checking for stored OAuth URL', { connected: searchParams.get('connected'), error: searchParams.get('error'), hasStored: !!sessionStorage.getItem('yelp_oauth_url') });

    if (searchParams.get('connected') || searchParams.get('error')) {
      console.log('[Yelp OAuth] Dashboard: skipping redirect — already a callback');
      return;
    }

    const stored = sessionStorage.getItem('yelp_oauth_url');
    if (stored) {
      try {
        const { url, exp } = JSON.parse(stored);
        sessionStorage.removeItem('yelp_oauth_url');
        const expired = Date.now() >= exp;
        console.log('[Yelp OAuth] Dashboard: found stored OAuth URL', { url: url?.substring(0, 80), expired, expiresIn: Math.round((exp - Date.now()) / 1000) + 's' });
        if (!expired) {
          console.log('[Yelp OAuth] Dashboard: redirecting to stored OAuth URL...');
          window.location.href = url;
          return;
        }
        console.log('[Yelp OAuth] Dashboard: stored URL expired, ignoring');
      } catch {
        console.error('[Yelp OAuth] Dashboard: failed to parse stored OAuth URL');
        sessionStorage.removeItem('yelp_oauth_url');
      }
    }
  }, []);

  useEffect(() => {
    const connected = searchParams.get('connected');
    if (connected === 'yelp') {
      const businesses = searchParams.get('businesses');
      const warning = searchParams.get('warning');
      console.log(`[Yelp OAuth] Step 7: Callback success — connected=yelp businesses=${businesses} warning=${warning}`);
      if (warning === 'no_businesses') {
        setOauthError('Yelp authorization succeeded but no businesses were found. Please add a business manually or contact support.');
      }
      loadAccounts(true);
      setSearchParams({}, { replace: true });
    }
  }, []);

  useEffect(() => {
    const webhookError = searchParams.get('webhook_error');
    const reconnect = searchParams.get('reconnect');
    const error = searchParams.get('error');

    if (webhookError) {
      console.log('[Dashboard] Webhook setup failed after OAuth:', webhookError);
      setOauthError(`Thumbtack authorization succeeded but webhook setup failed: ${webhookError}. Please try reconnecting again.`);
    } else if (error) {
      const desc = searchParams.get('error_description') || error;
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
      if (accounts.length > 0) {
        loadDiagnostics(accounts, forceDiagnostics);
      }
    } catch (err) {
      console.error('Failed to load accounts:', err);
    }
  }

  async function loadDashboardStats() {
    try {
      if (cachedStats) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const sevenDaysAgo = new Date(now);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      // Six platform-filtered fetches in parallel (today / 7d / all-time × yelp / thumbtack).
      // analyticsApi.getBasicAnalytics + getAnalytics already accept `platform`,
      // so this is a pure-frontend split — no backend changes.
      const platforms = ['yelp', 'thumbtack'] as const;
      const safeBasic = { data: { totalLeads: 0, customerEngagement: { engagementRate: 0 } } } as any;
      const safeFull = { data: { totalLeads: 0, connectionTime: { averageMinutes: 0 }, customerEngagement: { engagementRate: 0 }, messagesPerLead: { average: 0 } } } as any;
      const [todayYelp, todayTT, weekYelp, weekTT, allYelp, allTT, allRules] = await Promise.all([
        analyticsApi.getBasicAnalytics({ platform: platforms[0], startDate: todayStart.toISOString(), endDate: now.toISOString() }).catch(() => safeBasic),
        analyticsApi.getBasicAnalytics({ platform: platforms[1], startDate: todayStart.toISOString(), endDate: now.toISOString() }).catch(() => safeBasic),
        analyticsApi.getBasicAnalytics({ platform: platforms[0], startDate: sevenDaysAgo.toISOString(), endDate: now.toISOString() }).catch(() => safeBasic),
        analyticsApi.getBasicAnalytics({ platform: platforms[1], startDate: sevenDaysAgo.toISOString(), endDate: now.toISOString() }).catch(() => safeBasic),
        analyticsApi.getAnalytics({ platform: platforms[0] }).catch(() => safeFull),
        analyticsApi.getAnalytics({ platform: platforms[1] }).catch(() => safeFull),
        notificationsApi.getAllRules().catch(() => ({ success: false, count: 0, rules: [] as any[] })),
      ]);

      const formatDuration = (minutes: number): string => {
        if (!minutes || minutes <= 0) return '—';
        if (minutes < 1) return `${Math.round(minutes * 60)}s`;
        if (minutes < 60) return `${Math.round(minutes)}m`;
        const hours = Math.floor(minutes / 60);
        const mins = Math.round(minutes % 60);
        return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
      };

      // Build account-id → platform lookup so we can split notification-rule
      // trigger counts (auto-reply / alert) by the originating account's
      // platform. Rules without a savedAccountId fall back to neither bucket.
      const accountPlatform: Record<string, 'yelp' | 'thumbtack'> = {};
      for (const a of savedAccounts) {
        if (a.platform === 'yelp' || a.platform === 'thumbtack') {
          accountPlatform[a.id] = a.platform;
        }
      }
      const rules = (allRules as any).rules || [];
      const replyCount: Record<'yelp' | 'thumbtack', number> = { yelp: 0, thumbtack: 0 };
      const alertCount: Record<'yelp' | 'thumbtack', number> = { yelp: 0, thumbtack: 0 };
      for (const r of rules) {
        const p = accountPlatform[r.savedAccountId];
        if (!p) continue;
        if (r.sendToCustomer === true) replyCount[p] += r.triggerCount || 0;
        else alertCount[p] += r.triggerCount || 0;
      }

      const yelpHas = savedAccounts.some(a => a.platform === 'yelp');
      const ttHas = savedAccounts.some(a => a.platform === 'thumbtack');

      const freshStats: DashboardStats = {
        yelp: {
          leadsToday: todayYelp.data.totalLeads || 0,
          automatedReplies: replyCount.yelp,
          avgResponseTime: formatDuration(allYelp.data.connectionTime?.averageMinutes || 0),
          conversionRate: Math.round(allYelp.data.customerEngagement?.engagementRate || 0),
          weeklyLeads: weekYelp.data.totalLeads || 0,
          engagement: Math.round(weekYelp.data.customerEngagement?.engagementRate || 0),
          lifetimeReplies: replyCount.yelp,
          messagesSent: replyCount.yelp + alertCount.yelp,
          hasAccounts: yelpHas,
        },
        thumbtack: {
          leadsToday: todayTT.data.totalLeads || 0,
          automatedReplies: replyCount.thumbtack,
          avgResponseTime: formatDuration(allTT.data.connectionTime?.averageMinutes || 0),
          conversionRate: Math.round(allTT.data.customerEngagement?.engagementRate || 0),
          weeklyLeads: weekTT.data.totalLeads || 0,
          engagement: Math.round(weekTT.data.customerEngagement?.engagementRate || 0),
          lifetimeReplies: replyCount.thumbtack,
          messagesSent: replyCount.thumbtack + alertCount.thumbtack,
          hasAccounts: ttHas,
        },
      };

      setStats(freshStats);
      setDashboardStats(freshStats);
    } catch (err) {
      console.error('Failed to load dashboard stats:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  const handleAccountClick = (account: SavedAccount) => {
    const diag = accountDiagnostics[account.id];
    const hasConnectionIssues = account.tokenDead || (account.platform === 'thumbtack' && !account.webhookId) || (diag && !diag.healthy);
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
    await new Promise(resolve => setTimeout(resolve, 1000));
    await loadAccounts(true);
  };

  const isAdmin = user?.role === 'ADMIN';
  const hasNoAccounts = savedAccounts.length === 0;
  const greeting = new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening';

  // Admin empty state
  if (isAdmin && hasNoAccounts && !impersonatingUser && !loading) {
    return (
      <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div>
          <p
            style={{
              fontSize: 11,
              color: 'var(--lb-accent)',
              textTransform: 'uppercase',
              letterSpacing: 0.08,
              fontWeight: 600,
              fontFamily: 'var(--lb-font-mono)',
              margin: 0,
            }}
          >
            Good {greeting}, {user?.name || 'Admin'}
          </p>
          <h2 style={{ margin: '6px 0 0', fontSize: 22, fontWeight: 600, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
            Admin Dashboard
          </h2>
        </div>
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

  const connectedIssues = savedAccounts.filter(a => {
    const diag = accountDiagnostics[a.id];
    return a.tokenDead || (a.platform === 'thumbtack' && !a.webhookId) || (diag && !diag.healthy);
  });
  const hasAccounts = savedAccounts.length > 0;
  const healthyAccounts = savedAccounts.filter(a => {
    const diag = accountDiagnostics[a.id];
    if (a.platform === 'yelp') return diag?.healthy !== false;
    return a.webhookId && diag?.healthy;
  });
  const accountConnected = healthyAccounts.length > 0;
  const smsConfigured = accountConnected && healthyAccounts.some(a => {
    const issues = accountDiagnostics[a.id]?.notificationIssues || [];
    return issues.length === 0 || issues.every((i: string) => i.toLowerCase().includes('disabled'));
  });
  const automationEnabled = accountConnected && healthyAccounts.some(a => {
    const issues = accountDiagnostics[a.id]?.notificationIssues || [];
    return issues.length === 0;
  });

  return (
    <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 1400, margin: '0 auto' }}>
      {/* OAuth error banner */}
      {oauthError && (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            padding: '12px 14px',
            background: 'oklch(0.96 0.04 27)',
            border: '1px solid oklch(0.88 0.08 27)',
            borderRadius: 'var(--lb-radius-lg)',
            color: '#7a1a14',
          }}
        >
          <AlertCircle size={18} style={{ flexShrink: 0, marginTop: 1, color: 'var(--lb-danger)' }} />
          <div style={{ flex: 1, fontSize: 13 }}>{oauthError}</div>
          <button
            onClick={() => setOauthError(null)}
            style={{ background: 'transparent', border: 0, color: 'var(--lb-danger)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
          >
            ×
          </button>
        </div>
      )}

      {/* Greeting */}
      <div>
        <p
          style={{
            fontSize: 11,
            color: 'var(--lb-accent)',
            textTransform: 'uppercase',
            letterSpacing: 0.08,
            fontWeight: 600,
            fontFamily: 'var(--lb-font-mono)',
            margin: 0,
          }}
        >
          Good {greeting}, {user?.name || 'User'}
        </p>
        <h2 style={{ margin: '6px 0 4px', fontSize: 22, fontWeight: 600, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
          Overview
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--lb-ink-5)' }}>
          Leadbridge captured {stats.yelp.leadsToday + stats.thumbtack.leadsToday} new lead{(stats.yelp.leadsToday + stats.thumbtack.leadsToday) !== 1 ? 's' : ''} today.
        </p>
      </div>

      {/* KPI row */}
      <div style={{ position: 'relative' }}>
        {refreshing && (
          <div
            style={{
              position: 'absolute',
              top: -20,
              right: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              color: 'var(--lb-ink-5)',
              fontFamily: 'var(--lb-font-mono)',
            }}
          >
            <Loader2 size={12} className="animate-spin" />
            Updating...
          </div>
        )}
        {/* Top summary — one row of 4 metrics. Each cell shows both platform
            values inline, separated by a vertical rule (e.g. 'Leads today: 3 | 0').
            Only the platforms that have connected accounts contribute a value.
            Lifetime metrics get an "all-time" delta hint so the timeframe is
            still visible at a glance. */}
        {(() => {
          // Platform marker: small colored rounded square with "Y" (Yelp red)
          // or "TT" (Thumbtack blue) — matches the pill style already used on
          // the Messages page conversation header.
          const platforms: Array<{ key: 'yelp' | 'thumbtack'; tag: string; bg: string }> = [
            { key: 'yelp',      tag: 'Y',  bg: '#FF1A1A' },
            { key: 'thumbtack', tag: 'TT', bg: '#41B1E1' },
          ];
          const visible = platforms.filter(p => stats[p.key].hasAccounts);
          const active = visible.length > 0 ? visible : [platforms[1]];
          const splitValue = (renderOne: (p: 'yelp' | 'thumbtack') => React.ReactNode): React.ReactNode => (
            <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
              {active.map((p, i) => (
                <span key={p.key} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
                  {i > 0 && <span aria-hidden style={{ display: 'inline-block', width: 1, alignSelf: 'stretch', background: 'var(--lb-line)' }} />}
                  <span title={p.key === 'yelp' ? 'Yelp' : 'Thumbtack'} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      minWidth: 18,
                      height: 14,
                      padding: '0 4px',
                      borderRadius: 3,
                      background: p.bg,
                      color: '#fff',
                      fontSize: 9,
                      fontWeight: 700,
                      lineHeight: 1,
                      letterSpacing: 0.2,
                      transform: 'translateY(1px)',
                    }}>{p.tag}</span>
                    {renderOne(p.key)}
                  </span>
                </span>
              ))}
            </span>
          );
          return (
            <div
              className="grid grid-cols-2 md:grid-cols-4"
              style={{
                background: 'var(--lb-surface)',
                border: '1px solid var(--lb-line)',
                borderRadius: 'var(--lb-radius-lg)',
              }}
            >
              <Kpi
                label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Users size={12} /> Leads today</span>}
                value={loading ? '—' : splitValue(p => stats[p].leadsToday)}
                loading={loading}
              />
              <Kpi
                label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Send size={12} /> Auto replies</span>}
                value={loading ? '—' : splitValue(p => stats[p].automatedReplies)}
                delta={loading ? undefined : 'all-time'}
                loading={loading}
              />
              <Kpi
                label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Clock size={12} /> Avg response</span>}
                value={loading ? '—' : splitValue(p => stats[p].avgResponseTime)}
                delta={loading ? undefined : 'all-time'}
                loading={loading}
              />
              <Kpi
                label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><TrendingUp size={12} /> Engagement</span>}
                value={loading ? '—' : splitValue(p => `${stats[p].conversionRate}%`)}
                delta={loading ? undefined : 'all-time · of leads replied'}
                deltaDir="up"
                loading={loading}
                muted
              />
            </div>
          );
        })()}
      </div>

      {/* 2-col main grid */}
      <div
        style={{ gap: 20 }}
        className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
      >
        {/* Left column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
          {/* Connected accounts */}
          <Card
            title="Connected accounts"
            subtitle={hasAccounts ? `${savedAccounts.length} source${savedAccounts.length === 1 ? '' : 's'}` : undefined}
            padding={0}
            action={
              hasAccounts ? (
                <Btn size="sm" variant="accent" icon={<Plus size={13} />} onClick={() => setConnectionModalOpen(true)}>
                  Connect
                </Btn>
              ) : null
            }
          >
            {!hasAccounts ? (
              <div style={{ padding: 20 }}>
                <EmptyState
                  icon={<Rocket size={18} />}
                  title="Connect your first lead source"
                  body="Leadbridge will auto-reply, follow up, and route calls while you work."
                  action={
                    <Btn variant="accent" icon={<Plus size={14} />} onClick={() => setConnectionModalOpen(true)}>
                      Connect account
                    </Btn>
                  }
                />
              </div>
            ) : (
              savedAccounts.map((account, i) => {
                const diag = accountDiagnostics[account.id];
                const isCheckingDiag = !diag;
                const hasConnectionIssues = account.tokenDead || (!isCheckingDiag && (diag && !diag.healthy));
                const notifIssues = diag?.notificationIssues || [];
                const isJustDisabled = !isCheckingDiag && !hasConnectionIssues && notifIssues.length > 0 && notifIssues.every((i: string) => i.toLowerCase().includes('disabled'));
                const hasConfigIssues = !isCheckingDiag && !hasConnectionIssues && notifIssues.length > 0 && !isJustDisabled;
                const isLast = i === savedAccounts.length - 1;

                const statusLabel = isCheckingDiag
                  ? 'Checking…'
                  : hasConnectionIssues
                    ? (account.tokenDead ? 'Reconnect needed' : diag && !diag.healthy ? 'Needs attention' : 'Disconnected')
                    : hasConfigIssues
                      ? 'SMS not configured'
                      : isJustDisabled
                        ? 'Lead alerts off'
                        : 'Connected';
                const statusKind = isCheckingDiag
                  ? 'neutral'
                  : hasConnectionIssues
                    ? 'warning'
                    : hasConfigIssues
                      ? 'warning'
                      : isJustDisabled
                        ? 'lost'
                        : 'won';

                return (
                  <div
                    key={account.id}
                    onClick={() => handleAccountClick(account)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '12px 14px',
                      borderBottom: isLast ? 'none' : '1px solid var(--lb-line-soft)',
                      cursor: 'pointer',
                      transition: 'background 120ms ease',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--lb-ink-10)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    {account.imageUrl ? (
                      <img
                        src={account.imageUrl}
                        alt={account.businessName}
                        style={{ width: 30, height: 30, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 30, height: 30, borderRadius: 6,
                          background: 'var(--lb-ink-10)',
                          color: 'var(--lb-ink-5)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <Briefcase size={14} />
                      </div>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 500,
                            color: 'var(--lb-ink-1)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {account.businessName}
                        </span>
                        <PlatformBadge platform={account.platform} />
                      </div>
                      <div style={{ marginTop: 3, display: 'flex', alignItems: 'center', gap: 8 }}>
                        {isCheckingDiag && <Loader2 size={10} className="animate-spin" style={{ color: 'var(--lb-ink-5)' }} />}
                        <StatusPill status={statusKind as any} label={statusLabel} />
                      </div>
                    </div>
                    {/* Status icon + menu */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      {!isCheckingDiag && hasConnectionIssues && (
                        <AlertCircle size={15} style={{ color: 'var(--lb-warn)' }} />
                      )}
                      {!isCheckingDiag && !hasConnectionIssues && hasConfigIssues && (
                        <BellOff size={15} style={{ color: 'var(--lb-warn)' }} />
                      )}
                      {!isCheckingDiag && !hasConnectionIssues && !hasConfigIssues && !isJustDisabled && (
                        <ExternalLink size={14} style={{ color: 'var(--lb-ink-6)' }} />
                      )}
                      <div style={{ position: 'relative' }} data-account-menu>
                        <button
                          onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === account.id ? null : account.id); }}
                          disabled={actionLoading === account.id}
                          style={{
                            width: 26, height: 26,
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            background: 'transparent', border: 0, cursor: 'pointer',
                            color: 'var(--lb-ink-5)', borderRadius: 4,
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = 'var(--lb-ink-9)'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          {actionLoading === account.id ? <Loader2 size={13} className="animate-spin" /> : <MoreVertical size={13} />}
                        </button>
                        {menuOpenId === account.id && (
                          <div
                            style={{
                              position: 'absolute',
                              right: 0,
                              top: '100%',
                              marginTop: 4,
                              background: 'var(--lb-surface)',
                              border: '1px solid var(--lb-line)',
                              borderRadius: 'var(--lb-radius)',
                              boxShadow: 'var(--lb-shadow-md)',
                              padding: 4,
                              zIndex: 20,
                              minWidth: 180,
                            }}
                          >
                            {account.platform === 'yelp' ? (
                              <MenuItem
                                icon={<Unlink size={13} />}
                                label="Disconnect Yelp"
                                onClick={async (e) => { e.stopPropagation(); await platformsApi.disconnectYelp(account.id); loadAccounts(); setMenuOpenId(null); }}
                              />
                            ) : account.webhookId ? (
                              <MenuItem
                                icon={<Unlink size={13} />}
                                label="Disconnect"
                                onClick={(e) => { e.stopPropagation(); handleDisconnectWebhook(account); }}
                              />
                            ) : (
                              <MenuItem
                                icon={<RefreshCw size={13} />}
                                label="Reconnect"
                                accent
                                onClick={(e) => { e.stopPropagation(); handleReconnectWebhook(account); }}
                              />
                            )}
                            <MenuItem
                              icon={<Trash2 size={13} />}
                              label="Remove account"
                              danger
                              onClick={(e) => { e.stopPropagation(); handleRemoveAccount(account); }}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </Card>

          {/* Weekly snapshot — single 4-KPI row. Each cell shows both
              platforms inline separated by a vertical rule (Yelp | Thumbtack). */}
          <Card title="7-day snapshot" padding={0}>
            {(() => {
              const platforms: Array<{ key: 'yelp' | 'thumbtack'; dot: string }> = [
                { key: 'yelp',      dot: '🔴' },
                { key: 'thumbtack', dot: '🔵' },
              ];
              const visible = platforms.filter(p => stats[p.key].hasAccounts);
              const active = visible.length > 0 ? visible : [platforms[1]];
              const splitValue = (renderOne: (p: 'yelp' | 'thumbtack') => React.ReactNode): React.ReactNode => (
                <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
                  {active.map((p, i) => (
                    <span key={p.key} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
                      {i > 0 && <span aria-hidden style={{ display: 'inline-block', width: 1, alignSelf: 'stretch', background: 'var(--lb-line)' }} />}
                      <span title={p.key === 'yelp' ? 'Yelp' : 'Thumbtack'} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
                        <span style={{ fontSize: 10 }}>{p.dot}</span>
                        {renderOne(p.key)}
                      </span>
                    </span>
                  ))}
                </span>
              );
              return (
                <div className="grid grid-cols-2 md:grid-cols-4">
                  <Kpi label="Leads" value={loading ? '—' : splitValue(p => stats[p].weeklyLeads)} loading={loading} />
                  <Kpi label="Engagement" value={loading ? '—' : splitValue(p => `${stats[p].engagement}%`)} loading={loading} />
                  <Kpi label="Lifetime replies" value={loading ? '—' : splitValue(p => stats[p].lifetimeReplies)} loading={loading} />
                  <Kpi label="Messages sent" value={loading ? '—' : splitValue(p => stats[p].messagesSent)} loading={loading} muted />
                </div>
              );
            })()}
            <div
              style={{
                padding: '10px 14px',
                borderTop: '1px solid var(--lb-line-soft)',
                display: 'flex',
                justifyContent: 'flex-end',
              }}
            >
              <Link
                to="/analytics"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 12,
                  fontWeight: 500,
                  color: 'var(--lb-ink-4)',
                  textDecoration: 'none',
                }}
              >
                View full reports <ChevronRight size={13} />
              </Link>
            </div>
          </Card>
        </div>

        {/* Right column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
          {/* Account status */}
          <Card title="Account status" padding={0}>
            <SystemRow
              label="Accounts"
              sub={accountConnected ? 'At least one source synced' : 'No sources connected yet'}
              ok={accountConnected}
            />
            <SystemRow
              label="SMS alerts"
              sub={smsConfigured ? 'Lead alerts are configured' : 'Set up SMS alerts to get notified'}
              ok={smsConfigured}
            />
            <SystemRow
              label="Automation"
              sub={automationEnabled ? 'Rules are active' : 'Enable automation rules'}
              ok={automationEnabled}
            />
            <SystemRow label="Voice" sub="Beta" ok={null} last />
          </Card>

          {/* System status / alerts */}
          <SystemStatusCard
            systemHealth={systemHealth}
            systemHealthLoading={systemHealthLoading}
            savedAccounts={savedAccounts}
            onFixAccount={(acc) => { setAccountToReconnect(acc); setConnectionModalOpen(true); }}
          />

          {/* Tips / accent card */}
          {connectedIssues.length === 0 && hasAccounts && (
            <Card
              padding={14}
              style={{
                background: 'var(--lb-accent-tint)',
                borderColor: 'var(--lb-accent-line)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <Sparkles size={16} style={{ color: 'var(--lb-accent)', flexShrink: 0, marginTop: 2 }} />
                <div style={{ fontSize: 12, color: 'var(--lb-ink-3)', lineHeight: 1.5 }}>
                  <strong style={{ color: 'var(--lb-ink-1)' }}>AI templates are coming soon.</strong> Leadbridge will learn from your past replies and suggest variations your customers actually respond to.
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>

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

function MenuItem({ icon, label, onClick, accent, danger }: {
  icon: React.ReactNode;
  label: string;
  onClick: (e: React.MouseEvent) => void;
  accent?: boolean;
  danger?: boolean;
}) {
  const color = danger ? 'var(--lb-danger)' : accent ? 'var(--lb-accent)' : 'var(--lb-ink-2)';
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 10px',
        background: 'transparent',
        border: 0,
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 12,
        color,
        borderRadius: 4,
        textAlign: 'left',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--lb-ink-10)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      {icon}
      {label}
    </button>
  );
}

function SystemRow({ label, sub, ok, last }: { label: string; sub: string; ok: boolean | null; last?: boolean }) {
  const dotColor = ok === true ? 'var(--lb-success)' : ok === false ? 'var(--lb-ink-6)' : 'var(--lb-warn)';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        borderBottom: last ? 'none' : '1px solid var(--lb-line-soft)',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: 99, background: dotColor, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--lb-ink-1)' }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--lb-ink-5)' }}>{sub}</div>
      </div>
      <span
        style={{
          fontSize: 11,
          fontFamily: 'var(--lb-font-mono)',
          color: 'var(--lb-ink-5)',
          textTransform: 'uppercase',
          letterSpacing: 0.06,
        }}
      >
        {ok === true ? 'OK' : ok === false ? 'Off' : 'Beta'}
      </span>
    </div>
  );
}

function SystemStatusCard({
  systemHealth,
  systemHealthLoading,
  savedAccounts,
  onFixAccount,
}: {
  systemHealth: any;
  systemHealthLoading: boolean;
  savedAccounts: SavedAccount[];
  onFixAccount: (acc: SavedAccount) => void;
}) {
  const isLoading = systemHealthLoading || !systemHealth;
  const hasCritical = systemHealth && systemHealth.summary.critical > 0;
  const hasWarning = systemHealth && systemHealth.summary.warning > 0 && !hasCritical;

  const headerPill = isLoading
    ? { label: 'Checking', bg: 'var(--lb-ink-10)', fg: 'var(--lb-ink-5)' }
    : hasCritical
      ? { label: `${systemHealth.summary.critical} urgent`, bg: 'oklch(0.96 0.04 27)', fg: 'var(--lb-danger)' }
      : hasWarning
        ? { label: `${systemHealth.summary.warning} warning`, bg: 'oklch(0.96 0.05 75)', fg: 'var(--lb-warn)' }
        : { label: 'All good', bg: 'oklch(0.95 0.04 150)', fg: '#0c4a2b' };

  return (
    <Card
      title="System status"
      action={
        <span
          style={{
            fontSize: 10,
            fontFamily: 'var(--lb-font-mono)',
            fontWeight: 600,
            padding: '2px 7px',
            borderRadius: 99,
            background: headerPill.bg,
            color: headerPill.fg,
            textTransform: 'uppercase',
            letterSpacing: 0.06,
          }}
        >
          {headerPill.label}
        </span>
      }
      padding={14}
    >
      {isLoading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Loader2 size={14} className="animate-spin" style={{ color: 'var(--lb-ink-5)' }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--lb-ink-1)' }}>Checking systems…</div>
            <div style={{ fontSize: 11, color: 'var(--lb-ink-5)' }}>
              Verifying connections and notification settings.
            </div>
          </div>
        </div>
      ) : hasCritical || hasWarning ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-1)' }}>
            {hasCritical ? 'Action required' : 'Attention needed'}
          </div>
          {systemHealth.issues.map((issue: any, i: number) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--lb-ink-4)' }}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 99,
                  flexShrink: 0,
                  background: issue.status === 'critical' ? 'var(--lb-danger)' : 'var(--lb-warn)',
                }}
              />
              <span><strong style={{ color: 'var(--lb-ink-1)' }}>{issue.accountName}</strong> ({issue.platform}) — {issue.message}</span>
            </div>
          ))}
          <div style={{ marginTop: 6 }}>
            <Btn
              size="sm"
              variant="accent"
              iconRight={<ChevronRight size={13} />}
              onClick={() => {
                const firstIssue = systemHealth.issues.find((i: any) => i.status === 'critical') || systemHealth.issues[0];
                if (firstIssue) {
                  const account = savedAccounts.find(a => a.id === firstIssue.accountId);
                  if (account) onFixAccount(account);
                }
              }}
            >
              Fix now
            </Btn>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <CheckCircle size={16} style={{ color: 'var(--lb-success)', flexShrink: 0, marginTop: 2 }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--lb-ink-1)' }}>All systems operational</div>
            <div style={{ fontSize: 11, color: 'var(--lb-ink-5)' }}>
              Accounts are connected and automation is running.
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
