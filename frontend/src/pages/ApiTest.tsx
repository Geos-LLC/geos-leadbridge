import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, FlaskConical, Loader2, AlertCircle, X, CheckCircle, XCircle,
  Send, Plus, Trash2, ChevronDown, ChevronUp, MessageSquare, UserPlus, Search,
} from 'lucide-react';
import { testApi } from '../services/api';
import type { SimulateWebhookRequest, SimulationResult, TestLead, TestUser, TestAccount, AccountDiagnostics } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { notify } from '../store/notificationStore';

const DEFAULT_DETAILS = [
  { question: 'How many bedrooms?', answer: '3' },
  { question: 'How many bathrooms?', answer: '2' },
  { question: 'Do you have pets?', answer: 'Yes - 1 dog' },
  { question: 'How often?', answer: 'One-time' },
  { question: 'Any add-ons?', answer: 'Inside fridge, Inside oven' },
  { question: 'Preferred date?', answer: 'Next Monday' },
];

export function ApiTest() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);

  // Admin check
  useEffect(() => {
    if (user?.role !== 'ADMIN') {
      notify.error('Access Denied', 'You must be an admin to access this page');
      navigate('/');
    }
  }, [user, navigate]);

  // User selection
  const [users, setUsers] = useState<TestUser[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [loadingUsers, setLoadingUsers] = useState(true);

  // Account selection
  const [accounts, setAccounts] = useState<TestAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [loadingAccounts, setLoadingAccounts] = useState(false);

  // Account diagnostics
  const [diagnostics, setDiagnostics] = useState<AccountDiagnostics | null>(null);
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(false);

  const [eventType, setEventType] = useState<'NegotiationCreatedV4' | 'MessageCreatedV4'>('NegotiationCreatedV4');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // New Lead form
  const [leadForm, setLeadForm] = useState({
    customerFirstName: 'Test',
    customerLastName: 'Customer',
    customerPhone: '+15555555555',
    category: 'House Cleaning',
    city: 'Tampa',
    state: 'FL',
    zipCode: '33602',
    message: 'I need a deep cleaning for my 3-bedroom apartment.',
    estimateTotal: '150',
    details: [...DEFAULT_DETAILS],
  });

  // Message form
  const [messageForm, setMessageForm] = useState({
    messageText: 'Hi, I am interested in your cleaning service. When are you available?',
    negotiationId: '',
    messageSender: 'Customer' as 'Customer' | 'Pro',
    customerFirstName: 'Test',
    customerLastName: 'Customer',
    customerPhone: '+15555555555',
  });

  // Existing leads for message form
  const [existingLeads, setExistingLeads] = useState<TestLead[]>([]);
  const [loadingLeads, setLoadingLeads] = useState(false);

  // Results history
  const [results, setResults] = useState<SimulationResult[]>([]);
  const [expandedPayload, setExpandedPayload] = useState<number | null>(null);

  // Search debounce
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);

  const loadUsers = useCallback(async (search?: string) => {
    try {
      setLoadingUsers(true);
      const res = await testApi.getUsers(search);
      setUsers(res.users || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load users');
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  function handleUserSearch(value: string) {
    setUserSearch(value);
    if (searchTimeout) clearTimeout(searchTimeout);
    setSearchTimeout(setTimeout(() => loadUsers(value || undefined), 300));
  }

  // Load accounts when user is selected
  useEffect(() => {
    if (!selectedUserId) {
      setAccounts([]);
      setSelectedAccountId('');
      return;
    }
    (async () => {
      try {
        setLoadingAccounts(true);
        const res = await testApi.getUserAccounts(selectedUserId);
        setAccounts(res.accounts || []);
        if (res.accounts?.length > 0) {
          setSelectedAccountId(res.accounts[0].id);
        } else {
          setSelectedAccountId('');
        }
      } catch {
        setAccounts([]);
        setSelectedAccountId('');
      } finally {
        setLoadingAccounts(false);
      }
    })();
  }, [selectedUserId]);

  // Load diagnostics when account changes
  useEffect(() => {
    if (!selectedAccountId) {
      setDiagnostics(null);
      return;
    }
    (async () => {
      try {
        setLoadingDiagnostics(true);
        const diag = await testApi.getDiagnostics(selectedAccountId);
        setDiagnostics(diag);
      } catch {
        setDiagnostics(null);
      } finally {
        setLoadingDiagnostics(false);
      }
    })();
  }, [selectedAccountId]);

  // Load leads when account changes and event type is message
  useEffect(() => {
    if (selectedAccountId && selectedUserId && eventType === 'MessageCreatedV4') {
      loadLeads();
    }
  }, [selectedAccountId, selectedUserId, eventType]);

  async function loadLeads() {
    if (!selectedAccountId || !selectedUserId) return;
    try {
      setLoadingLeads(true);
      const res = await testApi.getLeadsForAccount(selectedAccountId, selectedUserId);
      setExistingLeads(res.leads || []);
    } catch {
      setExistingLeads([]);
    } finally {
      setLoadingLeads(false);
    }
  }

  async function handleSimulate() {
    if (!selectedUserId) {
      setError('Please select a client');
      return;
    }
    if (!selectedAccountId) {
      setError('Please select an account');
      return;
    }

    try {
      setSubmitting(true);
      setError(null);

      const request: SimulateWebhookRequest = {
        targetUserId: selectedUserId,
        savedAccountId: selectedAccountId,
        eventType,
      };

      if (eventType === 'NegotiationCreatedV4') {
        request.customerFirstName = leadForm.customerFirstName;
        request.customerLastName = leadForm.customerLastName;
        request.customerPhone = leadForm.customerPhone;
        request.category = leadForm.category;
        request.city = leadForm.city;
        request.state = leadForm.state;
        request.zipCode = leadForm.zipCode;
        request.message = leadForm.message;
        request.estimateTotal = leadForm.estimateTotal;
        request.details = leadForm.details.filter(d => d.question.trim() && d.answer.trim());
      } else {
        request.messageText = messageForm.messageText;
        request.negotiationId = messageForm.negotiationId || undefined;
        request.messageSender = messageForm.messageSender;
        request.customerFirstName = messageForm.customerFirstName;
        request.customerLastName = messageForm.customerLastName;
        request.customerPhone = messageForm.customerPhone;
      }

      const result = await testApi.simulate(request);
      setResults(prev => [result, ...prev]);

      // Refresh diagnostics after simulation
      testApi.getDiagnostics(selectedAccountId).then(setDiagnostics).catch(() => {});

      if (result.success) {
        setSuccessMessage(`${eventType === 'NegotiationCreatedV4' ? 'New lead' : 'Message'} simulated successfully`);
        setTimeout(() => setSuccessMessage(null), 4000);
        if (eventType === 'NegotiationCreatedV4') {
          loadLeads();
        }
      } else {
        setError(`Simulation failed: ${result.results.webhookError || 'Unknown error'}`);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to simulate webhook');
    } finally {
      setSubmitting(false);
    }
  }

  function addDetail() {
    setLeadForm(prev => ({
      ...prev,
      details: [...prev.details, { question: '', answer: '' }],
    }));
  }

  function removeDetail(index: number) {
    setLeadForm(prev => ({
      ...prev,
      details: prev.details.filter((_, i) => i !== index),
    }));
  }

  function updateDetail(index: number, field: 'question' | 'answer', value: string) {
    setLeadForm(prev => ({
      ...prev,
      details: prev.details.map((d, i) => i === index ? { ...d, [field]: value } : d),
    }));
  }

  if (user?.role !== 'ADMIN') return null;

  const selectedUser = users.find(u => u.id === selectedUserId);

  return (
    <div className="api-test">
      <div className="settings-header">
        <button className="btn-icon" onClick={() => navigate(-1)}><ArrowLeft size={20} /></button>
        <h1><FlaskConical size={24} /> API Test</h1>
      </div>

      {error && (
        <div className="error-message">
          <AlertCircle size={16} /> {error}
          <button className="btn-icon" onClick={() => setError(null)}><X size={16} /></button>
        </div>
      )}

      {successMessage && (
        <div className="success-message">
          <CheckCircle size={16} /> {successMessage}
        </div>
      )}

      <div className="settings-content">
        {/* Client (User) Selector */}
        <div className="settings-section">
          <div className="section-header"><h2>Select Client</h2></div>
          <div className="form-group">
            <label>Search Users</label>
            <div style={{ position: 'relative' }}>
              <Search size={16} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)' }} />
              <input
                type="text"
                placeholder="Search by name or email..."
                value={userSearch}
                onChange={e => handleUserSearch(e.target.value)}
                style={{ paddingLeft: 36 }}
              />
            </div>
          </div>
          <div className="form-group">
            <label>Client</label>
            <div className="select-wrapper">
              <select
                value={selectedUserId}
                onChange={e => setSelectedUserId(e.target.value)}
                disabled={loadingUsers}
              >
                <option value="">Select a client...</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>
                    {u.name || u.email} ({u.email}){u.subscriptionTier ? ` - ${u.subscriptionTier}` : ''}
                  </option>
                ))}
              </select>
            </div>
            {loadingUsers && <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Loading users...</span>}
          </div>
        </div>

        {/* Account Selector */}
        {selectedUserId && (
          <div className="settings-section">
            <div className="section-header">
              <h2>Select Account</h2>
              {selectedUser && <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>for {selectedUser.name || selectedUser.email}</span>}
            </div>
            <div className="form-group">
              <label>Business Account</label>
              <div className="select-wrapper">
                <select
                  value={selectedAccountId}
                  onChange={e => setSelectedAccountId(e.target.value)}
                  disabled={loadingAccounts}
                >
                  <option value="">Select an account...</option>
                  {accounts.map(acc => (
                    <option key={acc.id} value={acc.id}>
                      {acc.businessName}{!acc.webhookId ? ' (no webhook)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              {loadingAccounts && <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Loading accounts...</span>}
              {!loadingAccounts && accounts.length === 0 && selectedUserId && (
                <span style={{ fontSize: '12px', color: 'var(--danger)' }}>This client has no saved accounts</span>
              )}
            </div>
          </div>
        )}

        {/* Account Diagnostics */}
        {selectedAccountId && diagnostics && !loadingDiagnostics && (
          <div className={`settings-section`} style={{
            borderLeft: `3px solid ${diagnostics.healthy ? 'var(--success)' : 'var(--danger)'}`,
          }}>
            <div className="section-header">
              <h2>
                {diagnostics.healthy
                  ? <><CheckCircle size={18} style={{ color: 'var(--success)', verticalAlign: -3, marginRight: 6 }} />Account Healthy</>
                  : <><AlertCircle size={18} style={{ color: 'var(--danger)', verticalAlign: -3, marginRight: 6 }} />Account Issues</>}
              </h2>
            </div>

            {diagnostics.issues.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
                {diagnostics.issues.map((issue, i) => (
                  <div key={i} style={{ fontSize: '13px', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <XCircle size={14} style={{ flexShrink: 0 }} /> {issue}
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', fontSize: '13px' }}>
              <div>
                {diagnostics.platform.connected ? <CheckCircle size={12} className="check" /> : <XCircle size={12} className="cross" />}
                {' '}Thumbtack connected
              </div>
              <div>
                {diagnostics.account.hasWebhook ? <CheckCircle size={12} className="check" /> : <XCircle size={12} className="cross" />}
                {' '}Webhook registered
              </div>
              <div>
                {diagnostics.notifications.settingsExist ? <CheckCircle size={12} className="check" /> : <XCircle size={12} className="cross" />}
                {' '}Notification settings
              </div>
              <div>
                {diagnostics.notifications.hasCallioApiKey ? <CheckCircle size={12} className="check" /> : <XCircle size={12} className="cross" />}
                {' '}Callio API key
              </div>
              <div>
                {diagnostics.notifications.newLeadRules > 0 ? <CheckCircle size={12} className="check" /> : <XCircle size={12} className="cross" />}
                {' '}{diagnostics.notifications.newLeadRules} new lead rule{diagnostics.notifications.newLeadRules !== 1 ? 's' : ''}
              </div>
              <div>
                {diagnostics.notifications.customerReplyRules > 0 ? <CheckCircle size={12} className="check" /> : <XCircle size={12} className="cross" />}
                {' '}{diagnostics.notifications.customerReplyRules} reply rule{diagnostics.notifications.customerReplyRules !== 1 ? 's' : ''}
              </div>
              <div>
                {diagnostics.automation.totalRules > 0 ? <CheckCircle size={12} className="check" /> : <span style={{ color: 'var(--text-secondary)' }}>-</span>}
                {' '}{diagnostics.automation.totalRules} automation rule{diagnostics.automation.totalRules !== 1 ? 's' : ''}
              </div>
            </div>

            {diagnostics.notifications.rules.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {diagnostics.notifications.rules.map((r, i) => (
                  <span key={i} style={{
                    fontSize: '12px', padding: '3px 10px', borderRadius: 12,
                    background: 'var(--bg-secondary, rgba(0,0,0,0.05))',
                    color: 'var(--text-primary)',
                  }}>
                    {r.name}
                  </span>
                ))}
              </div>
            )}

            {diagnostics.recentLogs.length > 0 && (
              <div style={{ marginTop: 10, fontSize: '12px', color: 'var(--text-secondary)' }}>
                <strong>Recent SMS Logs (24h):</strong>
                {diagnostics.recentLogs.map((l, i) => (
                  <div key={i} style={{ marginLeft: 8, marginTop: 2, color: l.status === 'failed' ? 'var(--danger)' : 'var(--success)' }}>
                    {l.ruleName || 'Unknown'}: {l.status} {l.error && `- ${l.error}`}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {selectedAccountId && loadingDiagnostics && (
          <div className="settings-section" style={{ textAlign: 'center', padding: '20px' }}>
            <Loader2 size={20} className="spinner" /> Loading diagnostics...
          </div>
        )}

        {/* Event Type Selector */}
        {selectedAccountId && (
          <div className="settings-section">
            <div className="section-header"><h2>Event Type</h2></div>
            <div className="event-type-selector">
              <button
                className={`event-type-card ${eventType === 'NegotiationCreatedV4' ? 'selected' : ''}`}
                onClick={() => setEventType('NegotiationCreatedV4')}
              >
                <UserPlus size={24} />
                <h3>New Lead</h3>
                <p>NegotiationCreatedV4</p>
              </button>
              <button
                className={`event-type-card ${eventType === 'MessageCreatedV4' ? 'selected' : ''}`}
                onClick={() => setEventType('MessageCreatedV4')}
              >
                <MessageSquare size={24} />
                <h3>Customer Message</h3>
                <p>MessageCreatedV4</p>
              </button>
            </div>
          </div>
        )}

        {/* New Lead Form */}
        {selectedAccountId && eventType === 'NegotiationCreatedV4' && (
          <div className="settings-section">
            <div className="section-header"><h2>Lead Details</h2></div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div className="form-group">
                <label>First Name</label>
                <input type="text" value={leadForm.customerFirstName}
                  onChange={e => setLeadForm(p => ({ ...p, customerFirstName: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Last Name</label>
                <input type="text" value={leadForm.customerLastName}
                  onChange={e => setLeadForm(p => ({ ...p, customerLastName: e.target.value }))} />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div className="form-group">
                <label>Phone</label>
                <input type="text" value={leadForm.customerPhone}
                  onChange={e => setLeadForm(p => ({ ...p, customerPhone: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Category / Service</label>
                <input type="text" value={leadForm.category}
                  onChange={e => setLeadForm(p => ({ ...p, category: e.target.value }))} />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
              <div className="form-group">
                <label>City</label>
                <input type="text" value={leadForm.city}
                  onChange={e => setLeadForm(p => ({ ...p, city: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>State</label>
                <input type="text" value={leadForm.state}
                  onChange={e => setLeadForm(p => ({ ...p, state: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Zip Code</label>
                <input type="text" value={leadForm.zipCode}
                  onChange={e => setLeadForm(p => ({ ...p, zipCode: e.target.value }))} />
              </div>
            </div>

            <div className="form-group">
              <label>Estimate Total ($)</label>
              <input type="text" value={leadForm.estimateTotal}
                onChange={e => setLeadForm(p => ({ ...p, estimateTotal: e.target.value }))} />
            </div>

            <div className="form-group">
              <label>Message / Description</label>
              <textarea rows={3} value={leadForm.message}
                onChange={e => setLeadForm(p => ({ ...p, message: e.target.value }))} />
            </div>

            {/* Details (question/answer pairs) */}
            <div className="form-group">
              <label>Details (Question / Answer pairs)</label>
              <div className="details-list">
                {leadForm.details.map((detail, i) => (
                  <div key={i} className="detail-row">
                    <input type="text" placeholder="Question" value={detail.question}
                      onChange={e => updateDetail(i, 'question', e.target.value)} />
                    <input type="text" placeholder="Answer" value={detail.answer}
                      onChange={e => updateDetail(i, 'answer', e.target.value)} />
                    <button className="btn-icon danger" onClick={() => removeDetail(i)}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
                <button className="btn btn-outline" onClick={addDetail}>
                  <Plus size={14} /> Add Detail
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Message Form */}
        {selectedAccountId && eventType === 'MessageCreatedV4' && (
          <div className="settings-section">
            <div className="section-header"><h2>Message Details</h2></div>

            <div className="form-group">
              <label>Existing Lead (Negotiation)</label>
              <div className="select-wrapper">
                <select
                  value={messageForm.negotiationId}
                  onChange={e => setMessageForm(p => ({ ...p, negotiationId: e.target.value }))}
                >
                  <option value="">Auto-create new lead</option>
                  {loadingLeads && <option disabled>Loading leads...</option>}
                  {existingLeads.map(lead => (
                    <option key={lead.id} value={lead.externalRequestId}>
                      {lead.customerName} - {lead.category || 'No category'} ({lead.status})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="form-group">
              <label>Sender</label>
              <div className="select-wrapper">
                <select
                  value={messageForm.messageSender}
                  onChange={e => setMessageForm(p => ({ ...p, messageSender: e.target.value as 'Customer' | 'Pro' }))}
                >
                  <option value="Customer">Customer</option>
                  <option value="Pro">Pro (Business)</option>
                </select>
              </div>
            </div>

            <div className="form-group">
              <label>Message Text</label>
              <textarea rows={4} value={messageForm.messageText}
                onChange={e => setMessageForm(p => ({ ...p, messageText: e.target.value }))} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div className="form-group">
                <label>Customer First Name</label>
                <input type="text" value={messageForm.customerFirstName}
                  onChange={e => setMessageForm(p => ({ ...p, customerFirstName: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>Customer Last Name</label>
                <input type="text" value={messageForm.customerLastName}
                  onChange={e => setMessageForm(p => ({ ...p, customerLastName: e.target.value }))} />
              </div>
            </div>

            <div className="form-group">
              <label>Customer Phone</label>
              <input type="text" value={messageForm.customerPhone}
                onChange={e => setMessageForm(p => ({ ...p, customerPhone: e.target.value }))} />
            </div>
          </div>
        )}

        {/* Simulate Button */}
        {selectedAccountId && (
          <div className="settings-section" style={{ textAlign: 'center' }}>
            <button
              className="btn btn-primary"
              onClick={handleSimulate}
              disabled={submitting}
              style={{ minWidth: '200px', padding: '12px 24px', fontSize: '15px' }}
            >
              {submitting ? (
                <><Loader2 size={16} className="spinner" /> Simulating...</>
              ) : (
                <><Send size={16} /> Simulate {eventType === 'NegotiationCreatedV4' ? 'New Lead' : 'Message'}</>
              )}
            </button>
          </div>
        )}

        {/* Results */}
        {results.length > 0 && (
          <div className="settings-section">
            <div className="section-header"><h2>Results ({results.length})</h2></div>
            <div className="simulation-results">
              {results.map((result, idx) => (
                <div key={idx} className={`result-card ${result.success ? 'success' : 'error'}`}>
                  <div className="result-header">
                    <span style={{ fontWeight: 600, fontSize: '14px' }}>
                      {result.success ? <CheckCircle size={16} style={{ color: 'var(--success)', marginRight: 6, verticalAlign: -3 }} /> : <XCircle size={16} style={{ color: 'var(--danger)', marginRight: 6, verticalAlign: -3 }} />}
                      {result.eventType === 'NegotiationCreatedV4' ? 'New Lead' : 'Message'}
                    </span>
                    <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      {result.negotiationId}
                    </span>
                  </div>

                  <div className="result-items">
                    <div className="result-item">
                      {result.results.webhookProcessed ? <CheckCircle size={14} className="check" /> : <XCircle size={14} className="cross" />}
                      Webhook processed
                    </div>
                    <div className="result-item">
                      {result.results.leadCreated ? <CheckCircle size={14} className="check" /> : <span style={{ color: 'var(--text-secondary)' }}>-</span>}
                      {result.results.leadCreated ? 'Lead created' : 'Lead updated'}
                    </div>
                    <div className="result-item">
                      {result.results.sseEventEmitted ? <CheckCircle size={14} className="check" /> : <XCircle size={14} className="cross" />}
                      SSE event emitted
                    </div>

                    {/* SMS Status - prominent display */}
                    <div className="result-item" style={{ fontWeight: 600 }}>
                      {result.results.smsSent
                        ? <CheckCircle size={14} className="check" />
                        : <XCircle size={14} className="cross" />}
                      {result.results.smsSent
                        ? `SMS sent (${result.results.smsSuccessCount} ok${result.results.smsFailedCount > 0 ? `, ${result.results.smsFailedCount} failed` : ''})`
                        : 'SMS NOT sent'}
                    </div>

                    {result.results.smsNotSentReason && (
                      <div style={{ fontSize: '12px', color: 'var(--warning, #e67e22)', padding: '6px 8px', background: 'rgba(230, 126, 34, 0.08)', borderRadius: 6, marginTop: 2 }}>
                        <AlertCircle size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                        {result.results.smsNotSentReason}
                      </div>
                    )}

                    {/* Notification diagnostics */}
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: 4 }}>
                      Settings: {result.results.notificationDiagnostics?.settingsExist ? 'yes' : 'NO'} |
                      Enabled: {result.results.notificationDiagnostics?.settingsEnabled ? 'yes' : 'NO'} |
                      Callio key: {result.results.notificationDiagnostics?.hasCallioApiKey ? 'yes' : 'NO'} |
                      New lead rules: {result.results.notificationDiagnostics?.newLeadRules ?? 0} |
                      Reply rules: {result.results.notificationDiagnostics?.customerReplyRules ?? 0}
                    </div>

                    <div className="result-item">
                      <span style={{ fontWeight: 500 }}>{result.results.automationRulesFound}</span> automation rules
                      {result.results.automationRules.length > 0 && (
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                          ({result.results.automationRules.map(r => r.name).join(', ')})
                        </span>
                      )}
                    </div>
                    <div className="result-item">
                      <span style={{ fontWeight: 500 }}>{result.results.notificationRulesFound}</span> SMS rules
                      {result.results.notificationRules.length > 0 && (
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                          ({result.results.notificationRules.map(r => r.name).join(', ')})
                        </span>
                      )}
                    </div>
                  </div>

                  {result.results.smsLogs.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <span style={{ fontSize: '12px', fontWeight: 600 }}>SMS Logs:</span>
                      {result.results.smsLogs.map((log, i) => (
                        <div key={i} style={{ fontSize: '12px', marginTop: 2, color: log.status === 'failed' ? 'var(--danger)' : 'var(--success)' }}>
                          {log.ruleName || 'Unknown'}: {log.status}
                          {log.toPhone && ` → ${log.toPhone}`}
                          {log.error && ` - ${log.error}`}
                        </div>
                      ))}
                    </div>
                  )}

                  {result.results.webhookError && (
                    <div style={{ marginTop: 8, color: 'var(--danger)', fontSize: '13px' }}>
                      Error: {result.results.webhookError}
                    </div>
                  )}

                  <button
                    className="payload-toggle"
                    onClick={() => setExpandedPayload(expandedPayload === idx ? null : idx)}
                  >
                    {expandedPayload === idx ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    {' '}{expandedPayload === idx ? 'Hide' : 'Show'} raw payload
                  </button>

                  {expandedPayload === idx && (
                    <pre className="payload-content">
                      {JSON.stringify(result.payload, null, 2)}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
