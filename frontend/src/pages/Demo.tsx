import { useState } from 'react';
import {
  Home, MessageSquare, BarChart3, Settings, Phone, Briefcase,
  CreditCard, LogOut, Menu, Bell, Zap, ChevronRight,
  Plus, Pencil, Trash2, Send, Check, AlertCircle,
  Smartphone, Sparkles, Users, Clock, TrendingUp, Workflow,
  LayoutGrid, Search, Info
} from 'lucide-react';
import { NavLink, Outlet, useOutletContext, Link as RouterLink } from 'react-router-dom';

// ─── Types ────────────────────────────────────────────────────

export interface DemoContext {
  accounts: typeof MOCK_ACCOUNTS;
  selectedAccountId: string | null;
  setSelectedAccountId: (id: string | null) => void;
  selectedAccount: typeof MOCK_ACCOUNTS[0] | undefined;
}

export function useDemoContext() {
  return useOutletContext<DemoContext>();
}

// ─── Mock Data ────────────────────────────────────────────────

const MOCK_ACCOUNTS = [
  {
    id: 'demo-1',
    businessName: 'ABC Cleaning Services',
    businessId: 'biz_abc123',
    imageUrl: null as string | null,
    webhookId: 'wh_demo_123',
    emailHint: 'contact@abccleaning.com',
  },
  {
    id: 'demo-2',
    businessName: 'XYZ Home Repairs',
    businessId: 'biz_xyz456',
    imageUrl: null as string | null,
    webhookId: 'wh_demo_456',
    emailHint: 'info@xyzhome.com',
  },
];

const MOCK_TEMPLATES = [
  { id: 't1', name: 'Auto Reply - First Contact', content: 'Hi {{lead.name}}, thanks for reaching out! I\'d love to help with your {{lead.service}} needs in {{lead.location}}. When works best for you?', isDefault: true, usageCount: 47 },
  { id: 't2', name: 'Follow-Up Reminder', content: 'Hi {{lead.name}}, just following up on your {{lead.service}} request. Are you still looking for help? I\'m available this week!', isDefault: false, usageCount: 23 },
  { id: 't3', name: 'Lead Alert Template', content: 'New lead: {{lead.name}}\nPhone: {{lead.phone}}\nService: {{lead.service}}\nLocation: {{lead.location}}', isDefault: false, usageCount: 89 },
];

const MOCK_LEADS = [
  { id: 'l1', name: 'Sarah Johnson', category: 'House Cleaning', status: 'active', phone: '(813) 555-0142', location: 'Tampa, FL 33601', budget: '$150-200', time: '2m ago', snippet: 'I need a deep clean for my 3-bedroom house...', account: 'ABC Cleaning Services', messages: [
    { id: 'm1', sender: 'customer', text: 'Hi, I need a deep clean for my 3-bedroom house. Are you available this weekend?', time: '10:32 AM', channel: 'platform' },
    { id: 'm2', sender: 'pro', text: 'Hi Sarah, thanks for reaching out! I\'d love to help with your house cleaning needs. This weekend works great for me!', time: '10:34 AM', channel: 'platform' },
    { id: 'm3', sender: 'customer', text: 'Perfect! Can you come Saturday morning around 9am?', time: '10:45 AM', channel: 'platform' },
  ]},
  { id: 'l2', name: 'Mike Chen', category: 'Office Cleaning', status: 'active', phone: '(813) 555-0198', location: 'Tampa, FL 33602', budget: '$300-400', time: '1h ago', snippet: 'Looking for weekly office cleaning service...', account: 'ABC Cleaning Services', messages: [
    { id: 'm4', sender: 'customer', text: 'Looking for weekly office cleaning service for a 2000 sq ft office.', time: '9:15 AM', channel: 'platform' },
  ]},
  { id: 'l3', name: 'Emily Davis', category: 'Plumbing Repair', status: 'new', phone: '(727) 555-0167', location: 'St. Petersburg, FL 33701', budget: '$100-150', time: '3h ago', snippet: 'My kitchen faucet is leaking and needs repair...', account: 'XYZ Home Repairs', messages: [
    { id: 'm5', sender: 'customer', text: 'My kitchen faucet is leaking and needs repair. Can you help?', time: '7:30 AM', channel: 'platform' },
    { id: 'm6', sender: 'pro', text: 'Hi Emily! Yes, I can definitely help with that. Can you send me a photo of the faucet?', time: '7:32 AM', channel: 'sms' },
  ]},
];

const VARIABLES = [
  { key: '{{lead.name}}', desc: 'Customer\'s full name' },
  { key: '{{lead.phone}}', desc: 'Customer\'s phone number' },
  { key: '{{lead.service}}', desc: 'Service category requested' },
  { key: '{{lead.location}}', desc: 'City/area' },
  { key: '{{lead.budget}}', desc: 'Customer\'s budget range' },
  { key: '{{business.name}}', desc: 'Your business name' },
];

