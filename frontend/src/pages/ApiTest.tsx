import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, FlaskConical, Loader2, AlertCircle, X, CheckCircle, XCircle,
  Send, Plus, Trash2, ChevronDown, ChevronUp, MessageSquare, UserPlus,
} from 'lucide-react';
import {
  thumbtackApi, testApi,
  SimulateWebhookRequest, SimulationResult, TestLead,
} from '../services/api';
import type { SavedAccount } from '../types';

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
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [eventType, setEventType] = useState<'NegotiationCreatedV4' | 'MessageCreatedV4'>('NegotiationCreatedV4');
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    loadAccounts();
  }, []);

  useEffect(() => {
    if (selectedAccountId && eventType === 'MessageCreatedV4') {
      loadLeads();
    }
  }, [selectedAccountId, eventType]);

  async function loadAccounts() {
    try {
      setLoading(true);
      const res = await thumbtackApi.getSavedAccounts();
      setAccounts(res.accounts || []);
      if (res.accounts?.length > 0) {
        setSelectedAccountId(res.accounts[0].id);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load accounts');
    } finally {
      setLoading(false);
    }
  }

  async function loadLeads() {
    try {
      setLoadingLeads(true);
      const res = await testApi.getLeadsForAccount(selectedAccountId);
      setExistingLeads(res.leads || []);
    } catch {
      setExistingLeads([]);
    } finally {
      setLoadingLeads(false);
    }
  }

  async function handleSimulate() {
    if (!selectedAccountId) {
      setError('Please select an account');
      return;
    }

    try {
      setSubmitting(true);
      setError(null);

      const request: SimulateWebhookRequest = {
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

      if (result.success) {
        setSuccessMessage(`${eventType === 'NegotiationCreatedV4' ? 'New lead' : 'Message'} simulated successfully`);
        setTimeout(() => setSuccessMessage(null), 4000);
        // Refresh leads list for message form
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

  if (loading) {
    return (
      <div className="api-test">
        <div className="settings-header">
          <button className="btn-icon" onClick={() => navigate(-1)}><ArrowLeft size={20} /></button>
          <h1><FlaskConical size={24} /> API Test</h1>
        </div>
        <div className="loading-container"><Loader2 size={32} className="spinner" /><p>Loading...</p></div>
      </div>
    );
  }

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
        {/* Account Selector */}
        <div className="settings-section">
          <div className="form-group">
            <label>Business Account</label>
            <div className="select-wrapper">
              <select
                value={selectedAccountId}
                onChange={e => setSelectedAccountId(e.target.value)}
              >
                <option value="">Select an account...</option>
                {accounts.map(acc => (
                  <option key={acc.id} value={acc.id}>{acc.businessName}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

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
                    <div className="result-item">
                      {result.results.callioConnected ? <CheckCircle size={14} className="check" /> : <XCircle size={14} className="cross" />}
                      Callio connected
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
                          {log.ruleName || 'Unknown'}: {log.status} {log.error && `- ${log.error}`}
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
