import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2, Link2, CheckCircle, AlertCircle, Loader2, ExternalLink,
  Download, X, Unlink, Trash2, Mail, Pencil, Check, RefreshCw,
  ChevronDown, ChevronUp,
} from 'lucide-react';
import type { SavedAccount } from '../../types';

interface ImportResult {
  id: string;
  success: boolean;
  isNew?: boolean;
  error?: string;
}

interface AccountManagementProps {
  savedAccounts: SavedAccount[];
  connecting: boolean;
  // Handlers (kept in parent Dashboard)
  onConnectThumbtack: () => void;
  onDisconnectWebhook: (account: SavedAccount) => void;
  onReconnectWebhook: (account: SavedAccount) => void;
  onRemoveAccount: (account: { id: string; businessName: string }) => void;
  onUpdateEmail: (accountId: string, email: string) => Promise<void>;
  onImportNegotiations: (accountId: string, ids: string) => void;
  // Import state (controlled by parent)
  importing: boolean;
  importResults: ImportResult[];
  importTotal: number;
  showImportResults: boolean;
  selectedImportAccountId: string | null;
  onSelectImportAccount: (id: string) => void;
  importIds: string;
  onImportIdsChange: (ids: string) => void;
  onClearImport: () => void;
  // Webhook toggling
  togglingWebhookId: string | null;
  removingAccountId: string | null;
  // Collapse state
  defaultCollapsed?: boolean;
}

const COLLAPSE_KEY = 'dashboard_manage_collapsed';

