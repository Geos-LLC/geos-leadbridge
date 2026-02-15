import { useState } from 'react';
import {
  Home, MessageSquare, BarChart3, Settings, Phone, Briefcase,
  CreditCard, LogOut, Menu, X, Building2, CheckCircle, AlertCircle,
  Users, TrendingUp, Clock, Zap, Bell, PhoneCall, Link2, ExternalLink,
  ChevronDown, ChevronUp, Plus, Pencil, Trash2, Info,
  Send, MapPin, Calendar, DollarSign, Tag, Search,
  Bot, RefreshCw,
} from 'lucide-react';
import { Link as RouterLink, NavLink, Outlet, useOutletContext } from 'react-router-dom';
import '../App.css';

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
];

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
    <div className="app-layout">
      {/* Sidebar */}
      <nav className={`sidebar-nav ${mobileMenuOpen ? 'open' : ''}`}>
        <div className="nav-brand">
          <img src="/LeadBridge_Logo.png" alt="LeadBridge" className="nav-logo" />
        </div>
        <div className="nav-links">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
              onClick={() => setMobileMenuOpen(false)}
            >
              {item.icon}
              <span>{item.label}</span>
            </NavLink>
          ))}
          <div className="nav-separator"></div>
          <div className="nav-section-label">Account</div>
          <NavLink
            to="/demo/settings"
            className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
            onClick={() => setMobileMenuOpen(false)}
          >
            <Settings size={20} />
            <span>Settings</span>
          </NavLink>
        </div>
        <div className="nav-footer">
          <div className="user-info">
            <div className="user-avatar">D</div>
            <div className="user-details">
              <span className="user-name">Demo User</span>
              <span className="user-email">demo@leadbridge.app</span>
            </div>
          </div>
          <RouterLink to="/login" className="btn-icon logout-btn" title="Exit Demo">
            <LogOut size={20} />
          </RouterLink>
        </div>
      </nav>

      {mobileMenuOpen && <div className="sidebar-backdrop" onClick={() => setMobileMenuOpen(false)} />}

      <main className="main-content">
        <div className="mobile-header">
          <div className="mobile-header-brand">
            <img src="/LeadBridge_Logo.png" alt="LeadBridge" className="mobile-header-logo" />
            <span className="mobile-header-name">LeadBridge</span>
          </div>
          <button className="mobile-menu-btn" onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
            {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>

        {/* Demo Banner */}
        <div className="demo-banner">
          <AlertCircle size={18} className="demo-banner-icon" />
          <span className="demo-banner-text">
            This is a <strong>demo</strong> with mock data — no login required.
            <RouterLink to="/register" className="demo-banner-link">
              Create an account
            </RouterLink>
          </span>
        </div>

        <Outlet context={context} />
      </main>
    </div>
  );
}

// ─── Account Selector (shared) ────────────────────────────

function AccountSelector({ accounts, selectedAccountId, setSelectedAccountId, showAllOption = true }: {
  accounts: typeof MOCK_ACCOUNTS;
  selectedAccountId: string | null;
  setSelectedAccountId: (id: string | null) => void;
  showAllOption?: boolean;
}) {
  const selectedAccount = accounts.find(a => a.id === selectedAccountId);
  return (
    <div className="account-selector multi">
      <label className="account-selector-label">Account:</label>
      <div className="account-dropdown-wrapper">
        <select
          className="account-dropdown"
          value={selectedAccountId || '__all__'}
          onChange={(e) => setSelectedAccountId(e.target.value === '__all__' ? null : e.target.value)}
        >
          {accounts.map(a => (
            <option key={a.id} value={a.id}>{a.businessName}</option>
          ))}
          {showAllOption && <option value="__all__">All Accounts</option>}
        </select>
        <ChevronDown size={16} className="dropdown-chevron" />
      </div>
      {selectedAccount?.webhookId && (
        <span className="account-badge connected">
          <CheckCircle size={12} /> Connected
        </span>
      )}
    </div>
  );
}

// ─── Overview View ────────────────────────────────────────

