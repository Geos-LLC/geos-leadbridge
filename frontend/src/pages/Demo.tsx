import { useState } from 'react';
import {
  Home, MessageSquare, BarChart3, Settings, Phone, Briefcase,
  CreditCard, LogOut, Menu, X, Building2, CheckCircle, AlertCircle,
  Users, TrendingUp, Clock, Zap, Bell, PhoneCall, Link2,
  ChevronDown, ChevronUp, Plus, Pencil, Trash2, Info,
  Send, MapPin, Calendar, DollarSign, Tag, Search,
  Bot, Sparkles, ChevronRight, HelpCircle,
} from 'lucide-react';
import { Link as RouterLink, NavLink, Outlet, useOutletContext } from 'react-router-dom';

// ─── Outlet context type ─────────────────────────────────
export interface DemoContext {
  accounts: typeof MOCK_ACCOUNTS;
  selectedAccountId: string | null;
  setSelectedAccountId: (id: string | null) => void;
  selectedAccount: typeof MOCK_ACCOUNTS[0] | undefined;
}

export function useDemoContext() {
  return useOutletContext<DemoContext>();
}

// ─── Mock Data ────────────────────────────────────────────

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
  { id: 'l4', name: 'James Wilson', category: 'Handyman', status: 'won', phone: '(813) 555-0234', location: 'Brandon, FL 33511', budget: '$200-300', time: '1d ago', snippet: 'Need help mounting a TV and installing shelves...', account: 'XYZ Home Repairs', messages: [
    { id: 'm7', sender: 'customer', text: 'Need help mounting a TV and installing shelves in my living room.', time: 'Yesterday', channel: 'platform' },
    { id: 'm8', sender: 'pro', text: 'I can help with both! I have availability this Thursday.', time: 'Yesterday', channel: 'platform' },
    { id: 'm9', sender: 'customer', text: 'Thursday works! Let\'s do it.', time: 'Yesterday', channel: 'platform' },
  ]},
  { id: 'l5', name: 'Lisa Martinez', category: 'Move-Out Cleaning', status: 'active', phone: '(941) 555-0312', location: 'Sarasota, FL 34231', budget: '$250-350', time: '2d ago', snippet: 'Moving out of my apartment, need full clean...', account: 'ABC Cleaning Services', messages: [] },
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
  { icon: <Home size={20} />, label: 'Overview', path: '/demo/overview' },
  { icon: <Briefcase size={20} />, label: 'Automation', path: '/demo/automation' },
  { icon: <Settings size={20} />, label: 'Templates', path: '/demo/templates' },
  { icon: <MessageSquare size={20} />, label: 'Lead Activity', path: '/demo/leads' },
  { icon: <Phone size={20} />, label: 'Business Line', path: '/demo/phone' },
  { icon: <BarChart3 size={20} />, label: 'Insights', path: '/demo/insights' },
  { icon: <CreditCard size={20} />, label: 'Plans', path: '/demo/pricing' },
];

// ─── Reusable Toggle Component ────────────────────────────
function Toggle({ checked, onChange, disabled = false }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <label className="inline-flex items-center cursor-pointer">
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} className="sr-only peer" />
      <div className="relative w-14 h-7 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:start-[4px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-blue-600 peer-disabled:opacity-50 peer-disabled:cursor-not-allowed"></div>
    </label>
  );
}

// ─── Main Demo Component ──────────────────────────────────

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
          <nav className="flex-1 space-y-1 overflow-y-auto">
            <div className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-4 px-2">Main Menu</div>
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) => `flex items-center gap-3 px-4 py-3 rounded-xl transition-all group ${isActive ? 'bg-blue-50 text-blue-600 font-semibold' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}
                onClick={() => setMobileMenuOpen(false)}
              >
                {item.icon}
                <span>{item.label}</span>
              </NavLink>
            ))}
            <div className="pt-8 mb-4 px-2 text-[11px] font-bold text-slate-400 uppercase tracking-widest">Account</div>
            <NavLink
              to="/demo/settings"
              className={({ isActive }) => `flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${isActive ? 'bg-blue-50 text-blue-600 font-semibold' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'}`}
              onClick={() => setMobileMenuOpen(false)}
            >
              <Settings size={20} />
              <span>Settings</span>
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

      {/* Mobile Navigation Overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 lg:hidden" onClick={() => setMobileMenuOpen(false)} />
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col lg:ml-72">
        {/* Top Navbar */}
        <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-slate-100 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="lg:hidden p-2 text-slate-600">
                {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
              </button>
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

        {/* Demo Banner */}
        <div className="bg-blue-50/50 border-b border-blue-100 px-6 py-3 flex items-center gap-3">
          <AlertCircle size={18} className="text-blue-600" />
          <span className="text-sm text-slate-700">
            This is a <strong>demo</strong> with mock data — no login required.
            <RouterLink to="/register" className="text-blue-600 font-semibold hover:underline ml-1">
              Create an account
            </RouterLink>
          </span>
        </div>

        {/* Page Content */}
        <main className="flex-1 overflow-auto">
          <Outlet context={context} />
        </main>
      </div>
    </div>
  );
}

// ─── Overview View ────────────────────────────────────────