export default function AccountManagement({
  savedAccounts,
  connecting,
  onConnectThumbtack,
  onDisconnectWebhook,
  onReconnectWebhook,
  onRemoveAccount,
  onUpdateEmail,
  onImportNegotiations,
  importing,
  importResults,
  importTotal,
  showImportResults,
  selectedImportAccountId,
  onSelectImportAccount,
  importIds,
  onImportIdsChange,
  onClearImport,
  togglingWebhookId,
  removingAccountId,
  defaultCollapsed = true,
}: AccountManagementProps) {
  const navigate = useNavigate();

  // Collapse state
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem(COLLAPSE_KEY);
      return stored !== null ? stored === 'true' : defaultCollapsed;
    } catch {
      return defaultCollapsed;
    }
  });

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(COLLAPSE_KEY, String(next));
  };

  // Email editing local state
  const [editingEmailId, setEditingEmailId] = useState<string | null>(null);
  const [editEmailValue, setEditEmailValue] = useState('');
  const [savingEmail, setSavingEmail] = useState(false);

  const startEditingEmail = (account: { id: string; emailHint?: string }) => {
    setEditingEmailId(account.id);
    setEditEmailValue(account.emailHint || '');
  };

  const cancelEditingEmail = () => {
    setEditingEmailId(null);
    setEditEmailValue('');
  };

  const saveEmail = async (accountId: string) => {
    setSavingEmail(true);
    try {
      await onUpdateEmail(accountId, editEmailValue);
      setEditingEmailId(null);
      setEditEmailValue('');
    } finally {
      setSavingEmail(false);
    }
  };

  return (
    <section className="manage-accounts-section" id="manage-accounts">
      <div className="manage-accounts-header" onClick={toggleCollapsed}>
        <h2>Manage Accounts</h2>
        {collapsed ? <ChevronDown size={22} /> : <ChevronUp size={22} />}
      </div>

      <div className={`manage-accounts-content ${collapsed ? 'collapsed' : ''}`}>
        {/* Platform Connections */}
        <div className="dashboard-section" style={{ border: 'none', padding: 0 }}>
          <h3>Platform Connections</h3>
          <div className="platform-card">
            <div className="platform-info">
              <div className="platform-logo thumbtack-logo">TT</div>
              <div>
                <h3>Thumbtack</h3>
                <p>Connect your Thumbtack Pro accounts to receive and manage leads</p>
              </div>
            </div>
            <div className="platform-actions">
              <button
                className="btn btn-primary"
                onClick={onConnectThumbtack}
                disabled={connecting}
              >
                {connecting ? (
                  <>
                    <Loader2 className="spinner" size={18} />
                    Connecting...
                  </>
                ) : (
                  <>
                    <Link2 size={18} />
                    {savedAccounts.length > 0 ? 'Add Another Account' : 'Connect Thumbtack'}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Accounts Grid */}
        {savedAccounts.length > 0 && (
          <div className="dashboard-section" style={{ border: 'none', padding: 0 }}>
            <h3>Your Accounts</h3>
            <p className="section-description">
              All accounts are receiving leads via webhooks. Click "View Leads" to see messages.
            </p>
            <div className="businesses-grid">
              {savedAccounts.map((account) => (
                <div key={account.id} className="business-card">
                  <div className={`account-status-badge ${account.webhookId ? 'connected' : 'disconnected'}`}>
                    {account.webhookId ? (
                      <><CheckCircle size={12} /> Connected</>
                    ) : (
                      <><AlertCircle size={12} /> Disconnected</>
                    )}
                  </div>
                  {account.imageUrl ? (
                    <img src={account.imageUrl} alt={account.businessName} className="business-image" />
                  ) : (
                    <div className="business-image-placeholder"><Building2 size={32} /></div>
                  )}
                  <div className="business-info">
                    <h3>{account.businessName}</h3>
                    <p className="business-id">ID: {account.businessId}</p>
                    {editingEmailId === account.id ? (
                      <div className="email-edit-row">
                        <Mail size={14} />
                        <input
                          type="email"
                          value={editEmailValue}
                          onChange={(e) => setEditEmailValue(e.target.value)}
                          placeholder="account@email.com"
                          className="email-input"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveEmail(account.id);
                            if (e.key === 'Escape') cancelEditingEmail();
                          }}
                        />
                        <button
                          className="btn-icon btn-success-subtle"
                          onClick={() => saveEmail(account.id)}
                          disabled={savingEmail}
                          title="Save"
                        >
                          {savingEmail ? <Loader2 className="spinner" size={14} /> : <Check size={14} />}
                        </button>
                        <button
                          className="btn-icon btn-secondary-subtle"
                          onClick={cancelEditingEmail}
                          title="Cancel"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <div className="email-display-row" onClick={() => startEditingEmail(account)}>
                        <Mail size={14} />
                        <span className="email-hint">{account.emailHint || 'Add email...'}</span>
                        <Pencil size={12} className="edit-icon" />
                      </div>
                    )}
                  </div>
                  <div className="business-actions">
                    <button
                      className="btn btn-primary"
                      onClick={() => navigate(`/messages?account=${account.businessId}`)}
                    >
                      <ExternalLink size={16} /> View Leads
                    </button>
                    <button
                      className={`btn-icon ${account.webhookId ? 'btn-secondary-subtle' : 'btn-success-subtle'}`}
                      onClick={() => account.webhookId
                        ? onDisconnectWebhook(account)
                        : onReconnectWebhook(account)
                      }
                      disabled={togglingWebhookId === account.id || connecting}
                      title={account.webhookId ? 'Disconnect webhooks' : 'Reconnect (re-authenticate with Thumbtack)'}
                    >
                      {togglingWebhookId === account.id ? (
                        <Loader2 className="spinner" size={16} />
                      ) : account.webhookId ? (
                        <Unlink size={16} />
                      ) : (
                        <RefreshCw size={16} />
                      )}
                    </button>
                    <button
                      className="btn-icon btn-danger-subtle"
                      onClick={() => onRemoveAccount(account)}
                      disabled={removingAccountId === account.id}
                      title="Delete account"
                    >
                      {removingAccountId === account.id ? (
                        <Loader2 className="spinner" size={16} />
                      ) : (
                        <Trash2 size={16} />
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Import Negotiations */}
        {savedAccounts.length > 0 && (
          <div className="dashboard-section" style={{ border: 'none', padding: 0 }}>
            <h3>Import Negotiations</h3>
            <p className="section-description">
              Select an account and import existing negotiations by ID.
            </p>
            <div className="import-section">
              <div className="import-account-selection" style={{ marginBottom: '16px' }}>
                <label style={{ fontWeight: 500, marginBottom: '8px', display: 'block' }}>
                  Select account to import from:
                </label>
                <div className="import-account-cards" style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                  {savedAccounts.map((account) => {
                    const isSelected = selectedImportAccountId === account.id;
                    return (
                      <div
                        key={account.id}
                        onClick={() => onSelectImportAccount(account.id)}
                        style={{
                          padding: '12px 16px',
                          border: isSelected ? '2px solid var(--primary)' : '1px solid var(--border)',
                          borderRadius: '8px',
                          cursor: 'pointer',
                          background: isSelected ? 'var(--primary-light, #f0f7ff)' : 'var(--surface)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          transition: 'all 0.15s ease',
                        }}
                      >
                        {account.imageUrl ? (
                          <img
                            src={account.imageUrl}
                            alt=""
                            style={{ width: '28px', height: '28px', borderRadius: '4px', objectFit: 'cover' }}
                          />
                        ) : (
                          <Building2 size={28} style={{ color: 'var(--text-secondary)' }} />
                        )}
                        <div>
                          <div style={{ fontWeight: 500, fontSize: '14px' }}>{account.businessName}</div>
                          {account.emailHint && (
                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{account.emailHint}</div>
                          )}
                        </div>
                        {isSelected && (
                          <CheckCircle size={18} style={{ color: 'var(--primary)', marginLeft: 'auto' }} />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {!selectedImportAccountId && (
                <div style={{
                  background: '#fef3c7', border: '1px solid #fde68a', borderRadius: '8px',
                  padding: '12px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px',
                }}>
                  <AlertCircle size={18} style={{ color: '#d97706', flexShrink: 0 }} />
                  <span style={{ fontSize: '14px', color: '#92400e' }}>
                    Please select an account above before importing negotiations.
                  </span>
                </div>
              )}

              {selectedImportAccountId && (
                <div style={{
                  background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: '8px',
                  padding: '12px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px',
                }}>
                  <CheckCircle size={18} style={{ color: '#059669', flexShrink: 0 }} />
                  <span style={{ fontSize: '14px', color: '#065f46' }}>
                    Importing for: <strong>{savedAccounts.find(a => a.id === selectedImportAccountId)?.businessName}</strong>
                  </span>
                </div>
              )}

              <textarea
                className="import-textarea"
                placeholder={'Paste negotiation IDs here...\n\nExample:\nabc123\ndef456\nghi789\n\nOr: abc123, def456, ghi789'}
                value={importIds}
                onChange={(e) => onImportIdsChange(e.target.value)}
                disabled={importing || !selectedImportAccountId}
                rows={6}
              />

              <div className="import-actions">
                <button
                  className="btn btn-primary"
                  onClick={() => selectedImportAccountId && onImportNegotiations(selectedImportAccountId, importIds)}
                  disabled={importing || !importIds.trim() || !selectedImportAccountId}
                >
                  {importing ? (
                    <><Loader2 className="spinner" size={18} /> Importing...</>
                  ) : (
                    <><Download size={18} /> Import Negotiations</>
                  )}
                </button>
                {importIds && !importing && (
                  <button className="btn btn-secondary" onClick={onClearImport}>
                    <X size={18} /> Clear
                  </button>
                )}
              </div>

              {/* Import Progress */}
              {importing && importTotal > 0 && (
                <div style={{ marginTop: '16px', marginBottom: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ fontSize: '14px', fontWeight: 500 }}>Importing leads...</span>
                    <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
                      {importResults.length} / {importTotal}
                    </span>
                  </div>
                  <div style={{
                    width: '100%', height: '8px', background: 'var(--border, #e5e7eb)',
                    borderRadius: '4px', overflow: 'hidden',
                  }}>
                    <div style={{
                      width: `${(importResults.length / importTotal) * 100}%`,
                      height: '100%', background: 'var(--primary, #3b82f6)',
                      borderRadius: '4px', transition: 'width 0.3s ease',
                    }} />
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    {importResults.filter(r => r.success).length} successful, {importResults.filter(r => !r.success).length} failed
                  </div>
                </div>
              )}

              {/* Import Results */}
              {showImportResults && importResults.length > 0 && !importing && (
                <div className="import-results">
                  <h4>Import Results ({importResults.length} / {importTotal} processed)</h4>
                  <div className="results-list">
                    {importResults.map((result, idx) => (
                      <div key={idx} className={`result-item ${result.success ? (result.isNew ? 'success' : 'duplicate') : 'failed'}`}>
                        <span className="result-id">{result.id}</span>
                        {result.success ? (
                          <span className="result-status">
                            <CheckCircle size={16} className={`result-icon ${result.isNew ? 'success' : 'duplicate'}`} />
                            {result.isNew ? 'New' : 'Already exists'}
                          </span>
                        ) : (
                          <span className="result-error">
                            <AlertCircle size={16} className="result-icon failed" />
                            {result.error}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
