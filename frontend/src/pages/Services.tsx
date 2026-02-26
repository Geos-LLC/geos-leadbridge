import { useState, useEffect } from 'react';
import {
  Loader2, ChevronDown, MessageSquare, Bell, PhoneCall,
  Zap, Briefcase, AlertCircle, CheckCircle, X, Clock,
  Bot, Pencil, Phone, Send, ChevronUp, Trash2, Save,
} from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  automationApi, notificationsApi, thumbtackApi, templatesApi, usersApi, callConnectApi,
} from '../services/api';
import type {
  AutomationRule, NotificationRule, SavedAccount, MessageTemplate,
  CallConnectMode, AgentStrategy, SigcorePhoneNumber,
} from '../types';
import { TemplateEditorModal, AUTO_REPLY_VARIABLES, SMS_VARIABLES } from '../components/TemplateEditorModal';
import { useAppStore } from '../store/appStore';

// Combined variables — same set for all card types (matches Templates page)
const ALL_VARIABLES = [...AUTO_REPLY_VARIABLES, ...SMS_VARIABLES.filter(
  v => !AUTO_REPLY_VARIABLES.some(a => a.desc === v.desc)
)];

// -- ServiceCard sub-component --
interface ServiceCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  comingSoon?: boolean;
  expanded?: boolean;
  onExpand?: () => void;
  statusText?: string;
  warningText?: string;
  setupRequired?: boolean;
  children?: React.ReactNode;
  iconBgColor?: string;
  iconTextColor?: string;
}