export function DemoOverviewView() {
  const { accounts } = useDemoContext();

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

      {/* Core Metrics Grid */}
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
            {accounts.map((acc) => (
              <div key={acc.id} className="bg-white border border-slate-100 rounded-3xl p-5 flex items-center gap-5 hover:border-blue-200 transition-all cursor-pointer group shadow-sm">
                <div className="w-14 h-14 bg-slate-50 rounded-2xl flex items-center justify-center text-slate-400 group-hover:bg-blue-50 group-hover:text-blue-500 transition-colors">
                  <Building2 className="w-7 h-7" />
                </div>
                <div className="flex-1">
                  <h4 className="font-bold text-slate-900">{acc.businessName}</h4>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                    <span className="text-xs text-slate-500 font-medium">Synced: Thumbtack</span>
                  </div>
                </div>
                <ChevronRight className="w-5 h-5 text-slate-300 group-hover:text-blue-500" />
              </div>
            ))}
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

        {/* Alerts & Tasks */}
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
                  <Phone className="w-5 h-5" />
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

// ─── Automation View ──────────────────────────────────────

export function DemoAutomationView() {
  const { accounts, selectedAccountId, setSelectedAccountId } = useDemoContext();
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(true);
  const [leadAlertsEnabled, setLeadAlertsEnabled] = useState(true);
  const [expandedCard, setExpandedCard] = useState<string | null>('auto-reply');
  const [selectedTemplate, setSelectedTemplate] = useState('t1');

  return (
    <div className="p-6 lg:p-10 max-w-5xl mx-auto space-y-8">
      {/* Account Selector */}
      <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-1">Select Account</h2>
          <p className="text-slate-600 text-sm">Configure automation rules for your business profile.</p>
        </div>
        <div className="relative min-w-[240px]">
          <select
            value={selectedAccountId || ''}
            onChange={(e) => setSelectedAccountId(e.target.value || null)}
            className="w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl focus:ring-blue-500 focus:border-blue-500 block p-3 appearance-none font-semibold"
          >
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.businessName}</option>
            ))}
          </select>
          <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-slate-400">
            <ChevronDown className="w-4 h-4" />
          </div>
        </div>
      </div>

      {/* Automation Cards Grid */}
      <div className="grid grid-cols-1 gap-6">
        {/* Auto Reply & Follow-Ups */}
        <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden hover:border-blue-200 transition-all">
          <div className="p-6 md:p-8">
            <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
              <div className="flex gap-5">
                <div className="w-14 h-14 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center shrink-0">
                  <Zap className="w-7 h-7" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-slate-900">Auto Reply & Follow-Ups</h3>
                  <p className="text-slate-500 mt-1">Automatically respond to new leads as they arrive.</p>
                  <div className="flex items-center gap-2 mt-3">
                    <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                    <span className="text-xs font-bold text-slate-600 uppercase tracking-tight">Active: 1 message in sequence</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <Toggle checked={autoReplyEnabled} onChange={() => setAutoReplyEnabled(!autoReplyEnabled)} />
                <button className="p-2 text-slate-400" onClick={() => setExpandedCard(expandedCard === 'auto-reply' ? null : 'auto-reply')}>
                  {expandedCard === 'auto-reply' ? <ChevronUp className="w-6 h-6" /> : <ChevronDown className="w-6 h-6" />}
                </button>
              </div>
            </div>

            {expandedCard === 'auto-reply' && (
              <div className="mt-10 pt-8 border-t border-slate-50 space-y-8">
                {/* AI Optimization Card */}
                <div className="bg-gradient-to-r from-slate-900 to-slate-800 rounded-2xl p-6 text-white flex flex-col md:flex-row items-center justify-between gap-6 relative overflow-hidden">
                  <div className="flex items-center gap-4 relative z-10">
                    <div className="w-12 h-12 bg-white/10 rounded-xl flex items-center justify-center">
                      <Bot className="w-6 h-6 text-blue-400" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-bold">AI Optimization</h4>
                        <span className="px-2 py-0.5 bg-blue-500 text-[10px] font-bold rounded uppercase tracking-wider">Coming Soon</span>
                      </div>
                      <p className="text-slate-400 text-sm mt-1">AI decides timing and message variations to maximize response.</p>
                    </div>
                  </div>
                  <div className="opacity-50 cursor-not-allowed grayscale">
                    <div className="w-12 h-6 bg-white/20 rounded-full"></div>
                  </div>
                </div>

                {/* Step: First Message */}
                <div className="bg-slate-50 rounded-2xl p-6 border border-slate-100">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2 text-blue-600 font-bold">
                      <MessageSquare className="w-4 h-4" />
                      <span>First Message</span>
                    </div>
                    <span className="text-xs font-semibold text-slate-400 italic">Sent Immediately</span>
                  </div>

                  <div className="space-y-4">
                    <div className="relative">
                      <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Template Selection</label>
                      <select
                        value={selectedTemplate}
                        onChange={(e) => setSelectedTemplate(e.target.value)}
                        className="w-full bg-white border border-slate-200 rounded-xl p-3 text-sm font-medium"
                      >
                        {MOCK_TEMPLATES.filter(t => t.id !== 't3').map(t => (
                          <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="bg-white p-5 rounded-xl border border-dashed border-slate-200 text-slate-600 text-sm leading-relaxed relative group">
                      {MOCK_TEMPLATES.find(t => t.id === selectedTemplate)?.content}
                      <button className="absolute top-3 right-3 p-2 bg-slate-50 rounded-lg text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Pencil className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Lead Alerts */}
        <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden p-6 md:p-8 hover:border-blue-200 transition-all">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="flex gap-5">
              <div className="w-14 h-14 bg-amber-50 text-amber-600 rounded-2xl flex items-center justify-center shrink-0">
                <Bell className="w-7 h-7" />
              </div>
              <div>
                <h3 className="text-xl font-bold text-slate-900">Lead Alerts</h3>
                <p className="text-slate-500 mt-1">Get SMS notifications for every new inquiry.</p>
                <div className="mt-2 text-sm font-semibold text-slate-700">Destination: (813) 555-0100</div>
              </div>
            </div>
            <Toggle checked={leadAlertsEnabled} onChange={() => setLeadAlertsEnabled(!leadAlertsEnabled)} />
          </div>
        </div>

        {/* Customer Texting (Coming Soon) */}
        <div className="bg-slate-50/50 rounded-3xl border border-slate-100 p-6 md:p-8 opacity-75">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="flex gap-5">
              <div className="w-14 h-14 bg-white text-slate-400 rounded-2xl flex items-center justify-center shrink-0 border border-slate-100">
                <MessageSquare className="w-7 h-7" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-xl font-bold text-slate-400">Customer Texting</h3>
                  <span className="px-2 py-0.5 bg-slate-200 text-slate-500 text-[10px] font-bold rounded uppercase">Coming Soon</span>
                </div>
                <p className="text-slate-400 mt-1">Direct text routing to bypass platform apps.</p>
              </div>
            </div>
            <div className="w-14 h-7 bg-slate-100 rounded-full cursor-not-allowed"></div>
          </div>
        </div>

        {/* Call Connect (Coming Soon) */}
        <div className="bg-slate-50/50 rounded-3xl border border-slate-100 p-6 md:p-8 opacity-75">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div className="flex gap-5">
              <div className="w-14 h-14 bg-white text-slate-400 rounded-2xl flex items-center justify-center shrink-0 border border-slate-100">
                <PhoneCall className="w-7 h-7" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-xl font-bold text-slate-400">Instant Call Connect</h3>
                  <span className="px-2 py-0.5 bg-slate-200 text-slate-500 text-[10px] font-bold rounded uppercase">Coming Soon</span>
                </div>
                <p className="text-slate-400 mt-1">Receive a phone call to bridge you instantly to new leads.</p>
              </div>
            </div>
            <div className="w-14 h-7 bg-slate-100 rounded-full cursor-not-allowed"></div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Templates View ───────────────────────────────────────

export function DemoTemplatesView() {
  const [templates, setTemplates] = useState(MOCK_TEMPLATES);
  const [expandedTemplate, setExpandedTemplate] = useState<string | null>(null);

  const handleDelete = (id: string) => {
    setTemplates(prev => prev.filter(t => t.id !== id));
  };

  return (
    <div className="p-6 lg:p-10 max-w-5xl mx-auto space-y-10">
      {/* Welcome Section */}
      <section className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <p className="text-blue-600 font-semibold mb-1 uppercase tracking-wider text-xs">Messaging System</p>
          <h2 className="text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight">Message <span className="gradient-text">Templates.</span></h2>
          <p className="text-slate-500 mt-2 text-lg">Streamline your client communication with reusable response blocks.</p>
        </div>
        <div className="flex gap-3">
          <button className="px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all flex items-center gap-2">
            <Plus className="w-5 h-5" />
            Create New
          </button>
        </div>
      </section>

      {/* Templates List */}
      <section className="space-y-6">
        <div className="flex items-center justify-between px-2">
          <h3 className="text-xl font-bold text-slate-900">Your Library</h3>
          <span className="text-slate-400 text-sm font-medium">{templates.length} Templates saved</span>
        </div>

        <div className="grid gap-4">
          {templates.map(template => (
            <div key={template.id} className="bg-white border border-slate-100 rounded-[2rem] p-6 hover:border-blue-200 transition-all shadow-sm group">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center shrink-0">
                    <MessageSquare className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="flex items-center gap-3">
                      <h4 className="font-bold text-slate-900 text-lg">{template.name}</h4>
                      {template.isDefault && (
                        <span className="bg-blue-100 text-blue-700 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">Default</span>
                      )}
                    </div>
                    <p className="text-sm text-slate-500 mt-0.5">Used {template.usageCount} times</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button className="p-2.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-xl transition-all">
                    <Pencil className="w-5 h-5" />
                  </button>
                  <button className="p-2.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-all" onClick={() => handleDelete(template.id)}>
                    <Trash2 className="w-5 h-5" />
                  </button>
                  <button className="p-2.5 text-slate-300" onClick={() => setExpandedTemplate(expandedTemplate === template.id ? null : template.id)}>
                    {expandedTemplate === template.id ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                  </button>
                </div>
              </div>
              {expandedTemplate === template.id && (
                <div className="mt-4 p-4 bg-slate-50 rounded-xl text-sm text-slate-600 leading-relaxed whitespace-pre-wrap">
                  {template.content}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Variables Guide */}
      <section className="bg-slate-900 rounded-[2.5rem] p-8 text-white relative overflow-hidden">
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-blue-500/20 text-blue-400 rounded-xl flex items-center justify-center">
              <Info className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-xl font-bold">Dynamic Variables</h3>
              <p className="text-slate-400 text-sm mt-1">Personalize your messages automatically using these tags.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {VARIABLES.map(v => (
              <div key={v.key} className="bg-white/5 border border-white/10 rounded-2xl p-4 flex items-center gap-3 group hover:bg-white/10 transition-colors">
                <code className="text-blue-400 bg-blue-400/10 px-2 py-1 rounded text-xs font-mono font-bold">{v.key}</code>
                <span className="text-xs text-slate-300">{v.desc}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="absolute -right-16 -bottom-16 w-64 h-64 bg-blue-600/10 rounded-full blur-3xl"></div>
      </section>
    </div>
  );
}

// ─── Leads View ───────────────────────────────────────────

export function DemoLeadsView() {
  const { accounts, selectedAccountId, setSelectedAccountId } = useDemoContext();
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>('l1');
  const [searchQuery, setSearchQuery] = useState('');
  const [messageText, setMessageText] = useState('');
  const [channelFilter, setChannelFilter] = useState<'all' | 'platform' | 'sms'>('all');
  const [sendChannel, setSendChannel] = useState<'platform' | 'sms'>('platform');

  const filteredLeads = MOCK_LEADS.filter(lead => {
    const matchesSearch = !searchQuery || lead.name.toLowerCase().includes(searchQuery.toLowerCase()) || lead.category.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesAccount = !selectedAccountId || lead.account === accounts.find(a => a.id === selectedAccountId)?.businessName;
    return matchesSearch && matchesAccount;
  });

  const selectedLead = MOCK_LEADS.find(l => l.id === selectedLeadId);

  const filteredMessages = selectedLead?.messages.filter(msg =>
    channelFilter === 'all' || msg.channel === channelFilter
  ) || [];

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Leads Sidebar */}
      <div className="w-80 border-r border-slate-100 bg-white flex flex-col hidden md:flex">
        <div className="p-4 space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="Search leads..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-slate-50 border-none rounded-xl text-sm focus:ring-2 focus:ring-blue-500/20 outline-none"
            />
          </div>
          <div className="flex gap-2">
            <select
              value={selectedAccountId || 'all'}
              onChange={(e) => setSelectedAccountId(e.target.value === 'all' ? null : e.target.value)}
              className="flex-1 bg-slate-50 border-none rounded-lg text-xs font-semibold px-2 py-2 outline-none"
            >
              <option value="all">All Accounts ({MOCK_LEADS.length})</option>
              {accounts.map(a => {
                const count = MOCK_LEADS.filter(l => l.account === a.businessName).length;
                return (
                  <option key={a.id} value={a.id}>{a.businessName} ({count})</option>
                );
              })}
            </select>
            <button className="p-2 bg-slate-50 rounded-lg text-slate-400"><Calendar className="w-4 h-4" /></button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {filteredLeads.map(lead => (
            <div
              key={lead.id}
              className={`p-4 border-l-4 cursor-pointer ${selectedLeadId === lead.id ? 'border-blue-600 bg-blue-50/50' : 'border-transparent hover:bg-slate-50'} transition-colors`}
              onClick={() => setSelectedLeadId(lead.id)}
            >
              <div className="flex justify-between items-start mb-1">
                <span className="font-bold text-slate-900">{lead.name}</span>
                <span className="text-[10px] text-slate-400 font-medium uppercase">{lead.time}</span>
              </div>
              <div className="flex items-center gap-2 mb-2">
                <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-[10px] font-bold rounded uppercase">{lead.category}</span>
                {lead.status === 'active' && <span className="w-2 h-2 rounded-full bg-emerald-500"></span>}
              </div>
              <p className="text-xs text-slate-500 line-clamp-1 italic">"{lead.snippet}"</p>
            </div>
          ))}
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 flex flex-col bg-slate-50/30">
        {selectedLead ? (
          <>
            {/* Chat Header */}
            <div className="p-6 bg-white border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white shadow-lg">
                  <Users className="w-6 h-6" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-slate-900 text-lg">{selectedLead.name}</h3>
                    <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full border ${
                      selectedLead.status === 'active' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' :
                      selectedLead.status === 'won' ? 'bg-blue-50 text-blue-600 border-blue-100' :
                      'bg-slate-50 text-slate-600 border-slate-100'
                    }`}>{selectedLead.status.toUpperCase()}</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-slate-500 mt-1">
                    <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {selectedLead.location}</span>
                    <span className="flex items-center gap-1"><DollarSign className="w-3 h-3" /> {selectedLead.budget}</span>
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <button className="p-2.5 rounded-xl border border-slate-200 text-slate-400 hover:bg-slate-50 transition-all"><Phone className="w-5 h-5" /></button>
              </div>
            </div>

            {/* Channel Filter Bar */}
            <div className="px-6 py-3 bg-white border-b border-slate-100 flex gap-2">
              {(['all', 'platform', 'sms'] as const).map((filter) => (
                <button
                  key={filter}
                  className={`px-4 py-1.5 rounded-lg text-xs font-bold uppercase transition-all ${
                    channelFilter === filter
                      ? 'bg-blue-600 text-white'
                      : 'bg-slate-50 text-slate-500 hover:bg-slate-100'
                  }`}
                  onClick={() => setChannelFilter(filter)}
                >
                  {filter === 'all' && 'All'}
                  {filter === 'platform' && 'Platform'}
                  {filter === 'sms' && 'SMS'}
                </button>
              ))}
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              <div className="flex justify-center">
                <span className="text-[10px] font-bold text-slate-400 bg-white px-3 py-1 rounded-full border border-slate-100 uppercase tracking-widest">Conversation Started</span>
              </div>

              {filteredMessages.length > 0 ? filteredMessages.map(msg => (
                <div key={msg.id} className={`flex flex-col ${msg.sender === 'pro' ? 'items-end ml-auto' : 'items-start'} max-w-[80%]`}>
                  <span className={`text-[10px] font-bold mb-1 ${msg.sender === 'pro' ? 'text-slate-400 mr-1' : 'text-blue-600 ml-1'}`}>
                    {msg.sender === 'pro' ? 'YOU' : msg.channel === 'platform' ? 'THUMBTACK PLATFORM' : 'SMS'}
                  </span>
                  <div className={`p-4 rounded-2xl text-sm leading-relaxed ${
                    msg.sender === 'pro'
                      ? 'bg-blue-600 text-white shadow-lg shadow-blue-100 rounded-br-none'
                      : 'bg-white text-slate-700 shadow-sm border border-slate-100 rounded-bl-none'
                  }`}>
                    {msg.text}
                  </div>
                  <span className="text-[10px] text-slate-400 mt-1">{msg.time}</span>
                </div>
              )) : (
                <div className="flex flex-col items-center justify-center py-12 text-slate-400">
                  <MessageSquare size={32} />
                  <p className="mt-2">No messages yet</p>
                  <small className="text-xs">Send a message to start the conversation</small>
                </div>
              )}
            </div>

            {/* Input */}
            <div className="p-6 bg-white border-t border-slate-100">
              <div className="flex items-center gap-4 bg-slate-50 p-2 rounded-2xl border border-slate-100">
                <select
                  value={sendChannel}
                  onChange={(e) => setSendChannel(e.target.value as 'platform' | 'sms')}
                  className="bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs font-bold text-slate-600 outline-none"
                >
                  <option value="platform">Platform</option>
                  <option value="sms">SMS Bridge</option>
                </select>
                <input
                  type="text"
                  placeholder="Type your response..."
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  className="flex-1 bg-transparent border-none outline-none text-sm text-slate-700 py-2"
                />
                <button className="w-10 h-10 bg-blue-600 text-white rounded-xl flex items-center justify-center shadow-lg shadow-blue-200 hover:bg-blue-700 transition-all" disabled={!messageText.trim()}>
                  <Send className="w-5 h-5" />
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400">
            <MessageSquare size={64} />
            <h3 className="mt-4 font-bold text-lg">Select a lead</h3>
            <p className="text-sm">Choose a lead from the list to view details and send messages</p>
          </div>
        )}
      </div>

      {/* Details Sidebar */}
      {selectedLead && (
        <div className="w-72 border-l border-slate-100 bg-white p-6 hidden xl:block">
          <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-6">Lead Intelligence</h4>

          <div className="space-y-8">
            <div>
              <p className="text-[11px] font-bold text-slate-900 mb-3 uppercase">Communication</p>
              <div className="space-y-3">
                <div className="flex justify-between items-center p-3 bg-slate-50 rounded-xl">
                  <span className="text-xs text-slate-500">Platform Msgs</span>
                  <span className="text-xs font-bold text-slate-900">{selectedLead.messages.filter(m => m.channel === 'platform').length}</span>
                </div>
                <div className="flex justify-between items-center p-3 bg-slate-50 rounded-xl">
                  <span className="text-xs text-slate-500">SMS Sent</span>
                  <span className="text-xs font-bold text-slate-900">{selectedLead.messages.filter(m => m.channel === 'sms').length}</span>
                </div>
              </div>
            </div>

            <div>
              <p className="text-[11px] font-bold text-slate-900 mb-3 uppercase">Customer Info</p>
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                    <Phone className="w-4 h-4" />
                  </div>
                  <span className="text-sm font-medium text-slate-700">{selectedLead.phone}</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                    <Tag className="w-4 h-4" />
                  </div>
                  <span className="text-sm font-medium text-slate-700">{selectedLead.category}</span>
                </div>
              </div>
            </div>

            {selectedLead.messages[0] && (
              <div className="p-4 bg-gradient-to-br from-slate-900 to-slate-800 rounded-2xl text-white">
                <p className="text-[10px] font-bold text-slate-400 uppercase mb-2">Original Request</p>
                <p className="text-xs leading-relaxed italic opacity-90">"{selectedLead.messages[0].text}"</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Phone View ───────────────────────────────────────────

export function DemoPhoneView() {
  const { accounts, selectedAccountId, setSelectedAccountId } = useDemoContext();
  return (
    <div className="p-6 lg:p-10 max-w-5xl mx-auto space-y-8">
      {/* Welcome/Header Section */}
      <section className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-blue-600 text-white rounded-lg">
              <Phone className="w-5 h-5" />
            </div>
            <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight">Business <span className="gradient-text">Line</span></h2>
          </div>
          <p className="text-slate-500 text-lg">Manage your phone numbers for SMS and customer communications.</p>
        </div>
        <div>
          <div className="bg-white border border-slate-200 rounded-2xl p-1.5 flex items-center gap-2 shadow-sm">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-widest pl-3">Account:</span>
            <select
              value={selectedAccountId || ''}
              onChange={(e) => setSelectedAccountId(e.target.value || null)}
              className="bg-transparent border-none focus:ring-0 font-semibold text-slate-700 text-sm py-2 pr-8"
            >
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.businessName}</option>
              ))}
            </select>
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-xl text-xs font-bold border border-emerald-100">
              <CheckCircle className="w-3.5 h-3.5" />
              Connected
            </div>
          </div>
        </div>
      </section>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Pool Numbers Section */}
        <div className="lg:col-span-2 space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-xl font-bold text-slate-900">LeadBridge Pool Numbers</h3>
            <span className="text-xs font-medium text-slate-400">2 Active Numbers</span>
          </div>

          <div className="space-y-4">
            {[
              { number: '+1 (813) 555-9999', provider: 'Sinch', area: '813 • Tampa, FL' },
              { number: '+1 (727) 555-8888', provider: 'Sinch', area: '727 • St. Pete, FL' },
            ].map((phone, i) => (
              <div key={i} className="bg-white border border-slate-100 rounded-3xl p-6 flex items-center gap-6 shadow-sm hover:border-blue-200 transition-all group">
                <div className="w-14 h-14 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center shrink-0 transition-colors group-hover:bg-blue-600 group-hover:text-white">
                  <PhoneCall className="w-7 h-7" />
                </div>
                <div className="flex-1">
                  <h4 className="text-xl font-bold text-slate-900">{phone.number}</h4>
                  <div className="flex items-center gap-3 mt-1.5">
                    <span className="bg-slate-100 text-slate-600 px-2.5 py-0.5 rounded-lg text-xs font-bold uppercase tracking-tight">{phone.provider}</span>
                    <span className="text-xs text-slate-500 font-medium">{phone.area}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 text-emerald-600 font-bold text-sm">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                  Active
                </div>
              </div>
            ))}
          </div>

          {/* Info Card */}
          <div className="bg-blue-50/50 border border-blue-100 rounded-[2rem] p-6 flex gap-4">
            <HelpCircle className="w-5 h-5 text-blue-500 shrink-0" />
            <p className="text-sm text-slate-600 leading-relaxed">
              <strong>How it works:</strong> Pool numbers are shared across users in the same area. Messages are automatically routed to your LeadBridge dashboard based on lead metadata.
            </p>
          </div>
        </div>

        {/* Sidebar Configuration */}
        <div className="space-y-6">
          <h3 className="text-xl font-bold text-slate-900 px-2">Provider Settings</h3>

          {/* Connect Own Provider (Coming Soon) */}
          <div className="bg-white border border-dashed border-slate-200 rounded-[2rem] p-8 text-center opacity-70">
            <div className="w-14 h-14 bg-slate-100 text-slate-400 rounded-full flex items-center justify-center mx-auto mb-4">
              <Link2 className="w-6 h-6" />
            </div>
            <span className="inline-block bg-blue-100 text-blue-700 text-[10px] font-extrabold px-3 py-1 rounded-full mb-3 uppercase tracking-widest">Coming Soon</span>
            <h4 className="font-bold text-slate-900 mb-2">Dedicated Provider</h4>
            <p className="text-sm text-slate-500 leading-relaxed">
              Connect your own Twilio, Sinch, or Telnyx accounts for dedicated business numbers.
            </p>
          </div>

          {/* Upgrade Card */}
          <div className="bg-gradient-to-br from-blue-600 to-indigo-700 rounded-[2rem] p-6 text-white text-center shadow-lg shadow-blue-200">
            <div className="w-12 h-12 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <Zap className="w-6 h-6" />
            </div>
            <h4 className="font-bold text-lg mb-2">Need a Private Line?</h4>
            <p className="text-blue-100 text-sm mb-5 leading-relaxed">Upgrade to the Platinum plan to secure a private, dedicated business number.</p>
            <button className="w-full py-3 bg-white text-blue-600 rounded-xl font-bold text-sm shadow-sm hover:bg-blue-50 transition-colors">
              View Pricing
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Insights View ────────────────────────────────────────

export function DemoInsightsView() {
  const { accounts, selectedAccountId, setSelectedAccountId } = useDemoContext();
  const [timeRange, setTimeRange] = useState('30d');

  return (
    <div className="p-6 lg:p-10 max-w-7xl mx-auto space-y-10">
      {/* Welcome/Filter Section */}
      <section className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <p className="text-blue-600 font-semibold mb-1 uppercase tracking-wider text-xs">Performance Reports</p>
          <h2 className="text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight">Business <span className="gradient-text">Insights.</span></h2>
          <p className="text-slate-500 mt-2 text-lg">Track your leads, engagement, and response metrics.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="relative">
            <select
              value={selectedAccountId || '__all__'}
              onChange={(e) => setSelectedAccountId(e.target.value === '__all__' ? null : e.target.value)}
              className="appearance-none pl-10 pr-10 py-3 bg-white border border-slate-200 rounded-xl font-medium text-slate-700 hover:border-blue-300 focus:ring-2 focus:ring-blue-100 transition-all cursor-pointer"
            >
              <option value="__all__">All Accounts</option>
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.businessName}</option>
              ))}
            </select>
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
              <Building2 className="w-4 h-4" />
            </div>
          </div>
          <div className="relative">
            <select
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value)}
              className="appearance-none pl-10 pr-10 py-3 bg-white border border-slate-200 rounded-xl font-medium text-slate-700 hover:border-blue-300 focus:ring-2 focus:ring-blue-100 transition-all cursor-pointer"
            >
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="all">All time</option>
            </select>
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
              <Calendar className="w-4 h-4" />
            </div>
          </div>
        </div>
      </section>

      {/* Metrics Grid */}
      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
          <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-2xl flex items-center justify-center mb-4">
            <Users className="w-6 h-6" />
          </div>
          <p className="text-slate-500 text-sm font-medium uppercase tracking-wide">Total Leads</p>
          <h3 className="text-3xl font-bold text-slate-900 mt-1">{timeRange === '7d' ? '34' : timeRange === '30d' ? '127' : '458'}</h3>
        </div>
        <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
          <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center mb-4">
            <Clock className="w-6 h-6" />
          </div>
          <p className="text-slate-500 text-sm font-medium uppercase tracking-wide">Avg Connection</p>
          <h3 className="text-3xl font-bold text-slate-900 mt-1">2m 15s</h3>
        </div>
        <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
          <div className="w-12 h-12 bg-purple-50 text-purple-600 rounded-2xl flex items-center justify-center mb-4">
            <MessageSquare className="w-6 h-6" />
          </div>
          <p className="text-slate-500 text-sm font-medium uppercase tracking-wide">Messages/Lead</p>
          <h3 className="text-3xl font-bold text-slate-900 mt-1">4.2</h3>
        </div>
        <div className="bg-indigo-600 p-6 rounded-3xl shadow-xl shadow-indigo-100 text-white">
          <div className="w-12 h-12 bg-white/20 text-white rounded-2xl flex items-center justify-center mb-4">
            <TrendingUp className="w-6 h-6" />
          </div>
          <p className="text-indigo-100 text-sm font-medium uppercase tracking-wide">Engagement</p>
          <div className="flex items-baseline gap-2 mt-1">
            <h3 className="text-3xl font-bold">67%</h3>
            <span className="text-indigo-200 text-sm">Target Met</span>
          </div>
        </div>
      </section>

      {/* Detailed Analytics Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Service Categories */}
        <div className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-sm">
          <div className="flex items-center justify-between mb-8">
            <h3 className="text-xl font-bold text-slate-900">Service Categories</h3>
          </div>
          <div className="space-y-6">
            {[
              { name: 'House Cleaning', pct: 42, color: 'bg-blue-600' },
              { name: 'Office Cleaning', pct: 25, color: 'bg-indigo-500' },
              { name: 'Move-Out Cleaning', pct: 18, color: 'bg-purple-500' },
              { name: 'Deep Cleaning', pct: 15, color: 'bg-slate-400' },
            ].map((cat, i) => (
              <div key={i} className="space-y-2">
                <div className="flex justify-between text-sm font-bold text-slate-700">
                  <span>{cat.name}</span>
                  <span>{cat.pct}%</span>
                </div>
                <div className="h-3 bg-slate-100 rounded-full overflow-hidden">
                  <div className={`h-full ${cat.color} rounded-full`} style={{ width: `${cat.pct}%` }}></div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Response Times */}
        <div className="bg-white border border-slate-100 rounded-[2.5rem] p-8 shadow-sm">
          <div className="flex items-center justify-between mb-8">
            <h3 className="text-xl font-bold text-slate-900">Response Speed</h3>
          </div>
          <div className="grid grid-cols-2 gap-4">
            {[
              { label: 'Your Avg', value: '2m 15s', desc: 'Auto-reply bridge speed', color: 'slate' },
              { label: 'Customer Avg', value: '47m', desc: 'Human response time', color: 'slate' },
              { label: 'Fastest', value: '< 1m', desc: 'Peak performance', color: 'emerald' },
              { label: 'Slowest', value: '4h 12m', desc: 'Needs attention', color: 'rose' },
            ].map((stat, i) => (
              <div key={i} className={`p-5 ${stat.color === 'emerald' ? 'bg-emerald-50 border-emerald-100' : stat.color === 'rose' ? 'bg-rose-50 border-rose-100' : 'bg-slate-50 border-slate-100'} rounded-3xl border text-center`}>
                <div className={`text-2xl font-bold ${stat.color === 'emerald' ? 'text-emerald-700' : stat.color === 'rose' ? 'text-rose-700' : 'text-slate-900'}`}>{stat.value}</div>
                <div className={`text-xs font-bold uppercase tracking-tight mt-1 ${stat.color === 'emerald' ? 'text-emerald-600' : stat.color === 'rose' ? 'text-rose-600' : stat.label === 'Your Avg' ? 'text-blue-600' : 'text-slate-500'}`}>{stat.label}</div>
                <p className={`text-[10px] mt-2 leading-tight ${stat.color === 'emerald' ? 'text-emerald-600/60' : stat.color === 'rose' ? 'text-rose-600/60' : 'text-slate-400'}`}>{stat.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Locations Section */}
      <section className="space-y-6">
        <div className="flex items-center justify-between px-2">
          <h3 className="text-xl font-bold text-slate-900">Top Service Locations</h3>
        </div>
        <div className="bg-slate-900 rounded-[2.5rem] p-8 text-white relative overflow-hidden shadow-xl">
          <div className="relative z-10 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-8 items-center">
            {[
              { name: 'Tampa, FL', count: 45, pct: 100 },
              { name: 'St. Petersburg, FL', count: 32, pct: 71 },
              { name: 'Brandon, FL', count: 24, pct: 53 },
              { name: 'Sarasota, FL', count: 18, pct: 40 },
              { name: 'Clearwater, FL', count: 8, pct: 18 },
            ].map((loc, i) => (
              <div key={i} className="space-y-2" style={{ opacity: i === 0 ? 1 : 0.8 }}>
                <p className={`${i === 0 ? 'text-3xl' : 'text-2xl'} font-bold`}>{loc.count}</p>
                <p className={`text-sm font-medium ${i === 0 ? 'text-blue-400' : 'text-slate-400'}`}>{loc.name}</p>
                <div className="h-1 bg-white/20 rounded-full w-full overflow-hidden">
                  <div className={`h-full ${i === 0 ? 'bg-blue-500' : 'bg-blue-400'} rounded-full`} style={{ width: `${loc.pct}%` }}></div>
                </div>
              </div>
            ))}
          </div>
          <div className="absolute -right-20 -top-20 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl"></div>
        </div>
      </section>
    </div>
  );
}

// ─── Pricing View ─────────────────────────────────────────

const DEMO_TIERS = [
  {
    name: 'Instant Reply',
    id: 'STARTER',
    price: 49,
    description: 'Perfect for getting started with automated responses',
    features: [
      'Custom reply templates',
      'Unlimited leads',
      'Email notifications',
      'Basic analytics',
    ],
  },
  {
    name: 'Call Assist',
    id: 'PRO',
    price: 99,
    description: 'Everything you need to handle customer calls',
    features: [
      'Everything in Instant Reply',
      'Phone call capability',
      'SMS notifications',
      'Advanced analytics',
      'Priority support',
    ],
    popular: true,
  },
  {
    name: 'AI Conversations',
    id: 'ENTERPRISE',
    price: 129,
    description: 'AI-powered conversations for maximum engagement',
    features: [
      'Everything in Call Assist',
      'AI-powered follow-ups',
      'Smart conversation routing',
      'Custom integrations',
      'Dedicated support',
    ],
  },
];

export function DemoPricingView() {
  const [ownNumber, setOwnNumber] = useState(false);

  return (
    <div className="p-6 lg:p-10 max-w-7xl mx-auto space-y-12">
      {/* Header */}
      <section className="text-center max-w-2xl mx-auto">
        <h2 className="text-4xl lg:text-5xl font-extrabold text-slate-900 tracking-tight mb-4">
          Choose Your <span className="gradient-text">Plan</span>
        </h2>
        <p className="text-slate-500 text-lg">Select the perfect plan for your business needs. All plans include a 14-day money-back guarantee.</p>
      </section>

      {/* Add-on Toggle */}
      <section className="flex justify-center">
        <div className="bg-white border border-slate-200 p-4 rounded-2xl shadow-sm flex items-center gap-4 max-w-md w-full">
          <div className="w-12 h-12 bg-amber-50 text-amber-600 rounded-xl flex items-center justify-center shrink-0">
            <Phone className="w-6 h-6" />
          </div>
          <div className="flex-1">
            <label className="flex items-center gap-2 cursor-pointer group">
              <input
                type="checkbox"
                checked={ownNumber}
                onChange={(e) => setOwnNumber(e.target.checked)}
                className="w-5 h-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="font-bold text-slate-900 group-hover:text-blue-600 transition-colors">Add Own Business Number</span>
            </label>
            <p className="text-xs text-slate-500 mt-1">Dedicated phone line for <strong>+$29/month</strong></p>
          </div>
        </div>
      </section>

      {/* Pricing Tiers Grid */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {DEMO_TIERS.map((tier) => {
          const isCurrentPlan = tier.id === 'PRO';
          const totalPrice = tier.price + (ownNumber ? 29 : 0);

          return (
            <div
              key={tier.id}
              className={`p-8 rounded-[2.5rem] flex flex-col relative ${
                tier.id === 'ENTERPRISE'
                  ? 'bg-slate-900 text-white shadow-xl'
                  : `bg-white border ${tier.popular ? 'border-2 border-blue-600 shadow-2xl shadow-blue-100 scale-105' : 'border-slate-100 shadow-sm hover:shadow-xl'} transition-all`
              }`}
            >
              {tier.popular && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[10px] font-black uppercase tracking-widest px-4 py-1.5 rounded-full">
                  Most Popular
                </div>
              )}
              {isCurrentPlan && (
                <div className="absolute top-8 right-8">
                  <span className="bg-blue-50 text-blue-600 text-[10px] font-bold px-2 py-1 rounded">CURRENT PLAN</span>
                </div>
              )}

              <div className="mb-8">
                <h3 className={`text-xl font-bold ${tier.id === 'ENTERPRISE' ? 'text-white' : 'text-slate-900'}`}>{tier.name}</h3>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className={`text-4xl font-extrabold ${tier.id === 'ENTERPRISE' ? 'text-white' : 'text-slate-900'}`}>${totalPrice}</span>
                  <span className={tier.id === 'ENTERPRISE' ? 'text-slate-400' : 'text-slate-400'} >/ month</span>
                </div>
                <p className={`text-sm mt-4 leading-relaxed ${tier.id === 'ENTERPRISE' ? 'text-slate-400' : 'text-slate-500'}`}>{tier.description}</p>
              </div>

              <ul className="space-y-4 mb-10 flex-1">
                {tier.features.map((feature, index) => (
                  <li key={index} className={`flex items-center gap-3 text-sm ${tier.id === 'ENTERPRISE' ? 'text-slate-200' : index === 0 && tier.popular ? 'text-slate-900 font-semibold' : 'text-slate-600'}`}>
                    <div className={`rounded-full p-1 ${
                      tier.id === 'ENTERPRISE' ? 'bg-white/10 text-blue-400' :
                      tier.popular && index === 0 ? 'bg-blue-600 text-white' :
                      'bg-emerald-100 text-emerald-600'
                    }`}>
                      <CheckCircle className="w-3 h-3" />
                    </div>
                    {feature}
                  </li>
                ))}
              </ul>

              <button
                className={`w-full py-4 font-bold rounded-2xl transition-all ${
                  tier.id === 'ENTERPRISE'
                    ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-900/20'
                    : isCurrentPlan
                      ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                      : 'bg-slate-50 text-slate-900 hover:bg-slate-100'
                }`}
                disabled={isCurrentPlan}
              >
                {isCurrentPlan ? 'Current Plan' : tier.id === 'ENTERPRISE' ? 'Upgrade Now' : 'Get Started'}
              </button>
            </div>
          );
        })}
      </section>

      {/* Footer / Help */}
      <section className="bg-slate-50 rounded-3xl p-8 text-center border border-slate-100">
        <p className="text-slate-600 font-medium">Need help choosing the right plan for your business?</p>
        <div className="mt-4 flex flex-col sm:flex-row justify-center items-center gap-4">
          <a href="mailto:support@leadbridge.com" className="flex items-center gap-2 text-blue-600 font-bold hover:underline">
            Contact our team
          </a>
          <span className="hidden sm:block text-slate-300">|</span>
          <span className="text-slate-500 text-sm italic">All plans include a 14-day money-back guarantee</span>
        </div>
      </section>
    </div>
  );
}

// ─── Settings View ────────────────────────────────────────

export function DemoSettingsView() {
  return (
    <div className="p-6 lg:p-10 max-w-5xl mx-auto space-y-10">
      {/* Welcome Section */}
      <section>
        <div className="flex items-center gap-4 mb-2">
          <div className="w-12 h-12 bg-slate-100 rounded-2xl flex items-center justify-center text-slate-600">
            <Settings className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight">Account <span className="gradient-text">Settings</span></h2>
            <p className="text-slate-500">Manage your business profile, marketplace connections, and billing.</p>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-8">
        {/* Account Info Card */}
        <div className="bg-white rounded-[2.5rem] border border-slate-100 shadow-sm overflow-hidden">
          <div className="px-8 py-6 border-b border-slate-50">
            <h3 className="text-lg font-bold text-slate-900">Business Profile</h3>
          </div>
          <div className="p-8">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              <div className="space-y-1">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Business Name</p>
                <p className="text-slate-900 font-semibold text-lg">ABC Cleaning Services</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Email Address</p>
                <p className="text-slate-900 font-semibold text-lg">demo@leadbridge.app</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Phone Number</p>
                <p className="text-slate-900 font-semibold text-lg">(813) 555-0100</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Time Zone</p>
                <p className="text-slate-900 font-semibold text-lg">Eastern Time (ET)</p>
              </div>
              <div className="space-y-1 md:col-span-2">
                <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Business Hours</p>
                <p className="text-slate-900 font-semibold text-lg">Mon–Fri, 8 AM – 6 PM</p>
              </div>
            </div>
          </div>
        </div>

        {/* Marketplace Connections */}
        <div className="space-y-4">
          <h3 className="text-xl font-bold text-slate-900 px-2">Marketplace Connections</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Thumbtack Group */}
            <div className="bg-white rounded-[2rem] border border-slate-100 shadow-sm p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white font-bold text-xs shadow-lg shadow-blue-100">TT</div>
                  <span className="font-bold text-slate-900">Thumbtack</span>
                </div>
                <span className="bg-emerald-50 text-emerald-600 text-[10px] font-bold px-2 py-1 rounded-full border border-emerald-100 uppercase tracking-tighter">Active</span>
              </div>
              <div className="space-y-3">
                {MOCK_ACCOUNTS.map(account => (
                  <div key={account.id} className="flex items-center justify-between p-3 rounded-2xl bg-slate-50 border border-slate-100">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-slate-900 truncate">{account.businessName}</p>
                      <p className="text-[10px] text-slate-400 font-medium uppercase">ID: {account.businessId}</p>
                    </div>
                    <CheckCircle className="w-5 h-5 text-emerald-500" />
                  </div>
                ))}
              </div>
            </div>

            {/* Yelp Group */}
            <div className="bg-slate-50 rounded-[2rem] border border-slate-200 border-dashed p-6 flex flex-col items-center justify-center text-center">
              <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center text-slate-300 font-bold mb-3 border border-slate-100">Y</div>
              <h4 className="font-bold text-slate-400">Yelp Integration</h4>
              <p className="text-xs text-slate-400 mb-4">Coming very soon to LeadBridge</p>
              <span className="px-4 py-1.5 bg-white text-slate-400 text-[10px] font-bold rounded-full border border-slate-200 uppercase tracking-widest">Waitlist Only</span>
            </div>
          </div>
        </div>

        {/* Subscription Section */}
        <div className="bg-slate-900 rounded-[2.5rem] p-8 text-white relative overflow-hidden">
          <div className="relative z-10">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-8 pb-8 border-b border-white/10">
              <div>
                <div className="flex items-center gap-3 mb-2">
                  <h3 className="text-2xl font-bold">Pro Plan</h3>
                  <span className="px-3 py-1 bg-emerald-500/20 text-emerald-400 text-xs font-bold rounded-full border border-emerald-500/30">Active</span>
                </div>
                <p className="text-slate-400 text-sm">Automating your lead workflow since Jan 2024.</p>
              </div>
              <div className="text-left md:text-right">
                <div className="text-4xl font-black">$29<span className="text-lg text-slate-500 font-medium">/mo</span></div>
                <p className="text-slate-400 text-xs mt-1">Next billing: March 15, 2026</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-300">Connected Accounts</span>
                  <span className="text-sm font-bold text-white">2 of 5</span>
                </div>
                <div className="w-full bg-white/10 h-2 rounded-full overflow-hidden">
                  <div className="bg-blue-500 h-full w-[40%] rounded-full shadow-[0_0_12px_rgba(59,130,246,0.5)]"></div>
                </div>
                <div className="flex gap-3">
                  <button className="flex-1 py-3 bg-white text-slate-900 rounded-xl font-bold text-sm hover:bg-slate-100 transition-colors">
                    Manage Subscription
                  </button>
                  <button className="px-4 py-3 bg-red-500/10 text-red-400 rounded-xl font-bold text-sm hover:bg-red-500/20 transition-colors">
                    Cancel
                  </button>
                </div>
              </div>

              <div className="bg-white/5 rounded-3xl p-6 border border-white/10">
                <h4 className="text-sm font-bold text-slate-300 mb-4 uppercase tracking-widest">Payment Method</h4>
                <div className="flex items-center gap-4">
                  <div className="w-12 h-10 bg-indigo-600/20 rounded-lg flex items-center justify-center text-indigo-400 border border-indigo-600/30">
                    <CreditCard className="w-6 h-6" />
                  </div>
                  <div>
                    <p className="font-bold text-white text-sm">Visa ending in 4242</p>
                    <p className="text-xs text-slate-400">Expires 12/2027</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="absolute -right-20 -bottom-20 w-80 h-80 bg-blue-600/10 rounded-full blur-[100px]"></div>
        </div>
      </div>
    </div>
  );
}
