import { useState } from 'react';
import {
  Home, MessageSquare, BarChart3, Settings, Phone, Briefcase,
  CreditCard, LogOut, Menu, X, Building2, CheckCircle, AlertCircle,
  Users, TrendingUp, Clock, Zap, Bell, PhoneCall, Link2, ExternalLink,
  Download, ChevronDown, ChevronUp,
} from 'lucide-react';
import { Link as RouterLink } from 'react-router-dom';
import '../App.css';

// Mock data
const MOCK_ACCOUNT = {
  id: 'demo-1',
  businessName: 'ABC Cleaning Services',
  businessId: 'biz_abc123',
  imageUrl: null as string | null,
  webhookId: 'wh_demo_123',
  emailHint: 'contact@abccleaning.com',
};

const MOCK_ACCOUNT_2 = {
  id: 'demo-2',
  businessName: 'XYZ Home Repairs',
  businessId: 'biz_xyz456',
  imageUrl: null as string | null,
  webhookId: 'wh_demo_456',
  emailHint: 'info@xyzhome.com',
};

const NAV_ITEMS = [
  { icon: <Home size={20} />, label: 'Overview', active: true },
  { icon: <Briefcase size={20} />, label: 'Automation' },
  { icon: <Settings size={20} />, label: 'Templates' },
  { icon: <MessageSquare size={20} />, label: 'Lead Activity' },
  { icon: <Phone size={20} />, label: 'Business Line' },
  { icon: <BarChart3 size={20} />, label: 'Insights' },
];