export function DemoOverviewView() {
  const { accounts } = useDemoContext();
  const [healthToggles] = useState({ autoReply: true, customerSms: true, leadAlerts: true });
  const [selectedIdx, setSelectedIdx] = useState(0);
  const account = accounts[selectedIdx];

  return (
    <div className="dashboard">
      {/* Account Card with Dropdown */}
      <section className="manage-accounts-section" id="manage-accounts">
        <div className="account-cards-compact">
          <div className="account-cards-header">
            <h3>Your Accounts</h3>
            <button className="btn btn-primary btn-sm" disabled>
              <Link2 size={14} /> Add Account
            </button>
          </div>
          <div className="account-card-compact">
            <div className="account-card-left">
              <div className="account-card-avatar placeholder"><Building2 size={20} /></div>
              <div className="account-card-details">
                {accounts.length > 1 ? (
                  <div className="account-card-dropdown">
                    <select
                      value={selectedIdx}
                      onChange={(e) => setSelectedIdx(Number(e.target.value))}
                      className="account-name-select"
                    >
                      {accounts.map((acc, idx) => (
                        <option key={acc.id} value={idx}>{acc.businessName}</option>
                      ))}
                    </select>
                    <ChevronDown size={14} className="dropdown-chevron" />
                  </div>
                ) : (
                  <div className="account-card-name">{account.businessName}</div>
                )}
                <div className="account-card-meta">
                  <span className="account-card-id">ID: {account.businessId}</span>
                  <span className="account-card-status connected">
                    <CheckCircle size={10} /> Connected
                  </span>
                </div>
                <div className="email-display-row compact">
                  <span className="email-hint">{account.emailHint}</span>
                </div>
              </div>
            </div>
            <div className="account-card-actions">
              <button className="btn btn-primary btn-sm" disabled>
                <ExternalLink size={14} /> Leads
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* System Health - Clickable */}
      <section className="dashboard-section">
        <h2>System Health</h2>
        <div className="health-status-grid">
          {[
            { key: 'autoReply' as const, label: 'Auto Reply', icon: <Zap size={20} /> },
            { key: 'customerSms' as const, label: 'Customer SMS', icon: <MessageSquare size={20} /> },
            { key: null, label: 'Call Connect', icon: <Phone size={20} />, comingSoon: true },
            { key: 'leadAlerts' as const, label: 'Lead Alerts', icon: <Bell size={20} /> },
          ].map((card, i) => {
            const enabled = card.key ? healthToggles[card.key] : false;
            return (
              <div
                key={i}
                className={`health-status-card clickable ${card.comingSoon ? 'coming-soon' : enabled ? 'on' : 'off'}`}
                style={{ cursor: 'pointer' }}
              >
                <div className="health-card-icon">{card.icon}</div>
                <div className="health-card-info">
                  <span className="health-card-label">{card.label}</span>
                  {card.comingSoon ? (
                    <span className="status-indicator coming-soon">Coming Soon</span>
                  ) : (
                    <span className={`status-indicator ${enabled ? 'on' : 'off'}`}>
                      {enabled ? 'ON' : 'OFF'}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Today's Activity */}
      <section className="dashboard-section">
        <h2>Today's Activity</h2>
        <div className="metrics-summary">
          {[
            { label: 'Leads Today', value: '7', icon: <Users size={24} />, color: 'blue' },
            { label: 'SMS Sent Today', value: '12', icon: <MessageSquare size={24} />, color: 'green' },
            { label: 'Calls Connected', value: '0', subtext: 'Coming Soon', icon: <PhoneCall size={24} />, color: 'gray', comingSoon: true },
            { label: 'Avg Response Time', value: '2m 15s', icon: <Clock size={24} />, color: 'orange' },
          ].map((metric, i) => (
            <div key={i} className={`metric-card ${metric.color} ${metric.comingSoon ? 'coming-soon' : ''}`}>
              <div className={`metric-icon ${metric.color}`}>{metric.icon}</div>
              <div className="metric-details">
                <span className="metric-value">{metric.value}</span>
                <span className="metric-label">{metric.label}</span>
                {metric.subtext && <span className="metric-subtext">{metric.subtext}</span>}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Attention Needed */}
      <section className="dashboard-section">
        <h2>Attention Needed</h2>
        <div className="attention-grid">
          <div className="attention-card urgent">
            <div className="attention-count">3</div>
            <div className="attention-info">
              <span className="attention-label">Leads Not Replied</span>
              <span className="attention-desc">Respond to increase conversion</span>
            </div>
          </div>
          <div className="attention-card warning">
            <div className="attention-count">1</div>
            <div className="attention-info">
              <span className="attention-label">SMS Failed</span>
              <span className="attention-desc">Check phone configuration</span>
            </div>
          </div>
        </div>
      </section>

      {/* 7-Day Snapshot */}
      <section className="dashboard-section">
        <h2>7-Day Snapshot</h2>
        <div className="conversion-snapshot">
          {[
            { label: 'Leads (Last 7 Days)', value: '34', icon: <Users size={22} />, color: 'blue' },
            { label: 'Customer Engagement', value: '67%', icon: <TrendingUp size={22} />, color: 'green' },
            { label: 'Auto Replies (Lifetime)', value: '142', icon: <TrendingUp size={22} />, color: 'purple' },
            { label: 'SMS Sent (Lifetime)', value: '89', icon: <TrendingUp size={22} />, color: 'orange' },
          ].map((stat, i) => (
            <div key={i} className="snapshot-card">
              <div className={`snapshot-icon ${stat.color}`}>{stat.icon}</div>
              <div className="snapshot-info">
                <span className="snapshot-value">{stat.value}</span>
                <span className="snapshot-label">{stat.label}</span>
              </div>
            </div>
          ))}
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
  const [expandedSubCards, setExpandedSubCards] = useState<Set<string>>(new Set(['auto-reply-first', 'alerts-sms']));
  const [selectedTemplate, setSelectedTemplate] = useState('t1');
  const [alertToPhone, setAlertToPhone] = useState('(813) 555-0100');
  const [alertFromPhone, setAlertFromPhone] = useState('+1 (813) 555-9999');
  const [alertTemplate, setAlertTemplate] = useState('t3');
  const [testSent, setTestSent] = useState(false);

  const toggleSubCard = (id: string) => {
    setExpandedSubCards(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleTestSms = () => {
    setTestSent(true);
    setTimeout(() => setTestSent(false), 2000);
  };

  return (
    <div className="services-page">
      <div className="settings-header">
        <h1><Briefcase size={24} /> Automation</h1>
      </div>

      <div className="settings-content">
        {/* Account Selector */}
        <div className="account-selector">
          <label>Account:</label>
          <div className="select-wrapper">
            <select
              value={selectedAccountId || ''}
              onChange={(e) => setSelectedAccountId(e.target.value || null)}
            >
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.businessName}</option>
              ))}
            </select>
            <ChevronDown size={16} />
          </div>
        </div>

        <div className="services-grid">
          {/* 1. Auto Reply & Follow-Ups */}
          <div className={`service-card ${autoReplyEnabled ? 'enabled' : 'disabled'}`}>
            <div className="service-card-header" onClick={() => setExpandedCard(expandedCard === 'auto-reply' ? null : 'auto-reply')} style={{ cursor: 'pointer' }}>
              <div className="service-card-icon"><Zap size={22} /></div>
              <div className="service-card-info">
                <h3>Auto Reply & Follow-Ups</h3>
                <p>Automatically respond to new leads</p>
                {autoReplyEnabled && <span className="service-status-text">1 message in sequence</span>}
              </div>
              <button className="service-card-expand-icon" onClick={(e) => { e.stopPropagation(); setExpandedCard(expandedCard === 'auto-reply' ? null : 'auto-reply'); }}>
                <ChevronDown size={18} className={expandedCard === 'auto-reply' ? 'rotated' : ''} />
              </button>
              <div className="service-card-toggle" onClick={(e) => e.stopPropagation()}>
                <label className="toggle-switch">
                  <input type="checkbox" checked={autoReplyEnabled} onChange={() => setAutoReplyEnabled(!autoReplyEnabled)} />
                  <span className="toggle-slider"></span>
                </label>
              </div>
            </div>
            {expandedCard === 'auto-reply' && (
              <div className="service-card-settings">
                <div className="service-settings-inner">
                  {/* AI Optimization Banner */}
                  <div className="ai-optimization-banner coming-soon-banner">
                    <div className="ai-banner-info">
                      <Bot size={18} />
                      <div>
                        <strong>AI Optimization</strong>
                        <span className="coming-soon-badge" style={{ marginLeft: 6 }}>Coming Soon</span>
                        <p className="form-hint">AI decides timing, follow-ups, and message variations to maximize response.</p>
                      </div>
                    </div>
                    <label className="toggle-switch">
                      <input type="checkbox" checked={false} disabled />
                      <span className="toggle-slider"></span>
                    </label>
                  </div>

                  {/* First Reply Sub-Card */}
                  <div className="sub-card">
                    <div className="sub-card-header" onClick={() => toggleSubCard('auto-reply-first')}>
                      <div className="sub-card-title">
                        <Zap size={14} />
                        <span>First Message</span>
                      </div>
                      <ChevronDown size={14} className={expandedSubCards.has('auto-reply-first') ? 'rotated' : ''} />
                    </div>
                    {expandedSubCards.has('auto-reply-first') && (
                      <div className="sub-card-body">
                        <p className="form-hint">Sent immediately when a new lead arrives.</p>
                        <div className="form-group">
                          <label>Template</label>
                          <div className="select-wrapper">
                            <select value={selectedTemplate} onChange={(e) => setSelectedTemplate(e.target.value)}>
                              {MOCK_TEMPLATES.filter(t => t.id !== 't3').map(t => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                              ))}
                            </select>
                            <ChevronDown size={16} />
                          </div>
                        </div>
                        <div className="template-preview-container">
                          <div className="template-preview">
                            {MOCK_TEMPLATES.find(t => t.id === selectedTemplate)?.content}
                          </div>
                          <button className="template-edit-btn">
                            <Pencil size={12} /> Edit
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Follow-Up Messages Sub-Card (Coming Soon) */}
                  <div className="sub-card sub-card-coming-soon">
                    <div className="sub-card-header" onClick={() => toggleSubCard('auto-reply-followups')}>
                      <div className="sub-card-title">
                        <Clock size={14} />
                        <span>Follow-Up Messages</span>
                        <span className="coming-soon-badge">Coming Soon</span>
                      </div>
                      <ChevronDown size={14} className={expandedSubCards.has('auto-reply-followups') ? 'rotated' : ''} />
                    </div>
                    {expandedSubCards.has('auto-reply-followups') && (
                      <div className="sub-card-body sub-card-disabled">
                        <p className="form-hint">Automated follow-up messages sent after a delay.</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 2. Lead Alerts */}
          <div className={`service-card ${leadAlertsEnabled ? 'enabled' : 'disabled'}`}>
            <div className="service-card-header" onClick={() => setExpandedCard(expandedCard === 'alerts' ? null : 'alerts')} style={{ cursor: 'pointer' }}>
              <div className="service-card-icon"><Bell size={22} /></div>
              <div className="service-card-info">
                <h3>Lead Alerts</h3>
                <p>Get notified immediately via SMS when a new lead arrives.</p>
                {leadAlertsEnabled && <span className="service-status-text">SMS to {alertToPhone}</span>}
              </div>
              <button className="service-card-expand-icon" onClick={(e) => { e.stopPropagation(); setExpandedCard(expandedCard === 'alerts' ? null : 'alerts'); }}>
                <ChevronDown size={18} className={expandedCard === 'alerts' ? 'rotated' : ''} />
              </button>
              <div className="service-card-toggle" onClick={(e) => e.stopPropagation()}>
                <label className="toggle-switch">
                  <input type="checkbox" checked={leadAlertsEnabled} onChange={() => setLeadAlertsEnabled(!leadAlertsEnabled)} />
                  <span className="toggle-slider"></span>
                </label>
              </div>
            </div>
            {expandedCard === 'alerts' && (
              <div className="service-card-settings">
                <div className="service-settings-inner">
                  {/* SMS Alert Sub-Card */}
                  <div className="sub-card">
                    <div className="sub-card-header" onClick={() => toggleSubCard('alerts-sms')}>
                      <div className="sub-card-title">
                        <Bell size={14} />
                        <span>SMS Alert</span>
                      </div>
                      <ChevronDown size={14} className={expandedSubCards.has('alerts-sms') ? 'rotated' : ''} />
                    </div>
                    {expandedSubCards.has('alerts-sms') && (
                      <div className="sub-card-body">
                        <p className="form-hint"><Clock size={12} /> Sends immediately when a new lead arrives</p>
                        <div className="form-group">
                          <label>Send to (your phone)</label>
                          <input type="tel" value={alertToPhone} onChange={(e) => setAlertToPhone(e.target.value)} placeholder="+1234567890" />
                        </div>
                        <div className="form-group">
                          <label>Send from</label>
                          <div className="select-wrapper">
                            <select value={alertFromPhone} onChange={(e) => setAlertFromPhone(e.target.value)}>
                              <option value="+1 (813) 555-9999">+1 (813) 555-9999 (LeadBridge)</option>
                              <option value="+1 (727) 555-8888">+1 (727) 555-8888 (LeadBridge)</option>
                            </select>
                            <ChevronDown size={16} />
                          </div>
                          <button className="get-own-number-btn" disabled>
                            <Phone size={14} />
                            Get your own number
                            <span className="coming-soon-badge">Coming Soon</span>
                          </button>
                        </div>
                        <div className="form-group">
                          <label>Template</label>
                          <div className="select-wrapper">
                            <select value={alertTemplate} onChange={(e) => setAlertTemplate(e.target.value)}>
                              {MOCK_TEMPLATES.map(t => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                              ))}
                            </select>
                            <ChevronDown size={16} />
                          </div>
                          <div className="template-preview-container">
                            <div className="template-preview">
                              {MOCK_TEMPLATES.find(t => t.id === alertTemplate)?.content}
                            </div>
                          </div>
                        </div>
                        <div className="alert-test-section">
                          <button
                            className="btn btn-sm btn-secondary"
                            onClick={handleTestSms}
                            disabled={testSent}
                          >
                            {testSent ? <><CheckCircle size={14} /> Test Sent!</> : <><Send size={14} /> Send Test SMS</>}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Call Alert Sub-Card (Coming Soon) */}
                  <div className="sub-card sub-card-coming-soon">
                    <div className="sub-card-header" onClick={() => toggleSubCard('alerts-call')}>
                      <div className="sub-card-title">
                        <PhoneCall size={14} />
                        <span>Call Alert</span>
                        <span className="coming-soon-badge">Coming Soon</span>
                      </div>
                      <ChevronDown size={14} className={expandedSubCards.has('alerts-call') ? 'rotated' : ''} />
                    </div>
                    {expandedSubCards.has('alerts-call') && (
                      <div className="sub-card-body sub-card-disabled">
                        <p className="form-hint">Get a phone call when a new lead arrives. We'll connect you directly to the customer.</p>
                        <div className="form-group">
                          <label>Call to (your phone)</label>
                          <input type="tel" value="" placeholder="+1234567890" disabled />
                        </div>
                        <div className="form-group">
                          <label>Call from</label>
                          <div className="select-wrapper">
                            <select disabled>
                              <option>Select phone number</option>
                            </select>
                            <ChevronDown size={16} />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 3. Customer Texting — Coming Soon */}
          <div className="service-card coming-soon">
            <div className="service-card-header">
              <div className="service-card-icon"><MessageSquare size={22} /></div>
              <div className="service-card-info">
                <h3>Customer Texting <span className="coming-soon-badge">Coming Soon</span></h3>
                <p>Send a direct text to customers to increase response rate.</p>
              </div>
              <div className="service-card-toggle">
                <label className="toggle-switch">
                  <input type="checkbox" checked={false} disabled />
                  <span className="toggle-slider"></span>
                </label>
              </div>
            </div>
          </div>

          {/* 4. Instant Call Connect — Coming Soon */}
          <div className="service-card coming-soon">
            <div className="service-card-header">
              <div className="service-card-icon"><PhoneCall size={22} /></div>
              <div className="service-card-info">
                <h3>Instant Call Connect <span className="coming-soon-badge">Coming Soon</span></h3>
                <p>When a new lead arrives, we call you and connect you to the customer instantly.</p>
              </div>
              <div className="service-card-toggle">
                <label className="toggle-switch">
                  <input type="checkbox" checked={false} disabled />
                  <span className="toggle-slider"></span>
                </label>
              </div>
            </div>
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
    <div className="message-settings">
      <div className="settings-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Settings size={24} />
          <div>
            <h1>Message Templates</h1>
            <p>Manage your message templates</p>
          </div>
        </div>
      </div>

      <div className="templates-section">
        <div className="section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={{ fontSize: '16px', fontWeight: 600 }}>Your Templates</h2>
          <button className="btn btn-primary btn-sm">
            <Plus size={14} /> Create New
          </button>
        </div>

        <div className="templates-list" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {templates.map(template => (
            <div key={template.id} className={`template-card ${template.isDefault ? 'default' : ''}`} style={{
              border: '1px solid #e2e8f0',
              borderRadius: '10px',
              overflow: 'hidden',
              background: 'white',
            }}>
              <div className="template-header" style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '14px 16px',
                cursor: 'pointer',
              }} onClick={() => setExpandedTemplate(expandedTemplate === template.id ? null : template.id)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontWeight: 600, fontSize: '14px' }}>{template.name}</span>
                  {template.isDefault && (
                    <span className="default-badge" style={{ fontSize: '11px', background: '#dbeafe', color: '#2563eb', padding: '2px 8px', borderRadius: '10px' }}>Default</span>
                  )}
                </div>
                <div className="template-actions" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '12px', color: '#94a3b8' }}>Used {template.usageCount} times</span>
                  <button className="btn-icon" style={{ color: '#6366f1' }} onClick={(e) => { e.stopPropagation(); }}>
                    <Pencil size={14} />
                  </button>
                  <button className="btn-icon" style={{ color: '#ef4444' }} onClick={(e) => { e.stopPropagation(); handleDelete(template.id); }}>
                    <Trash2 size={14} />
                  </button>
                  {expandedTemplate === template.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
              </div>
              {expandedTemplate === template.id && (
                <div className="template-preview" style={{
                  padding: '0 16px 14px',
                  fontSize: '13px',
                  color: '#475569',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  background: '#f8fafc',
                  margin: '0 12px 12px',
                  borderRadius: '8px',
                  paddingTop: '12px',
                }}>
                  {template.content}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Variables Reference */}
      <div className="variables-section" style={{ marginTop: '32px' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '15px', fontWeight: 600, marginBottom: '8px' }}>
          <Info size={16} />
          Available Variables
        </h3>
        <p style={{ fontSize: '13px', color: '#64748b', marginBottom: '12px' }}>
          Use these variables in your templates. They will be replaced with actual values when the message is sent.
        </p>
        <div className="variables-list" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '8px' }}>
          {VARIABLES.map(v => (
            <div key={v.key} className="variable-item" style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '8px 12px',
              background: '#f8fafc',
              borderRadius: '6px',
              fontSize: '13px',
            }}>
              <code style={{ background: '#e2e8f0', padding: '2px 6px', borderRadius: '4px', fontSize: '12px', fontFamily: 'monospace', color: '#6366f1' }}>{v.key}</code>
              <span style={{ color: '#64748b' }}>{v.desc}</span>
            </div>
          ))}
        </div>
      </div>
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
    <div className="messages-page">
      {/* Leads Sidebar */}
      <aside className="leads-sidebar">
        <div className="sidebar-header">
          <button className="btn-icon" disabled title="Back">
            <Search size={20} />
          </button>
          <h2>Leads</h2>
          <button className="btn-icon" disabled title="Refresh">
            <RefreshCw size={20} />
          </button>
        </div>

        {/* Search Input */}
        <div className="leads-search">
          <Search size={16} />
          <input
            type="text"
            placeholder="Search by name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="leads-search-input"
          />
        </div>

        {/* Account Filter */}
        <div className="account-filter">
          <Building2 size={16} />
          <select
            value={selectedAccountId || 'all'}
            onChange={(e) => setSelectedAccountId(e.target.value === 'all' ? null : e.target.value)}
            className="account-filter-select"
          >
            <option value="all">All Accounts ({MOCK_LEADS.length})</option>
            {accounts.map(a => {
              const count = MOCK_LEADS.filter(l => l.account === a.businessName).length;
              return (
                <option key={a.id} value={a.id}>{a.businessName} ({count})</option>
              );
            })}
          </select>
        </div>

        {/* Date Filter */}
        <div className="account-filter">
          <Calendar size={16} />
          <select className="account-filter-select" disabled>
            <option>All Time</option>
          </select>
        </div>

        <div className="leads-list">
          {filteredLeads.map(lead => {
            const accountName = lead.account;
            return (
              <div
                key={lead.id}
                className={`lead-item ${selectedLeadId === lead.id ? 'selected' : ''}`}
                onClick={() => setSelectedLeadId(lead.id)}
              >
                <div className="lead-avatar">
                  <Users size={20} />
                </div>
                <div className="lead-preview">
                  <div className="lead-header">
                    <span className="lead-name">{lead.name}</span>
                    <span className="lead-time">{lead.time}</span>
                  </div>
                  <div className="lead-meta">
                    <span className="lead-category">{lead.category}</span>
                    <span className={`lead-status-badge status-${lead.status}`}>
                      {lead.status}
                    </span>
                  </div>
                  <span className="lead-account-badge current">
                    <Building2 size={12} />
                    {accountName}
                  </span>
                  <p className="lead-snippet">{lead.snippet}</p>
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      {/* Chat Area */}
      <main className="chat-area">
        {selectedLead ? (
          <>
            {/* Lead Info Header */}
            <div className="chat-header">
              <div className="lead-info-header">
                <div className="lead-avatar large">
                  <Users size={24} />
                </div>
                <div>
                  <div className="lead-name-row">
                    <h3>{selectedLead.name}</h3>
                    <span className={`status-badge status-${selectedLead.status}`}>
                      {selectedLead.status}
                    </span>
                  </div>
                  <p>{selectedLead.category}</p>
                </div>
              </div>
              <div className="lead-quick-info">
                <span className="quick-info-item">
                  <Phone size={16} />
                  {selectedLead.phone}
                </span>
                <span className="quick-info-item">
                  <MapPin size={16} />
                  {selectedLead.location}
                </span>
                <span className="quick-info-item">
                  <DollarSign size={16} />
                  {selectedLead.budget}
                </span>
                <span className="quick-info-item">
                  <Tag size={16} />
                  {selectedLead.category}
                </span>
                <button className="btn-icon resync-btn" disabled title="Resync messages">
                  <RefreshCw size={16} />
                </button>
              </div>
            </div>

            {/* Channel Filter Bar */}
            <div className="timeline-filter-bar">
              {(['all', 'platform', 'sms'] as const).map((filter) => (
                <button
                  key={filter}
                  className={`timeline-filter-btn ${channelFilter === filter ? 'active' : ''}`}
                  onClick={() => setChannelFilter(filter)}
                >
                  {filter === 'all' && 'All'}
                  {filter === 'platform' && 'Platform'}
                  {filter === 'sms' && 'SMS'}
                </button>
              ))}
            </div>

            {/* Messages */}
            <div className="messages-container">
              {filteredMessages.length > 0 ? filteredMessages.map(msg => (
                <div
                  key={msg.id}
                  className={`message ${msg.sender === 'pro' ? 'sent' : 'received'} channel-${msg.channel}`}
                >
                  <div className="message-channel-badge">
                    <span className={`channel-badge ${msg.channel}`}>
                      {msg.channel === 'sms' ? 'SMS' : 'Platform'}
                    </span>
                  </div>
                  <div className="message-content">{msg.text}</div>
                  <div className="message-footer">
                    <span className="message-time">{msg.time}</span>
                  </div>
                </div>
              )) : (
                <div className="no-messages">
                  <MessageSquare size={32} />
                  <p>No messages yet</p>
                  <small>Send a message to start the conversation</small>
                </div>
              )}
            </div>

            {/* Message Input */}
            <div className="message-input-container">
              <div className="channel-selector">
                <select
                  value={sendChannel}
                  onChange={(e) => setSendChannel(e.target.value as 'platform' | 'sms')}
                  className="channel-select"
                >
                  <option value="platform">Platform</option>
                  <option value="sms">SMS</option>
                </select>
              </div>
              <form className="message-input-form" onSubmit={(e) => e.preventDefault()}>
                <input
                  type="text"
                  placeholder="Type a message..."
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                />
                <button
                  type="submit"
                  className="btn send-btn btn-primary"
                  disabled={!messageText.trim()}
                >
                  <Send size={20} />
                </button>
              </form>
            </div>
          </>
        ) : (
          <div className="no-lead-selected">
            <MessageSquare size={64} />
            <h3>Select a lead</h3>
            <p>Choose a lead from the list to view details and send messages</p>
          </div>
        )}
      </main>

      {/* Right Details Panel */}
      {selectedLead && (
        <aside className="lead-details-sidebar">
          <div className="details-sidebar-header">
            <h3>Lead Details</h3>
          </div>
          <div className="details-sidebar-content">
            <div className="details-section">
              <h4>Communication Summary</h4>
              <div className="comm-summary">
                <div className="comm-summary-row">
                  <span className="comm-summary-label">Platform Messages</span>
                  <span className="comm-summary-value">{selectedLead.messages.filter(m => m.channel === 'platform').length}</span>
                </div>
                <div className="comm-summary-row">
                  <span className="comm-summary-label">SMS Sent</span>
                  <span className="comm-summary-value">{selectedLead.messages.filter(m => m.channel === 'sms').length}</span>
                </div>
              </div>
            </div>
            <div className="details-section">
              <h4>Contact Info</h4>
              <p className="detail-value"><Phone size={14} /> {selectedLead.phone}</p>
              <p className="detail-value"><MapPin size={14} /> {selectedLead.location}</p>
              <p className="detail-value"><DollarSign size={14} /> {selectedLead.budget}</p>
            </div>
            {selectedLead.messages[0] && (
              <div className="details-section">
                <h4>Customer Message</h4>
                <p className="customer-message">{selectedLead.messages[0].text}</p>
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

// ─── Phone View ───────────────────────────────────────────

export function DemoPhoneView() {
  const { accounts, selectedAccountId, setSelectedAccountId } = useDemoContext();
  return (
    <div className="notification-settings">
      <div className="settings-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Phone size={24} />
          <div>
            <h1>Business Line</h1>
            <p>Manage your phone numbers for SMS</p>
          </div>
        </div>
      </div>

      <AccountSelector accounts={accounts} selectedAccountId={selectedAccountId} setSelectedAccountId={setSelectedAccountId} showAllOption={false} />

      <div className="settings-content" style={{ marginTop: '20px' }}>
        <p style={{ fontSize: '14px', color: '#64748b', marginBottom: '20px' }}>
          Your business line is used for sending SMS notifications and customer texts. You can use our pool numbers or connect your own provider.
        </p>

        {/* Pool Phone */}
        <div className="settings-section" style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '20px', marginBottom: '16px' }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '16px', fontWeight: 600, marginBottom: '16px' }}>
            <PhoneCall size={18} />
            LeadBridge Pool Numbers
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {[
              { number: '+1 (813) 555-9999', provider: 'Sinch', area: '813 - Tampa' },
              { number: '+1 (727) 555-8888', provider: 'Sinch', area: '727 - St. Pete' },
            ].map((phone, i) => (
              <div key={i} style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '14px 16px',
                background: '#f8fafc',
                borderRadius: '8px',
                border: '1px solid #e2e8f0',
              }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '15px' }}>{phone.number}</div>
                  <div style={{ display: 'flex', gap: '10px', marginTop: '4px', fontSize: '12px', color: '#64748b' }}>
                    <span style={{ background: '#dbeafe', color: '#2563eb', padding: '1px 8px', borderRadius: '10px' }}>{phone.provider}</span>
                    <span>{phone.area}</span>
                  </div>
                </div>
                <span style={{ color: '#059669', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px' }}>
                  <CheckCircle size={14} /> Active
                </span>
              </div>
            ))}
          </div>
          <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '12px' }}>
            Pool numbers are shared across users in the same area. Messages are routed automatically.
          </p>
        </div>

        {/* Own Provider - Coming Soon */}
        <div className="settings-section" style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '20px', opacity: 0.6 }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '16px', fontWeight: 600, marginBottom: '8px' }}>
            <Phone size={18} />
            Connect Your Own Provider
            <span style={{ fontSize: '11px', background: '#dbeafe', color: '#2563eb', padding: '2px 8px', borderRadius: '10px' }}>Coming Soon</span>
          </h3>
          <p style={{ fontSize: '14px', color: '#94a3b8' }}>
            Use your own Twilio, Sinch, or other provider for a dedicated business number.
          </p>
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
    <div className="analytics-page" style={{ padding: '32px' }}>
      <div className="analytics-header" style={{ marginBottom: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <BarChart3 size={24} />
          <div>
            <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0 }}>Analytics</h1>
            <p style={{ fontSize: '14px', color: '#64748b', margin: 0 }}>Track your business performance</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="analytics-filters" style={{ display: 'flex', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Building2 size={16} style={{ color: '#64748b' }} />
          <select
            value={selectedAccountId || '__all__'}
            onChange={(e) => setSelectedAccountId(e.target.value === '__all__' ? null : e.target.value)}
            style={{ padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '13px' }}
          >
            <option value="__all__">All Accounts</option>
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.businessName}</option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Calendar size={16} style={{ color: '#64748b' }} />
          <select
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value)}
            style={{ padding: '8px 12px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '13px' }}
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All time</option>
          </select>
        </div>
      </div>

      {/* Metrics */}
      <div className="metrics-summary">
        {[
          { label: 'Total Leads', value: timeRange === '7d' ? '34' : timeRange === '30d' ? '127' : '458', icon: <Users size={24} />, color: 'blue' },
          { label: 'Avg Connection Time', value: '2m 15s', icon: <Clock size={24} />, color: 'green' },
          { label: 'Avg Messages/Lead', value: '4.2', icon: <MessageSquare size={24} />, color: 'purple' },
          { label: 'Customer Engagement', value: '67%', icon: <TrendingUp size={24} />, color: 'orange' },
        ].map((metric, i) => (
          <div key={i} className={`metric-card ${metric.color}`}>
            <div className={`metric-icon ${metric.color}`}>{metric.icon}</div>
            <div className="metric-details">
              <span className="metric-value">{metric.value}</span>
              <span className="metric-label">{metric.label}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Charts */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '16px', marginTop: '24px' }}>
        {/* Service Categories */}
        <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '20px', background: 'white' }}>
          <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '16px' }}>Service Categories</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {[
              { name: 'House Cleaning', pct: 42, color: '#6366f1' },
              { name: 'Office Cleaning', pct: 25, color: '#3b82f6' },
              { name: 'Move-Out Cleaning', pct: 18, color: '#8b5cf6' },
              { name: 'Deep Cleaning', pct: 15, color: '#a78bfa' },
            ].map((cat, i) => (
              <div key={i}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '4px' }}>
                  <span>{cat.name}</span>
                  <span style={{ fontWeight: 600 }}>{cat.pct}%</span>
                </div>
                <div style={{ height: '8px', background: '#f1f5f9', borderRadius: '4px', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${cat.pct}%`, background: cat.color, borderRadius: '4px' }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Response Times */}
        <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '20px', background: 'white' }}>
          <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '16px' }}>Response Times</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            {[
              { label: 'Your Avg', value: '2m 15s', desc: 'Auto reply speed' },
              { label: 'Customer Avg', value: '47m', desc: 'Time to respond' },
              { label: 'Fastest', value: '< 1m', desc: 'Best response' },
              { label: 'Slowest', value: '4h 12m', desc: 'Needs attention' },
            ].map((stat, i) => (
              <div key={i} style={{ padding: '12px', background: '#f8fafc', borderRadius: '8px', textAlign: 'center' }}>
                <div style={{ fontSize: '20px', fontWeight: 700, color: '#1e293b' }}>{stat.value}</div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', marginTop: '2px' }}>{stat.label}</div>
                <div style={{ fontSize: '11px', color: '#94a3b8' }}>{stat.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Top Locations */}
        <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '20px', background: 'white' }}>
          <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '16px' }}>Top Locations</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {[
              { name: 'Tampa, FL', count: 45, pct: 100 },
              { name: 'St. Petersburg, FL', count: 32, pct: 71 },
              { name: 'Brandon, FL', count: 24, pct: 53 },
              { name: 'Sarasota, FL', count: 18, pct: 40 },
              { name: 'Clearwater, FL', count: 8, pct: 18 },
            ].map((loc, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '13px', minWidth: '140px' }}>{loc.name}</span>
                <div style={{ flex: 1, height: '8px', background: '#f1f5f9', borderRadius: '4px', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${loc.pct}%`, background: '#3b82f6', borderRadius: '4px' }} />
                </div>
                <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', minWidth: '24px', textAlign: 'right' }}>{loc.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Settings View ────────────────────────────────────────

export function DemoSettingsView() {
  return (
    <div className="settings-page">
      <div className="settings-page-header">
        <Settings size={24} />
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0 }}>Settings</h1>
          <p style={{ fontSize: '14px', color: '#64748b', margin: 0 }}>Account, connections & subscription</p>
        </div>
      </div>

      {/* Section 1: Account Info */}
      <div className="settings-section-card">
        <h2 className="settings-section-title">Account Info</h2>
        <div className="settings-field-grid">
          <div className="settings-field">
            <label>Business Name</label>
            <div className="settings-field-value">ABC Cleaning Services</div>
          </div>
          <div className="settings-field">
            <label>Email</label>
            <div className="settings-field-value">demo@leadbridge.app</div>
          </div>
          <div className="settings-field">
            <label>Phone</label>
            <div className="settings-field-value">(813) 555-0100</div>
          </div>
          <div className="settings-field">
            <label>Time Zone</label>
            <div className="settings-field-value">Eastern (ET)</div>
          </div>
          <div className="settings-field">
            <label>Business Hours</label>
            <div className="settings-field-value">Mon–Fri, 8 AM – 6 PM</div>
          </div>
        </div>
      </div>

      {/* Section 2: Marketplace Connections */}
      <div className="settings-section-card">
        <h2 className="settings-section-title">Marketplace Connections</h2>

        {/* Thumbtack */}
        <div className="settings-connection-group">
          <div className="settings-connection-group-header">
            <div className="platform-logo thumbtack-logo" style={{ width: '28px', height: '28px', fontSize: '11px' }}>TT</div>
            <span style={{ fontWeight: 600, fontSize: '15px' }}>Thumbtack</span>
          </div>
          <div className="settings-connections-list">
            {MOCK_ACCOUNTS.map(account => (
              <div key={account.id} className="settings-connection-row">
                <div className="settings-connection-info">
                  <span className="settings-connection-name">{account.businessName}</span>
                  <span className="settings-connection-meta">ID: {account.businessId}</span>
                </div>
                <span className="connection-badge connected">
                  <CheckCircle size={12} /> Connected
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Yelp */}
        <div className="settings-connection-group" style={{ marginTop: '16px' }}>
          <div className="settings-connection-group-header">
            <div className="platform-logo yelp-logo" style={{ width: '28px', height: '28px', fontSize: '12px', fontWeight: 700 }}>Y</div>
            <span style={{ fontWeight: 600, fontSize: '15px' }}>Yelp</span>
            <span className="connection-badge coming-soon">Coming Soon</span>
          </div>
        </div>
      </div>

      {/* Section 3: Subscription & Billing */}
      <div className="settings-section-card">
        <h2 className="settings-section-title">Subscription & Billing</h2>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
          <div>
            <h3 style={{ fontSize: '18px', fontWeight: 700, margin: 0 }}>Pro Plan</h3>
            <span style={{
              display: 'inline-block',
              marginTop: '6px',
              fontSize: '12px',
              padding: '2px 10px',
              borderRadius: '10px',
              background: '#dcfce7',
              color: '#059669',
              fontWeight: 600,
            }}>Active</span>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b' }}>$29</div>
            <div style={{ fontSize: '13px', color: '#94a3b8' }}>/month</div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '14px', color: '#475569', marginBottom: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Next billing date</span>
            <span style={{ fontWeight: 600 }}>March 15, 2026</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Connected accounts</span>
            <span style={{ fontWeight: 600 }}>2 of 5</span>
          </div>
        </div>

        <div style={{ marginBottom: '20px', display: 'flex', gap: '10px' }}>
          <button className="btn btn-secondary btn-sm">Manage Subscription</button>
          <button className="btn btn-secondary btn-sm" style={{ color: '#ef4444' }}>Cancel Plan</button>
        </div>

        {/* Payment Method */}
        <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: '16px' }}>
          <h4 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '10px' }}>Payment Method</h4>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '12px 16px',
            background: '#f8fafc',
            borderRadius: '8px',
            border: '1px solid #e2e8f0',
          }}>
            <CreditCard size={20} style={{ color: '#6366f1' }} />
            <div>
              <div style={{ fontSize: '14px', fontWeight: 600 }}>Visa ending in 4242</div>
              <div style={{ fontSize: '12px', color: '#94a3b8' }}>Expires 12/2027</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