const NAV_ITEMS: { icon: React.ReactNode; label: string; path: string }[] = [
  { icon: <LayoutGrid size={20} />, label: 'Dashboard', path: '/demo/overview' },
  { icon: <MessageSquare size={20} />, label: 'Conversations', path: '/demo/leads' },
  { icon: <Workflow size={20} />, label: 'Automations', path: '/demo/automation' },
  { icon: <Users size={20} />, label: 'Lead Pipeline', path: '/demo/templates' },
  { icon: <BarChart3 size={20} />, label: 'Analytics', path: '/demo/insights' },
  { icon: <Phone size={20} />, label: 'Business Line', path: '/demo/phone' },
  { icon: <CreditCard size={20} />, label: 'Plans', path: '/demo/pricing' },
];

// ─── Toggle Component ─────────────────────────────────────────

function Toggle({ checked, onChange, disabled = false }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <label className="inline-flex items-center cursor-pointer">
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} className="sr-only peer" />
      <div className="relative w-14 h-7 bg-slate-200 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-0.5 after:start-[4px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-blue-600 peer-disabled:opacity-50"></div>
    </label>
  );
}

// ─── Demo Layout ──────────────────────────────────────────────

export function DemoLayout() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(MOCK_ACCOUNTS[0].id);

  const selectedAccount = MOCK_ACCOUNTS.find(a => a.id === selectedAccountId);

  const context: DemoContext = {
    accounts: MOCK_ACCOUNTS,
    selectedAccountId,
    setSelectedAccountId,
    selectedAccount,
  };

  return (
    <div className="flex min-h-screen">
      {/* Mobile Navigation Overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 lg:hidden" onClick={() => setMobileMenuOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-72 bg-white border-r border-slate-100 transform transition-transform duration-300 ease-in-out ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}>
        <div className="flex flex-col h-full p-6">
          {/* Brand */}
          <div className="flex items-center gap-3 mb-10 px-2">
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-blue-200">
              <Zap className="w-6 h-6" />
            </div>
            <span className="text-xl font-bold tracking-tight">LeadBridge</span>
          </div>

          {/* Navigation Links */}
          <nav className="flex-1 space-y-1 sidebar-scroll overflow-y-auto">
            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-4 px-2">Main Menu</div>
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) => `flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${isActive ? 'nav-item-active' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}
                onClick={() => setMobileMenuOpen(false)}
              >
                {item.icon}
                <span>{item.label}</span>
              </NavLink>
            ))}

            <div className="pt-8 mb-4 px-2 text-[11px] font-bold text-slate-400 uppercase tracking-widest">Configuration</div>
            <NavLink
              to="/demo/settings"
              className={({ isActive }) => `flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${isActive ? 'nav-item-active' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}
              onClick={() => setMobileMenuOpen(false)}
            >
              <Settings size={20} />
              <span>Account Settings</span>
            </NavLink>
          </nav>

          {/* Profile Footer */}
          <div className="mt-auto pt-6 border-t border-slate-100">
            <div className="flex items-center gap-4 px-2">
              <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-blue-100 to-indigo-100 flex items-center justify-center text-blue-700 font-bold border-2 border-white shadow-sm">
                DU
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-900 truncate">Demo User</p>
                <p className="text-xs text-slate-500 truncate">Pro Plan • Active</p>
              </div>
              <RouterLink to="/login" className="text-slate-400 hover:text-red-500 transition-colors" title="Exit Demo">
                <LogOut className="w-5 h-5" />
              </RouterLink>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 lg:ml-72 min-h-screen">
        {/* Top Navbar */}
        <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-slate-100 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="lg:hidden p-2 text-slate-600">
                <Menu className="w-6 h-6" />
              </button>
              <h1 className="text-xl font-bold text-slate-900 lg:block hidden">Overview</h1>
            </div>
            <div className="flex items-center gap-3">
              <div className="hidden md:flex items-center bg-amber-50 text-amber-700 px-4 py-1.5 rounded-full text-sm font-medium border border-amber-100">
                <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse mr-2"></span>
                Demo Mode Active
              </div>
              <button className="relative p-2 text-slate-400 hover:text-slate-600 transition-colors">
                <Bell className="w-6 h-6" />
                <span className="absolute top-2 right-2 w-2 h-2 bg-red-500 rounded-full border-2 border-white"></span>
              </button>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <Outlet context={context} />
      </main>
    </div>
  );
}

// ─── Overview Page ────────────────────────────────────────────