export function Demo() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(MOCK_ACCOUNT.id);
  const [importCollapsed, setImportCollapsed] = useState(true);

  const accounts = [MOCK_ACCOUNT, MOCK_ACCOUNT_2];
  const selectedAccount = accounts.find(a => a.id === selectedAccountId);
  const displayAccounts = selectedAccountId
    ? accounts.filter(a => a.id === selectedAccountId)
    : accounts;

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <nav className={`sidebar-nav ${mobileMenuOpen ? 'open' : ''}`}>
        <div className="nav-brand">
          <img src="/LeadBridge_Logo.png" alt="LeadBridge" className="nav-logo" />
        </div>
        <div className="nav-links">
          {NAV_ITEMS.map((item, i) => (
            <a
              key={i}
              className={`nav-link ${item.active ? 'active' : ''}`}
              href="#"
              onClick={(e) => { e.preventDefault(); setMobileMenuOpen(false); }}
            >
              {item.icon}
              <span>{item.label}</span>
            </a>
          ))}
          <div className="nav-separator"></div>
          <div className="nav-section-label">Account</div>
          <a className="nav-link" href="#" onClick={(e) => { e.preventDefault(); setMobileMenuOpen(false); }}>
            <CreditCard size={20} />
            <span>Billing</span>
          </a>
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
        <button className="mobile-menu-btn" onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
          {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>

        <div className="dashboard">
          {/* Header */}
          <div className="dashboard-header">
            <h1>Overview</h1>
            <p>Welcome back, Demo User</p>
          </div>

          {/* Demo Banner */}
          <div style={{
            background: 'linear-gradient(135deg, #dbeafe, #ede9fe)',
            border: '1px solid #93c5fd',
            borderRadius: '10px',
            padding: '14px 18px',
            marginBottom: '20px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            fontSize: '14px',
          }}>
            <AlertCircle size={18} style={{ color: '#3b82f6', flexShrink: 0 }} />
            <span style={{ color: '#1e40af' }}>
              This is a <strong>demo page</strong> with mock data — no login required.
              <RouterLink to="/login" style={{ marginLeft: '8px', color: '#2563eb', fontWeight: 600 }}>
                Sign in for real data
              </RouterLink>
            </span>
          </div>

          {/* Account Selector */}
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
                <option value="__all__">All Accounts</option>
              </select>
              <ChevronDown size={16} className="dropdown-chevron" />
            </div>
            {selectedAccount?.webhookId && (
              <span className="account-badge connected">
                <CheckCircle size={12} /> Connected
              </span>
            )}
          </div>

          {/* Account Management */}
          <section className="manage-accounts-section" id="manage-accounts">
            <div className="platform-card compact">
              <div className="platform-info">
                <div className="platform-logo thumbtack-logo">TT</div>
                <div>
                  <h3>Thumbtack</h3>
                  <p>Connect your Thumbtack Pro accounts</p>
                </div>
              </div>
              <div className="platform-actions">
                <button className="btn btn-primary btn-sm" disabled>
                  <Link2 size={14} /> Add Account
                </button>
              </div>
            </div>

            <div className="account-cards-compact">
              {displayAccounts.map((account) => (
                <div key={account.id} className="account-card-compact">
                  <div className="account-card-left">
                    <div className="account-card-avatar placeholder"><Building2 size={20} /></div>
                    <div className="account-card-details">
                      <div className="account-card-name">{account.businessName}</div>
                      <div className="account-card-meta">
                        <span className="account-card-id">ID: {account.businessId}</span>
                        <span className="account-card-status connected">
                          <CheckCircle size={10} /> Connected
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="account-card-actions">
                    <button className="btn btn-primary btn-sm" disabled>
                      <ExternalLink size={14} /> Leads
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Import Negotiations - collapsible */}
            <div className="import-section-collapsible">
              <div className="import-section-header" onClick={() => setImportCollapsed(!importCollapsed)}>
                <h3><Download size={16} /> Import Negotiations</h3>
                {importCollapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
              </div>
              <div className={`import-section-content ${importCollapsed ? 'collapsed' : ''}`}>
                {selectedAccountId ? (
                  <>
                    <div style={{
                      background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: '8px',
                      padding: '10px 12px', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px',
                    }}>
                      <CheckCircle size={14} style={{ color: '#059669', flexShrink: 0 }} />
                      <span style={{ color: '#065f46' }}>
                        Importing for: <strong>{selectedAccount?.businessName}</strong>
                      </span>
                    </div>
                    <textarea className="import-textarea" placeholder="Paste negotiation IDs here..." rows={3} disabled />
                    <div className="import-actions">
                      <button className="btn btn-primary btn-sm" disabled>
                        <Download size={14} /> Import
                      </button>
                    </div>
                  </>
                ) : (
                  <div style={{
                    background: '#fef3c7', border: '1px solid #fde68a', borderRadius: '8px',
                    padding: '12px', display: 'flex', alignItems: 'center', gap: '10px',
                  }}>
                    <AlertCircle size={18} style={{ color: '#d97706', flexShrink: 0 }} />
                    <span style={{ fontSize: '14px', color: '#92400e' }}>
                      Select a specific account from the dropdown above to import negotiations.
                    </span>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* System Health */}
          <section className="dashboard-section">
            <h2>System Health</h2>
            <div className="health-status-grid">
              {[
                { label: 'Auto Reply', icon: <Zap size={20} />, enabled: true },
                { label: 'Customer SMS', icon: <MessageSquare size={20} />, enabled: true },
                { label: 'Call Connect', icon: <Phone size={20} />, enabled: false, comingSoon: true },
                { label: 'Lead Alerts', icon: <Bell size={20} />, enabled: true },
              ].map((card, i) => (
                <div key={i} className={`health-status-card ${card.comingSoon ? 'coming-soon' : card.enabled ? 'on' : 'off'}`}>
                  <div className={`health-card-icon ${card.comingSoon ? '' : card.enabled ? 'on' : 'off'}`}>
                    {card.icon}
                  </div>
                  <span className="health-card-label">{card.label}</span>
                  {card.comingSoon ? (
                    <span className="status-indicator coming-soon">Coming Soon</span>
                  ) : (
                    <span className={`status-indicator ${card.enabled ? 'on' : 'off'}`}>
                      {card.enabled ? 'ON' : 'OFF'}
                    </span>
                  )}
                </div>
              ))}
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
      </main>
    </div>
  );
}