function ServiceCard({ icon, title, description, enabled, onToggle, comingSoon, expanded, onExpand, statusText, warningText, setupRequired, children, iconBgColor = 'bg-blue-50', iconTextColor = 'text-blue-600' }: ServiceCardProps) {
  return (
    <div className={`bg-white rounded-3xl border shadow-sm overflow-hidden transition-all ${comingSoon ? 'opacity-75 bg-slate-50/50 border-slate-100' : setupRequired ? 'border-orange-200 hover:border-orange-300' : 'border-slate-100 hover:border-blue-200'}`}>
      <div className="p-6 md:p-8">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
          <div className="flex gap-5">
            <div className={`w-14 h-14 ${comingSoon ? 'bg-white text-slate-400 border border-slate-100' : `${iconBgColor} ${iconTextColor}`} rounded-2xl flex items-center justify-center shrink-0`}>
              {icon}
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className={`text-xl font-bold ${comingSoon ? 'text-slate-400' : 'text-slate-900'}`}>{title}</h3>
                {comingSoon && (
                  <span className="px-2 py-0.5 bg-slate-200 text-slate-500 text-[10px] font-bold rounded uppercase">Coming Soon</span>
                )}
                {!comingSoon && (
                  <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full border uppercase tracking-wider ${
                    enabled
                      ? 'bg-emerald-50 text-emerald-600 border-emerald-200'
                      : 'bg-slate-100 text-slate-400 border-slate-200'
                  }`}>
                    {enabled ? 'Active' : 'Disabled'}
                  </span>
                )}
                {setupRequired && !comingSoon && (
                  <span className="px-2 py-0.5 bg-orange-100 text-orange-600 text-[10px] font-bold rounded-full border border-orange-200 uppercase tracking-wider">Setup Required</span>
                )}
              </div>
              <p className={`mt-1 ${comingSoon ? 'text-slate-400' : 'text-slate-500'}`}>{description}</p>
              {warningText && !comingSoon && (
                <div className="flex items-center gap-2 mt-3">
                  <span className="w-2 h-2 rounded-full bg-orange-400"></span>
                  <span className="text-xs font-bold text-orange-600 uppercase tracking-tight">{warningText}</span>
                </div>
              )}
              {statusText && !warningText && !comingSoon && (
                <div className="flex items-center gap-2 mt-3">
                  <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                  <span className="text-xs font-bold text-slate-600 uppercase tracking-tight">{statusText}</span>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-4">
            {!comingSoon && onExpand && (
              <button
                onClick={onExpand}
                className="p-2 text-slate-400 hover:text-slate-600 transition-colors"
              >
                {expanded ? <ChevronUp className="w-6 h-6" /> : <ChevronDown className="w-6 h-6" />}
              </button>
            )}
            <label className="inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => onToggle(e.target.checked)}
                disabled={comingSoon}
                className="sr-only peer"
              />
              <div className={`relative w-14 h-7 ${comingSoon ? 'bg-slate-100 cursor-not-allowed' : 'bg-slate-200'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:start-[4px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-blue-600`}></div>
            </label>
          </div>
        </div>

        {expanded && children && (
          <div className="mt-10 pt-8 border-t border-slate-50 space-y-6">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

// -- Main Services Page --
export function Services() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const storedAccounts = useAppStore(state => state.savedAccounts);
  const setSavedAccounts = useAppStore(state => state.setSavedAccounts);

  // Account state — seed from Zustand store so there's no loading flash
  const [accounts, setAccounts] = useState<SavedAccount[]>(storedAccounts);
  const [selectedAccountId, setSelectedAccountId] = useState(storedAccounts[0]?.id || '');
  const [loading, setLoading] = useState(storedAccounts.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'sending' | 'delivered' | 'failed'>('idle');
  const [deletingAlert, setDeletingAlert] = useState(false);
  const [confirmDeleteAlert, setConfirmDeleteAlert] = useState(false);

  // Auto Reply rules (dynamic array of all new_lead automation rules)
  const [autoReplyRules, setAutoReplyRules] = useState<AutomationRule[]>([]);
  const autoReplyEnabled = autoReplyRules.some(r => r.enabled);
  const firstReplyRule = autoReplyRules.find(r => r.delayMinutes === 0 || !r.delayMinutes) || null;
  const followUpRules = autoReplyRules
    .filter(r => r.delayMinutes > 0)
    .sort((a, b) => a.delayMinutes - b.delayMinutes);

  // Other service rules
  const [leadAlertRule, setLeadAlertRule] = useState<NotificationRule | null>(null);


  // Supporting data
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [poolPhones, setPoolPhones] = useState<{ id: string; phoneNumber: string; provider: string; friendlyName: string | null; assigned: boolean }[]>([]);
  const [ctOwnPhoneNumbers, setCtOwnPhoneNumbers] = useState<SigcorePhoneNumber[]>([]);
  const [ctSigcoreConnected, setCtSigcoreConnected] = useState(false);

  // UI state
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  // Template editor modal state
  const [templateEditor, setTemplateEditor] = useState<{
    mode: 'create' | 'service-edit';
    ruleId: string;
    templateId?: string;
    templateName?: string;
    content: string;
    type: 'autoReply' | 'alert' | 'cc-whisper' | 'cc-greeting' | 'cc-voicemail' | 'ct';
  } | null>(null);

  // Instant Call Connect state
  const [ccEnabled, setCcEnabled] = useState(false);
  const [ccMode, setCcMode] = useState<CallConnectMode>('AGENT_FIRST');
  const [ccAgentStrategy, setCcAgentStrategy] = useState<AgentStrategy>('owner');
  const [ccAgentPhone, setCcAgentPhone] = useState('');
  const [ccMaxAttempts, setCcMaxAttempts] = useState(2);
  const [ccQuietEnabled, setCcQuietEnabled] = useState(false);
  const [ccQuietTimezone, setCcQuietTimezone] = useState('America/New_York');
  const [ccQuietStart, setCcQuietStart] = useState('22:00');
  const [ccQuietEnd, setCcQuietEnd] = useState('08:00');
  const [ccAgentAcceptDigits, setCcAgentAcceptDigits] = useState('1');
  const [ccAgentWhisperMessage, setCcAgentWhisperMessage] = useState('');
  const [ccLeadGreetingMessage, setCcLeadGreetingMessage] = useState('');
  const [ccVoicemailEnabled, setCcVoicemailEnabled] = useState(false);
  const [ccVoicemailMessage, setCcVoicemailMessage] = useState('');
  const [ccVoicemailRecordingUrl, setCcVoicemailRecordingUrl] = useState('');
  const [ccBotNumber, setCcBotNumber] = useState('');
  const [ccSaving, setCcSaving] = useState(false);
  const [ccTestPhone, setCcTestPhone] = useState(() => localStorage.getItem('cc_test_phone') || '');
  const [ccTesting, setCcTesting] = useState(false);
  // Track which saved template is currently loaded in each CC message field (for edit button)
  const [ccWhisperTemplateId, setCcWhisperTemplateId] = useState<string | null>(null);
  const [ccGreetingTemplateId, setCcGreetingTemplateId] = useState<string | null>(null);
  const [ccVoicemailTemplateId, setCcVoicemailTemplateId] = useState<string | null>(null);

  // CC dirty tracking
  const [ccSavedSnapshot, setCcSavedSnapshot] = useState<{
    mode: CallConnectMode;
    agentPhone: string;
    botNumber: string;
    agentWhisperMessage: string;
    leadGreetingMessage: string;
    voicemailMessage: string;
    voicemailRecordingUrl: string;
  } | null>(null);
  const [ccValidationModalOpen, setCcValidationModalOpen] = useState(false);
  const [ccUnsavedModalOpen, setCcUnsavedModalOpen] = useState(false);

  // Lead Alerts form state (needed for first-time creation)
  const [alertToPhone, setAlertToPhone] = useState('');
  const [alertFromPhone, setAlertFromPhone] = useState('');

  // Customer Texting state
  const [ctEnabled, setCtEnabled] = useState(false);
  const [ctAutoReplyTemplate, setCtAutoReplyTemplate] = useState(
    "Hi {customerName}, this is {accountName}. We just received your request for {category}. When would be a good time to call you?"
  );
  const [ctFollowUps, setCtFollowUps] = useState<Array<{ enabled: boolean; delayMinutes: number; template: string }>>([
    { enabled: true, delayMinutes: 10, template: "Hi {customerName}, just checking in — did you get our message? We'd love to help!" },
    { enabled: true, delayMinutes: 60, template: "Hi {customerName}, this is {accountName} again. We're available to discuss your {category} needs. Feel free to reply anytime!" },
    { enabled: false, delayMinutes: 1440, template: "Hi {customerName}, we wanted to follow up one more time. Reply anytime and we'll get back to you right away!" },
  ]);
  const [ctStopOnReply, setCtStopOnReply] = useState(true);
  const [ctSaving, setCtSaving] = useState(false);
  const [ctFromPhone, setCtFromPhone] = useState('');
  const [ctSigcoreFromPhone, setCtSigcoreFromPhone] = useState<string | null>(null);
  const [ctTestPhone, setCtTestPhone] = useState(() => localStorage.getItem('ct_test_phone') || '');
  const [ctTestStatus, setCtTestStatus] = useState<'idle' | 'sending' | 'delivered' | 'failed'>('idle');
  const [ctSavedSnapshot, setCtSavedSnapshot] = useState<{ autoReplyTemplate: string; fromPhone: string } | null>(null);
  const [ctSelectedTemplateId, setCtSelectedTemplateId] = useState<string>('');

  // Derived: unsaved Lead Alert changes (only alertToPhone is pending — from-phone saves immediately)
  const alertDirty = !!leadAlertRule && alertToPhone !== (leadAlertRule.toPhone || '');

  // Derived: unsaved CT changes
  const ctDirty = ctSavedSnapshot !== null && (
    ctAutoReplyTemplate !== ctSavedSnapshot.autoReplyTemplate ||
    ctFromPhone !== ctSavedSnapshot.fromPhone
  );

  // Derived: unsaved CC changes
  const ccDirty = ccSavedSnapshot !== null && (
    ccMode !== ccSavedSnapshot.mode ||
    ccAgentPhone !== ccSavedSnapshot.agentPhone ||
    ccBotNumber !== ccSavedSnapshot.botNumber ||
    ccAgentWhisperMessage !== ccSavedSnapshot.agentWhisperMessage ||
    ccLeadGreetingMessage !== ccSavedSnapshot.leadGreetingMessage ||
    ccVoicemailMessage !== ccSavedSnapshot.voicemailMessage ||
    ccVoicemailRecordingUrl !== ccSavedSnapshot.voicemailRecordingUrl
  );

  useEffect(() => {
    loadAccounts();
  }, []);

  useEffect(() => {
    if (selectedAccountId) {
      loadServiceData(selectedAccountId);
    }
  }, [selectedAccountId]);

  async function loadAccounts() {
    try {
      const { accounts: accs } = await thumbtackApi.getSavedAccounts();
      setAccounts(accs);
      setSavedAccounts(accs); // Update global app store
      // Only set selectedAccount from fetch if nothing was pre-selected from store
      if (!selectedAccountId && accs.length > 0) {
        setSelectedAccountId(accs[0].id);
      }
    } catch (err: any) {
      // If we have store data, silent fail; only show error if accounts list is empty
      if (accounts.length === 0) {
        setError(err.message || 'Failed to load accounts');
      }
    } finally {
      setLoading(false);
    }
  }

  async function loadServiceData(accountId: string) {
    try {
      setLoading(true);
      setError(null);

      const [automationRes, notifRes, templatesRes, poolRes, ccRes, ctRes, notifSettingsRes] = await Promise.all([
        automationApi.getRulesForAccount(accountId).catch(() => ({ rules: [] as AutomationRule[] })),
        notificationsApi.getRules(accountId).catch(() => ({ rules: [] as NotificationRule[] })),
        templatesApi.getTemplates().catch(() => ({ templates: [] as MessageTemplate[] })),
        usersApi.getPoolPhonesForSms().catch(() => ({ phoneNumbers: [] })),
        callConnectApi.getSettings(accountId).catch(() => ({ settings: null })),
        notificationsApi.getCustomerTextingSettings(accountId).catch(() => null),
        notificationsApi.getSettings(accountId).catch(() => null),
      ]);

      const ccs = ccRes.settings;
      const defaultBotNumber = poolRes.phoneNumbers[0]?.phoneNumber || '';
      if (ccs) {
        setCcEnabled(ccs.enabled);
        setCcMode(ccs.mode);
        setCcAgentStrategy(ccs.agentStrategy);
        setCcAgentPhone(ccs.agentPhoneE164 || '');
        setCcMaxAttempts(ccs.maxAgentAttempts);
        setCcQuietEnabled(ccs.quietHoursEnabled);
        setCcQuietTimezone(ccs.quietHoursTimezone || 'America/New_York');
        setCcQuietStart(ccs.quietHoursStart || '22:00');
        setCcQuietEnd(ccs.quietHoursEnd || '08:00');
        setCcAgentAcceptDigits(ccs.agentAcceptDigits || '0123456789*#');
        setCcAgentWhisperMessage(ccs.agentWhisperMessage || '');
        setCcLeadGreetingMessage(ccs.leadGreetingMessage || '');
        setCcVoicemailEnabled(ccs.leadVoicemailEnabled);
        setCcVoicemailMessage(ccs.leadVoicemailMessage || '');
        setCcVoicemailRecordingUrl(ccs.leadVoicemailRecordingUrl || '');
        setCcBotNumber(ccs.botNumberE164 || defaultBotNumber);
      } else {
        setCcEnabled(false);
        setCcMode('AGENT_FIRST');
        setCcAgentStrategy('owner');
        setCcAgentPhone('');
        setCcMaxAttempts(2);
        setCcQuietEnabled(false);
        setCcQuietTimezone('America/New_York');
        setCcQuietStart('22:00');
        setCcQuietEnd('08:00');
        setCcAgentAcceptDigits('1');
        setCcAgentWhisperMessage('');
        setCcLeadGreetingMessage('');
        setCcVoicemailEnabled(false);
        setCcVoicemailMessage('');
        setCcVoicemailRecordingUrl('');
        setCcBotNumber(defaultBotNumber);
      }

      // Load Customer Texting settings
      if (ctRes) {
        setCtEnabled(ctRes.enabled);
        setCtAutoReplyTemplate(ctRes.autoReplyTemplate);
        setCtFollowUps(ctRes.followUps);
        setCtStopOnReply(ctRes.stopOnCustomerReply);
        setCtFromPhone(ctRes.fromPhone || poolRes.phoneNumbers[0]?.phoneNumber || '');
      }

      // Collect ALL new_lead automation rules
      const allAutoReplies = automationRes.rules.filter(
        (r: AutomationRule) => r.triggerType === 'new_lead'
      );
      setAutoReplyRules(allAutoReplies);

      // Find lead alert rules (non-customer-facing)
      const leadAlert = notifRes.rules.find(
        (r: NotificationRule) => r.triggerType === 'new_lead' && !r.sendToCustomer
      ) || null;

      setLeadAlertRule(leadAlert);
      setPoolPhones(poolRes.phoneNumbers);

      // Load own provider connection status for CT Option 2
      const connected = !!notifSettingsRes?.settings?.sigcoreConnected;
      setCtSigcoreConnected(connected);
      setCtSigcoreFromPhone(notifSettingsRes?.settings?.sigcoreFromPhone || null);
      if (connected) {
        notificationsApi.getSigcorePhoneNumbers(accountId).then(r => setCtOwnPhoneNumbers(r.phoneNumbers)).catch(() => {});
      } else {
        setCtOwnPhoneNumbers([]);
      }

      // Seed CC default templates for every user on first page visit
      const DEFAULT_CC_WHISPER = 'Hi {customerName}, you have a new lead for {category}. Press any key to connect with the customer.';
      const DEFAULT_CC_GREETING = 'Hi {customerName}! Thanks for your inquiry about {category}. We\'re connecting you with a specialist right now. Please hold for just a moment.';
      const DEFAULT_CC_VOICEMAIL = 'Hi {customerName}, this is {accountName}. We tried to reach you about your {category} request. Please call us back and we\'ll be happy to help!';
      const DEFAULT_CT_AUTO_REPLY = 'Hi {customerName}, this is {accountName}. We just received your request for {category}. When would be a good time to call you?';

      let allTemplates: MessageTemplate[] = [...templatesRes.templates];
      const whisperExists = allTemplates.find(t => t.name === 'CC - Agent Whisper');
      const greetingExists = allTemplates.find(t => t.name === 'CC - Lead Greeting');
      const voicemailExists = allTemplates.find(t => t.name === 'CC - Voicemail TTS');
      const ctAutoReplyExists = allTemplates.find(t => t.name === 'CT - Auto Reply');

      if (!whisperExists || !greetingExists || !voicemailExists || !ctAutoReplyExists) {
        const [whisperRes, greetingRes, voicemailRes, ctAutoReplyRes] = await Promise.all([
          whisperExists ? Promise.resolve({ template: whisperExists }) : templatesApi.createTemplate('CC - Agent Whisper', DEFAULT_CC_WHISPER),
          greetingExists ? Promise.resolve({ template: greetingExists }) : templatesApi.createTemplate('CC - Lead Greeting', DEFAULT_CC_GREETING),
          voicemailExists ? Promise.resolve({ template: voicemailExists }) : templatesApi.createTemplate('CC - Voicemail TTS', DEFAULT_CC_VOICEMAIL),
          ctAutoReplyExists ? Promise.resolve({ template: ctAutoReplyExists }) : templatesApi.createTemplate('CT - Auto Reply', DEFAULT_CT_AUTO_REPLY),
        ]);
        if (!whisperExists) allTemplates = [...allTemplates, whisperRes.template];
        if (!greetingExists) allTemplates = [...allTemplates, greetingRes.template];
        if (!voicemailExists) allTemplates = [...allTemplates, voicemailRes.template];
        if (!ctAutoReplyExists) allTemplates = [...allTemplates, ctAutoReplyRes.template];
      }

      setTemplates(allTemplates);

      // Pre-select CC templates: use saved setting content if set, otherwise load the default template
      const whisperTpl = allTemplates.find(t => t.name === 'CC - Agent Whisper');
      const greetingTpl = allTemplates.find(t => t.name === 'CC - Lead Greeting');
      const voicemailTpl = allTemplates.find(t => t.name === 'CC - Voicemail TTS');

      // Load default content if nothing saved yet
      if (!ccs?.agentWhisperMessage && whisperTpl) setCcAgentWhisperMessage(whisperTpl.content);
      if (!ccs?.leadGreetingMessage && greetingTpl) setCcLeadGreetingMessage(greetingTpl.content);
      if (!ccs?.leadVoicemailMessage && voicemailTpl) setCcVoicemailMessage(voicemailTpl.content);

      // Always restore the dropdown selection: match saved content to a template,
      // falling back to the default CC template by name so it stays pre-selected across reloads.
      const whisperContent = ccs?.agentWhisperMessage || whisperTpl?.content || '';
      const greetingContent = ccs?.leadGreetingMessage || greetingTpl?.content || '';
      const voicemailContent = ccs?.leadVoicemailMessage || voicemailTpl?.content || '';
      setCcWhisperTemplateId(allTemplates.find(t => t.content === whisperContent)?.id || whisperTpl?.id || null);
      setCcGreetingTemplateId(allTemplates.find(t => t.content === greetingContent)?.id || greetingTpl?.id || null);
      setCcVoicemailTemplateId(allTemplates.find(t => t.content === voicemailContent)?.id || voicemailTpl?.id || null);

      // Pre-select CT auto-reply template: match saved content, fall back to default by name
      const ctTpl = allTemplates.find(t => t.name === 'CT - Auto Reply');
      const ctResolvedFromPhone = ctRes?.fromPhone || poolRes.phoneNumbers[0]?.phoneNumber || '';
      const ctContent = ctRes?.autoReplyTemplate || ctTpl?.content || '';
      if (!ctRes && ctTpl) {
        setCtAutoReplyTemplate(ctTpl.content);
        setCtFromPhone(ctResolvedFromPhone);
      }
      setCtSelectedTemplateId(allTemplates.find(t => t.content === ctContent)?.id || ctTpl?.id || '');
      // Initialize CT snapshot for dirty tracking (always, same as CC)
      setCtSavedSnapshot({ autoReplyTemplate: ctContent, fromPhone: ctResolvedFromPhone });

      // Initialize CC snapshot for dirty tracking
      const snapshotWhisper = ccs?.agentWhisperMessage || whisperTpl?.content || '';
      const snapshotGreeting = ccs?.leadGreetingMessage || greetingTpl?.content || '';
      const snapshotVoicemail = ccs?.leadVoicemailMessage || voicemailTpl?.content || '';
      setCcSavedSnapshot({
        mode: (ccs?.mode || 'AGENT_FIRST') as CallConnectMode,
        agentPhone: ccs?.agentPhoneE164 || '',
        botNumber: ccs?.botNumberE164 || defaultBotNumber,
        agentWhisperMessage: snapshotWhisper,
        leadGreetingMessage: snapshotGreeting,
        voicemailMessage: snapshotVoicemail,
        voicemailRecordingUrl: ccs?.leadVoicemailRecordingUrl || '',
      });

      // Pre-fill form states from existing rules
      if (leadAlert) {
        setAlertToPhone(leadAlert.toPhone || '');
        setAlertFromPhone(leadAlert.fromPhone || '');
      }
      // Default from phone to first pool phone
      const defaultFrom = poolRes.phoneNumbers[0]?.phoneNumber || '';
      if (!leadAlert) setAlertFromPhone(defaultFrom);

      // Auto-expand Lead Alerts card if setup is incomplete OR directed here from Dashboard alert
      const toPhoneMissing = leadAlert && !leadAlert.toPhone;
      const templateMissing = leadAlert && !leadAlert.templateId && !leadAlert.messageTemplate;
      const expandParam = searchParams.get('expand');
      if (toPhoneMissing || templateMissing || expandParam === 'lead-alerts') {
        setExpandedCard('lead-alerts');
      }

    } catch (err: any) {
      setError(err.message || 'Failed to load services data');
    } finally {
      setLoading(false);
    }
  }

  function showSuccess(msg: string) {
    setSuccessMessage(msg);
    setTimeout(() => setSuccessMessage(null), 3000);
  }

  // --- Phone formatting helpers ---

  function formatPhoneE164(raw: string): string {
    if (!raw.trim()) return raw;
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 0) return raw;
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    if (digits.length >= 7 && digits.length <= 15) return `+${digits}`;
    return raw;
  }

  function isValidPhoneE164(phone: string): boolean {
    // US E.164: +1 followed by 10 digits, area code must start with 2-9
    return /^\+1[2-9]\d{9}$/.test(phone);
  }

  // --- Toggle Handlers ---

  async function toggleAutoReply(enabled: boolean) {
    setError(null);
    // Optimistic: update UI immediately
    const prevRules = [...autoReplyRules];
    if (autoReplyRules.length > 0) {
      setAutoReplyRules(prev => prev.map(r => ({ ...r, enabled })));
    }
    setSaving(true);
    try {
      if (autoReplyRules.length > 0) {
        // Toggle all existing rules
        const updated = await Promise.all(
          autoReplyRules.map(r => automationApi.updateRule(r.id, { enabled }))
        );
        setAutoReplyRules(updated.map(u => u.rule));
      } else if (enabled) {
        // First time: create default template + first message rule only
        let templateId = templates.find(t => t.name.includes('Auto Reply'))?.id;
        if (!templateId) {
          const { template } = await templatesApi.createTemplate(
            'Auto Reply - Welcome',
            'Hi {firstName}, thanks for reaching out about {category}! I\'d love to help. Let me review your request and get back to you shortly.',
          );
          templateId = template.id;
          setTemplates(prev => [template, ...prev]);
        }

        const { rule } = await automationApi.createRule({
          savedAccountId: selectedAccountId,
          name: 'Auto Reply - Immediate',
          triggerType: 'new_lead',
          templateId,
          delayMinutes: 0,
          enabled: true,
        });
        setAutoReplyRules([rule]);
        showSuccess('Auto Reply enabled');
      }
    } catch (err: any) {
      // Rollback on error
      setAutoReplyRules(prevRules);
      setError(err.response?.data?.message || err.message || 'Failed to toggle Auto Reply');
    } finally {
      setSaving(false);
    }
  }

  async function toggleLeadAlerts(enabled: boolean) {
    setError(null);
    // Optimistic: update UI immediately
    const prevAlertRule = leadAlertRule ? { ...leadAlertRule } : null;
    if (leadAlertRule) {
      setLeadAlertRule({ ...leadAlertRule, enabled });
    }
    setSaving(true);
    try {
      if (leadAlertRule) {
        const { rule } = await notificationsApi.updateRule(selectedAccountId, leadAlertRule.id, { enabled });
        setLeadAlertRule(rule);
      } else if (enabled) {
        // Find or create a default Lead Alert template
        const DEFAULT_ALERT_TEMPLATE =
          'New lead: {lead.name}, Price {lead.price}\n' +
          'Location: {lead.location}, {lead.zip}\n' +
          'Service: {lead.service} {lead.bedrooms} bed / {lead.bathrooms} bath\n' +
          'Frequency: {lead.frequency}\n' +
          'Description: {lead.serviceDescription}\n' +
          'Add-ons: {lead.addons}\n' +
          'Pets: {lead.pets}\n' +
          'Message: {lead.message}\n' +
          'Phone: {lead.phone}';

        let templateId = templates.find(t => t.name.includes('Lead Alert'))?.id;
        if (!templateId) {
          const { template } = await templatesApi.createTemplate(
            'Lead Alert - SMS',
            DEFAULT_ALERT_TEMPLATE,
          );
          templateId = template.id;
          setTemplates(prev => [template, ...prev]);
        }

        const defaultFrom = poolPhones[0]?.phoneNumber || '';
        const { rule } = await notificationsApi.createRule(selectedAccountId, {
          name: 'Lead Alert - SMS',
          triggerType: 'new_lead',
          fromPhone: alertFromPhone || defaultFrom,
          toPhone: alertToPhone,
          sendToCustomer: false,
          template: DEFAULT_ALERT_TEMPLATE,
          templateId,
          enabled: true,
        });
        setLeadAlertRule(rule);
        if (!alertFromPhone && defaultFrom) setAlertFromPhone(defaultFrom);
        setExpandedCard('lead-alerts');
        showSuccess('Lead Alerts enabled — configure your alert phone number');
      }
    } catch (err: any) {
      // Rollback on error
      setLeadAlertRule(prevAlertRule);
      setError(err.response?.data?.message || err.message || 'Failed to toggle Lead Alerts');
    } finally {
      setSaving(false);
    }
  }


  async function toggleCallConnect(enabled: boolean) {
    if (!selectedAccountId) return;
    setCcEnabled(enabled); // optimistic
    setCcSaving(true);
    try {
      const { settings } = await callConnectApi.saveSettings(selectedAccountId, { enabled });
      setCcEnabled(settings.enabled);
    } catch (err: any) {
      setCcEnabled(!enabled); // rollback
      setError(err.response?.data?.message || err.message || 'Failed to update Call Connect');
    } finally {
      setCcSaving(false);
    }
  }

  async function saveCcSettings() {
    if (!selectedAccountId) return;
    setCcSaving(true);
    try {
      await callConnectApi.saveSettings(selectedAccountId, {
        enabled: ccEnabled,
        mode: ccMode,
        agentStrategy: ccAgentStrategy,
        agentPhoneE164: ccAgentPhone || undefined,
        maxAgentAttempts: ccMaxAttempts,
        quietHoursEnabled: ccQuietEnabled,
        quietHoursTimezone: ccQuietEnabled ? ccQuietTimezone : undefined,
        quietHoursStart: ccQuietEnabled ? ccQuietStart : undefined,
        quietHoursEnd: ccQuietEnabled ? ccQuietEnd : undefined,
        agentAcceptDigits: ccAgentAcceptDigits || '0123456789*#',
        agentWhisperMessage: ccAgentWhisperMessage || undefined,
        leadGreetingMessage: ccLeadGreetingMessage || undefined,
        leadVoicemailEnabled: ccVoicemailEnabled,
        leadVoicemailMessage: ccVoicemailEnabled ? ccVoicemailMessage : undefined,
        leadVoicemailRecordingUrl: ccVoicemailEnabled ? ccVoicemailRecordingUrl : undefined,
        botNumberE164: ccBotNumber || undefined,
      });
      showSuccess('Instant Call Connect settings saved');
      setCcSavedSnapshot({
        mode: ccMode,
        agentPhone: ccAgentPhone,
        botNumber: ccBotNumber,
        agentWhisperMessage: ccAgentWhisperMessage,
        leadGreetingMessage: ccLeadGreetingMessage,
        voicemailMessage: ccVoicemailMessage,
        voicemailRecordingUrl: ccVoicemailRecordingUrl,
      });
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to save Call Connect settings');
    } finally {
      setCcSaving(false);
    }
  }

  async function toggleCustomerTexting(enabled: boolean) {
    if (!selectedAccountId) return;
    setCtEnabled(enabled); // optimistic
    setCtSaving(true);
    try {
      await notificationsApi.saveCustomerTextingSettings(selectedAccountId, {
        enabled,
        fromPhone: ctFromPhone || undefined,
        autoReplyTemplate: ctAutoReplyTemplate,
        followUps: ctFollowUps,
        stopOnCustomerReply: ctStopOnReply,
      });
    } catch (err: any) {
      setCtEnabled(!enabled); // rollback
      setError(err.response?.data?.message || err.message || 'Failed to toggle Customer Texting');
    } finally {
      setCtSaving(false);
    }
  }

  async function saveCtSettings() {
    if (!selectedAccountId) return;
    setCtSaving(true);
    try {
      await notificationsApi.saveCustomerTextingSettings(selectedAccountId, {
        enabled: ctEnabled,
        fromPhone: ctFromPhone || undefined,
        autoReplyTemplate: ctAutoReplyTemplate,
        followUps: ctFollowUps,
        stopOnCustomerReply: ctStopOnReply,
      });
      showSuccess('Customer Texting settings saved');
      setCtSavedSnapshot({ autoReplyTemplate: ctAutoReplyTemplate, fromPhone: ctFromPhone });
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to save Customer Texting settings');
    } finally {
      setCtSaving(false);
    }
  }

  function discardAlertChanges() {
    setAlertToPhone(leadAlertRule?.toPhone || '');
  }

  function discardCtChanges() {
    if (!ctSavedSnapshot) return;
    setCtAutoReplyTemplate(ctSavedSnapshot.autoReplyTemplate);
    setCtFromPhone(ctSavedSnapshot.fromPhone);
    setCtSelectedTemplateId(templates.find(t => t.content === ctSavedSnapshot.autoReplyTemplate)?.id || '');
  }

  async function doTestCall() {
    if (!selectedAccountId) return;
    setCcTesting(true);
    try {
      await callConnectApi.testCall(selectedAccountId, ccTestPhone.trim());
      showSuccess('Test call triggered — your agent phone should ring shortly');
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Test call failed');
    } finally {
      setCcTesting(false);
    }
  }

  async function handleTestCall() {
    if (!selectedAccountId) return;
    // Guard 1: required fields must be valid
    const agentPhoneOk = ccAgentPhone && isValidPhoneE164(ccAgentPhone);
    const botNumberOk = !!ccBotNumber;
    const testPhoneOk = ccTestPhone.trim() && isValidPhoneE164(ccTestPhone);
    if (!agentPhoneOk || !botNumberOk || !testPhoneOk) {
      setCcValidationModalOpen(true);
      return;
    }
    // Guard 2: no unsaved changes
    if (ccDirty) {
      setCcUnsavedModalOpen(true);
      return;
    }
    await doTestCall();
  }

  function discardCcChanges() {
    if (!ccSavedSnapshot) return;
    setCcMode(ccSavedSnapshot.mode);
    setCcAgentPhone(ccSavedSnapshot.agentPhone);
    setCcBotNumber(ccSavedSnapshot.botNumber);
    setCcAgentWhisperMessage(ccSavedSnapshot.agentWhisperMessage);
    setCcLeadGreetingMessage(ccSavedSnapshot.leadGreetingMessage);
    setCcVoicemailMessage(ccSavedSnapshot.voicemailMessage);
    setCcVoicemailRecordingUrl(ccSavedSnapshot.voicemailRecordingUrl);
  }

  // --- Auto Reply Handlers ---

  async function changeRuleTemplate(ruleId: string, templateId: string) {
    setSaving(true);
    try {
      const { rule } = await automationApi.updateRule(ruleId, { templateId });
      setAutoReplyRules(prev => prev.map(r => r.id === ruleId ? rule : r));
      showSuccess('Template updated');
    } catch (err: any) {
      setError(err.message || 'Failed to update template');
    } finally {
      setSaving(false);
    }
  }

  // changeFollowUpDelay, addFollowUp, deleteFollowUp removed — follow-ups are Coming Soon

  // --- Lead Alert Handlers ---

  async function changeAlertRuleTemplate(ruleId: string, templateId: string) {
    setSaving(true);
    try {
      const { rule } = await notificationsApi.updateRule(selectedAccountId, ruleId, { templateId });
      setLeadAlertRule(rule);
      showSuccess('Template updated');
    } catch (err: any) {
      setError(err.message || 'Failed to update template');
    } finally {
      setSaving(false);
    }
  }

  async function saveAlertToPhone(toPhone: string) {
    setAlertToPhone(toPhone);
    if (!leadAlertRule) return;
    setSaving(true);
    try {
      const { rule } = await notificationsApi.updateRule(selectedAccountId, leadAlertRule.id, { toPhone });
      setLeadAlertRule(rule);
      showSuccess('Alert destination updated');
    } catch (err: any) {
      setError(err.message || 'Failed to update alert destination');
    } finally {
      setSaving(false);
    }
  }

  async function saveAlertFromPhone(fromPhone: string) {
    setAlertFromPhone(fromPhone);
    if (!leadAlertRule) return;
    setSaving(true);
    try {
      const { rule } = await notificationsApi.updateRule(selectedAccountId, leadAlertRule.id, { fromPhone });
      setLeadAlertRule(rule);
      showSuccess('Send from number updated');
    } catch (err: any) {
      setError(err.message || 'Failed to update from phone');
    } finally {
      setSaving(false);
    }
  }

  async function sendTestAlert() {
    if (!leadAlertRule || !selectedAccountId) return;
    setTestStatus('sending');
    setError(null);
    try {
      const result = await notificationsApi.sendTest(selectedAccountId, leadAlertRule.id);
      if (result.success) {
        setTestStatus('delivered');
        setTimeout(() => setTestStatus('idle'), 4000);
      } else {
        setTestStatus('failed');
        setError(result.message || 'Failed to send test');
        setTimeout(() => setTestStatus('idle'), 4000);
      }
    } catch (err: any) {
      setTestStatus('failed');
      setError(err.response?.data?.message || err.message || 'Failed to send test SMS');
      setTimeout(() => setTestStatus('idle'), 4000);
    }
  }

  async function deleteLeadAlertRule() {
    if (!leadAlertRule || !selectedAccountId) return;
    setDeletingAlert(true);
    setError(null);
    try {
      await notificationsApi.deleteRule(selectedAccountId, leadAlertRule.id);
      setLeadAlertRule(null);
      setAlertToPhone('');
      setConfirmDeleteAlert(false);
      setExpandedCard(null);
      showSuccess('Lead Alerts rule removed — toggle it on to set up fresh');
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to delete rule');
    } finally {
      setDeletingAlert(false);
    }
  }

  // --- Customer Texting Handlers ---

  function saveCtFromPhone(fromPhone: string) {
    setCtFromPhone(fromPhone); // tracked in ctDirty — saved when user clicks Save Settings
  }

  async function sendCtTest() {
    if (!selectedAccountId || !ctTestPhone) return;
    setCtTestStatus('sending');
    setError(null);
    try {
      const result = await notificationsApi.sendTest(selectedAccountId, undefined, ctTestPhone, ctAutoReplyTemplate || undefined);
      if (result.success) {
        setCtTestStatus('delivered');
        setTimeout(() => setCtTestStatus('idle'), 4000);
      } else {
        setCtTestStatus('failed');
        setError(result.message || 'Failed to send test');
        setTimeout(() => setCtTestStatus('idle'), 4000);
      }
    } catch (err: any) {
      setCtTestStatus('failed');
      setError(err.response?.data?.message || err.message || 'Failed to send test SMS');
      setTimeout(() => setCtTestStatus('idle'), 4000);
    }
  }

  // --- Template Editor Modal Handlers ---

  async function handleEditorCreate({ name, content }: { name: string; content: string }) {
    if (!templateEditor) return;
    setSaving(true);
    try {
      const { template } = await templatesApi.createTemplate(name, content || 'Hi {{lead.name}}, ');
      setTemplates(prev => [template, ...prev]);
      if (templateEditor.type === 'autoReply') {
        await changeRuleTemplate(templateEditor.ruleId, template.id);
      } else if (templateEditor.type === 'alert') {
        await changeAlertRuleTemplate(templateEditor.ruleId, template.id);
      } else if (templateEditor.type === 'cc-whisper') {
        setCcAgentWhisperMessage(template.content); setCcWhisperTemplateId(template.id);
      } else if (templateEditor.type === 'cc-greeting') {
        setCcLeadGreetingMessage(template.content); setCcGreetingTemplateId(template.id);
      } else if (templateEditor.type === 'cc-voicemail') {
        setCcVoicemailMessage(template.content); setCcVoicemailTemplateId(template.id);
      } else if (templateEditor.type === 'ct') {
        setCtAutoReplyTemplate(template.content); setCtSelectedTemplateId(template.id);
      }
      setTemplateEditor(null);
      showSuccess('Template created');
    } catch (err: any) {
      setError(err.message || 'Failed to create template');
    } finally {
      setSaving(false);
    }
  }

  async function handleEditorUpdate({ content }: { name: string; content: string }) {
    if (!templateEditor || !templateEditor.templateId) return;
    const { ruleId, templateId, type } = templateEditor;
    setSaving(true);
    try {
      const { template } = await templatesApi.updateTemplate(templateId, { content });
      setTemplates(prev => prev.map(t => t.id === templateId ? { ...t, content: template.content } : t));
      setAutoReplyRules(prev => prev.map(r =>
        r.id === ruleId && r.template?.id === templateId
          ? { ...r, template: { ...r.template!, content: template.content } }
          : r
      ));
      if (leadAlertRule?.id === ruleId && leadAlertRule?.messageTemplate?.id === templateId) {
        setLeadAlertRule({ ...leadAlertRule, messageTemplate: { ...leadAlertRule.messageTemplate!, content: template.content } });
      }
      if (type === 'cc-whisper') setCcAgentWhisperMessage(template.content);
      else if (type === 'cc-greeting') setCcLeadGreetingMessage(template.content);
      else if (type === 'cc-voicemail') setCcVoicemailMessage(template.content);
      else if (type === 'ct') setCtAutoReplyTemplate(template.content);
      setTemplateEditor(null);
      showSuccess('Template saved');
    } catch (err: any) {
      setError(err.message || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  }

  async function handleEditorSaveAsNew({ name, content }: { name: string; content: string }) {
    if (!templateEditor) return;
    setSaving(true);
    try {
      const { template } = await templatesApi.createTemplate(name, content);
      setTemplates(prev => [template, ...prev]);
      if (templateEditor.type === 'autoReply') {
        await changeRuleTemplate(templateEditor.ruleId, template.id);
      } else if (templateEditor.type === 'alert') {
        await changeAlertRuleTemplate(templateEditor.ruleId, template.id);
      } else if (templateEditor.type === 'cc-whisper') {
        setCcAgentWhisperMessage(template.content); setCcWhisperTemplateId(template.id);
      } else if (templateEditor.type === 'cc-greeting') {
        setCcLeadGreetingMessage(template.content); setCcGreetingTemplateId(template.id);
      } else if (templateEditor.type === 'cc-voicemail') {
        setCcVoicemailMessage(template.content); setCcVoicemailTemplateId(template.id);
      } else if (templateEditor.type === 'ct') {
        setCtAutoReplyTemplate(template.content); setCtSelectedTemplateId(template.id);
      }
      setTemplateEditor(null);
      showSuccess('Saved as new template');
    } catch (err: any) {
      setError(err.message || 'Failed to save as new template');
    } finally {
      setSaving(false);
    }
  }

  function toggleExpand(card: string) {
    setExpandedCard(expandedCard === card ? null : card);
  }

  // --- Render ---

  if (loading && accounts.length === 0) {
    return (
      <div className="p-6 lg:p-10">
        <div className="flex items-center gap-3 mb-6">
          <Briefcase className="w-6 h-6 text-blue-600" />
          <h1 className="text-2xl font-bold text-slate-900">Automation</h1>
        </div>
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 size={32} className="animate-spin text-blue-600" />
          <p className="mt-4 text-slate-500">Loading...</p>
        </div>
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="p-6 lg:p-10">
        <div className="flex items-center gap-3 mb-6">
          <Briefcase className="w-6 h-6 text-blue-600" />
          <h1 className="text-2xl font-bold text-slate-900">Automation</h1>
        </div>
        <div className="max-w-md mx-auto bg-white rounded-3xl border border-slate-100 shadow-sm p-10 text-center mt-10">
          <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
          <h3 className="text-xl font-bold text-slate-900 mb-2">No Accounts Connected</h3>
          <p className="text-slate-500 mb-6">You need to connect an account first.</p>
          <button
            className="px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all"
            onClick={() => navigate('/dashboard')}
          >
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-10 max-w-5xl mx-auto space-y-8">
      {/* Floating Notifications */}
      {error && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 max-w-md w-full mx-4 bg-red-50 border border-red-100 rounded-2xl p-4 flex items-center gap-3 text-red-600 text-sm font-medium shadow-lg animate-in slide-in-from-top-2">
          <AlertCircle size={16} className="shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="p-1 hover:bg-red-100 rounded-lg transition-colors">
            <X size={16} />
          </button>
        </div>
      )}

      {successMessage && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 max-w-md w-full mx-4 bg-emerald-50 border border-emerald-100 rounded-2xl p-4 flex items-center gap-3 text-emerald-600 text-sm font-medium shadow-lg animate-in slide-in-from-top-2">
          <CheckCircle size={16} className="shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      {/* Account Selector */}
      <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-1">Select Account</h2>
          <p className="text-slate-600 text-sm">Configure automation rules for your business profile.</p>
        </div>
        <div className="relative min-w-[240px]">
          <select
            value={selectedAccountId}
            onChange={e => setSelectedAccountId(e.target.value)}
            className="w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl focus:ring-blue-500 focus:border-blue-500 block p-3 appearance-none font-semibold"
          >
            {accounts.map(acc => (
              <option key={acc.id} value={acc.id}>{acc.businessName}</option>
            ))}
          </select>
          <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-slate-400">
            <ChevronDown className="w-4 h-4" />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 size={24} className="animate-spin text-blue-600" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6">

          {/* 1. Auto Reply & Follow-Ups */}
          <ServiceCard
            icon={<Zap className="w-7 h-7" />}
            title="Auto Reply & Follow-Ups"
            description="Automatically respond to new leads as they arrive."
            enabled={autoReplyEnabled}
            onToggle={toggleAutoReply}
            expanded={expandedCard === 'auto-reply'}
            onExpand={() => toggleExpand('auto-reply')}
            statusText={autoReplyEnabled ? `Active: ${1 + followUpRules.length} message${followUpRules.length > 0 ? 's' : ''} in sequence` : undefined}
          >
            {/* AI Optimization Banner — Coming Soon */}
            <div className="bg-gradient-to-r from-slate-900 to-slate-800 rounded-2xl p-6 text-white flex flex-col md:flex-row items-center justify-between gap-6 relative overflow-hidden">
              <div className="flex items-center gap-4 relative z-10">
                <div className="w-12 h-12 bg-white/10 rounded-xl flex items-center justify-center">
                  <Bot className="w-6 h-6 text-blue-400" />
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
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

            {/* First Message */}
            {firstReplyRule && (
              <div>
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Template</label>
                <select
                  value={firstReplyRule.templateId || ''}
                  onChange={e => {
                    if (e.target.value === '__create_new__') {
                      setTemplateEditor({ mode: 'create', ruleId: firstReplyRule.id, content: '', type: 'autoReply' });
                    } else {
                      changeRuleTemplate(firstReplyRule.id, e.target.value);
                    }
                  }}
                  disabled={saving}
                  className="w-full bg-white border border-slate-200 rounded-xl p-3 text-sm font-medium disabled:opacity-50"
                >
                  <option value="">Select template...</option>
                  {templates.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                  <option value="__create_new__">+ Create New Template</option>
                </select>
                {firstReplyRule.template?.content && (
                  <div className="mt-4 bg-white p-5 rounded-xl border border-dashed border-slate-200 text-slate-600 text-sm leading-relaxed relative group">
                    {firstReplyRule.template.content}
                    <button
                      onClick={() => setTemplateEditor({
                        mode: 'service-edit',
                        ruleId: firstReplyRule.id,
                        templateId: firstReplyRule.template!.id,
                        templateName: templates.find(t => t.id === firstReplyRule.templateId)?.name || 'template',
                        content: firstReplyRule.template!.content,
                        type: 'autoReply',
                      })}
                      className="absolute top-3 right-3 p-2 bg-slate-50 rounded-lg text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity hover:text-blue-600"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Follow-Up Messages - Coming Soon */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-slate-400">
                <Clock className="w-4 h-4" />
                <span className="font-bold">Follow-Up Messages</span>
                <span className="px-2 py-0.5 bg-slate-200 text-[10px] font-bold rounded uppercase">Coming Soon</span>
              </div>
              {followUpRules.length > 0 ? (
                followUpRules.map((rule, idx) => (
                  <div key={rule.id} className="bg-slate-50/50 rounded-2xl p-6 border border-slate-100 opacity-50">
                    <div className="text-sm font-bold text-slate-600 mb-3">Message {idx + 2}</div>
                    <div className="text-xs text-slate-500">Delay: {rule.delayMinutes} minutes</div>
                  </div>
                ))
              ) : (
                <div className="bg-slate-50/50 rounded-2xl p-6 border border-slate-100 border-dashed opacity-50 text-center">
                  <p className="text-sm text-slate-400">Scheduled follow-up messages will appear here</p>
                </div>
              )}
            </div>
          </ServiceCard>

          {/* 2. Lead Alerts */}
          {(() => {
            const toPhoneMissing = !!leadAlertRule && !alertToPhone;
            const templateMissing = !!leadAlertRule && !leadAlertRule.templateId && !leadAlertRule.messageTemplate;
            const leadAlertsIncomplete = toPhoneMissing || templateMissing;
            const directedHere = searchParams.get('expand') === 'lead-alerts';
            const isDisabledButExists = !!leadAlertRule && !leadAlertRule.enabled;
            const warningText = leadAlertsIncomplete
              ? (toPhoneMissing ? 'Phone number required' : 'Template required')
              : (directedHere && isDisabledButExists) ? 'Toggle on to activate lead alerts' : undefined;
            return (
          <ServiceCard
            icon={<Bell className="w-7 h-7" />}
            title="Lead Alerts"
            description="Get SMS notifications for every new inquiry."
            enabled={leadAlertRule?.enabled ?? false}
            onToggle={toggleLeadAlerts}
            expanded={expandedCard === 'lead-alerts'}
            onExpand={() => toggleExpand('lead-alerts')}
            setupRequired={leadAlertsIncomplete || (directedHere && isDisabledButExists)}
            warningText={warningText}
            statusText={!leadAlertsIncomplete && leadAlertRule?.enabled ? `Destination: ${leadAlertRule.toPhone}` : undefined}
            iconBgColor="bg-amber-50"
            iconTextColor="text-amber-600"
          >
            {/* SMS Alert Configuration */}
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                {/* Send to */}
                <div>
                  <label className={`text-[11px] font-bold uppercase tracking-widest mb-2 block ${toPhoneMissing ? 'text-orange-500' : 'text-slate-400'}`}>
                    Send to (your phone){toPhoneMissing && <span className="ml-1 text-orange-500">*</span>}
                  </label>
                  <input
                    type="tel"
                    value={alertToPhone}
                    onChange={e => setAlertToPhone(e.target.value)}
                    onBlur={e => {
                      const formatted = formatPhoneE164(e.target.value);
                      if (formatted !== e.target.value) setAlertToPhone(formatted);
                    }}
                    placeholder="+1234567890"
                    className={`w-full rounded-xl p-3 text-sm focus:ring-2 focus:outline-none transition-colors ${
                      toPhoneMissing
                        ? 'border-2 border-orange-300 bg-orange-50/40 focus:ring-orange-200 focus:border-orange-400 placeholder:text-orange-300'
                        : alertToPhone && !isValidPhoneE164(alertToPhone)
                          ? 'border-2 border-red-300 bg-red-50/30 focus:ring-red-200 focus:border-red-400'
                          : alertToPhone && isValidPhoneE164(alertToPhone)
                            ? 'border-2 border-emerald-300 bg-emerald-50/20 focus:ring-emerald-200 focus:border-emerald-400'
                            : 'bg-white border border-slate-200 focus:ring-blue-500 focus:border-blue-500'
                    }`}
                  />
                  {toPhoneMissing && (
                    <p className="mt-1.5 text-xs text-orange-600 font-medium flex items-center gap-1">
                      <AlertCircle className="w-3 h-3 shrink-0" />
                      Enter your phone number to receive lead alert SMS messages
                    </p>
                  )}
                  {!toPhoneMissing && alertToPhone && !isValidPhoneE164(alertToPhone) && (
                    <p className="mt-1.5 text-xs text-red-600 font-medium flex items-center gap-1">
                      <AlertCircle className="w-3 h-3 shrink-0" />
                      Must be E.164 format, e.g. +12125550100
                    </p>
                  )}
                </div>

                {/* Send from */}
                <div>
                  <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Send from</label>
                  <div className="relative">
                    <select
                      value={alertFromPhone}
                      onChange={e => saveAlertFromPhone(e.target.value)}
                      disabled={saving}
                      className="w-full bg-white border border-slate-200 rounded-xl p-3 text-sm font-medium disabled:opacity-50 appearance-none"
                    >
                      <option value="">Select phone number</option>
                      {/* Legacy: currently configured number not found in any list */}
                      {alertFromPhone &&
                        !poolPhones.some(p => p.phoneNumber === alertFromPhone) &&
                        !ctOwnPhoneNumbers.some(p => p.phoneNumber === alertFromPhone) &&
                        alertFromPhone !== ctSigcoreFromPhone && (
                          <option value={alertFromPhone}>{alertFromPhone} (configured)</option>
                      )}
                      {poolPhones.map(p => (
                        <option key={p.id} value={p.phoneNumber}>
                          {p.phoneNumber} (LeadBridge shared)
                        </option>
                      ))}
                      {ctOwnPhoneNumbers.map(p => (
                        <option key={p.id} value={p.phoneNumber}>
                          {p.phoneNumber}{p.friendlyName ? ` — ${p.friendlyName}` : ''} ({p.provider === 'openphone' ? 'OpenPhone/QUO' : p.provider})
                        </option>
                      ))}
                      {ctSigcoreFromPhone && !ctOwnPhoneNumbers.some(p => p.phoneNumber === ctSigcoreFromPhone) && (
                        <option value={ctSigcoreFromPhone}>
                          {ctSigcoreFromPhone} (Twilio · Dedicated)
                        </option>
                      )}
                    </select>
                    <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-slate-400">
                      <ChevronDown className="w-4 h-4" />
                    </div>
                  </div>
                  {alertFromPhone && alertToPhone && alertFromPhone === alertToPhone && (
                    <p className="mt-1.5 text-xs text-amber-600 font-medium flex items-center gap-1">
                      <AlertCircle className="w-3 h-3 shrink-0" />
                      Send-from and send-to are the same number
                    </p>
                  )}
                </div>
              </div>

              {leadAlertRule && (
                <>
                  <div>
                    <label className={`text-[11px] font-bold uppercase tracking-widest mb-2 block ${templateMissing ? 'text-orange-500' : 'text-slate-400'}`}>
                      Template{templateMissing && <span className="ml-1 text-orange-500">*</span>}
                    </label>
                    <select
                      value={leadAlertRule.templateId || leadAlertRule.messageTemplate?.id || ''}
                      onChange={e => {
                        if (e.target.value === '__create_new__') {
                          setTemplateEditor({ mode: 'create', ruleId: leadAlertRule.id, content: '', type: 'alert' });
                        } else {
                          changeAlertRuleTemplate(leadAlertRule.id, e.target.value);
                        }
                      }}
                      disabled={saving}
                      className={`w-full rounded-xl p-3 text-sm font-medium disabled:opacity-50 transition-colors ${
                        templateMissing
                          ? 'border-2 border-orange-300 bg-orange-50/40 focus:ring-orange-200 focus:border-orange-400'
                          : 'bg-white border border-slate-200'
                      }`}
                    >
                      <option value="">Select template</option>
                      {templates.map(t => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                      <option value="__create_new__">+ Create New Template</option>
                    </select>
                    {templateMissing && (
                      <p className="mt-1.5 text-xs text-orange-600 font-medium flex items-center gap-1">
                        <AlertCircle className="w-3 h-3 shrink-0" />
                        Select or create a template to define the SMS message content
                      </p>
                    )}
                    {leadAlertRule.messageTemplate && (
                      <div className="mt-4 bg-white p-5 rounded-xl border border-dashed border-slate-200 text-slate-600 text-sm leading-relaxed relative group">
                        {leadAlertRule.messageTemplate.content}
                        <button
                          onClick={() => setTemplateEditor({
                            mode: 'service-edit',
                            ruleId: leadAlertRule.id,
                            templateId: leadAlertRule.messageTemplate!.id,
                            templateName: templates.find(t => t.id === (leadAlertRule.templateId || leadAlertRule.messageTemplate?.id))?.name || 'template',
                            content: leadAlertRule.messageTemplate!.content,
                            type: 'alert',
                          })}
                          className="absolute top-3 right-3 p-2 bg-slate-50 rounded-lg text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity hover:text-blue-600"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Send Test + Trigger Stats + Save Button */}
                  <div className="space-y-4 pt-4 border-t border-slate-100">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                      <button
                        onClick={sendTestAlert}
                        disabled={testStatus === 'sending' || saving || !leadAlertRule.toPhone || !alertFromPhone}
                        className={`px-4 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:cursor-not-allowed flex items-center gap-2 ${
                          testStatus === 'delivered' ? 'bg-emerald-100 text-emerald-700' :
                          testStatus === 'failed' ? 'bg-red-100 text-red-700' :
                          testStatus === 'sending' ? 'bg-slate-100 text-slate-500' :
                          'bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50'
                        }`}
                        title={!leadAlertRule.toPhone ? 'Set a destination phone first' : !alertFromPhone ? 'Set a send-from phone first' : 'Send a test SMS'}
                      >
                        {testStatus === 'sending' ? <Loader2 size={14} className="animate-spin" /> :
                         testStatus === 'delivered' ? <CheckCircle size={14} /> :
                         testStatus === 'failed' ? <X size={14} /> :
                         <Send size={14} />}
                        {testStatus === 'sending' ? 'Sending...' :
                         testStatus === 'delivered' ? 'Delivered' :
                         testStatus === 'failed' ? 'Failed' :
                         'Send Test SMS'}
                      </button>
                      {leadAlertRule.triggerCount > 0 && (
                        <span className="text-xs text-slate-500">
                          Triggered {leadAlertRule.triggerCount} time{leadAlertRule.triggerCount !== 1 ? 's' : ''}
                          {leadAlertRule.lastTriggeredAt && (
                            <> — last {new Date(leadAlertRule.lastTriggeredAt).toLocaleDateString()}</>
                          )}
                        </span>
                      )}
                    </div>
                    {alertDirty && (
                      <div className="flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3">
                        <div className="flex items-center gap-2 text-amber-700">
                          <AlertCircle className="w-4 h-4 shrink-0" />
                          <span className="text-sm font-medium">You have unsaved changes</span>
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <button
                            onClick={discardAlertChanges}
                            className="px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                          >
                            Discard
                          </button>
                          <button
                            onClick={() => saveAlertToPhone(alertToPhone)}
                            disabled={saving || !alertToPhone}
                            className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-1"
                          >
                            {saving && <Loader2 className="w-3 h-3 animate-spin" />}
                            Save Changes
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* Delete / Reset rule */}
              {leadAlertRule && (
                <div className="pt-4 border-t border-slate-100">
                  {confirmDeleteAlert ? (
                    <div className="bg-red-50 border border-red-100 rounded-2xl p-4 flex flex-col sm:flex-row items-start sm:items-center gap-4">
                      <div className="flex-1">
                        <p className="text-sm font-bold text-red-700">Delete this Lead Alert rule?</p>
                        <p className="text-xs text-red-500 mt-0.5">This removes the rule and phone configuration. Toggle Lead Alerts back on to create a fresh setup with the new default template.</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => setConfirmDeleteAlert(false)}
                          className="px-3 py-2 text-sm font-semibold text-slate-600 hover:text-slate-800 transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={deleteLeadAlertRule}
                          disabled={deletingAlert}
                          className="px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 transition-all disabled:opacity-50 flex items-center gap-2"
                        >
                          {deletingAlert ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                          Delete Rule
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteAlert(true)}
                      className="text-xs font-semibold text-slate-400 hover:text-red-500 transition-colors flex items-center gap-1.5"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete this rule and start over
                    </button>
                  )}
                </div>
              )}
            </div>
          </ServiceCard>
            );
          })()}

          {/* 3. Customer Texting */}
          <ServiceCard
            icon={<MessageSquare className="w-7 h-7" />}
            title="Customer Texting"
            description="Automatically text customers when new leads arrive, with follow-up reminders."
            enabled={ctEnabled}
            onToggle={ctSaving ? () => {} : toggleCustomerTexting}
            expanded={expandedCard === 'customer-texting'}
            onExpand={() => toggleExpand('customer-texting')}
            statusText={ctEnabled ? 'Active — texting new leads automatically' : undefined}
            iconBgColor="bg-emerald-50"
            iconTextColor="text-emerald-600"
          >
            <div className={`space-y-6${!ctEnabled ? ' opacity-40 pointer-events-none select-none' : ''}`}>
              {/* Phone number — unified Send From dropdown */}
              <div className="space-y-2">
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest block">Send from</label>
                <div className="relative">
                  <select
                    value={ctFromPhone}
                    onChange={e => saveCtFromPhone(e.target.value)}
                    disabled={ctSaving}
                    className="w-full bg-white border border-slate-200 rounded-xl p-3 text-sm font-medium disabled:opacity-50 appearance-none"
                  >
                    <option value="">Select phone number</option>
                    {/* Legacy: currently configured number not found in any list */}
                    {ctFromPhone &&
                      !poolPhones.some(p => p.phoneNumber === ctFromPhone) &&
                      !ctOwnPhoneNumbers.some(p => p.phoneNumber === ctFromPhone) &&
                      ctFromPhone !== ctSigcoreFromPhone && (
                        <option value={ctFromPhone}>{ctFromPhone} (configured)</option>
                    )}
                    {poolPhones.map(p => (
                      <option key={p.id} value={p.phoneNumber}>
                        {p.phoneNumber} (LeadBridge shared)
                      </option>
                    ))}
                    {ctOwnPhoneNumbers.map(p => (
                      <option key={p.id} value={p.phoneNumber}>
                        {p.phoneNumber}{p.friendlyName ? ` — ${p.friendlyName}` : ''} ({p.provider === 'openphone' ? 'OpenPhone/QUO' : p.provider})
                      </option>
                    ))}
                    {ctSigcoreFromPhone && !ctOwnPhoneNumbers.some(p => p.phoneNumber === ctSigcoreFromPhone) && (
                      <option value={ctSigcoreFromPhone}>
                        {ctSigcoreFromPhone} (Twilio · Dedicated)
                      </option>
                    )}
                  </select>
                  <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-slate-400">
                    <ChevronDown className="w-4 h-4" />
                  </div>
                </div>
                {poolPhones.length === 0 && !ctSigcoreConnected && !ctSigcoreFromPhone && (
                  <p className="text-xs text-slate-400 leading-relaxed">
                    No numbers available.{' '}
                    <button type="button" onClick={() => navigate('/phone-settings')} className="text-blue-600 hover:underline font-medium">
                      Set up a number in Business Line settings.
                    </button>
                  </p>
                )}
              </div>

              {/* Auto-reply message */}
              <div>
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Auto-Reply Message</label>
                <p className="text-xs text-slate-400 mb-2">Sent immediately when a new lead arrives.</p>
                <select
                  value={ctSelectedTemplateId}
                  onChange={e => {
                    if (e.target.value === '__create_new__') {
                      setTemplateEditor({ mode: 'create', ruleId: '', content: '', type: 'ct' });
                    } else {
                      const tpl = templates.find(t => t.id === e.target.value);
                      if (tpl) {
                        setCtSelectedTemplateId(tpl.id);
                        setCtAutoReplyTemplate(tpl.content);
                      }
                    }
                  }}
                  className="w-full rounded-xl p-3 text-sm font-medium bg-white border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                >
                  <option value="">Select template</option>
                  {templates.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                  <option value="__create_new__">+ Create New Template</option>
                </select>
                {ctAutoReplyTemplate && (
                  <div className="mt-4 bg-white p-5 rounded-xl border border-dashed border-slate-200 text-slate-600 text-sm leading-relaxed relative group">
                    {ctAutoReplyTemplate}
                    <button
                      type="button"
                      onClick={() => setTemplateEditor({
                        mode: ctSelectedTemplateId ? 'service-edit' : 'create',
                        ruleId: '',
                        ...(ctSelectedTemplateId && {
                          templateId: ctSelectedTemplateId,
                          templateName: templates.find(t => t.id === ctSelectedTemplateId)?.name || 'template',
                        }),
                        content: ctAutoReplyTemplate,
                        type: 'ct',
                      })}
                      className="absolute top-3 right-3 p-2 bg-slate-50 rounded-lg text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity hover:text-emerald-600"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>

              {/* Test SMS */}
              <div>
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Send Test</label>
                <div className="flex gap-2">
                  <input
                    type="tel"
                    value={ctTestPhone}
                    onChange={e => {
                      const v = e.target.value.replace(/[^\d+\s\-()]/g, '');
                      setCtTestPhone(v);
                      localStorage.setItem('ct_test_phone', v);
                    }}
                    onBlur={e => {
                      const formatted = formatPhoneE164(e.target.value);
                      if (formatted !== e.target.value) {
                        setCtTestPhone(formatted);
                        localStorage.setItem('ct_test_phone', formatted);
                      }
                    }}
                    placeholder="+15555550100"
                    className={`flex-1 rounded-xl px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:border-transparent transition-colors ${
                      ctTestPhone && !isValidPhoneE164(ctTestPhone)
                        ? 'border-2 border-red-300 bg-red-50/30 focus:ring-red-200'
                        : ctTestPhone && isValidPhoneE164(ctTestPhone)
                          ? 'border-2 border-emerald-300 bg-emerald-50/20 focus:ring-emerald-200'
                          : 'border border-slate-200 focus:ring-emerald-400'
                    }`}
                  />
                  <button
                    onClick={sendCtTest}
                    disabled={ctTestStatus === 'sending' || !ctTestPhone || !isValidPhoneE164(ctTestPhone) || !ctFromPhone}
                    className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all disabled:cursor-not-allowed flex items-center gap-2 ${
                      ctTestStatus === 'delivered' ? 'bg-emerald-100 text-emerald-700' :
                      ctTestStatus === 'failed' ? 'bg-red-100 text-red-700' :
                      ctTestStatus === 'sending' ? 'bg-slate-100 text-slate-500' :
                      'bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50'
                    }`}
                    title={!ctFromPhone ? 'Set a send-from phone first' : !ctTestPhone ? 'Enter a test phone number' : 'Send a test SMS'}
                  >
                    {ctTestStatus === 'sending' ? <Loader2 size={14} className="animate-spin" /> :
                     ctTestStatus === 'delivered' ? <CheckCircle size={14} /> :
                     ctTestStatus === 'failed' ? <X size={14} /> :
                     <Send size={14} />}
                    {ctTestStatus === 'sending' ? 'Sending...' :
                     ctTestStatus === 'delivered' ? 'Delivered' :
                     ctTestStatus === 'failed' ? 'Failed' :
                     'Send Test'}
                  </button>
                </div>
                {ctTestPhone && !isValidPhoneE164(ctTestPhone) && (
                  <p className="text-xs text-red-500 mt-1.5 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3 shrink-0" />
                    Must be E.164 format, e.g. +12125550100
                  </p>
                )}
                {ctTestPhone && isValidPhoneE164(ctTestPhone) && ctFromPhone && ctFromPhone === ctTestPhone && (
                  <p className="text-xs text-amber-600 mt-1.5 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3 shrink-0" />
                    Test phone matches the send-from number
                  </p>
                )}
              </div>

              {/* Follow-up messages — Coming Soon */}
              <div className="border-t border-slate-100 pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Follow-Up Messages</span>
                    <p className="text-xs text-slate-400 mt-0.5">Sent if the customer hasn't replied yet.</p>
                  </div>
                  <span className="px-2.5 py-1 text-[11px] font-bold uppercase tracking-widest bg-slate-100 text-slate-400 rounded-full">Coming Soon</span>
                </div>
              </div>
            </div>

            {/* Save / unsaved changes */}
            <div className="pt-4 border-t border-slate-100">
              {ctDirty ? (
                <div className="flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3">
                  <div className="flex items-center gap-2 text-amber-700">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span className="text-sm font-medium">You have unsaved changes</span>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={discardCtChanges}
                      className="px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                    >
                      Discard
                    </button>
                    <button
                      onClick={saveCtSettings}
                      disabled={ctSaving}
                      className="px-3 py-1.5 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50 flex items-center gap-1"
                    >
                      {ctSaving && <Loader2 className="w-3 h-3 animate-spin" />}
                      Save Settings
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={saveCtSettings}
                  disabled={ctSaving}
                  className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-emerald-600 rounded-xl hover:bg-emerald-700 transition-colors disabled:opacity-50"
                >
                  {ctSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save Settings
                </button>
              )}
            </div>
          </ServiceCard>

          {/* 4. Instant Call Connect */}
          <ServiceCard
            icon={<PhoneCall className="w-7 h-7" />}
            title="Instant Call Connect"
            description="Receive a phone call to bridge you instantly to new leads."
            enabled={ccEnabled}
            onToggle={ccSaving ? () => {} : toggleCallConnect}
            expanded={expandedCard === 'call-connect'}
            onExpand={() => toggleExpand('call-connect')}
            statusText={ccEnabled ? 'Active — bridging calls for new leads' : undefined}
            iconBgColor="bg-violet-50"
            iconTextColor="text-violet-600"
          >
            <div className={`space-y-6${!ccEnabled ? ' opacity-40 pointer-events-none select-none' : ''}`}>
            {/* Unsaved changes banner */}
            {ccDirty && (
              <div className="flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3">
                <div className="flex items-center gap-2 text-amber-700">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span className="text-sm font-medium">You have unsaved changes</span>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={discardCcChanges}
                    className="px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
                  >
                    Discard
                  </button>
                  <button
                    onClick={saveCcSettings}
                    disabled={ccSaving}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-violet-600 rounded-lg hover:bg-violet-700 transition-colors disabled:opacity-50 flex items-center gap-1"
                  >
                    {ccSaving && <Loader2 className="w-3 h-3 animate-spin" />}
                    Save Settings
                  </button>
                </div>
              </div>
            )}
            {/* Agent Phone + Send from — always 2 columns */}
            <div className="grid grid-cols-2 gap-4">
              {/* Agent Phone */}
              <div>
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Agent Phone (E.164)</label>
                <input
                  type="tel"
                  value={ccAgentPhone}
                  onChange={e => setCcAgentPhone(e.target.value.replace(/[^\d+\s\-()]/g, ''))}
                  onBlur={e => {
                    const formatted = formatPhoneE164(e.target.value);
                    if (formatted !== e.target.value) setCcAgentPhone(formatted);
                  }}
                  placeholder="+15551234567"
                  className={`w-full rounded-xl p-3 text-slate-800 text-sm font-medium placeholder-slate-400 focus:outline-none focus:ring-2 focus:border-transparent transition-colors ${
                    ccAgentPhone && !isValidPhoneE164(ccAgentPhone)
                      ? 'border-2 border-red-300 bg-red-50/30 focus:ring-red-200'
                      : ccAgentPhone && isValidPhoneE164(ccAgentPhone)
                        ? 'border-2 border-emerald-300 bg-emerald-50/20 focus:ring-emerald-200'
                        : 'bg-white border border-slate-200 focus:ring-violet-300'
                  }`}
                />
                {ccAgentPhone && !isValidPhoneE164(ccAgentPhone) ? (
                  <p className="text-xs text-red-500 mt-1.5 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3 shrink-0" />
                    Must be E.164 format, e.g. +12125550100
                  </p>
                ) : (
                  <p className="text-xs text-slate-400 mt-1.5">Phone Sigcore will ring when a new lead arrives</p>
                )}
              </div>

              {/* Send from */}
              <div>
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Send from</label>
                <div className="relative">
                  <select
                    value={ccBotNumber}
                    onChange={e => setCcBotNumber(e.target.value)}
                    className="w-full bg-white border border-slate-200 rounded-xl p-3 text-sm font-medium appearance-none"
                  >
                    <option value="">Select phone number</option>
                    {ccBotNumber && !poolPhones.some(p => p.phoneNumber === ccBotNumber) && (
                      <option value={ccBotNumber}>{ccBotNumber} (configured)</option>
                    )}
                    {poolPhones.map(p => (
                      <option key={p.id} value={p.phoneNumber}>
                        {p.phoneNumber} (LeadBridge)
                      </option>
                    ))}
                  </select>
                  <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-slate-400">
                    <ChevronDown className="w-4 h-4" />
                  </div>
                </div>
                <button className="mt-2 px-4 py-2 bg-slate-100 text-slate-400 rounded-xl text-xs font-bold flex items-center gap-2 cursor-not-allowed">
                  <Phone className="w-3 h-3" />
                  Get your own number
                  <span className="px-1.5 py-0.5 bg-slate-200 text-[9px] rounded uppercase">Coming Soon</span>
                </button>
              </div>
            </div>

            {/* Agent Whisper Message */}
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Agent Whisper Message</label>
              <p className="text-xs text-slate-400 mb-3">
                Played to you before the bridge. Press <span className="font-semibold text-slate-500">any key</span> to accept.
              </p>
              <select
                value={ccWhisperTemplateId || ''}
                onChange={e => {
                  if (e.target.value === '__create_new__') {
                    setTemplateEditor({ mode: 'create', ruleId: '', content: ccAgentWhisperMessage, type: 'cc-whisper' });
                  } else {
                    const t = templates.find(x => x.id === e.target.value);
                    if (t) { setCcAgentWhisperMessage(t.content); setCcWhisperTemplateId(t.id); }
                  }
                }}
                className="w-full bg-white border border-slate-200 rounded-xl p-3 text-sm font-medium"
              >
                <option value="">Select template…</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                <option value="__create_new__">+ Create New Template</option>
              </select>
              {ccAgentWhisperMessage && (
                <div className="mt-4 bg-white p-5 rounded-xl border border-dashed border-slate-200 text-slate-600 text-sm leading-relaxed relative group">
                  {ccAgentWhisperMessage}
                  <button
                    onClick={() => {
                      const tpl = ccWhisperTemplateId ? templates.find(t => t.id === ccWhisperTemplateId) : null;
                      setTemplateEditor({ mode: tpl ? 'service-edit' : 'create', ruleId: '', templateId: tpl?.id, templateName: tpl?.name, content: ccAgentWhisperMessage, type: 'cc-whisper' });
                    }}
                    className="absolute top-3 right-3 p-2 bg-slate-50 rounded-lg text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity hover:text-violet-600"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>

            {/* Voicemail Message */}
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Voicemail Message</label>
              <p className="text-xs text-slate-400 mb-3">Left automatically when the lead doesn't answer.</p>
              <select
                value={ccVoicemailTemplateId || ''}
                onChange={e => {
                  if (e.target.value === '__create_new__') {
                    setTemplateEditor({ mode: 'create', ruleId: '', content: ccVoicemailMessage, type: 'cc-voicemail' });
                  } else {
                    const t = templates.find(x => x.id === e.target.value);
                    if (t) { setCcVoicemailMessage(t.content); setCcVoicemailTemplateId(t.id); }
                  }
                }}
                className="w-full bg-white border border-slate-200 rounded-xl p-3 text-sm font-medium"
              >
                <option value="">Select template…</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                <option value="__create_new__">+ Create New Template</option>
              </select>
              {ccVoicemailMessage && (
                <div className="mt-4 bg-white p-5 rounded-xl border border-dashed border-slate-200 text-slate-600 text-sm leading-relaxed relative group">
                  {ccVoicemailMessage}
                  <button
                    onClick={() => {
                      const tpl = ccVoicemailTemplateId ? templates.find(t => t.id === ccVoicemailTemplateId) : null;
                      setTemplateEditor({ mode: tpl ? 'service-edit' : 'create', ruleId: '', templateId: tpl?.id, templateName: tpl?.name, content: ccVoicemailMessage, type: 'cc-voicemail' });
                    }}
                    className="absolute top-3 right-3 p-2 bg-slate-50 rounded-lg text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity hover:text-violet-600"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                </div>
              )}
              <div className="mt-5">
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Recording URL <span className="normal-case font-normal text-slate-400">(optional — overrides TTS above)</span></label>
                <div className="relative">
                  <input
                    type="url"
                    value={ccVoicemailRecordingUrl}
                    onChange={e => setCcVoicemailRecordingUrl(e.target.value)}
                    placeholder="https://example.com/voicemail.mp3"
                    className={`w-full bg-white border border-slate-200 rounded-xl p-3 text-slate-800 text-sm font-medium placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-transparent ${ccVoicemailRecordingUrl ? 'pr-10' : ''}`}
                  />
                  {ccVoicemailRecordingUrl && (
                    <button
                      type="button"
                      onClick={() => setCcVoicemailRecordingUrl('')}
                      title="Clear URL"
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-red-500 transition-colors"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Connection Mode — segmented switcher */}
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3 block">Connection Mode</label>
              <div className="flex bg-slate-100 rounded-2xl p-1 max-w-lg">
                <button
                  onClick={() => setCcMode('AGENT_FIRST')}
                  className={`flex-1 flex flex-col items-center gap-0.5 rounded-xl px-4 py-3 transition-all ${
                    ccMode === 'AGENT_FIRST'
                      ? 'bg-white text-violet-700 shadow-sm'
                      : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  <Phone className="w-4 h-4" />
                  <span className="text-sm font-bold">Agent First</span>
                  <span className="text-[11px] font-normal text-slate-400 leading-tight text-center">We call you, then bridge the lead</span>
                </button>
                <button
                  onClick={() => setCcMode('PARALLEL')}
                  className={`flex-1 flex flex-col items-center gap-0.5 rounded-xl px-4 py-3 transition-all ${
                    ccMode === 'PARALLEL'
                      ? 'bg-white text-violet-700 shadow-sm'
                      : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  <Zap className="w-4 h-4" />
                  <span className="text-sm font-bold">Parallel</span>
                  <span className="text-[11px] font-normal text-slate-400 leading-tight text-center">Call you and lead simultaneously</span>
                </button>
              </div>
            </div>

            {/* Lead Greeting Message — Parallel mode only */}
            {ccMode === 'PARALLEL' && (
              <div>
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Lead Greeting Message</label>
                <p className="text-xs text-slate-400 mb-3">Played to the lead while they wait for you to answer.</p>
                <select
                  value={ccGreetingTemplateId || ''}
                  onChange={e => {
                    if (e.target.value === '__create_new__') {
                      setTemplateEditor({ mode: 'create', ruleId: '', content: ccLeadGreetingMessage, type: 'cc-greeting' });
                    } else {
                      const t = templates.find(x => x.id === e.target.value);
                      if (t) { setCcLeadGreetingMessage(t.content); setCcGreetingTemplateId(t.id); }
                    }
                  }}
                  className="w-full bg-white border border-slate-200 rounded-xl p-3 text-sm font-medium"
                >
                  <option value="">Select template…</option>
                  {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  <option value="__create_new__">+ Create New Template</option>
                </select>
                {ccLeadGreetingMessage && (
                  <div className="mt-4 bg-white p-5 rounded-xl border border-dashed border-slate-200 text-slate-600 text-sm leading-relaxed relative group">
                    {ccLeadGreetingMessage}
                    <button
                      onClick={() => {
                        const tpl = ccGreetingTemplateId ? templates.find(t => t.id === ccGreetingTemplateId) : null;
                        setTemplateEditor({ mode: tpl ? 'service-edit' : 'create', ruleId: '', templateId: tpl?.id, templateName: tpl?.name, content: ccLeadGreetingMessage, type: 'cc-greeting' });
                      }}
                      className="absolute top-3 right-3 p-2 bg-slate-50 rounded-lg text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity hover:text-violet-600"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Test Call + Save Settings */}
            <div className="space-y-4 pt-4 border-t border-slate-100">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex gap-3 flex-wrap items-center">
                  <input
                    type="tel"
                    value={ccTestPhone}
                    onChange={e => {
                      const v = e.target.value.replace(/[^\d+\s\-()]/g, '');
                      setCcTestPhone(v);
                      localStorage.setItem('cc_test_phone', v);
                    }}
                    onBlur={e => {
                      const formatted = formatPhoneE164(e.target.value);
                      if (formatted !== e.target.value) {
                        setCcTestPhone(formatted);
                        localStorage.setItem('cc_test_phone', formatted);
                      }
                    }}
                    placeholder="+15559876543"
                    className={`rounded-xl px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:border-transparent min-w-[160px] transition-colors ${
                      ccTestPhone && !isValidPhoneE164(ccTestPhone)
                        ? 'border-2 border-red-300 bg-red-50/30 focus:ring-red-200'
                        : ccTestPhone && isValidPhoneE164(ccTestPhone)
                          ? 'border-2 border-emerald-300 bg-emerald-50/20 focus:ring-emerald-200'
                          : 'bg-slate-50 border border-slate-200 focus:ring-violet-500'
                    }`}
                  />
                  <button
                    onClick={handleTestCall}
                    disabled={ccTesting || !ccEnabled}
                    className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all bg-slate-100 text-slate-700 hover:bg-slate-200 whitespace-nowrap ${
                      ccTesting || !ccEnabled
                        ? 'opacity-50 cursor-not-allowed'
                        : (!ccAgentPhone || !isValidPhoneE164(ccAgentPhone) || !ccBotNumber || !ccTestPhone.trim() || !isValidPhoneE164(ccTestPhone))
                          ? 'opacity-60'
                          : ''
                    }`}
                  >
                    {ccTesting ? <Loader2 size={14} className="animate-spin" /> : <PhoneCall size={14} />}
                    {ccTesting ? 'Calling…' : 'Test Call'}
                  </button>
                </div>
                {!ccEnabled && (
                  <p className="text-xs text-orange-500">Enable Call Connect first to run a test.</p>
                )}
              </div>
              <div className="flex justify-end">
                <button
                  onClick={saveCcSettings}
                  disabled={ccSaving}
                  className="px-6 py-2.5 bg-violet-600 text-white rounded-xl text-sm font-semibold hover:bg-violet-700 shadow-lg shadow-violet-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {ccSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  Save Settings
                </button>
              </div>
            </div>
            </div>{/* end disabled overlay */}
          </ServiceCard>

        </div>
      )}

      {/* Validation Modal — missing required fields for test call */}
      {ccValidationModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-3xl shadow-2xl p-8 max-w-md w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-orange-100 rounded-2xl flex items-center justify-center shrink-0">
                <AlertCircle className="w-5 h-5 text-orange-600" />
              </div>
              <h3 className="text-lg font-bold text-slate-900">Missing Required Fields</h3>
            </div>
            <p className="text-slate-500 text-sm mb-4">Please fill in the following before running a test call:</p>
            <ul className="space-y-2 mb-6">
              {(!ccAgentPhone || !isValidPhoneE164(ccAgentPhone)) && (
                <li className="flex items-center gap-2 text-sm text-red-600 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
                  Agent Phone (E.164)
                </li>
              )}
              {!ccBotNumber && (
                <li className="flex items-center gap-2 text-sm text-red-600 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
                  Send from
                </li>
              )}
              {(!ccTestPhone.trim() || !isValidPhoneE164(ccTestPhone)) && (
                <li className="flex items-center gap-2 text-sm text-red-600 font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
                  Test call number
                </li>
              )}
            </ul>
            <button
              onClick={() => setCcValidationModalOpen(false)}
              className="w-full px-6 py-3 bg-slate-100 text-slate-700 rounded-xl text-sm font-semibold hover:bg-slate-200 transition-all"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* Unsaved Changes Modal — warn before test call */}
      {ccUnsavedModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-3xl shadow-2xl p-8 max-w-md w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-amber-100 rounded-2xl flex items-center justify-center shrink-0">
                <AlertCircle className="w-5 h-5 text-amber-600" />
              </div>
              <h3 className="text-lg font-bold text-slate-900">Unsaved Changes</h3>
            </div>
            <p className="text-slate-500 text-sm mb-6">You have unsaved changes to your Call Connect settings. Save them first to make sure you're testing the latest configuration.</p>
            <div className="flex gap-3">
              <button
                onClick={() => setCcUnsavedModalOpen(false)}
                className="flex-1 px-6 py-3 bg-slate-100 text-slate-700 rounded-xl text-sm font-semibold hover:bg-slate-200 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setCcUnsavedModalOpen(false);
                  await saveCcSettings();
                  await doTestCall();
                }}
                disabled={ccSaving}
                className="flex-1 px-6 py-3 bg-violet-600 text-white rounded-xl text-sm font-semibold hover:bg-violet-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {ccSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Save & Test
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Template Editor Modal */}
      <TemplateEditorModal
        isOpen={!!templateEditor}
        onClose={() => setTemplateEditor(null)}
        mode={templateEditor?.mode === 'create' ? 'create' : 'service-edit'}
        initialName=""
        initialContent={templateEditor?.content || ''}
        templateName={templateEditor?.templateName}
        saving={saving}
        variables={ALL_VARIABLES}
        existingNames={templates.map(t => t.name)}
        onSave={templateEditor?.mode === 'create' ? handleEditorCreate : handleEditorUpdate}
        onSaveAsNew={handleEditorSaveAsNew}
      />
    </div>
  );
}