export function DemoOverviewView() {
  return (
    <div className="p-6 lg:p-10 max-w-7xl mx-auto space-y-10">
      {/* Welcome Section */}
      <section className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <p className="text-blue-600 font-semibold mb-1 uppercase tracking-wider text-xs">Good morning, Demo User</p>
          <h2 className="text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight">Your business is <span className="gradient-text">growing.</span></h2>
          <p className="text-slate-500 mt-2 text-lg">LeadBridge captured 7 new leads from Thumbtack and Yelp today.</p>
        </div>
        <div className="flex gap-3">
          <button className="px-6 py-3 bg-white border border-slate-200 rounded-xl font-semibold text-slate-700 hover:bg-slate-50 shadow-sm transition-all">
            View Reports
          </button>
          <button className="px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all flex items-center gap-2">
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
            <h3 className="text-3xl font-bold text-slate-900">7</h3>
            <span className="text-emerald-500 text-sm font-bold">+12%</span>
          </div>
        </div>
        <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
          <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center mb-4">
            <Send className="w-6 h-6" />
          </div>
          <p className="text-slate-500 text-sm font-medium uppercase tracking-wide">Automated Replies</p>
          <div className="flex items-baseline gap-2 mt-1">
            <h3 className="text-3xl font-bold text-slate-900">12</h3>
            <span className="text-emerald-500 text-sm font-bold">100%</span>
          </div>
        </div>
        <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
          <div className="w-12 h-12 bg-orange-50 text-orange-600 rounded-2xl flex items-center justify-center mb-4">
            <Clock className="w-6 h-6" />
          </div>
          <p className="text-slate-500 text-sm font-medium uppercase tracking-wide">Avg Response Time</p>
          <div className="flex items-baseline gap-2 mt-1">
            <h3 className="text-3xl font-bold text-slate-900">2.2m</h3>
            <span className="text-emerald-500 text-sm font-bold">Fast</span>
          </div>
        </div>
        <div className="bg-indigo-600 p-6 rounded-3xl shadow-xl shadow-indigo-100 text-white">
          <div className="w-12 h-12 bg-white/20 text-white rounded-2xl flex items-center justify-center mb-4">
            <TrendingUp className="w-6 h-6" />
          </div>
          <p className="text-indigo-100 text-sm font-medium uppercase tracking-wide">Conv. Rate</p>
          <div className="flex items-baseline gap-2 mt-1">
            <h3 className="text-3xl font-bold">67%</h3>
            <span className="text-indigo-200 text-sm">Target Met</span>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Accounts & Platforms */}
        <div className="lg:col-span-2 space-y-6">
          <div className="flex items-center justify-between px-2">
            <h3 className="text-xl font-bold text-slate-900">Connected Platforms</h3>
            <button className="text-blue-600 font-semibold text-sm hover:underline">Manage All</button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white border border-slate-100 rounded-3xl p-5 flex items-center gap-5 hover:border-blue-200 transition-all cursor-pointer group shadow-sm">
              <div className="w-14 h-14 bg-slate-50 rounded-2xl flex items-center justify-center text-slate-400 group-hover:bg-blue-50 group-hover:text-blue-500 transition-colors">
                <Home className="w-7 h-7" />
              </div>
              <div className="flex-1">
                <h4 className="font-bold text-slate-900">ABC Cleaning</h4>
                <div className="flex items-center gap-2 mt-1">
                  <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                  <span className="text-xs text-slate-500 font-medium">Synced: Thumbtack</span>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-slate-300 group-hover:text-blue-500" />
            </div>

            <div className="bg-white border border-slate-100 rounded-3xl p-5 flex items-center gap-5 hover:border-blue-200 transition-all cursor-pointer group shadow-sm">
              <div className="w-14 h-14 bg-slate-50 rounded-2xl flex items-center justify-center text-slate-400 group-hover:bg-blue-50 group-hover:text-blue-500 transition-colors">
                <Briefcase className="w-7 h-7" />
              </div>
              <div className="flex-1">
                <h4 className="font-bold text-slate-900">XYZ Home Repairs</h4>
                <div className="flex items-center gap-2 mt-1">
                  <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                  <span className="text-xs text-slate-500 font-medium">Synced: Yelp</span>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-slate-300 group-hover:text-blue-500" />
            </div>
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

        {/* Alerts */}
        <div className="space-y-6">
          <div className="flex items-center justify-between px-2">
            <h3 className="text-xl font-bold text-slate-900">Action Required</h3>
            <span className="bg-red-50 text-red-600 text-xs font-bold px-2 py-1 rounded-md">4 URGENT</span>
          </div>

          <div className="space-y-4">
            <div className="bg-rose-50/50 border border-rose-100 rounded-3xl p-5 relative overflow-hidden group hover:bg-rose-50 transition-colors">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 bg-rose-100 text-rose-600 rounded-xl flex items-center justify-center shrink-0">
                  <AlertCircle className="w-5 h-5" />
                </div>
                <div className="flex-1">
                  <h5 className="font-bold text-slate-900">3 Leads Waiting</h5>
                  <p className="text-sm text-slate-600 mt-1 leading-relaxed">Highly-rated projects from Thumbtack require manual intervention.</p>
                  <button className="mt-4 text-xs font-bold text-rose-600 uppercase tracking-wider flex items-center gap-1">
                    Reply Now <ChevronRight className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>

            <div className="bg-amber-50/50 border border-amber-100 rounded-3xl p-5 relative overflow-hidden group hover:bg-amber-50 transition-colors">
              <div className="flex items-start gap-4">
                <div className="w-10 h-10 bg-amber-100 text-amber-600 rounded-xl flex items-center justify-center shrink-0">
                  <Smartphone className="w-5 h-5" />
                </div>
                <div className="flex-1">
                  <h5 className="font-bold text-slate-900">SMS Configuration</h5>
                  <p className="text-sm text-slate-600 mt-1 leading-relaxed">One message failed to deliver. Check your phone settings.</p>
                </div>
              </div>
            </div>

            <div className="bg-gradient-to-br from-indigo-500 to-purple-600 rounded-[2rem] p-6 text-white text-center shadow-lg shadow-indigo-100">
              <div className="w-12 h-12 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-4">
                <Sparkles className="w-6 h-6" />
              </div>
              <h4 className="font-bold text-lg mb-2">Automate Even Faster</h4>
              <p className="text-indigo-100 text-sm mb-5 leading-relaxed">Our new AI-powered response templates are now live for all users.</p>
              <button className="w-full py-3 bg-white text-indigo-600 rounded-xl font-bold text-sm shadow-sm hover:bg-indigo-50 transition-colors">
                Try AI Templates
              </button>
            </div>
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
              <p className="text-3xl font-extrabold text-slate-900">34</p>
            </div>
            <div className="w-px h-12 bg-slate-100 hidden md:block"></div>
            <div className="text-center">
              <p className="text-slate-400 text-sm font-medium mb-1">Engagement</p>
              <p className="text-3xl font-extrabold text-slate-900">67%</p>
            </div>
            <div className="w-px h-12 bg-slate-100 hidden md:block"></div>
            <div className="text-center">
              <p className="text-slate-400 text-sm font-medium mb-1">Lifetime Replies</p>
              <p className="text-3xl font-extrabold text-slate-900">142</p>
            </div>
            <div className="w-px h-12 bg-slate-100 hidden md:block"></div>
            <div className="text-center">
              <p className="text-slate-400 text-sm font-medium mb-1">Messages Sent</p>
              <p className="text-3xl font-extrabold text-slate-900">89</p>
            </div>
          </div>
          <div className="bg-slate-50/50 p-6 flex items-center justify-center">
            <p className="text-slate-400 text-sm italic">Detailed chart visualization loading...</p>
          </div>
        </div>
      </section>
    </div>
  );
}

