import { useState, useEffect } from 'react';
import {
  ArrowLeft,
  Phone,
  Zap,
  Users,
  ToggleLeft,
  ToggleRight,
  Save,
  Loader2,
  Info,
  Moon,
  Key,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { callConnectApi, thumbtackApi } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { notify } from '../store/notificationStore';
import type { CallConnectMode, AgentStrategy, SavedAccount } from '../types';

const MODE_OPTIONS: { value: CallConnectMode; label: string; desc: string }[] = [
  { value: 'AGENT_FIRST', label: 'Agent first (recommended)', desc: 'We call you first, then connect to the lead once you answer.' },
  { value: 'PARALLEL', label: 'Parallel (fastest)', desc: 'We call you and the lead simultaneously.' },
];

const AGENT_STRATEGY_OPTIONS: { value: AgentStrategy; label: string }[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'round_robin', label: 'Round-robin' },
  { value: 'on_duty', label: 'On duty' },
];

const COMMON_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
];

export function CallConnectSettings() {
  const navigate = useNavigate();
  const { user } = useAuthStore();

  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');

  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<CallConnectMode>('AGENT_FIRST');
  const [agentStrategy, setAgentStrategy] = useState<AgentStrategy>('owner');
  const [agentPhone, setAgentPhone] = useState('');
  const [sigcoreApiKey, setSigcoreApiKey] = useState('');
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(false);
  const [quietHoursTimezone, setQuietHoursTimezone] = useState('America/New_York');
  const [quietHoursStart, setQuietHoursStart] = useState('22:00');
  const [quietHoursEnd, setQuietHoursEnd] = useState('08:00');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const isPro = user?.subscriptionTier === 'PRO' || user?.subscriptionTier === 'ENTERPRISE';

  useEffect(() => {
    loadAccounts();
  }, []);

  useEffect(() => {
    if (selectedAccountId) loadSettings(selectedAccountId);
  }, [selectedAccountId]);

  async function loadAccounts() {
    try {
      const res = await thumbtackApi.getSavedAccounts();
      setAccounts(res.accounts);
      if (res.accounts.length > 0) setSelectedAccountId(res.accounts[0].id);
    } catch {
      notify.error('Error', 'Failed to load accounts');
    } finally {
      setLoading(false);
    }
  }

  async function loadSettings(accountId: string) {
    setLoading(true);
    try {
      const res = await callConnectApi.getSettings(accountId);
      if (res.settings) {
        setEnabled(res.settings.enabled);
        setMode(res.settings.mode);
        setAgentStrategy(res.settings.agentStrategy);
        setAgentPhone(res.settings.agentPhoneE164 || '');
        setSigcoreApiKey(res.settings.sigcoreApiKey || '');
        setQuietHoursEnabled(res.settings.quietHoursEnabled);
        setQuietHoursTimezone(res.settings.quietHoursTimezone || 'America/New_York');
        setQuietHoursStart(res.settings.quietHoursStart || '22:00');
        setQuietHoursEnd(res.settings.quietHoursEnd || '08:00');
      } else {
        setEnabled(false);
        setMode('AGENT_FIRST');
        setAgentStrategy('owner');
        setAgentPhone('');
        setSigcoreApiKey('');
        setQuietHoursEnabled(false);
        setQuietHoursTimezone('America/New_York');
        setQuietHoursStart('22:00');
        setQuietHoursEnd('08:00');
      }
    } catch {
      notify.error('Error', 'Failed to load call connect settings');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!selectedAccountId) return;
    setSaving(true);
    try {
      await callConnectApi.saveSettings(selectedAccountId, {
        enabled,
        mode,
        agentStrategy,
        agentPhoneE164: agentPhone || undefined,
        sigcoreApiKey: sigcoreApiKey || undefined,
        quietHoursEnabled,
        quietHoursTimezone: quietHoursEnabled ? quietHoursTimezone : undefined,
        quietHoursStart: quietHoursEnabled ? quietHoursStart : undefined,
        quietHoursEnd: quietHoursEnabled ? quietHoursEnd : undefined,
      });
      notify.success('Saved', 'Call connect settings updated');
      await loadSettings(selectedAccountId);
    } catch {
      notify.error('Error', 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  if (loading && accounts.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
          <ArrowLeft size={20} />
        </button>
        <div className="flex items-center gap-2">
          <Phone size={22} className="text-blue-600" />
          <h1 className="text-xl font-semibold text-gray-900">Instant Call Connect</h1>
        </div>
      </div>

      {/* Account selector */}
      {accounts.length > 1 && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Account</label>
          <select
            value={selectedAccountId}
            onChange={e => setSelectedAccountId(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.businessName}</option>
            ))}
          </select>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
        </div>
      ) : (
        <>
          {/* Enable toggle */}
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <Zap size={18} className="text-blue-500" />
                  <span className="font-medium text-gray-900">Instant Call Connect</span>
                </div>
                <p className="text-sm text-gray-500 mt-1">
                  When a new lead arrives, automatically call you and connect them instantly.
                </p>
              </div>
              <button onClick={() => setEnabled(!enabled)} className="ml-4 shrink-0">
                {enabled
                  ? <ToggleRight size={36} className="text-blue-600" />
                  : <ToggleLeft size={36} className="text-gray-400" />}
              </button>
            </div>
          </div>

          {/* Tier notice */}
          <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-lg p-3 text-sm text-blue-800">
            <Info size={16} className="shrink-0 mt-0.5" />
            <div>
              {isPro
                ? 'You can use your own business number for outbound calls.'
                : 'Starter plans use a shared bot number for calls. Upgrade to Pro+ to use your own business number.'}
            </div>
          </div>

          {/* Sigcore API Key */}
          <div className="bg-white border border-gray-200 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <Key size={16} className="text-gray-500" />
              <span className="font-medium text-gray-800 text-sm">Sigcore API Key</span>
            </div>
            <input
              type="password"
              value={sigcoreApiKey}
              onChange={e => setSigcoreApiKey(e.target.value)}
              placeholder="Enter your Sigcore workspace API key"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-400 mt-1.5">
              Issued by Sigcore per business. Required to trigger and manage calls.
            </p>
          </div>

          {/* Settings (only shown when enabled) */}
          {enabled && (
            <div className="space-y-5">
              {/* Mode */}
              <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
                <div className="flex items-center gap-2 mb-1">
                  <Zap size={16} className="text-gray-500" />
                  <span className="font-medium text-gray-800 text-sm">Connection Mode</span>
                </div>
                {MODE_OPTIONS.map(opt => (
                  <label key={opt.value} className="flex items-start gap-3 cursor-pointer group">
                    <input
                      type="radio"
                      name="mode"
                      value={opt.value}
                      checked={mode === opt.value}
                      onChange={() => setMode(opt.value)}
                      className="mt-0.5"
                    />
                    <div>
                      <div className="text-sm font-medium text-gray-800">{opt.label}</div>
                      <div className="text-xs text-gray-500">{opt.desc}</div>
                    </div>
                  </label>
                ))}
              </div>

              {/* Agent routing */}
              <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
                <div className="flex items-center gap-2 mb-1">
                  <Users size={16} className="text-gray-500" />
                  <span className="font-medium text-gray-800 text-sm">Agent Routing</span>
                </div>
                <div className="flex gap-2 flex-wrap">
                  {AGENT_STRATEGY_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setAgentStrategy(opt.value)}
                      className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                        agentStrategy === opt.value
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-gray-700 border-gray-200 hover:border-blue-300'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {/* Agent phone */}
                <div className="mt-3">
                  <label className="block text-xs font-medium text-gray-600 mb-1">Agent phone number (E.164)</label>
                  <input
                    type="tel"
                    value={agentPhone}
                    onChange={e => setAgentPhone(e.target.value)}
                    placeholder="+15551234567"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <p className="text-xs text-gray-400 mt-1">The phone number Sigcore will ring when a new lead arrives.</p>
                </div>
              </div>

              {/* Quiet hours */}
              <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Moon size={16} className="text-gray-500" />
                    <span className="font-medium text-gray-800 text-sm">Quiet Hours</span>
                  </div>
                  <button onClick={() => setQuietHoursEnabled(!quietHoursEnabled)} className="shrink-0">
                    {quietHoursEnabled
                      ? <ToggleRight size={28} className="text-blue-600" />
                      : <ToggleLeft size={28} className="text-gray-400" />}
                  </button>
                </div>

                {quietHoursEnabled && (
                  <div className="space-y-3 pt-1">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Timezone</label>
                      <select
                        value={quietHoursTimezone}
                        onChange={e => setQuietHoursTimezone(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        {COMMON_TIMEZONES.map(tz => (
                          <option key={tz} value={tz}>{tz}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex gap-3">
                      <div className="flex-1">
                        <label className="block text-xs font-medium text-gray-600 mb-1">From</label>
                        <input
                          type="time"
                          value={quietHoursStart}
                          onChange={e => setQuietHoursStart(e.target.value)}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <div className="flex-1">
                        <label className="block text-xs font-medium text-gray-600 mb-1">To</label>
                        <input
                          type="time"
                          value={quietHoursEnd}
                          onChange={e => setQuietHoursEnd(e.target.value)}
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-gray-400">Calls will not be triggered during quiet hours.</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Save button */}
          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors disabled:opacity-60"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              Save Settings
            </button>
          </div>
        </>
      )}
    </div>
  );
}
