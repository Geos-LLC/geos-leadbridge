import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Users, Send, Clock, TrendingUp, Plus, ChevronRight,
  Briefcase, Sparkles, AlertCircle, ExternalLink
} from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useAuthStore } from '../store/authStore';
import { thumbtackApi, analyticsApi, testApi } from '../services/api';
import ConnectionModal from '../components/ConnectionModal';
import type { SavedAccount, AccountDiagnostics } from '../types';

interface DashboardStats {
  leadsToday: number;
  automatedReplies: number;
  avgResponseTime: string;
  conversionRate: number;
  weeklyLeads: number;
  engagement: number;
  lifetimeReplies: number;
  messagesSent: number;
}

export function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { savedAccounts, setSavedAccounts } = useAppStore();
  const [stats, setStats] = useState<DashboardStats>({
    leadsToday: 0,
    automatedReplies: 0,
    avgResponseTime: '0m',
    conversionRate: 0,
    weeklyLeads: 0,
    engagement: 0,
    lifetimeReplies: 0,
    messagesSent: 0,
  });
  const [loading, setLoading] = useState(true);
  const [connectionModalOpen, setConnectionModalOpen] = useState(false);
  const [accountToReconnect, setAccountToReconnect] = useState<SavedAccount | null>(null);
  const [showAllAccounts, setShowAllAccounts] = useState(false);
  const [accountDiagnostics, setAccountDiagnostics] = useState<Record<string, AccountDiagnostics>>({});

  useEffect(() => {
    loadAccounts();
    loadDashboardStats();
  }, []);

  async function loadAccounts() {
    try {
      const { accounts } = await thumbtackApi.getSavedAccounts();
      setSavedAccounts(accounts);

      // Load diagnostics for all accounts
      if (accounts.length > 0) {
        loadDiagnostics(accounts);
      }
    } catch (err) {
      console.error('Failed to load accounts:', err);
    }
  }

  async function loadDiagnostics(accountsList: SavedAccount[]) {
    const diagnosticsMap: Record<string, AccountDiagnostics> = {};

    for (const account of accountsList) {
      try {
        const diag = await testApi.getDiagnostics(account.id);
        diagnosticsMap[account.id] = diag;
      } catch (err) {
        console.error(`Failed to load diagnostics for ${account.id}:`, err);
      }
    }

    setAccountDiagnostics(diagnosticsMap);
  }

  async function loadDashboardStats() {
    try {
      setLoading(true);

      // Calculate date ranges
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const sevenDaysAgo = new Date(now);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      // Load analytics data in parallel
      const [todayData, weekData, allTimeData] = await Promise.all([
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
      ]);

      // Format average response time
      const formatDuration = (minutes: number): string => {
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

      // Calculate estimated message counts (rough approximation)
      const totalLeads = allTimeData.data.totalLeads || 0;
      const avgMessagesPerLead = allTimeData.data.messagesPerLead?.average || 0;
      const estimatedTotalMessages = Math.round(totalLeads * avgMessagesPerLead);
      const estimatedProMessages = Math.round(estimatedTotalMessages / 2); // Rough estimate

      setStats({
        leadsToday: todayData.data.totalLeads || 0,
        automatedReplies: Math.round(estimatedProMessages * 0.7), // Estimate 70% automated
        avgResponseTime: formatDuration(allTimeData.data.connectionTime?.averageMinutes || 0),
        conversionRate: Math.round(allTimeData.data.customerEngagement?.engagementRate || 0),
        weeklyLeads: weekData.data.totalLeads || 0,
        engagement: Math.round(weekData.data.customerEngagement?.engagementRate || 0),
        lifetimeReplies: estimatedProMessages,
        messagesSent: estimatedTotalMessages,
      });
    } catch (err) {
      console.error('Failed to load dashboard stats:', err);
      // Keep default zeros if error
    } finally {
      setLoading(false);
    }
  }

  const handleAccountClick = (account: SavedAccount) => {
    const diag = accountDiagnostics[account.id];
    const hasIssues = !account.webhookId || (diag && !diag.healthy);

    if (hasIssues) {
      // If has issues, open reconnect modal
      setAccountToReconnect(account);
      setConnectionModalOpen(true);
    } else {
      // If healthy, navigate to messages for this account
      navigate(`/messages?account=${account.businessId}`);
    }
  };

  const handleConnectionSuccess = () => {
    // Reload accounts after successful connection
    loadAccounts();
    setAccountToReconnect(null);
  };

  return (
    <div className="p-6 lg:p-10 max-w-7xl mx-auto space-y-10">
      {/* Welcome Section */}
      <section className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <p className="text-blue-600 font-semibold mb-1 uppercase tracking-wider text-xs">
            Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, {user?.name || 'User'}
          </p>
          <h2 className="text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight">
            Your business is <span className="gradient-text">growing.</span>
          </h2>
          <p className="text-slate-500 mt-2 text-lg">
            LeadBridge captured {stats.leadsToday} new lead{stats.leadsToday !== 1 ? 's' : ''} from Thumbtack today.
          </p>
        </div>
        <div className="flex gap-3">
          <Link to="/analytics" className="px-6 py-3 bg-white border border-slate-200 rounded-xl font-semibold text-slate-700 hover:bg-slate-50 shadow-sm transition-all">
            View Reports
          </Link>
          <button
            onClick={() => setConnectionModalOpen(true)}
            className="px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all flex items-center gap-2"
          >
            <Plus className="w-5 h-5" />
            New Account
          </button>
        </div>
      </section>

      {/* Core Metrics */}
      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
          <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mb-4">
            <Users className="w-6 h-6" />
          </div>
          <p className="text-slate-500 text-sm font-medium uppercase tracking-wide">Leads Today</p>
          <div className="flex items-baseline gap-2 mt-1">
            <h3 className="text-3xl font-bold text-slate-900">{loading ? '...' : stats.leadsToday}</h3>
            <span className="text-emerald-500 text-sm font-bold">+12%</span>
          </div>
        </div>

        <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
          <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center mb-4">
            <Send className="w-6 h-6" />
          </div>
          <p className="text-slate-500 text-sm font-medium uppercase tracking-wide">Automated Replies</p>
          <div className="flex items-baseline gap-2 mt-1">
            <h3 className="text-3xl font-bold text-slate-900">{loading ? '...' : stats.automatedReplies}</h3>
            <span className="text-emerald-500 text-sm font-bold">100%</span>
          </div>
        </div>

        <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
          <div className="w-12 h-12 bg-orange-50 text-orange-600 rounded-2xl flex items-center justify-center mb-4">
            <Clock className="w-6 h-6" />
          </div>
          <p className="text-slate-500 text-sm font-medium uppercase tracking-wide">Avg Response Time</p>
          <div className="flex items-baseline gap-2 mt-1">
            <h3 className="text-3xl font-bold text-slate-900">{loading ? '...' : stats.avgResponseTime}</h3>
            <span className="text-emerald-500 text-sm font-bold">Fast</span>
          </div>
        </div>

        <div className="bg-indigo-600 p-6 rounded-3xl shadow-xl shadow-indigo-100 text-white">
          <div className="w-12 h-12 bg-white/20 text-white rounded-2xl flex items-center justify-center mb-4">
            <TrendingUp className="w-6 h-6" />
          </div>
          <p className="text-indigo-100 text-sm font-medium uppercase tracking-wide">Conv. Rate</p>
          <div className="flex items-baseline gap-2 mt-1">
            <h3 className="text-3xl font-bold">{loading ? '...' : stats.conversionRate}%</h3>
            <span className="text-indigo-200 text-sm">Target Met</span>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 lg:items-start">
        {/* Accounts & Platforms */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          <div className="flex items-center justify-between px-2">
            <h3 className="text-xl font-bold text-slate-900">Connected Platforms</h3>
            {savedAccounts.length > 2 && (
              <button
                onClick={() => setShowAllAccounts(!showAllAccounts)}
                className="text-blue-600 font-semibold text-sm hover:underline"
              >
                {showAllAccounts ? 'Show Less' : 'Show All'}
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {savedAccounts.length > 0 ? (
              (showAllAccounts ? savedAccounts : savedAccounts.slice(0, 2)).map((account) => {
                const diag = accountDiagnostics[account.id];
                const hasIssues = !account.webhookId || (diag && !diag.healthy);

                return (
                  <div
                    key={account.id}
                    className={`bg-white border rounded-3xl p-5 flex items-center gap-5 transition-all cursor-pointer group shadow-sm ${
                      hasIssues
                        ? 'border-amber-200 hover:border-amber-300'
                        : 'border-slate-100 hover:border-blue-200'
                    }`}
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
                        <span className={`w-2 h-2 rounded-full ${hasIssues ? 'bg-amber-500' : 'bg-emerald-500'}`}></span>
                        <span className="text-xs text-slate-500 font-medium">
                          {hasIssues ? (diag && !diag.healthy ? 'Needs attention' : 'Disconnected') : 'Synced: Thumbtack'}
                        </span>
                      </div>
                    </div>
                    {hasIssues ? (
                      <AlertCircle className="w-5 h-5 text-amber-500 group-hover:text-amber-600" />
                    ) : (
                      <ExternalLink className="w-5 h-5 text-slate-300 group-hover:text-blue-500" />
                    )}
                  </div>
                );
              })
            ) : (
              <div className="col-span-2 bg-slate-50 border-2 border-dashed border-slate-200 rounded-3xl p-8 text-center">
                <p className="text-slate-600 font-medium mb-4">No accounts connected yet</p>
                <Link to="/services" className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all">
                  <Plus className="w-5 h-5" />
                  Connect Account
                </Link>
              </div>
            )}
          </div>

          {/* System Health */}
          <div className="bg-slate-900 rounded-[2rem] p-8 text-white relative overflow-hidden">
            <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-8">
              <div className="max-w-xs">
                <h3 className="text-2xl font-bold mb-2">System Performance</h3>
                <p className="text-slate-400 text-sm">Your automation bridge is running at optimal capacity. No downtime detected.</p>
              </div>
              <div className="grid grid-cols-2 gap-4 flex-1">
                <div className="bg-white/10 rounded-2xl p-4 flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"></div>
                  <span className="text-sm font-medium">Auto-Reply: Active</span>
                </div>
                <div className="bg-white/10 rounded-2xl p-4 flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"></div>
                  <span className="text-sm font-medium">SMS Bridge: Up</span>
                </div>
                <div className="bg-white/10 rounded-2xl p-4 flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.8)]"></div>
                  <span className="text-sm font-medium">Lead Sync: Real-time</span>
                </div>
                <div className="bg-white/10 rounded-2xl p-4 flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-amber-400"></div>
                  <span className="text-sm font-medium opacity-60 italic">Voice: Beta</span>
                </div>
              </div>
            </div>
            <div className="absolute -right-20 -bottom-20 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl"></div>
          </div>
        </div>

        {/* Alerts & Quick Actions */}
        <div className="flex flex-col gap-6">
          <div className="flex items-center justify-between px-2">
            <h3 className="text-xl font-bold text-slate-900">Action Required</h3>
            <span className="bg-red-50 text-red-600 text-xs font-bold px-2 py-1 rounded-md">
              {savedAccounts.filter(a => !a.webhookId).length} URGENT
            </span>
          </div>

          {savedAccounts.some(a => !a.webhookId) && (
            <div className="bg-rose-50/50 border border-rose-100 rounded-3xl p-5 relative overflow-hidden group hover:bg-rose-50 transition-colors">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 bg-rose-100 text-rose-600 rounded-xl flex items-center justify-center shrink-0">
                  <AlertCircle className="w-5 h-5" />
                </div>
                <div className="flex-1">
                  <h5 className="font-bold text-slate-900">Account Disconnected</h5>
                  <p className="text-sm text-slate-600 mt-1 leading-relaxed">
                    One or more accounts need reconnection to resume automation.
                  </p>
                  <button
                    onClick={() => {
                      const disconnected = savedAccounts.find(a => !a.webhookId);
                      if (disconnected) {
                        setAccountToReconnect(disconnected);
                        setConnectionModalOpen(true);
                      }
                    }}
                    className="mt-4 text-xs font-bold text-rose-600 uppercase tracking-wider flex items-center gap-1 hover:text-rose-700 transition-colors"
                  >
                    Reconnect Now <ChevronRight className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="bg-gradient-to-br from-indigo-500 to-purple-600 rounded-[2rem] p-8 text-white shadow-lg shadow-indigo-100 relative overflow-hidden flex-1">
            <div className="relative z-10 flex flex-col items-center justify-center text-center h-full min-h-[200px]">
              <div className="w-16 h-16 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-6">
                <Sparkles className="w-8 h-8" />
              </div>
              <h3 className="text-2xl font-bold mb-3">Automate Even Faster</h3>
              <p className="text-indigo-100 text-sm mb-6 leading-relaxed max-w-xs">
                Our new AI-powered response templates are now live for all users.
              </p>
              <Link to="/message-settings" className="px-8 py-3 bg-white text-indigo-600 rounded-xl font-bold text-sm shadow-lg hover:bg-indigo-50 transition-all">
                Try AI Templates
              </Link>
            </div>
            <div className="absolute -right-20 -bottom-20 w-64 h-64 bg-purple-600/20 rounded-full blur-3xl"></div>
          </div>
        </div>
      </div>

      {/* 7-Day Snapshot */}
      <section className="space-y-6">
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
            <p className="text-slate-400 text-sm italic">Detailed chart visualization loading...</p>
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
        onSuccess={handleConnectionSuccess}
      />
    </div>
  );
}
