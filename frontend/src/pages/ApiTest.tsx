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
    <div className="p-6 lg:p-10 max-w-7xl mx-auto space-y-10">
      <div className="flex items-center gap-4">
        <button className="p-2 hover:bg-slate-100 rounded-xl transition-all" onClick={() => navigate(-1)}><ArrowLeft size={20} /></button>
        <h1 className="text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight flex items-center gap-3">
          <FlaskConical size={24} /> API Test
        </h1>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-red-700 flex items-center gap-2">
          <AlertCircle size={16} />
          <span className="flex-1">{error}</span>
          <button className="p-1 hover:bg-red-100 rounded transition-all" onClick={() => setError(null)}><X size={16} /></button>
        </div>
      )}

      {successMessage && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-4 text-emerald-700 flex items-center gap-2">
          <CheckCircle size={16} /> {successMessage}
        </div>
      )}

      <div className="space-y-8">
        {/* Client (User) Selector */}
        <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-8 space-y-6">
          <h2 className="text-2xl font-bold text-slate-900">Select Client</h2>
          <div className="space-y-2">
            <label className="block text-sm font-semibold text-slate-700">Search Users</label>
            <div className="relative">
              <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Search by name or email..."
                value={userSearch}
                onChange={e => handleUserSearch(e.target.value)}
                className="w-full pl-12 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-semibold text-slate-700">Client</label>
            <select
              value={selectedUserId}
              onChange={e => setSelectedUserId(e.target.value)}
              disabled={loadingUsers}
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
            >
              <option value="">Select a client...</option>
              {users.map(u => (
                <option key={u.id} value={u.id}>
                  {u.name || u.email} ({u.email}){u.subscriptionTier ? ` - ${u.subscriptionTier}` : ''}
                </option>
              ))}
            </select>
            {loadingUsers && <span className="text-xs text-slate-500">Loading users...</span>}
          </div>
        </div>

        {/* Account Selector */}
        {selectedUserId && (
          <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-8 space-y-6">
            <div className="space-y-1">
              <h2 className="text-2xl font-bold text-slate-900">Select Account</h2>
              {selectedUser && <p className="text-sm text-slate-500">for {selectedUser.name || selectedUser.email}</p>}
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-slate-700">Business Account</label>
              <select
                value={selectedAccountId}
                onChange={e => setSelectedAccountId(e.target.value)}
                disabled={loadingAccounts}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              >
                <option value="">Select an account...</option>
                {accounts.map(acc => (
                  <option key={acc.id} value={acc.id}>
                    {acc.businessName}{!acc.webhookId ? ' (no webhook)' : ''}
                  </option>
                ))}
              </select>
              {loadingAccounts && <span className="text-xs text-slate-500">Loading accounts...</span>}
              {!loadingAccounts && accounts.length === 0 && selectedUserId && (
                <span className="text-xs text-red-600">This client has no saved accounts</span>
              )}
            </div>
          </div>
        )}

        {/* Account Diagnostics */}
        {selectedAccountId && diagnostics && !loadingDiagnostics && (
          <div className={`bg-white rounded-3xl border shadow-sm p-8 space-y-6 ${diagnostics.healthy ? 'border-l-4 border-l-emerald-500 border-t-slate-100 border-r-slate-100 border-b-slate-100' : 'border-l-4 border-l-red-500 border-t-slate-100 border-r-slate-100 border-b-slate-100'}`}>
            <h2 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
              {diagnostics.healthy
                ? <><CheckCircle size={18} className="text-emerald-600" />Account Healthy</>
                : <><AlertCircle size={18} className="text-red-600" />Account Issues</>}
            </h2>

            {diagnostics.issues.length > 0 && (
              <div className="flex flex-col gap-1 mb-3">
                {diagnostics.issues.map((issue, i) => (
                  <div key={i} className="text-sm text-red-600 flex items-center gap-2">
                    <XCircle size={14} className="flex-shrink-0" /> {issue}
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
              <div className="flex items-center gap-2">
                {diagnostics.platform.connected ? <CheckCircle size={12} className="text-emerald-600" /> : <XCircle size={12} className="text-red-600" />}
                Thumbtack connected
              </div>
              <div className="flex items-center gap-2">
                {diagnostics.account.hasWebhook ? <CheckCircle size={12} className="text-emerald-600" /> : <XCircle size={12} className="text-red-600" />}
                Webhook registered
              </div>
              <div className="flex items-center gap-2">
                {diagnostics.notifications.settingsExist ? <CheckCircle size={12} className="text-emerald-600" /> : <XCircle size={12} className="text-red-600" />}
                Notification settings
              </div>
              <div className="flex items-center gap-2">
                {diagnostics.notifications.hasSigcoreApiKey ? <CheckCircle size={12} className="text-emerald-600" /> : <XCircle size={12} className="text-red-600" />}
                Sigcore API key
              </div>
              <div className="flex items-center gap-2">
                {diagnostics.notifications.newLeadRules > 0 ? <CheckCircle size={12} className="text-emerald-600" /> : <XCircle size={12} className="text-red-600" />}
                {diagnostics.notifications.newLeadRules} SMS alert{diagnostics.notifications.newLeadRules !== 1 ? 's' : ''} (new lead)
              </div>
              <div className="flex items-center gap-2">
                {diagnostics.notifications.customerReplyRules > 0 ? <CheckCircle size={12} className="text-emerald-600" /> : <span className="text-slate-400">-</span>}
                {diagnostics.notifications.customerReplyRules} SMS alert{diagnostics.notifications.customerReplyRules !== 1 ? 's' : ''} (reply)
              </div>
              <div className="flex items-center gap-2">
                {diagnostics.automation.totalRules > 0 ? <CheckCircle size={12} className="text-emerald-600" /> : <span className="text-slate-400">-</span>}
                {diagnostics.automation.totalRules} auto-reply rule{diagnostics.automation.totalRules !== 1 ? 's' : ''}
              </div>
            </div>

            {diagnostics.notifications.rules.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {diagnostics.notifications.rules.map((r, i) => (
                  <span key={i} className="text-xs px-3 py-1 rounded-full bg-slate-100 text-slate-700">
                    {r.name}
                  </span>
                ))}
              </div>
            )}

            {diagnostics.recentLogs.length > 0 && (
              <div className="text-xs text-slate-500 space-y-1">
                <strong className="text-slate-700">Recent SMS Logs (24h):</strong>
                {diagnostics.recentLogs.map((l, i) => (
                  <div key={i} className={`ml-2 ${l.status === 'failed' ? 'text-red-600' : 'text-emerald-600'}`}>
                    {l.ruleName || 'Unknown'}: {l.status} {l.error && `- ${l.error}`}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {selectedAccountId && loadingDiagnostics && (
          <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-8 text-center">
            <Loader2 size={20} className="inline-block animate-spin text-blue-600" /> <span className="ml-2 text-slate-600">Loading diagnostics...</span>
          </div>
        )}

        {/* Event Type Selector */}
        {selectedAccountId && (
          <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-8 space-y-6">
            <h2 className="text-2xl font-bold text-slate-900">Event Type</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <button
                className={`p-6 rounded-2xl border-2 transition-all hover:shadow-lg ${eventType === 'NegotiationCreatedV4' ? 'border-blue-500 bg-blue-50 shadow-md' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                onClick={() => setEventType('NegotiationCreatedV4')}
              >
                <UserPlus size={24} className={eventType === 'NegotiationCreatedV4' ? 'text-blue-600' : 'text-slate-600'} />
                <h3 className={`text-lg font-bold mt-3 ${eventType === 'NegotiationCreatedV4' ? 'text-blue-900' : 'text-slate-900'}`}>New Lead</h3>
                <p className={`text-sm mt-1 ${eventType === 'NegotiationCreatedV4' ? 'text-blue-700' : 'text-slate-600'}`}>NegotiationCreatedV4</p>
              </button>
              <button
                className={`p-6 rounded-2xl border-2 transition-all hover:shadow-lg ${eventType === 'MessageCreatedV4' ? 'border-blue-500 bg-blue-50 shadow-md' : 'border-slate-200 bg-white hover:border-slate-300'}`}
                onClick={() => setEventType('MessageCreatedV4')}
              >
                <MessageSquare size={24} className={eventType === 'MessageCreatedV4' ? 'text-blue-600' : 'text-slate-600'} />
                <h3 className={`text-lg font-bold mt-3 ${eventType === 'MessageCreatedV4' ? 'text-blue-900' : 'text-slate-900'}`}>Customer Message</h3>
                <p className={`text-sm mt-1 ${eventType === 'MessageCreatedV4' ? 'text-blue-700' : 'text-slate-600'}`}>MessageCreatedV4</p>
              </button>
            </div>
          </div>
        )}

        {/* New Lead Form */}
        {selectedAccountId && eventType === 'NegotiationCreatedV4' && (
          <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-8 space-y-6">
            <h2 className="text-2xl font-bold text-slate-900">Lead Details</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-slate-700">First Name</label>
                <input type="text" value={leadForm.customerFirstName}
                  onChange={e => setLeadForm(p => ({ ...p, customerFirstName: e.target.value }))}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-slate-700">Last Name</label>
                <input type="text" value={leadForm.customerLastName}
                  onChange={e => setLeadForm(p => ({ ...p, customerLastName: e.target.value }))}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-slate-700">Phone</label>
                <input type="text" value={leadForm.customerPhone}
                  onChange={e => setLeadForm(p => ({ ...p, customerPhone: e.target.value }))}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-slate-700">Category / Service</label>
                <input type="text" value={leadForm.category}
                  onChange={e => setLeadForm(p => ({ ...p, category: e.target.value }))}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-slate-700">City</label>
                <input type="text" value={leadForm.city}
                  onChange={e => setLeadForm(p => ({ ...p, city: e.target.value }))}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-slate-700">State</label>
                <input type="text" value={leadForm.state}
                  onChange={e => setLeadForm(p => ({ ...p, state: e.target.value }))}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-slate-700">Zip Code</label>
                <input type="text" value={leadForm.zipCode}
                  onChange={e => setLeadForm(p => ({ ...p, zipCode: e.target.value }))}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-semibold text-slate-700">Estimate Total ($)</label>
              <input type="text" value={leadForm.estimateTotal}
                onChange={e => setLeadForm(p => ({ ...p, estimateTotal: e.target.value }))}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-semibold text-slate-700">Message / Description</label>
              <textarea rows={3} value={leadForm.message}
                onChange={e => setLeadForm(p => ({ ...p, message: e.target.value }))}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
            </div>

            {/* Details (question/answer pairs) */}
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-slate-700">Details (Question / Answer pairs)</label>
              <div className="space-y-3">
                {leadForm.details.map((detail, i) => (
                  <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                    <input type="text" placeholder="Question" value={detail.question}
                      onChange={e => updateDetail(i, 'question', e.target.value)}
                      className="px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
                    <input type="text" placeholder="Answer" value={detail.answer}
                      onChange={e => updateDetail(i, 'answer', e.target.value)}
                      className="px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
                    <button className="p-3 hover:bg-red-50 text-red-600 rounded-xl transition-all" onClick={() => removeDetail(i)}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
                <button className="px-6 py-2 border-2 border-slate-200 text-slate-700 rounded-xl font-semibold hover:bg-slate-50 transition-all flex items-center gap-2" onClick={addDetail}>
                  <Plus size={14} /> Add Detail
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Message Form */}
        {selectedAccountId && eventType === 'MessageCreatedV4' && (
          <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-8 space-y-6">
            <h2 className="text-2xl font-bold text-slate-900">Message Details</h2>

            <div className="space-y-2">
              <label className="block text-sm font-semibold text-slate-700">Existing Lead (Negotiation)</label>
              <select
                value={messageForm.negotiationId}
                onChange={e => setMessageForm(p => ({ ...p, negotiationId: e.target.value }))}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
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

            <div className="space-y-2">
              <label className="block text-sm font-semibold text-slate-700">Sender</label>
              <select
                value={messageForm.messageSender}
                onChange={e => setMessageForm(p => ({ ...p, messageSender: e.target.value as 'Customer' | 'Pro' }))}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              >
                <option value="Customer">Customer</option>
                <option value="Pro">Pro (Business)</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-semibold text-slate-700">Message Text</label>
              <textarea rows={4} value={messageForm.messageText}
                onChange={e => setMessageForm(p => ({ ...p, messageText: e.target.value }))}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-slate-700">Customer First Name</label>
                <input type="text" value={messageForm.customerFirstName}
                  onChange={e => setMessageForm(p => ({ ...p, customerFirstName: e.target.value }))}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-slate-700">Customer Last Name</label>
                <input type="text" value={messageForm.customerLastName}
                  onChange={e => setMessageForm(p => ({ ...p, customerLastName: e.target.value }))}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-sm font-semibold text-slate-700">Customer Phone</label>
              <input type="text" value={messageForm.customerPhone}
                onChange={e => setMessageForm(p => ({ ...p, customerPhone: e.target.value }))}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
            </div>
          </div>
        )}

        {/* Simulate Button */}
        {selectedAccountId && (
          <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-8 text-center">
            <button
              className="px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all flex items-center justify-center gap-2 mx-auto min-w-[200px]"
              onClick={handleSimulate}
              disabled={submitting}
            >
              {submitting ? (
                <><Loader2 size={16} className="animate-spin" /> Simulating...</>
              ) : (
                <><Send size={16} /> Simulate {eventType === 'NegotiationCreatedV4' ? 'New Lead' : 'Message'}</>
              )}
            </button>
          </div>
        )}

        {/* Results */}
        {results.length > 0 && (
          <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-8 space-y-6">
            <h2 className="text-2xl font-bold text-slate-900">Results ({results.length})</h2>
            <div className="space-y-4">
              {results.map((result, idx) => (
                <div key={idx} className={`rounded-2xl border-2 p-6 space-y-4 ${result.success ? 'border-emerald-200 bg-emerald-50/30' : 'border-red-200 bg-red-50/30'}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-sm flex items-center gap-2">
                      {result.success ? <CheckCircle size={16} className="text-emerald-600" /> : <XCircle size={16} className="text-red-600" />}
                      {result.eventType === 'NegotiationCreatedV4' ? 'New Lead' : 'Message'}
                    </span>
                    <span className="text-xs text-slate-500">
                      {result.negotiationId}
                    </span>
                  </div>

                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2">
                      {result.results.webhookProcessed ? <CheckCircle size={14} className="text-emerald-600" /> : <XCircle size={14} className="text-red-600" />}
                      Webhook processed
                    </div>
                    <div className="flex items-center gap-2">
                      {result.results.leadCreated ? <CheckCircle size={14} className="text-emerald-600" /> : <span className="text-slate-400">-</span>}
                      {result.results.leadCreated ? 'Lead created' : 'Lead updated'}
                    </div>
                    <div className="flex items-center gap-2">
                      {result.results.sseEventEmitted ? <CheckCircle size={14} className="text-emerald-600" /> : <XCircle size={14} className="text-red-600" />}
                      SSE event emitted
                    </div>

                    {/* SMS Status - prominent display */}
                    <div className="flex items-center gap-2 font-semibold">
                      {result.results.smsSent
                        ? <CheckCircle size={14} className="text-emerald-600" />
                        : <XCircle size={14} className="text-red-600" />}
                      {result.results.smsSent
                        ? `SMS sent (${result.results.smsSuccessCount} ok${result.results.smsFailedCount > 0 ? `, ${result.results.smsFailedCount} failed` : ''})`
                        : 'SMS NOT sent'}
                    </div>

                    {result.results.smsNotSentReason && (
                      <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-2 flex items-center gap-1">
                        <AlertCircle size={12} />
                        {result.results.smsNotSentReason}
                      </div>
                    )}

                    {/* Pipeline trace - shows exactly where SMS sending passed/failed */}
                    {result.results.pipelineTrace?.length > 0 && (
                      <div className="mt-2 p-3 bg-slate-100 rounded-xl text-xs space-y-1">
                        <div className="font-semibold text-[11px] uppercase tracking-wide text-slate-600 mb-2">
                          Pipeline Trace
                        </div>
                        {result.results.pipelineTrace.map((t, i) => (
                          <div key={i} className="flex items-start gap-2">
                            <span className="flex-shrink-0 mt-0.5">
                              {t.status === 'pass' ? <CheckCircle size={11} className="text-emerald-600" /> :
                               t.status === 'fail' ? <XCircle size={11} className="text-red-600" /> :
                               <span className="text-slate-400 text-[11px]">i</span>}
                            </span>
                            <span>
                              <strong>{t.step}</strong>: <span className={t.status === 'fail' ? 'text-red-600' : 'text-slate-600'}>{t.detail}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="text-sm">
                      <span className="font-medium">{result.results.automationRulesFound}</span> auto-reply rule{result.results.automationRulesFound !== 1 ? 's' : ''} (Thumbtack)
                      {result.results.automationRules.length > 0 && (
                        <span className="text-[11px] text-slate-500 ml-1">
                          ({result.results.automationRules.map(r => r.name).join(', ')})
                        </span>
                      )}
                    </div>
                    <div className="text-sm">
                      <span className="font-medium">{result.results.notificationRulesFound}</span> SMS alert rule{result.results.notificationRulesFound !== 1 ? 's' : ''}
                      {result.results.notificationRules.length > 0 && (
                        <span className="text-[11px] text-slate-500 ml-1">
                          ({result.results.notificationRules.map(r => r.name).join(', ')})
                        </span>
                      )}
                    </div>
                  </div>

                  {result.results.smsLogs.length > 0 && (
                    <div className="space-y-1">
                      <span className="text-xs font-semibold text-slate-700">SMS Logs:</span>
                      {result.results.smsLogs.map((log, i) => (
                        <div key={i} className={`text-xs ${log.status === 'failed' ? 'text-red-600' : 'text-emerald-600'}`}>
                          {log.ruleName || 'Unknown'}: {log.status}
                          {log.toPhone && ` → ${log.toPhone}`}
                          {log.error && ` - ${log.error}`}
                        </div>
                      ))}
                    </div>
                  )}

                  {result.results.webhookError && (
                    <div className="text-red-600 text-sm">
                      Error: {result.results.webhookError}
                    </div>
                  )}

                  <button
                    className="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all text-sm flex items-center gap-2"
                    onClick={() => setExpandedPayload(expandedPayload === idx ? null : idx)}
                  >
                    {expandedPayload === idx ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    {expandedPayload === idx ? 'Hide' : 'Show'} raw payload
                  </button>

                  {expandedPayload === idx && (
                    <pre className="bg-slate-900 text-slate-100 p-4 rounded-xl text-xs overflow-x-auto">
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