// ─── Automation Page ──────────────────────────────────────────

export function DemoAutomationView() {
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(true);
  const [smsAlertsEnabled, setSmsAlertsEnabled] = useState(true);

  return (
    <div className="p-6 lg:p-10 max-w-5xl mx-auto space-y-8">
      {/* Account Selector */}
      <div className="bg-blue-50 border border-blue-100 rounded-3xl p-6">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 bg-blue-600 text-white rounded-2xl flex items-center justify-center shrink-0">
            <Info className="w-6 h-6" />
          </div>
          <div className="flex-1">
            <h3 className="font-bold text-slate-900 mb-2">Select Active Business Account</h3>
            <p className="text-sm text-slate-600 mb-4">Automation settings apply per business. Choose which account to configure below.</p>
            <select className="w-full max-w-md px-4 py-3 rounded-xl border border-slate-200 bg-white font-medium">
              <option>ABC Cleaning Services</option>
              <option>XYZ Home Repairs</option>
            </select>
          </div>
        </div>
      </div>

      {/* Auto Reply */}
      <div className="bg-white border border-slate-100 rounded-3xl p-8 shadow-sm">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-xl font-bold text-slate-900">Auto Reply & Follow-Ups</h3>
            <p className="text-slate-500 text-sm mt-1">Respond instantly when new leads arrive</p>
          </div>
          <Toggle checked={autoReplyEnabled} onChange={() => setAutoReplyEnabled(!autoReplyEnabled)} />
        </div>

        {autoReplyEnabled && (
          <div className="space-y-6 pt-6 border-t border-slate-100">
            <div className="bg-gradient-to-r from-purple-50 to-blue-50 border border-purple-100 rounded-2xl p-5">
              <div className="flex items-center gap-3 mb-2">
                <Sparkles className="w-5 h-5 text-purple-600" />
                <h4 className="font-bold text-slate-900">AI Optimization</h4>
                <span className="ml-auto bg-purple-100 text-purple-700 text-xs font-bold px-2 py-1 rounded-full">COMING SOON</span>
              </div>
              <p className="text-sm text-slate-600">LeadBridge AI will analyze your leads and customize replies to increase response rates.</p>
            </div>

            <div>
              <label className="block text-sm font-bold text-slate-900 mb-2">First Message Template</label>
              <select className="w-full px-4 py-3 rounded-xl border border-slate-200 bg-white">
                <option>Auto Reply - First Contact (47 uses)</option>
                <option>Follow-Up Reminder (23 uses)</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Lead Alerts */}
      <div className="bg-white border border-slate-100 rounded-3xl p-8 shadow-sm">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-xl font-bold text-slate-900">Lead Alerts via SMS</h3>
            <p className="text-slate-500 text-sm mt-1">Get notified when high-value leads arrive</p>
          </div>
          <Toggle checked={smsAlertsEnabled} onChange={() => setSmsAlertsEnabled(!smsAlertsEnabled)} />
        </div>

        {smsAlertsEnabled && (
          <div className="pt-6 border-t border-slate-100">
            <p className="text-sm text-slate-600">Alerts will be sent to: <span className="font-semibold text-slate-900">(555) 123-4567</span></p>
          </div>
        )}
      </div>

      {/* Coming Soon Features */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-slate-50 border-2 border-dashed border-slate-200 rounded-3xl p-6 opacity-60">
          <h3 className="font-bold text-slate-900 mb-2">Customer Texting</h3>
          <p className="text-sm text-slate-600 mb-4">Two-way SMS conversations from your business number</p>
          <span className="inline-block bg-slate-200 text-slate-600 text-xs font-bold px-3 py-1 rounded-full">COMING SOON</span>
        </div>

        <div className="bg-slate-50 border-2 border-dashed border-slate-200 rounded-3xl p-6 opacity-60">
          <h3 className="font-bold text-slate-900 mb-2">Call Connect</h3>
          <p className="text-sm text-slate-600 mb-4">Forward inbound calls to your personal phone</p>
          <span className="inline-block bg-slate-200 text-slate-600 text-xs font-bold px-3 py-1 rounded-full">COMING SOON</span>
        </div>
      </div>
    </div>
  );
}

// ─── Templates Page ───────────────────────────────────────────

export function DemoTemplatesView() {
  return (
    <div className="p-6 lg:p-10 max-w-5xl mx-auto space-y-10">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight mb-2">Message <span className="gradient-text">Templates</span></h2>
          <p className="text-slate-500 text-lg">Create reusable messages with dynamic variables</p>
        </div>
        <button className="px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all flex items-center gap-2">
          <Plus className="w-5 h-5" />
          Create New
        </button>
      </div>

      {/* Templates List */}
      <div className="space-y-4">
        {MOCK_TEMPLATES.map((template) => (
          <div key={template.id} className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm hover:shadow-md transition-all">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3">
                <h3 className="font-bold text-slate-900">{template.name}</h3>
                {template.isDefault && (
                  <span className="bg-blue-50 text-blue-600 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-full">Default</span>
                )}
                <span className="text-slate-400 text-sm">{template.usageCount} uses</span>
              </div>
              <div className="flex gap-2">
                <button className="p-2 text-slate-400 hover:text-blue-600 transition-colors">
                  <Pencil className="w-4 h-4" />
                </button>
                <button className="p-2 text-slate-400 hover:text-red-600 transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
            <p className="text-slate-600 text-sm leading-relaxed">{template.content}</p>
          </div>
        ))}
      </div>

      {/* Variables Guide */}
      <div className="bg-slate-900 rounded-[2.5rem] p-8 text-white">
        <h3 className="text-2xl font-bold mb-2">Dynamic Variables</h3>
        <p className="text-slate-400 mb-6">Insert these codes into your templates—they'll auto-fill with real lead data.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {VARIABLES.map((v) => (
            <div key={v.key} className="bg-white/10 rounded-2xl p-4">
              <code className="text-blue-300 font-mono text-sm font-bold">{v.key}</code>
              <p className="text-slate-300 text-xs mt-1">{v.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Leads Page ───────────────────────────────────────────────

export function DemoLeadsView() {
  const [selectedLeadId, setSelectedLeadId] = useState(MOCK_LEADS[0].id);
  const selectedLead = MOCK_LEADS.find(l => l.id === selectedLeadId);

  return (
    <div className="flex-1 flex overflow-hidden h-[calc(100vh-73px)]">
      {/* Leads Sidebar */}
      <aside className="w-80 bg-white border-r border-slate-100 flex flex-col">
        <div className="p-4 border-b border-slate-100">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input type="text" placeholder="Search leads..." className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-200 text-sm" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {MOCK_LEADS.map((lead) => (
            <div
              key={lead.id}
              onClick={() => setSelectedLeadId(lead.id)}
              className={`p-4 border-b border-slate-50 cursor-pointer transition-all ${selectedLeadId === lead.id ? 'bg-blue-50 border-l-4 border-l-blue-600' : 'hover:bg-slate-50'}`}
            >
              <div className="flex items-start justify-between mb-1">
                <h4 className="font-bold text-slate-900">{lead.name}</h4>
                <span className="text-xs text-slate-400">{lead.time}</span>
              </div>
              <p className="text-sm text-slate-600 mb-2">{lead.category}</p>
              <p className="text-sm text-slate-500 truncate">{lead.snippet}</p>
            </div>
          ))}
        </div>
      </aside>

      {/* Chat Area */}
      <div className="flex-1 flex flex-col bg-slate-50">
        {selectedLead && (
          <>
            <div className="bg-white border-b border-slate-100 p-4 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-slate-900">{selectedLead.name}</h3>
                <p className="text-sm text-slate-500">{selectedLead.category} • {selectedLead.location}</p>
              </div>
              <div className="flex gap-2">
                <button className="px-4 py-2 bg-blue-600 text-white rounded-xl font-semibold text-sm hover:bg-blue-700 transition-all">
                  Reply
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {selectedLead.messages.map((msg) => (
                <div key={msg.id} className={`flex ${msg.sender === 'pro' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-md px-4 py-3 rounded-2xl ${msg.sender === 'pro' ? 'bg-blue-600 text-white' : 'bg-white border border-slate-100 text-slate-900'}`}>
                    <p className="text-sm">{msg.text}</p>
                    <p className={`text-xs mt-1 ${msg.sender === 'pro' ? 'text-blue-100' : 'text-slate-400'}`}>{msg.time}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="bg-white border-t border-slate-100 p-4">
              <div className="flex gap-2">
                <input type="text" placeholder="Type a message..." className="flex-1 px-4 py-3 rounded-xl border border-slate-200" />
                <button className="px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 transition-all">
                  <Send className="w-5 h-5" />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Phone Page ───────────────────────────────────────────────

export function DemoPhoneView() {
  return (
    <div className="p-6 lg:p-10 max-w-5xl mx-auto space-y-8">
      <div className="flex items-start gap-4">
        <div className="w-14 h-14 bg-green-50 text-green-600 rounded-2xl flex items-center justify-center shrink-0">
          <Phone className="w-7 h-7" />
        </div>
        <div>
          <h2 className="text-3xl font-extrabold text-slate-900 mb-2">Business <span className="gradient-text">Phone Line</span></h2>
          <p className="text-slate-500 text-lg">LeadBridge-managed numbers for SMS & voice</p>
        </div>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 flex items-start gap-3">
        <Info className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
        <p className="text-sm text-amber-900"><strong>Demo Mode:</strong> Phone numbers shown below are for demonstration purposes only. Upgrade to enable real SMS & calling.</p>
      </div>

      <div className="space-y-4">
        <h3 className="font-bold text-slate-900">Pool Numbers (2 Active)</h3>
        <div className="grid gap-4">
          <div className="bg-white border border-slate-100 rounded-3xl p-6 group hover:border-green-200 transition-all shadow-sm">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                <span className="text-xs font-bold text-emerald-600 uppercase tracking-wider">Active</span>
              </div>
              <span className="bg-slate-100 text-slate-600 text-xs font-bold px-2 py-1 rounded-md">Telnyx</span>
            </div>
            <h4 className="text-2xl font-bold text-slate-900 mb-2">(813) 555-0100</h4>
            <p className="text-sm text-slate-500">Tampa, FL • Assigned to ABC Cleaning</p>
          </div>

          <div className="bg-white border border-slate-100 rounded-3xl p-6 group hover:border-green-200 transition-all shadow-sm">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                <span className="text-xs font-bold text-emerald-600 uppercase tracking-wider">Active</span>
              </div>
              <span className="bg-slate-100 text-slate-600 text-xs font-bold px-2 py-1 rounded-md">Twilio</span>
            </div>
            <h4 className="text-2xl font-bold text-slate-900 mb-2">(727) 555-0200</h4>
            <p className="text-sm text-slate-500">St. Petersburg, FL • Assigned to XYZ Home</p>
          </div>
        </div>
      </div>

      <div className="bg-gradient-to-br from-blue-600 to-indigo-600 rounded-[2rem] p-8 text-white">
        <h3 className="text-2xl font-bold mb-2">Upgrade to Enable Voice</h3>
        <p className="text-blue-100 mb-6">Call Connect forwards customer calls to your personal phone. Available on Pro+ plans.</p>
        <button className="px-6 py-3 bg-white text-blue-600 rounded-xl font-bold shadow-sm hover:bg-blue-50 transition-colors">
          View Plans
        </button>
      </div>
    </div>
  );
}

// ─── Insights Page ────────────────────────────────────────────

export function DemoInsightsView() {
  return (
    <div className="p-6 lg:p-10 max-w-7xl mx-auto space-y-10">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <h2 className="text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight mb-2">Business <span className="gradient-text">Insights</span></h2>
          <p className="text-slate-500 text-lg">Performance metrics across all your accounts</p>
        </div>
        <div className="flex gap-3">
          <select className="px-4 py-2 rounded-xl border border-slate-200 bg-white text-sm font-medium">
            <option>All Accounts</option>
            <option>ABC Cleaning</option>
            <option>XYZ Home Repairs</option>
          </select>
          <select className="px-4 py-2 rounded-xl border border-slate-200 bg-white text-sm font-medium">
            <option>Last 30 Days</option>
            <option>Last 7 Days</option>
            <option>Last 90 Days</option>
          </select>
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
          <p className="text-slate-500 text-sm font-medium uppercase tracking-wide mb-1">Total Leads</p>
          <h3 className="text-3xl font-bold text-slate-900">34</h3>
        </div>
        <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
          <p className="text-slate-500 text-sm font-medium uppercase tracking-wide mb-1">Avg Connection</p>
          <h3 className="text-3xl font-bold text-slate-900">2.2m</h3>
        </div>
        <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
          <p className="text-slate-500 text-sm font-medium uppercase tracking-wide mb-1">Messages/Lead</p>
          <h3 className="text-3xl font-bold text-slate-900">4.2</h3>
        </div>
        <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
          <p className="text-slate-500 text-sm font-medium uppercase tracking-wide mb-1">Engagement</p>
          <h3 className="text-3xl font-bold text-slate-900">67%</h3>
        </div>
      </div>

      {/* Analytics Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-white border border-slate-100 rounded-3xl p-8 shadow-sm">
          <h3 className="font-bold text-slate-900 mb-6">Service Categories</h3>
          <div className="space-y-4">
            {[
              { name: 'House Cleaning', pct: 45, color: 'bg-blue-500' },
              { name: 'Plumbing', pct: 30, color: 'bg-emerald-500' },
              { name: 'Handyman', pct: 15, color: 'bg-orange-500' },
              { name: 'Other', pct: 10, color: 'bg-slate-300' },
            ].map((cat) => (
              <div key={cat.name}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-slate-700">{cat.name}</span>
                  <span className="text-sm font-bold text-slate-900">{cat.pct}%</span>
                </div>
                <div className="w-full bg-slate-100 rounded-full h-2">
                  <div className={`${cat.color} h-2 rounded-full transition-all`} style={{ width: `${cat.pct}%` }}></div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white border border-slate-100 rounded-3xl p-8 shadow-sm">
          <h3 className="font-bold text-slate-900 mb-6">Response Speed</h3>
          <div className="grid grid-cols-2 gap-4">
            {[
              { label: '< 5 min', count: 12, color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
              { label: '5-30 min', count: 8, color: 'bg-blue-50 text-blue-700 border-blue-200' },
              { label: '30min-1h', count: 4, color: 'bg-orange-50 text-orange-700 border-orange-200' },
              { label: '> 1 hour', count: 2, color: 'bg-slate-50 text-slate-700 border-slate-200' },
            ].map((bucket) => (
              <div key={bucket.label} className={`${bucket.color} border rounded-2xl p-4 text-center`}>
                <p className="text-2xl font-bold">{bucket.count}</p>
                <p className="text-xs font-medium mt-1">{bucket.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Locations */}
      <div className="bg-slate-900 rounded-[2.5rem] p-8 text-white">
        <h3 className="text-2xl font-bold mb-6">Top Service Locations</h3>
        <div className="space-y-4">
          {[
            { city: 'Tampa, FL', leads: 18 },
            { city: 'St. Petersburg, FL', leads: 12 },
            { city: 'Brandon, FL', leads: 8 },
            { city: 'Sarasota, FL', leads: 5 },
            { city: 'Clearwater, FL', leads: 3 },
          ].map((loc) => (
            <div key={loc.city}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">{loc.city}</span>
                <span className="text-sm font-bold">{loc.leads} leads</span>
              </div>
              <div className="w-full bg-white/10 rounded-full h-2">
                <div className="bg-white h-2 rounded-full" style={{ width: `${(loc.leads / 18) * 100}%` }}></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Pricing Page ─────────────────────────────────────────────

export function DemoPricingView() {
  return (
    <div className="p-6 lg:p-10 max-w-7xl mx-auto space-y-12">
      <div className="text-center max-w-2xl mx-auto">
        <h2 className="text-4xl lg:text-5xl font-extrabold text-slate-900 mb-4">Choose Your <span className="gradient-text">Plan</span></h2>
        <p className="text-slate-500 text-lg">Automate more, grow faster. All plans include unlimited leads & messages.</p>
      </div>

      {/* Pricing Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto">
        {/* Instant Reply */}
        <div className="bg-white border border-slate-200 rounded-[2rem] p-8 shadow-sm hover:shadow-lg transition-all">
          <h3 className="text-2xl font-bold text-slate-900 mb-2">Instant Reply</h3>
          <div className="mb-6">
            <span className="text-4xl font-extrabold text-slate-900">$29</span>
            <span className="text-slate-500">/month</span>
          </div>
          <ul className="space-y-3 mb-8">
            {['Auto-reply templates', 'SMS lead alerts', '1 business account', 'Email support'].map((feat) => (
              <li key={feat} className="flex items-start gap-2 text-sm text-slate-600">
                <Check className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
                <span>{feat}</span>
              </li>
            ))}
          </ul>
          <button className="w-full py-3 bg-slate-100 text-slate-700 rounded-xl font-bold hover:bg-slate-200 transition-all">
            Start Free Trial
          </button>
        </div>

        {/* Call Assist */}
        <div className="bg-white border-2 border-blue-500 rounded-[2rem] p-8 shadow-xl transform scale-105 relative">
          <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-xs font-bold px-4 py-1 rounded-full">
            CURRENT PLAN
          </div>
          <h3 className="text-2xl font-bold text-slate-900 mb-2">Call Assist</h3>
          <div className="mb-6">
            <span className="text-4xl font-extrabold text-slate-900">$79</span>
            <span className="text-slate-500">/month</span>
          </div>
          <ul className="space-y-3 mb-8">
            {['Everything in Instant Reply', 'Business phone number', 'Call forwarding', 'Up to 5 accounts', 'Priority support'].map((feat) => (
              <li key={feat} className="flex items-start gap-2 text-sm text-slate-600">
                <Check className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
                <span>{feat}</span>
              </li>
            ))}
          </ul>
          <button className="w-full py-3 bg-blue-600 text-white rounded-xl font-bold shadow-lg shadow-blue-200 cursor-not-allowed opacity-75">
            Current Plan
          </button>
        </div>

        {/* AI Conversations */}
        <div className="bg-slate-900 text-white rounded-[2rem] p-8 shadow-xl">
          <h3 className="text-2xl font-bold mb-2">AI Conversations</h3>
          <div className="mb-6">
            <span className="text-4xl font-extrabold">$149</span>
            <span className="text-slate-400">/month</span>
          </div>
          <ul className="space-y-3 mb-8">
            {['Everything in Call Assist', 'AI-powered responses', 'Unlimited accounts', 'Custom integrations', 'Dedicated success manager'].map((feat) => (
              <li key={feat} className="flex items-start gap-2 text-sm text-slate-300">
                <Check className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <span>{feat}</span>
              </li>
            ))}
          </ul>
          <button className="w-full py-3 bg-white text-slate-900 rounded-xl font-bold hover:bg-slate-100 transition-all">
            Upgrade Now
          </button>
        </div>
      </div>

      <div className="text-center pt-8">
        <p className="text-slate-500 text-sm">Need help choosing? <a href="#" className="text-blue-600 font-semibold hover:underline">Contact our team</a></p>
      </div>
    </div>
  );
}

// ─── Settings Page ────────────────────────────────────────────

export function DemoSettingsView() {
  return (
    <div className="p-6 lg:p-10 max-w-5xl mx-auto space-y-10">
      <div className="flex items-start gap-4">
        <div className="w-14 h-14 bg-slate-100 text-slate-600 rounded-2xl flex items-center justify-center shrink-0">
          <Settings className="w-7 h-7" />
        </div>
        <div>
          <h2 className="text-3xl font-extrabold text-slate-900 mb-2">Account <span className="gradient-text">Settings</span></h2>
          <p className="text-slate-500 text-lg">Manage your profile, connections, and subscription</p>
        </div>
      </div>

      {/* Business Profile */}
      <div className="bg-white border border-slate-100 rounded-3xl p-8 shadow-sm">
        <h3 className="font-bold text-slate-900 mb-6">Business Profile</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-slate-500 mb-1">Business Name</label>
            <p className="text-slate-900 font-semibold">ABC Cleaning Services</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-500 mb-1">Email</label>
            <p className="text-slate-900 font-semibold">contact@abccleaning.com</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-500 mb-1">Phone</label>
            <p className="text-slate-900 font-semibold">(813) 555-0142</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-500 mb-1">Timezone</label>
            <p className="text-slate-900 font-semibold">America/New_York (EST)</p>
          </div>
        </div>
      </div>

      {/* Marketplace Connections */}
      <div className="space-y-6">
        <h3 className="font-bold text-slate-900 px-2">Marketplace Connections</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white border border-slate-100 rounded-3xl p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h4 className="font-bold text-slate-900">Thumbtack</h4>
              <span className="bg-emerald-50 text-emerald-600 text-xs font-bold px-2 py-1 rounded-full">CONNECTED</span>
            </div>
            <p className="text-sm text-slate-500 mb-4">2 active accounts synced</p>
            <ul className="space-y-2">
              <li className="flex items-center gap-2 text-sm text-slate-600">
                <Check className="w-4 h-4 text-emerald-500" />
                <span>ABC Cleaning Services</span>
              </li>
              <li className="flex items-center gap-2 text-sm text-slate-600">
                <Check className="w-4 h-4 text-emerald-500" />
                <span>XYZ Home Repairs</span>
              </li>
            </ul>
          </div>

          <div className="bg-slate-50 border-2 border-dashed border-slate-200 rounded-3xl p-6 opacity-60">
            <div className="flex items-center justify-between mb-4">
              <h4 className="font-bold text-slate-900">Yelp</h4>
              <span className="bg-slate-200 text-slate-600 text-xs font-bold px-2 py-1 rounded-full">COMING SOON</span>
            </div>
            <p className="text-sm text-slate-500">Yelp integration arriving Q2 2024</p>
          </div>
        </div>
      </div>

      {/* Subscription */}
      <div className="bg-slate-900 rounded-[2rem] p-8 text-white">
        <h3 className="text-2xl font-bold mb-6">Subscription</h3>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8">
          <div>
            <p className="text-slate-400 text-sm mb-1">Current Plan</p>
            <h4 className="text-3xl font-bold">Call Assist</h4>
            <p className="text-slate-300 text-sm mt-2">$79/month • Renews Feb 15, 2024</p>
          </div>
          <div className="flex gap-3">
            <button className="px-6 py-3 bg-white/10 text-white rounded-xl font-semibold hover:bg-white/20 transition-all">
              Cancel Plan
            </button>
            <button className="px-6 py-3 bg-white text-slate-900 rounded-xl font-semibold hover:bg-slate-100 transition-all">
              Upgrade to AI
            </button>
          </div>
        </div>

        <div className="bg-white/10 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium">Connected Accounts</span>
            <span className="text-sm font-bold">2 of 5</span>
          </div>
          <div className="w-full bg-white/10 rounded-full h-2">
            <div className="bg-white h-2 rounded-full" style={{ width: '40%' }}></div>
          </div>
        </div>
      </div>
    </div>
  );
}
