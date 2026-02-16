import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Users, Send, Clock, TrendingUp, Plus, ChevronRight,
  Briefcase, Sparkles
} from 'lucide-react';
import { useAppStore } from '../store/appStore';
import { useAuthStore } from '../store/authStore';
import { thumbtackApi } from '../services/api';
import ConnectionModal from '../components/ConnectionModal';
import type { SavedAccount } from '../types';

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

  useEffect(() => {
    loadAccounts();
    // Simulate loading mock data
    setTimeout(() => {
      setStats({
        leadsToday: 12,
        automatedReplies: 18,
        avgResponseTime: '2m',
        conversionRate: 68,
        weeklyLeads: 84,
        engagement: 92,
        lifetimeReplies: 1247,
        messagesSent: 2891,
      });
      setLoading(false);
    }, 500);
  }, []);

  async function loadAccounts() {
    try {
      const { accounts } = await thumbtackApi.getSavedAccounts();
      setSavedAccounts(accounts);
    } catch (err) {
      console.error('Failed to load accounts:', err);
    }
  }

  const handleAccountClick = (account: SavedAccount) => {
    if (!account.webhookId) {
      // If disconnected, open reconnect modal
      setAccountToReconnect(account);
      setConnectionModalOpen(true);
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Accounts & Platforms */}
        <div className="lg:col-span-2 space-y-6">
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
              (showAllAccounts ? savedAccounts : savedAccounts.slice(0, 2)).map((account) => (
                <div
                  key={account.id}
                  className="bg-white border border-slate-100 rounded-3xl p-5 flex items-center gap-5 hover:border-blue-200 transition-all cursor-pointer group shadow-sm"
                  onClick={() => handleAccountClick(account)}
                >
                  <div className="w-14 h-14 bg-slate-50 rounded-2xl flex items-center justify-center text-slate-400 group-hover:bg-blue-50 group-hover:text-blue-500 transition-colors">
                    <Briefcase className="w-7 h-7" />
                  </div>
                  <div className="flex-1">
                    <h4 className="font-bold text-slate-900">{account.businessName}</h4>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`w-2 h-2 rounded-full ${account.webhookId ? 'bg-emerald-500' : 'bg-red-500'}`}></span>
                      <span className="text-xs text-slate-500 font-medium">
                        {account.webhookId ? 'Synced: Thumbtack' : 'Disconnected'}
                      </span>
                    </div>
                  </div>
                  <ChevronRight className="w-5 h-5 text-slate-300 group-hover:text-blue-500" />
                </div>
              ))
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

        {/* Quick Actions */}
        <div className="space-y-6">
          <div className="bg-gradient-to-br from-indigo-500 to-purple-600 rounded-[2rem] p-6 text-white text-center shadow-lg shadow-indigo-100">
            <div className="w-12 h-12 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <Sparkles className="w-6 h-6" />
            </div>
            <h4 className="font-bold text-lg mb-2">Automate Even Faster</h4>
            <p className="text-indigo-100 text-sm mb-5 leading-relaxed">
              Our new AI-powered response templates are now live for all users.
            </p>
            <Link to="/message-settings" className="w-full inline-block py-3 bg-white text-indigo-600 rounded-xl font-bold text-sm shadow-sm hover:bg-indigo-50 transition-colors">
              Try AI Templates
            </Link>
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
