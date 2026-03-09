import { useState, useEffect, useRef } from 'react';
import {
  Loader2, ChevronDown, MessageSquare, Bell, PhoneCall,
  Zap, Briefcase, AlertCircle, AlertTriangle, CheckCircle, X,
  Pencil, Phone, Send, ChevronUp, Trash2, Save,
  Key, Hash, ExternalLink, Link2, Sparkles, RefreshCw, Unlink,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import {
  automationApi, notificationsApi, thumbtackApi, templatesApi, callConnectApi, conversationSyncApi,
} from '../services/api';
import type { TenantPhoneNumber } from '../services/api';
import type {
  AutomationRule, NotificationRule, SavedAccount, MessageTemplate,
  CallConnectMode, AgentStrategy, SigcorePhoneNumber, AvailablePhoneNumber,
} from '../types';
import { TemplateEditorModal, AUTO_REPLY_VARIABLES, SMS_VARIABLES } from '../components/TemplateEditorModal';
import AdminNoAccountsState from '../components/AdminNoAccountsState';
import NoAccountsOverlay from '../components/NoAccountsOverlay';
import OnboardingTour, { ONBOARDING_STORAGE_KEY } from '../components/OnboardingTour';
import { useAppStore } from '../store/appStore';
import { useAuthStore } from '../store/authStore';

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
  cardRef?: (el: HTMLDivElement | null) => void;
}

function ServiceCard({ icon, title, description, enabled, onToggle, comingSoon, expanded, onExpand, statusText, warningText, setupRequired, children, iconBgColor = 'bg-blue-50', iconTextColor = 'text-blue-600', cardRef }: ServiceCardProps) {
  return (
    <div ref={cardRef} className={`bg-white rounded-3xl border shadow-sm overflow-hidden transition-all ${comingSoon ? 'opacity-75 bg-slate-50/50 border-slate-100' : setupRequired ? 'border-orange-200 hover:border-orange-300' : 'border-slate-100 hover:border-blue-200'}`}>
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

// Module-level cache — survives navigation unmounts within SPA session
// Keyed by accountId so switching accounts still fetches fresh data
const _svcCache = new Map<string, Record<string, any>>();
let _svcLoaded = false; // true once we've fetched at least once (even if no accounts)

// -- Main Services Page --
export function Services() {
  const [searchParams] = useSearchParams();
  const storedAccounts = useAppStore(state => state.savedAccounts);
  const setSavedAccounts = useAppStore(state => state.setSavedAccounts);
  const setAccountDiagnostics = useAppStore(state => state.setAccountDiagnostics);

  // Account state — seed from Zustand store so there's no loading flash
  const [accounts, setAccounts] = useState<SavedAccount[]>(storedAccounts);
  const initialAccountId = storedAccounts[0]?.id || '';
  const [selectedAccountId, setSelectedAccountId] = useState(initialAccountId);
  const sc = _svcCache.get(initialAccountId); // cached service data for this account
  const [loading, setLoading] = useState(!sc);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'sending' | 'delivered' | 'failed'>('idle');
  const [deletingAlert, setDeletingAlert] = useState(false);
  const [confirmDeleteAlert, setConfirmDeleteAlert] = useState(false);

  // Auto Reply rules (dynamic array of all new_lead automation rules)
  const [autoReplyRules, setAutoReplyRules] = useState<AutomationRule[]>(sc?.autoReplyRules ?? []);
  const autoReplyEnabled = autoReplyRules.some(r => r.enabled);
  const firstReplyRule = autoReplyRules.find(r => r.delayMinutes === 0 || !r.delayMinutes) || null;

  // Other service rules
  const [leadAlertRule, setLeadAlertRule] = useState<NotificationRule | null>(sc?.leadAlertRule ?? null);


  // Supporting data
  const [templates, setTemplates] = useState<MessageTemplate[]>(sc?.templates ?? []);
  const [, setCtOwnPhoneNumbers] = useState<SigcorePhoneNumber[]>(sc?.ctOwnPhoneNumbers ?? []);
  // ctSigcoreConnected tracked via local var in loadServiceData (no longer needed in JSX)
  const [tenantPhones, setTenantPhones] = useState<TenantPhoneNumber[]>(sc?.tenantPhones ?? []);

  // UI state
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [showPhoneSetupModal, setShowPhoneSetupModal] = useState(false);
  // OpenPhone setup modal
  const [showOpenPhoneModal, setShowOpenPhoneModal] = useState(false);
  const [opApiKey, setOpApiKey] = useState('');
  const [opConnecting, setOpConnecting] = useState(false);
  const [opConnectError, setOpConnectError] = useState<string | null>(null);
  // Dedicated number setup modal
  const [showDedicatedModal, setShowDedicatedModal] = useState(false);
  const [dpAreaCode, setDpAreaCode] = useState('');
  const [dpLocality, setDpLocality] = useState('');
  const [dpSearchLoading, setDpSearchLoading] = useState(false);
  const [dpAvailableNumbers, setDpAvailableNumbers] = useState<AvailablePhoneNumber[]>([]);
  const [dpPurchasingNumber, setDpPurchasingNumber] = useState<string | null>(null);
  const [dpSearchError, setDpSearchError] = useState<string | null>(null);
  const [dpSmsConsent, setDpSmsConsent] = useState(false);
  const [dpPhonePrice, setDpPhonePrice] = useState<number | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
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
  const [ccEnabled, setCcEnabled] = useState(sc?.ccEnabled ?? false);
  const [ccMode, setCcMode] = useState<CallConnectMode>(sc?.ccMode ?? 'AGENT_FIRST');
  const [ccAgentStrategy, setCcAgentStrategy] = useState<AgentStrategy>(sc?.ccAgentStrategy ?? 'owner');
  const [ccAgentPhone, setCcAgentPhone] = useState(sc?.ccAgentPhone ?? '');
  const [ccMaxAttempts, setCcMaxAttempts] = useState(sc?.ccMaxAttempts ?? 2);
  const [ccQuietEnabled, setCcQuietEnabled] = useState(sc?.ccQuietEnabled ?? false);
  const [ccQuietTimezone, setCcQuietTimezone] = useState(sc?.ccQuietTimezone ?? 'America/New_York');
  const [ccQuietStart, setCcQuietStart] = useState(sc?.ccQuietStart ?? '22:00');
  const [ccQuietEnd, setCcQuietEnd] = useState(sc?.ccQuietEnd ?? '08:00');
  const [ccAgentAcceptDigits, setCcAgentAcceptDigits] = useState(sc?.ccAgentAcceptDigits ?? '1');
  const [ccAgentWhisperMessage, setCcAgentWhisperMessage] = useState(sc?.ccAgentWhisperMessage ?? '');
  const [ccLeadGreetingMessage, setCcLeadGreetingMessage] = useState(sc?.ccLeadGreetingMessage ?? '');
  const [ccVoicemailEnabled, setCcVoicemailEnabled] = useState(sc?.ccVoicemailEnabled ?? false);
  const [ccVoicemailMessage, setCcVoicemailMessage] = useState(sc?.ccVoicemailMessage ?? '');
  const [ccVoicemailRecordingUrl, setCcVoicemailRecordingUrl] = useState(sc?.ccVoicemailRecordingUrl ?? '');
  const [ccBotNumber, setCcBotNumber] = useState(sc?.ccBotNumber ?? '');
  const [ccSaving, setCcSaving] = useState(false);
  const [ccTestPhone, setCcTestPhone] = useState(() => {
    if (selectedAccountId) return localStorage.getItem(`cc_test_phone_${selectedAccountId}`) || '';
    return '';
  });
  const [ccTesting, setCcTesting] = useState(false);
  // Track which saved template is currently loaded in each CC message field (for edit button)
  const [ccWhisperTemplateId, setCcWhisperTemplateId] = useState<string | null>(sc?.ccWhisperTemplateId ?? null);
  const [ccGreetingTemplateId, setCcGreetingTemplateId] = useState<string | null>(sc?.ccGreetingTemplateId ?? null);
  const [ccVoicemailTemplateId, setCcVoicemailTemplateId] = useState<string | null>(sc?.ccVoicemailTemplateId ?? null);

  // CC dirty tracking
  const [ccSavedSnapshot, setCcSavedSnapshot] = useState<{
    mode: CallConnectMode;
    agentPhone: string;
    botNumber: string;
    agentWhisperMessage: string;
    leadGreetingMessage: string;
    voicemailMessage: string;
    voicemailRecordingUrl: string;
    callForwardingNumber: string;
  } | null>(sc?.ccSavedSnapshot ?? null);
  const [ccValidationModalOpen, setCcValidationModalOpen] = useState(false);
  const [ccUnsavedModalOpen, setCcUnsavedModalOpen] = useState(false);

  // Lead Alerts form state (needed for first-time creation)
  const [alertToPhone, setAlertToPhone] = useState(sc?.alertToPhone ?? '');

  // Shared agent phone editing (bottom of both cards)
  const [editingAgentPhone, setEditingAgentPhone] = useState(false);

  // Customer Texting state
  const [ctEnabled, setCtEnabled] = useState(sc?.ctEnabled ?? false);
  const [ctAutoReplyTemplate, setCtAutoReplyTemplate] = useState(
    sc?.ctAutoReplyTemplate ?? "Hi {customerName}, this is {accountName}. We just received your request for {category}. When would be a good time to call you?"
  );
  const [ctSaving, setCtSaving] = useState(false);
  const [ctTestStatus, setCtTestStatus] = useState<'idle' | 'sending' | 'delivered' | 'failed'>('idle');
  const [ctSavedSnapshot, setCtSavedSnapshot] = useState<{ autoReplyTemplate: string } | null>(sc?.ctSavedSnapshot ?? null);
  const [ctSelectedTemplateId, setCtSelectedTemplateId] = useState<string>(sc?.ctSelectedTemplateId ?? '');
  const [ccCallForwardingNumber, setCcCallForwardingNumber] = useState(sc?.ccCallForwardingNumber ?? '');

  // Conversation Sync state (isolated BYO phone)
  const [csConnected, setCsConnected] = useState(false);
  const [csConnecting, setCsConnecting] = useState(false);
  const [csApiKey, setCsApiKey] = useState('');
  const [csError, setCsError] = useState<string | null>(null);
  const [csPhoneNumbers, setCsPhoneNumbers] = useState<Array<{ id: string; phoneNumber: string; name?: string }>>([]);
  // Step 1: OpenPhone → Sigcore sync
  const [csOpenPhoneSyncing, setCsOpenPhoneSyncing] = useState(false);
  const [csSyncProgress, setCsSyncProgress] = useState<{ status: string; progress?: number; total?: number } | null>(null);
  // Step 2: Match to leads
  const [csMatchingLeads, setCsMatchingLeads] = useState(false);
  const [csMatchResult, setCsMatchResult] = useState<{ synced: number; totalConversations: number; totalLeads: number } | null>(null);

  // Onboarding tour
  const [tourActive, setTourActive] = useState(false);

  // Listen for tour start event from Layout header button
  useEffect(() => {
    const handler = () => setTourActive(true);
    window.addEventListener('lb:start-tour', handler);
    return () => window.removeEventListener('lb:start-tour', handler);
  }, []);

  // Auto-start tour on first visit (once data is loaded and tenant phones exist)
  useEffect(() => {
    if (!loading && tenantPhones.length > 0 && !localStorage.getItem(ONBOARDING_STORAGE_KEY)) {
      // Small delay so DOM is fully rendered
      const t = setTimeout(() => setTourActive(true), 600);
      return () => clearTimeout(t);
    }
  }, [loading, tenantPhones.length]);

  // Lead Alert saved snapshot for dirty tracking
  const [alertSavedSnapshot, setAlertSavedSnapshot] = useState<{ toPhone: string } | null>(sc?.alertSavedSnapshot ?? null);

  // Derived: unsaved Lead Alert changes
  const alertDirty = alertSavedSnapshot !== null && (
    alertToPhone !== alertSavedSnapshot.toPhone
  );

  // Derived: unsaved CT changes
  const ctDirty = ctSavedSnapshot !== null && (
    ctAutoReplyTemplate !== ctSavedSnapshot.autoReplyTemplate
  );

  // Derived: unsaved CC changes
  const ccDirty = ccSavedSnapshot !== null && (
    ccMode !== ccSavedSnapshot.mode ||
    ccAgentPhone !== ccSavedSnapshot.agentPhone ||
    ccBotNumber !== ccSavedSnapshot.botNumber ||
    ccAgentWhisperMessage !== ccSavedSnapshot.agentWhisperMessage ||
    ccLeadGreetingMessage !== ccSavedSnapshot.leadGreetingMessage ||
    ccVoicemailMessage !== ccSavedSnapshot.voicemailMessage ||
    ccVoicemailRecordingUrl !== ccSavedSnapshot.voicemailRecordingUrl ||
    ccCallForwardingNumber !== ccSavedSnapshot.callForwardingNumber
  );
  const commsDirty = ctDirty || ccDirty;

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
      // Reset selected account if it doesn't exist in the fetched list (e.g. after
      // switching impersonated user — the store may still hold a stale account ID)
      const currentStillValid = accs.some(a => a.id === selectedAccountId);
      if ((!selectedAccountId || !currentStillValid) && accs.length > 0) {
        setSelectedAccountId(accs[0].id);
      }
      // If no accounts, stop loading — loadServiceData won't fire
      if (accs.length === 0) {
        setLoading(false);
      }
    } catch (err: any) {
      // If we have store data, silent fail; only show error if accounts list is empty
      if (accounts.length === 0) {
        setError(err.message || 'Failed to load accounts');
        setLoading(false); // Only stop spinner if no accounts will trigger loadServiceData
      }
    }
  }

  async function loadServiceData(accountId: string) {
    try {
      // Only show loading spinner on first load — cached data renders instantly
      if (!_svcLoaded && !_svcCache.has(accountId)) setLoading(true);
      setError(null);

      const [automationRes, notifRes, templatesRes, poolRes, ccRes, ctRes, notifSettingsRes, tenantPhonesRes] = await Promise.all([
        automationApi.getRulesForAccount(accountId).catch(() => ({ rules: [] as AutomationRule[] })),
        notificationsApi.getRules(accountId).catch(() => ({ rules: [] as NotificationRule[] })),
        templatesApi.getTemplates().catch(() => ({ templates: [] as MessageTemplate[] })),
        Promise.resolve({ phoneNumbers: [] }),
        callConnectApi.getSettings(accountId).catch(() => ({ settings: null })),
        notificationsApi.getCustomerTextingSettings(accountId).catch(() => null),
        notificationsApi.getSettings(accountId).catch(() => null),
        notificationsApi.listTenantPhones().catch((): { success: boolean; data: TenantPhoneNumber[] } => ({ success: false, data: [] })),
      ]);

      const ccs = ccRes.settings;
      const activeTenantPhones = tenantPhonesRes.success ? tenantPhonesRes.data.filter(tp => tp.status === 'ACTIVE') : [];
      setTenantPhones(activeTenantPhones);
      // Bot number defaults to first dedicated (tenant) phone — never pool
      const defaultBotNumber = activeTenantPhones[0]?.phoneNumber || '';
      if (ccs) {
        setCcEnabled(ccs.enabled);
        setCcMode(ccs.mode);
        setCcAgentStrategy(ccs.agentStrategy);
        // ccAgentPhone set below after byoPhone is resolved
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
        setCcTestPhone(localStorage.getItem(`cc_test_phone_${accountId}`) || '');
      } else {
        setCcEnabled(false);
        setCcMode('AGENT_FIRST');
        setCcAgentStrategy('owner');
        // ccAgentPhone set below after byoPhone is resolved
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
        setCcTestPhone(localStorage.getItem(`cc_test_phone_${accountId}`) || '');
      }

      // Load Customer Texting settings
      if (ctRes) {
        setCtEnabled(ctRes.enabled);
        setCtAutoReplyTemplate(ctRes.autoReplyTemplate);
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

      // Agent phone: use saved value, else destination phone (never fall back to auth-store
      // user.businessPhone — that belongs to the logged-in admin, not the tenant being viewed)
      const agentPhoneDefault = ccs?.agentPhoneE164 || notifSettingsRes?.settings?.destinationPhone || '';
      setCcAgentPhone(agentPhoneDefault);
      // Forward calls to: same as agent phone (destinationPhone)
      setCcCallForwardingNumber(agentPhoneDefault);
      // No more phone number dropdowns — dedicated number is auto-resolved
      setCtOwnPhoneNumbers([]);

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
      const ctContent = ctRes?.autoReplyTemplate || ctTpl?.content || '';
      if (!ctRes && ctTpl) {
        setCtAutoReplyTemplate(ctTpl.content);
      }
      setCtSelectedTemplateId(allTemplates.find(t => t.content === ctContent)?.id || ctTpl?.id || '');
      // Initialize CT snapshot for dirty tracking
      setCtSavedSnapshot({ autoReplyTemplate: ctContent });

      // Initialize CC snapshot for dirty tracking
      const snapshotWhisper = ccs?.agentWhisperMessage || whisperTpl?.content || '';
      const snapshotGreeting = ccs?.leadGreetingMessage || greetingTpl?.content || '';
      const snapshotVoicemail = ccs?.leadVoicemailMessage || voicemailTpl?.content || '';
      setCcSavedSnapshot({
        mode: (ccs?.mode || 'AGENT_FIRST') as CallConnectMode,
        agentPhone: agentPhoneDefault,
        botNumber: ccs?.botNumberE164 || defaultBotNumber,
        agentWhisperMessage: snapshotWhisper,
        leadGreetingMessage: snapshotGreeting,
        voicemailMessage: snapshotVoicemail,
        voicemailRecordingUrl: ccs?.leadVoicemailRecordingUrl || '',
        callForwardingNumber: agentPhoneDefault,
      });

      // Pre-fill form states from existing rules
      const alertTo = leadAlert?.toPhone || agentPhoneDefault;
      setAlertToPhone(alertTo);
      // Initialize alert snapshot for dirty tracking
      if (leadAlert) {
        setAlertSavedSnapshot({ toPhone: alertTo });
      }

      // Auto-expand Lead Alerts card if setup is incomplete OR directed here from Dashboard alert
      const toPhoneMissing = leadAlert && !leadAlert.toPhone;
      const templateMissing = leadAlert && !leadAlert.templateId && !leadAlert.messageTemplate;
      const expandParam = searchParams.get('expand');
      if (toPhoneMissing || templateMissing || expandParam === 'lead-alerts') {
        setExpandedCard('notifications');
      }

      // Persist to module-level cache so returning to this page is instant
      _svcCache.set(accountId, {
        autoReplyRules: allAutoReplies, leadAlertRule: leadAlert, templates: allTemplates,
        poolPhones: poolRes.phoneNumbers, tenantPhones: activeTenantPhones, ctOwnPhoneNumbers: [],
        ccEnabled: ccs?.enabled ?? false, ccMode: (ccs?.mode || 'AGENT_FIRST') as CallConnectMode,
        ccAgentStrategy: (ccs?.agentStrategy || 'owner') as AgentStrategy,
        ccAgentPhone: agentPhoneDefault, ccMaxAttempts: ccs?.maxAgentAttempts ?? 2,
        ccQuietEnabled: ccs?.quietHoursEnabled ?? false,
        ccQuietTimezone: ccs?.quietHoursTimezone || 'America/New_York',
        ccQuietStart: ccs?.quietHoursStart || '22:00', ccQuietEnd: ccs?.quietHoursEnd || '08:00',
        ccAgentAcceptDigits: ccs?.agentAcceptDigits || '0123456789*#',
        ccAgentWhisperMessage: ccs?.agentWhisperMessage || '',
        ccLeadGreetingMessage: ccs?.leadGreetingMessage || '',
        ccVoicemailEnabled: ccs?.leadVoicemailEnabled ?? false,
        ccVoicemailMessage: ccs?.leadVoicemailMessage || '',
        ccVoicemailRecordingUrl: ccs?.leadVoicemailRecordingUrl || '',
        ccBotNumber: ccs?.botNumberE164 || defaultBotNumber,
        ccWhisperTemplateId: allTemplates.find(t => t.content === (ccs?.agentWhisperMessage || allTemplates.find(tt => tt.name === 'CC - Agent Whisper')?.content || ''))?.id || null,
        ccGreetingTemplateId: allTemplates.find(t => t.content === (ccs?.leadGreetingMessage || allTemplates.find(tt => tt.name === 'CC - Lead Greeting')?.content || ''))?.id || null,
        ccVoicemailTemplateId: allTemplates.find(t => t.content === (ccs?.leadVoicemailMessage || allTemplates.find(tt => tt.name === 'CC - Voicemail TTS')?.content || ''))?.id || null,
        ctEnabled: ctRes?.enabled ?? false,
        ctAutoReplyTemplate: ctRes?.autoReplyTemplate || allTemplates.find(t => t.name === 'CT - Auto Reply')?.content || '',
        ctSigcoreProvider: null,
        ctSmsForwardingNumber: '',
        ccCallForwardingNumber: agentPhoneDefault,
        ctSelectedTemplateId: allTemplates.find(t => t.content === ctContent)?.id || allTemplates.find(t => t.name === 'CT - Auto Reply')?.id || '',
        alertToPhone: alertTo,
        alertSavedSnapshot: leadAlert ? { toPhone: alertTo } : null,
        ctSavedSnapshot: { autoReplyTemplate: ctContent },
        ccSavedSnapshot: {
          mode: (ccs?.mode || 'AGENT_FIRST') as CallConnectMode,
          agentPhone: agentPhoneDefault, botNumber: ccs?.botNumberE164 || defaultBotNumber,
          agentWhisperMessage: ccs?.agentWhisperMessage || allTemplates.find(t => t.name === 'CC - Agent Whisper')?.content || '',
          leadGreetingMessage: ccs?.leadGreetingMessage || allTemplates.find(t => t.name === 'CC - Lead Greeting')?.content || '',
          voicemailMessage: ccs?.leadVoicemailMessage || allTemplates.find(t => t.name === 'CC - Voicemail TTS')?.content || '',
          voicemailRecordingUrl: ccs?.leadVoicemailRecordingUrl || '',
          callForwardingNumber: agentPhoneDefault,
        },
      });

      // Load Conversation Sync status (non-blocking)
      conversationSyncApi.getStatus(accountId).then(csStatus => {
        setCsConnected(csStatus.connected);
        setCsPhoneNumbers(csStatus.connectedNumbers || []);
        setCsError(csStatus.lastError);
      }).catch(() => {
        setCsConnected(false);
        setCsPhoneNumbers([]);
      });

    } catch (err: any) {
      setError(err.message || 'Failed to load services data');
    } finally {
      setLoading(false);
      _svcLoaded = true;
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
    } else if (enabled) {
      setAutoReplyRules([{ id: '_pending', enabled: true } as any]);
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
      }
    } catch (err: any) {
      console.error('[toggleAutoReply] FAILED:', err.response?.data || err.message);
      // Rollback on error
      setAutoReplyRules(prevRules);
      setError(err.response?.data?.message || err.message || 'Failed to toggle Auto Reply');
    } finally {
      setSaving(false);
    }
  }

  async function toggleLeadAlerts(enabled: boolean) {
    if (enabled && tenantPhones.length === 0) {
      setShowDedicatedModal(true);
      return;
    }
    setError(null);
    // Optimistic: update UI immediately
    const prevAlertRule = leadAlertRule ? { ...leadAlertRule } : null;
    if (leadAlertRule) {
      setLeadAlertRule({ ...leadAlertRule, enabled });
    } else if (enabled) {
      setLeadAlertRule({ id: '_pending', enabled: true, toPhone: alertToPhone } as any);
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

        const { rule } = await notificationsApi.createRule(selectedAccountId, {
          name: 'Lead Alert - SMS',
          triggerType: 'new_lead',
          toPhone: alertToPhone,
          sendToCustomer: false,
          template: DEFAULT_ALERT_TEMPLATE,
          templateId,
          enabled: true,
        });
        setLeadAlertRule(rule);
        setAlertSavedSnapshot({ toPhone: alertToPhone });
        setExpandedCard('notifications');
        showSuccess(alertToPhone ? 'Lead Notifications enabled' : 'Lead Notifications enabled — configure your alert phone number');
      }
      // Invalidate diagnostics cache so Dashboard/Settings show fresh data
      setAccountDiagnostics({});
    } catch (err: any) {
      console.error('Failed to toggle Lead Alerts:', err.response?.data || err.message);
      // Rollback on error
      setLeadAlertRule(prevAlertRule);
      setError(err.response?.data?.message || err.message || 'Failed to toggle Lead Alerts');
    } finally {
      setSaving(false);
    }
  }


  async function toggleCallConnect(enabled: boolean) {
    if (!selectedAccountId) return;
    if (enabled && tenantPhones.length === 0) {
      setShowDedicatedModal(true);
      return;
    }
    setCcEnabled(enabled); // optimistic
    setCcSaving(true);
    try {
      const { settings } = await callConnectApi.saveSettings(selectedAccountId, { enabled });
      setCcEnabled(settings.enabled);
    } catch (err: any) {
      console.error('Failed to toggle Call Connect:', err.response?.data || err.message);
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
        callForwardingNumber: ccCallForwardingNumber,
      });
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to save Call Connect settings');
    } finally {
      setCcSaving(false);
    }
  }

  async function toggleCustomerTexting(enabled: boolean) {
    if (!selectedAccountId) return;
    if (enabled && tenantPhones.length === 0) {
      setShowDedicatedModal(true);
      return;
    }
    setCtEnabled(enabled); // optimistic
    setCtSaving(true);
    try {
      await notificationsApi.saveCustomerTextingSettings(selectedAccountId, {
        enabled,
        autoReplyTemplate: ctAutoReplyTemplate,
      });
    } catch (err: any) {
      console.error('Failed to toggle Customer Texting:', err.response?.data || err.message);
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
        autoReplyTemplate: ctAutoReplyTemplate,
      });
      showSuccess('Customer Texting settings saved');
      setCtSavedSnapshot({ autoReplyTemplate: ctAutoReplyTemplate });
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to save Customer Texting settings');
    } finally {
      setCtSaving(false);
    }
  }

  function setAllAgentPhones(phone: string) {
    setCcAgentPhone(phone);
    setAlertToPhone(phone);
    setCcCallForwardingNumber(phone);
  }

  const [agentPhoneSaveStatus, setAgentPhoneSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const savingAgentPhoneRef = useRef(false);

  async function saveAgentPhone() {
    setEditingAgentPhone(false);
    if (savingAgentPhoneRef.current) return;
    savingAgentPhoneRef.current = true;
    const phone = formatPhoneE164(ccAgentPhone);
    if (phone !== ccAgentPhone) setAllAgentPhones(phone);
    const finalPhone = phone || ccAgentPhone;
    if (!selectedAccountId || !finalPhone) { savingAgentPhoneRef.current = false; return; }

    // Optimistic: show saved immediately
    setAgentPhoneSaveStatus('saved');
    setCcSavedSnapshot(prev => prev ? { ...prev, agentPhone: finalPhone, callForwardingNumber: finalPhone } : prev);
    setAlertSavedSnapshot({ toPhone: finalPhone });
    showSuccess('Business phone saved');
    setTimeout(() => setAgentPhoneSaveStatus('idle'), 3000);

    // Fire-and-forget saves — warn only on failure
    const promises: Promise<any>[] = [];
    if (leadAlertRule && leadAlertRule.id !== '_pending') {
      promises.push(
        notificationsApi.updateRule(selectedAccountId, leadAlertRule.id, { toPhone: finalPhone })
          .then(({ rule }) => { setLeadAlertRule(rule); })
          .catch(() => { setError('Failed to save business phone to alert rule'); })
      );
    }
    promises.push(
      callConnectApi.saveSettings(selectedAccountId, { agentPhoneE164: finalPhone })
        .catch(() => { setError('Failed to save business phone to call settings'); })
    );
    await Promise.all(promises);
    savingAgentPhoneRef.current = false;
  }

  function discardAlertChanges() {
    if (!alertSavedSnapshot) return;
    setAlertToPhone(alertSavedSnapshot.toPhone);
  }

  function discardCtChanges() {
    if (!ctSavedSnapshot) return;
    setCtAutoReplyTemplate(ctSavedSnapshot.autoReplyTemplate);
    setCtSelectedTemplateId(templates.find(t => t.content === ctSavedSnapshot.autoReplyTemplate)?.id || '');
  }

  function discardCommsChanges() {
    discardCtChanges();
    discardCcChanges();
  }

  async function saveCommsSettings() {
    if (!selectedAccountId) return;
    const saving1 = ctDirty ? saveCtSettings() : Promise.resolve();
    const saving2 = ccDirty ? saveCcSettings() : Promise.resolve();
    await Promise.all([saving1, saving2]);
    if (!ctDirty && !ccDirty) {
      // Nothing was dirty — just save both anyway
      await Promise.all([saveCtSettings(), saveCcSettings()]);
    }
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

  const ccSamePhoneError = ccTestPhone.trim() && isValidPhoneE164(ccTestPhone) && (
    ccBotNumber === ccTestPhone.trim() || ccAgentPhone === ccTestPhone.trim()
  );

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
    // Guard 2: same-phone check
    if (ccSamePhoneError) {
      setError('Test phone cannot be the same as the bot number or agent phone');
      return;
    }
    // Guard 3: no unsaved changes
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
    setCcCallForwardingNumber(ccSavedSnapshot.callForwardingNumber);
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

  // saveAlertToPhone removed — now handled by saveAlertSettings()

  async function saveAlertSettings() {
    if (!leadAlertRule || !selectedAccountId) return;
    setSaving(true);
    try {
      const { rule } = await notificationsApi.updateRule(selectedAccountId, leadAlertRule.id, {
        toPhone: alertToPhone,
      });
      setLeadAlertRule(rule);
      setAlertSavedSnapshot({ toPhone: alertToPhone });
      showSuccess('Lead Alert settings saved');
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to save alert settings');
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

  function openDedicatedModal() {
    setShowDedicatedModal(true);
    setShowPhoneSetupModal(false);
    notificationsApi.getPhonePricing().then(r => { if (r.success) setDpPhonePrice(r.data.priceMonthly); }).catch(() => {});
  }

  async function handleOpConnect() {
    if (!selectedAccountId || !opApiKey.trim()) return;
    setOpConnecting(true);
    setOpConnectError(null);
    try {
      const result = await notificationsApi.connectSigcore(selectedAccountId, 'openphone', { apiKey: opApiKey.trim() });
      if (result.success) {
        setShowOpenPhoneModal(false);
        setOpApiKey('');
        showSuccess('OpenPhone connected successfully');
      } else {
        setOpConnectError((result as any).error || 'Failed to connect');
      }
    } catch (err: any) {
      setOpConnectError(err.response?.data?.message || err.message || 'Failed to connect');
    } finally {
      setOpConnecting(false);
    }
  }

  async function handleDpSearch() {
    if (!selectedAccountId) return;
    setDpSearchLoading(true);
    setDpSearchError(null);
    try {
      const result = await notificationsApi.searchAvailableNumbers(selectedAccountId, 'US', dpAreaCode || undefined, dpLocality || undefined);
      if (result.success) {
        setDpAvailableNumbers(result.data);
      } else {
        setDpSearchError('Search failed — try a different area code or city');
      }
    } catch (err: any) {
      setDpSearchError(err.response?.data?.message || err.message || 'Search failed');
    } finally {
      setDpSearchLoading(false);
    }
  }

  async function handleDpPurchase(phoneNumber: string) {
    if (!selectedAccountId || !dpSmsConsent) return;
    setDpPurchasingNumber(phoneNumber);
    setDpSearchError(null);
    try {
      const result = await notificationsApi.purchaseTenantPhone(selectedAccountId, phoneNumber);
      if (result.success && result.tenantPhone) {
        const refreshed = await notificationsApi.listTenantPhones();
        if (refreshed.success) setTenantPhones(refreshed.data);
        setShowDedicatedModal(false);
        setDpAvailableNumbers([]);
        setDpAreaCode('');
        setDpLocality('');
        showSuccess('LeadBridge number provisioned successfully');
      } else {
        setDpSearchError((result as any).error || 'Purchase failed');
      }
    } catch (err: any) {
      setDpSearchError(err.response?.data?.message || err.message || 'Purchase failed');
    } finally {
      setDpPurchasingNumber(null);
    }
  }

  async function sendCtTest() {
    if (!selectedAccountId || !ccTestPhone) return;
    setCtTestStatus('sending');
    setError(null);
    try {
      const result = await notificationsApi.sendTest(selectedAccountId, undefined, ccTestPhone, ctAutoReplyTemplate || undefined);
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
    const isExpanding = expandedCard !== card;
    setExpandedCard(isExpanding ? card : null);
    if (isExpanding) {
      setTimeout(() => {
        const el = cardRefs.current[card];
        if (!el) return;
        const HEADER_OFFSET = 80;
        const top = el.getBoundingClientRect().top + window.scrollY - HEADER_OFFSET;
        window.scrollTo({ top, behavior: 'smooth' });
      }, 50);
    }
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

  if (accounts.length === 0 && useAuthStore.getState().user?.role === 'ADMIN') {
    return (
      <div className="p-6 lg:p-10">
        <div className="flex items-center gap-3 mb-6">
          <Briefcase className="w-6 h-6 text-blue-600" />
          <h1 className="text-2xl font-bold text-slate-900">Automation</h1>
        </div>
        <AdminNoAccountsState />
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-10 max-w-5xl mx-auto space-y-8">
      {accounts.length === 0 && <NoAccountsOverlay />}
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

      {/* Your LeadBridge Number — shared across all service cards */}
      {!loading && (
        <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 bg-blue-50 rounded-2xl flex items-center justify-center">
              <Phone className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">Your LeadBridge Number</h2>
              <p className="text-xs text-slate-400">Used for all outbound SMS and calls</p>
            </div>
          </div>

          {tenantPhones.length > 0 ? (
            <div className="space-y-4">
              {/* Row 1: Bot Number + Business Phone */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div data-tour="bot-number">
                  <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">🤖 Bot Number</label>
                  <p className="text-[11px] text-slate-400 mb-2">Customers receive texts and calls from this number.</p>
                  <div className="w-full rounded-xl p-3 text-sm font-medium bg-blue-50/30 border-2 border-blue-200 text-blue-700">
                    {`${tenantPhones[0].phoneNumber}${tenantPhones[0].friendlyName && tenantPhones[0].friendlyName !== tenantPhones[0].phoneNumber ? ` — ${tenantPhones[0].friendlyName}` : ''}`}
                  </div>
                </div>
                <div data-tour="business-phone">
                  <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">📱 Your Business Phone</label>
                  <p className="text-[11px] text-slate-400 mb-2">Lead notifications and alerts are sent to this number.</p>
                  {editingAgentPhone ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="tel"
                        value={ccAgentPhone}
                        onChange={e => setAllAgentPhones(e.target.value.replace(/[^\d+\s\-()]/g, ''))}
                        onBlur={() => saveAgentPhone()}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') saveAgentPhone(); }}
                        autoFocus
                        placeholder="+15551234567"
                        className="flex-1 rounded-xl px-3 py-2.5 text-sm border border-slate-200 focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                      />
                      <button onClick={() => saveAgentPhone()} className="px-3 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors">Done</button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className={`flex-1 rounded-xl px-3 py-2.5 text-sm font-medium font-mono transition-colors ${
                        agentPhoneSaveStatus === 'saved' ? 'bg-emerald-50 border-2 border-emerald-300 text-emerald-700' :
                        agentPhoneSaveStatus === 'saving' ? 'bg-blue-50 border-2 border-blue-200 text-blue-700' :
                        'bg-slate-50 border border-slate-200 text-slate-800'
                      }`}>
                        {agentPhoneSaveStatus === 'saved' && <CheckCircle className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />}
                        {ccAgentPhone || <span className="text-slate-400">Not set</span>}
                      </div>
                      <button
                        onClick={() => setEditingAgentPhone(true)}
                        className="px-3 py-2 text-xs font-semibold text-blue-600 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors shrink-0"
                      >
                        Change
                      </button>
                    </div>
                  )}
                  {ccAgentPhone && tenantPhones.length > 0 && ccAgentPhone === tenantPhones[0].phoneNumber && (
                    <p className="mt-1.5 text-xs text-red-600 font-medium flex items-center gap-1">
                      <AlertCircle className="w-3 h-3 shrink-0" />
                      This is your Bot Number — enter your business phone instead
                    </p>
                  )}
                </div>
              </div>

              {/* Row 2: Test Number (aligned under Bot) + Test Buttons (aligned under Business Phone) */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div data-tour="test-number">
                  <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">🧪 Test Number</label>
                  <p className="text-[11px] text-slate-400 mb-2">Used to test messaging and automation safely.</p>
                  <input
                    type="tel"
                    value={ccTestPhone}
                    onChange={e => { const v = e.target.value.replace(/[^\d+\s\-()]/g, ''); setCcTestPhone(v); if (selectedAccountId) localStorage.setItem(`cc_test_phone_${selectedAccountId}`, v); }}
                    onBlur={e => { const formatted = formatPhoneE164(e.target.value); if (formatted !== e.target.value) { setCcTestPhone(formatted); if (selectedAccountId) localStorage.setItem(`cc_test_phone_${selectedAccountId}`, formatted); } }}
                    placeholder="+15559876543"
                    className={`w-full rounded-xl px-4 py-2.5 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:border-transparent transition-colors ${
                      ccSamePhoneError ? 'border-2 border-amber-400 bg-amber-50/30 focus:ring-amber-200'
                        : ccTestPhone && !isValidPhoneE164(ccTestPhone) ? 'border-2 border-red-300 bg-red-50/30 focus:ring-red-200'
                        : ccTestPhone && isValidPhoneE164(ccTestPhone) ? 'border-2 border-emerald-300 bg-emerald-50/20 focus:ring-emerald-200'
                        : 'bg-slate-50 border border-slate-200 focus:ring-blue-500'
                    }`}
                  />
                  {ccTestPhone && !isValidPhoneE164(ccTestPhone) && (
                    <p className="text-xs text-red-500 mt-1.5 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3 shrink-0" /> Must be E.164 format, e.g. +12125550100
                    </p>
                  )}
                  {ccSamePhoneError && (
                    <p className="text-xs text-amber-600 mt-1.5 flex items-center gap-1">
                      <AlertTriangle size={12} /> Test phone cannot be the same as the bot number or business phone.
                    </p>
                  )}
                </div>
                <div className="flex items-end" data-tour="test-buttons">
                  <div className="flex gap-2 flex-wrap pb-[1px]">
                  <button
                    onClick={sendTestAlert}
                    disabled={testStatus !== 'idle' || !(leadAlertRule?.enabled) || !alertToPhone || !isValidPhoneE164(alertToPhone) || alertDirty}
                    title={!(leadAlertRule?.enabled) ? 'Enable Lead Alerts first' : alertDirty ? 'Save changes first' : !alertToPhone ? 'Set agent phone first' : ''}
                    className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all whitespace-nowrap disabled:cursor-not-allowed ${
                      testStatus === 'delivered' ? 'bg-emerald-100 text-emerald-700' :
                      testStatus === 'failed' ? 'bg-red-100 text-red-700' :
                      testStatus === 'sending' ? 'bg-slate-100 text-slate-500' :
                      'bg-amber-100 text-amber-700 hover:bg-amber-200 disabled:opacity-50'
                    }`}
                  >
                    {testStatus === 'sending' ? <Loader2 size={14} className="animate-spin" /> :
                     testStatus === 'delivered' ? <CheckCircle size={14} /> :
                     testStatus === 'failed' ? <X size={14} /> :
                     <Send size={14} />}
                    {testStatus === 'sending' ? 'Sending...' : testStatus === 'delivered' ? 'Sent!' : testStatus === 'failed' ? 'Failed' : 'Test Alert'}
                  </button>
                  <button
                    onClick={sendCtTest}
                    disabled={ctTestStatus === 'sending' || !ctEnabled || !ccTestPhone || !isValidPhoneE164(ccTestPhone) || tenantPhones.length === 0 || !!ccSamePhoneError || commsDirty}
                    className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all whitespace-nowrap disabled:cursor-not-allowed ${
                      ctTestStatus === 'delivered' ? 'bg-emerald-100 text-emerald-700' :
                      ctTestStatus === 'failed' ? 'bg-red-100 text-red-700' :
                      ctTestStatus === 'sending' ? 'bg-slate-100 text-slate-500' :
                      'bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50'
                    }`}
                    title={!ctEnabled ? 'Enable Customer Texting first' : commsDirty ? 'Save changes first' : ''}
                  >
                    {ctTestStatus === 'sending' ? <Loader2 size={14} className="animate-spin" /> :
                     ctTestStatus === 'delivered' ? <CheckCircle size={14} /> :
                     ctTestStatus === 'failed' ? <X size={14} /> :
                     <Send size={14} />}
                    {ctTestStatus === 'sending' ? 'Sending...' : ctTestStatus === 'delivered' ? 'Sent' : ctTestStatus === 'failed' ? 'Failed' : 'Test Text'}
                  </button>
                  <button
                    onClick={handleTestCall}
                    disabled={ccTesting || !ccEnabled || !!ccSamePhoneError || !ccTestPhone || !isValidPhoneE164(ccTestPhone) || commsDirty}
                    className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all whitespace-nowrap disabled:cursor-not-allowed ${
                      ccTesting ? 'bg-slate-100 text-slate-500' : 'bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50'
                    }`}
                    title={!ccEnabled ? 'Enable Instant Calls first' : commsDirty ? 'Save changes first' : ''}
                  >
                    {ccTesting ? <Loader2 size={14} className="animate-spin" /> : <PhoneCall size={14} />}
                    {ccTesting ? 'Calling…' : 'Test Call'}
                  </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-6 px-4 bg-amber-50/50 rounded-2xl border border-amber-200">
              <Phone className="w-8 h-8 text-amber-500" />
              <p className="text-sm text-amber-700 font-medium text-center">You need a LeadBridge number to use notifications and communications</p>
              <button
                onClick={() => setShowDedicatedModal(true)}
                className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-amber-500 text-white hover:bg-amber-600 transition-colors flex items-center gap-2"
              >
                <Phone className="w-4 h-4" />
                Get a Number
              </button>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 size={24} className="animate-spin text-blue-600" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6">
          {/* 1. Lead Notifications (combined Auto-Reply + Lead Alerts) */}
          {(() => {
            const noPhone = tenantPhones.length === 0;
            const toPhoneMissing = !!leadAlertRule && !alertToPhone;
            const templateMissing = !!leadAlertRule && !leadAlertRule.templateId && !leadAlertRule.messageTemplate;
            const leadAlertsIncomplete = toPhoneMissing || templateMissing;
            return (
          <ServiceCard
            icon={<Bell className="w-7 h-7" />}
            title="Lead Notifications"
            description="Auto-reply to leads and get SMS alerts for every new inquiry."
            enabled={autoReplyEnabled || (leadAlertRule?.enabled ?? false)}
            onToggle={(on) => {
              if (on && noPhone) { setShowDedicatedModal(true); return; }
              // Optimistic: flip sub-switches immediately so the main toggle switches right away
              if (on) {
                if (!autoReplyEnabled) setAutoReplyRules(prev => prev.length ? prev.map(r => ({ ...r, enabled: true })) : [{ id: '_pending', enabled: true } as any]);
                if (!leadAlertRule?.enabled) setLeadAlertRule(leadAlertRule ? { ...leadAlertRule, enabled: true } : { id: '_pending', enabled: true } as any);
              } else {
                setAutoReplyRules(prev => prev.map(r => ({ ...r, enabled: false })));
                if (leadAlertRule) setLeadAlertRule({ ...leadAlertRule, enabled: false });
              }
              if (!expandedCard || expandedCard !== 'notifications') setExpandedCard('notifications');
              // Persist to backend
              if (on) {
                if (!autoReplyEnabled) toggleAutoReply(true);
                if (!leadAlertRule?.enabled) toggleLeadAlerts(true);
              } else {
                if (autoReplyEnabled) toggleAutoReply(false);
                if (leadAlertRule?.enabled) toggleLeadAlerts(false);
              }
            }}
            expanded={expandedCard === 'notifications'}
            onExpand={() => toggleExpand('notifications')}
            setupRequired={noPhone || leadAlertsIncomplete}
            warningText={noPhone ? 'LeadBridge number required' : leadAlertsIncomplete ? (toPhoneMissing ? 'Phone number required' : 'Template required') : undefined}
            statusText={undefined}
            iconBgColor="bg-amber-50"
            iconTextColor="text-amber-600"
            cardRef={el => { cardRefs.current['notifications'] = el; if (el) el.setAttribute('data-tour', 'notifications-card'); }}
          >
            <div className={`space-y-6${noPhone ? ' opacity-40 pointer-events-none select-none' : ''}`}>

              {/* ── Auto Reply sub-section ── */}
              <div className="border border-slate-100 rounded-2xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 bg-slate-50/50">
                  <div className="flex items-center gap-3">
                    <Zap className="w-5 h-5 text-blue-600" />
                    <div>
                      <h4 className="text-sm font-bold text-slate-800">Auto Reply</h4>
                      <p className="text-xs text-slate-400">Automatically respond to new leads as they arrive</p>
                    </div>
                  </div>
                  <label className="inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoReplyEnabled}
                      onChange={e => toggleAutoReply(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="relative w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-100 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500" />
                  </label>
                </div>
                <div className={`px-5 py-4 space-y-4${!autoReplyEnabled ? ' opacity-40 pointer-events-none select-none' : ''}`}>
                  {/* Template */}
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
                </div>
              </div>

              {/* ── Lead Alerts sub-section ── */}
              <div className="border border-slate-100 rounded-2xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 bg-slate-50/50">
                  <div className="flex items-center gap-3">
                    <MessageSquare className="w-5 h-5 text-amber-600" />
                    <div>
                      <h4 className="text-sm font-bold text-slate-800">Lead Alerts</h4>
                      <p className="text-xs text-slate-400">Get SMS notifications for every new inquiry</p>
                    </div>
                  </div>
                  <label className="inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={leadAlertRule?.enabled ?? false}
                      onChange={e => toggleLeadAlerts(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="relative w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-amber-100 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-500" />
                  </label>
                </div>
                <div className={`px-5 py-4 space-y-4${!(leadAlertRule?.enabled) ? ' opacity-40 pointer-events-none select-none' : ''}`}>
                  {/* Template */}
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
                            templateMissing ? 'border-2 border-orange-300 bg-orange-50/40 focus:ring-orange-200' : 'bg-white border border-slate-200'
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

                    </>
                  )}
                </div>

                {/* Alert Save */}
                {leadAlertRule && (
                  <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/30">
                    {alertDirty ? (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-amber-600 font-medium flex items-center gap-1">
                          <AlertCircle className="w-3 h-3" /> Unsaved changes
                        </span>
                        <div className="flex gap-2">
                          <button onClick={discardAlertChanges} className="px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">Discard</button>
                          <button onClick={saveAlertSettings} disabled={saving || !alertToPhone} className="px-3 py-1.5 text-xs font-semibold text-white bg-amber-600 rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50 flex items-center gap-1">
                            {saving && <Loader2 className="w-3 h-3 animate-spin" />} Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button onClick={saveAlertSettings} disabled={saving} className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-amber-600 rounded-lg hover:bg-amber-700 transition-colors disabled:opacity-50">
                        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Save Alerts
                      </button>
                    )}
                  </div>
                )}

                {/* Delete rule */}
                {leadAlertRule && (
                  <div className="px-5 py-3 border-t border-slate-100">
                    {confirmDeleteAlert ? (
                      <div className="bg-red-50 border border-red-100 rounded-xl p-3 flex flex-col sm:flex-row items-start sm:items-center gap-3">
                        <div className="flex-1">
                          <p className="text-xs font-bold text-red-700">Delete this rule?</p>
                          <p className="text-[11px] text-red-500 mt-0.5">Toggle Lead Alerts back on to create a fresh setup.</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button onClick={() => setConfirmDeleteAlert(false)} className="px-3 py-1.5 text-xs font-semibold text-slate-600 hover:text-slate-800 transition-colors">Cancel</button>
                          <button onClick={deleteLeadAlertRule} disabled={deletingAlert} className="px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-semibold hover:bg-red-700 disabled:opacity-50 flex items-center gap-1">
                            {deletingAlert ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Delete
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button onClick={() => setConfirmDeleteAlert(true)} className="text-xs font-semibold text-slate-400 hover:text-red-500 transition-colors flex items-center gap-1.5">
                        <Trash2 className="w-3.5 h-3.5" /> Delete this rule and start over
                      </button>
                    )}
                  </div>
                )}
              </div>

            </div>
          </ServiceCard>
            );
          })()}

          {/* 3. Customer Communications (combined CT + ICC) */}
          <ServiceCard
            icon={<Phone className="w-7 h-7" />}
            title="Customer Communications"
            description="Text and call customers from your LeadBridge number."
            enabled={ctEnabled || ccEnabled}
            onToggle={(on) => {
              if (on && tenantPhones.length === 0) { setShowDedicatedModal(true); return; }
              // Optimistic: flip both sub-switches immediately
              setCtEnabled(on);
              setCcEnabled(on);
              if (!expandedCard || expandedCard !== 'comms') setExpandedCard('comms');
              // Persist to backend (fire & forget — each handles its own rollback)
              if (on !== ctEnabled && selectedAccountId) {
                notificationsApi.saveCustomerTextingSettings(selectedAccountId, {
                  enabled: on,
                  autoReplyTemplate: ctAutoReplyTemplate,
                }).catch((err) => { console.error('CT save failed:', err); setCtEnabled(!on); });
              }
              if (on !== ccEnabled && selectedAccountId) {
                callConnectApi.saveSettings(selectedAccountId, { enabled: on })
                  .then(({ settings }) => setCcEnabled(settings.enabled))
                  .catch((err) => { console.error('CC save failed:', err); setCcEnabled(!on); });
              }
            }}
            expanded={expandedCard === 'comms'}
            onExpand={() => toggleExpand('comms')}
            setupRequired={tenantPhones.length === 0 || (!ccAgentPhone && tenantPhones.length > 0)}
            warningText={tenantPhones.length === 0 ? 'LeadBridge number required' : (!ccAgentPhone && tenantPhones.length > 0) ? 'Agent phone required' : undefined}
            statusText={undefined}
            iconBgColor="bg-blue-50"
            iconTextColor="text-blue-600"
            cardRef={el => { cardRefs.current['comms'] = el; if (el) el.setAttribute('data-tour', 'comms-card'); }}
          >
            <div className={`space-y-6${tenantPhones.length === 0 ? ' opacity-40 pointer-events-none select-none' : ''}`}>

              {/* ── Customer Texting sub-section ── */}
              <div className="border border-slate-100 rounded-2xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 bg-slate-50/50">
                  <div className="flex items-center gap-3">
                    <MessageSquare className="w-5 h-5 text-emerald-600" />
                    <div>
                      <h4 className="text-sm font-bold text-slate-800">Customer Texting</h4>
                      <p className="text-xs text-slate-400">Auto-text customers when new leads arrive</p>
                    </div>
                  </div>
                  <label className="inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={ctEnabled}
                      onChange={e => toggleCustomerTexting(e.target.checked)}
                      disabled={ctSaving}
                      className="sr-only peer"
                    />
                    <div className="relative w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-emerald-100 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500" />
                  </label>
                </div>
                <div className={`px-5 py-4 space-y-4${!ctEnabled ? ' opacity-40 pointer-events-none select-none' : ''}`}>
                  {/* Auto-reply template */}
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

                </div>
              </div>

              {/* ── Instant Call Connect sub-section ── */}
              <div className="border border-slate-100 rounded-2xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 bg-slate-50/50">
                  <div className="flex items-center gap-3">
                    <PhoneCall className="w-5 h-5 text-violet-600" />
                    <div>
                      <h4 className="text-sm font-bold text-slate-800">Instant Call Connect</h4>
                      <p className="text-xs text-slate-400">Bridge you instantly to new leads via phone call</p>
                    </div>
                  </div>
                  <label className="inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={ccEnabled}
                      onChange={e => toggleCallConnect(e.target.checked)}
                      disabled={ccSaving}
                      className="sr-only peer"
                    />
                    <div className="relative w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-violet-100 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-violet-500" />
                  </label>
                </div>
                <div className={`px-5 py-4 space-y-4${!ccEnabled ? ' opacity-40 pointer-events-none select-none' : ''}`}>
                  {/* Connection Mode */}
                  <div>
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-3 block">Connection Mode</label>
                    <div className="flex bg-slate-100 rounded-2xl p-1 max-w-lg">
                      <button
                        onClick={() => setCcMode('AGENT_FIRST')}
                        className={`flex-1 flex flex-col items-center gap-0.5 rounded-xl px-4 py-3 transition-all ${
                          ccMode === 'AGENT_FIRST' ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-400 hover:text-slate-600'
                        }`}
                      >
                        <Phone className="w-4 h-4" />
                        <span className="text-sm font-bold">Agent First</span>
                        <span className="text-[11px] font-normal text-slate-400 leading-tight text-center">We call you, then bridge the lead</span>
                      </button>
                      <button
                        onClick={() => setCcMode('PARALLEL')}
                        className={`flex-1 flex flex-col items-center gap-0.5 rounded-xl px-4 py-3 transition-all ${
                          ccMode === 'PARALLEL' ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-400 hover:text-slate-600'
                        }`}
                      >
                        <Zap className="w-4 h-4" />
                        <span className="text-sm font-bold">Parallel</span>
                        <span className="text-[11px] font-normal text-slate-400 leading-tight text-center">Call you and lead simultaneously</span>
                      </button>
                    </div>
                  </div>

                  {/* Agent Whisper Message */}
                  <div>
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Agent Whisper Message</label>
                    <p className="text-xs text-slate-400 mb-3">Played to you before the bridge. Press <span className="font-semibold text-slate-500">any key</span> to accept.</p>
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

                  {/* Lead Greeting — Parallel mode only */}
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

                  {/* Voicemail */}
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
                        <input type="url" value={ccVoicemailRecordingUrl} onChange={e => setCcVoicemailRecordingUrl(e.target.value)} placeholder="https://example.com/voicemail.mp3"
                          className={`w-full bg-white border border-slate-200 rounded-xl p-3 text-slate-800 text-sm font-medium placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-violet-300 focus:border-transparent ${ccVoicemailRecordingUrl ? 'pr-10' : ''}`}
                        />
                        {ccVoicemailRecordingUrl && (
                          <button type="button" onClick={() => setCcVoicemailRecordingUrl('')} title="Clear URL" className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-red-500 transition-colors">
                            <X className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                </div>
              </div>

              {/* ── Save / unsaved changes ── */}
              <div className="pt-4 border-t border-slate-100">
                {commsDirty ? (
                  <div className="flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3">
                    <div className="flex items-center gap-2 text-amber-700">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span className="text-sm font-medium">You have unsaved changes</span>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button onClick={discardCommsChanges} className="px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">Discard</button>
                      <button onClick={saveCommsSettings} disabled={ctSaving || ccSaving} className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-1">
                        {(ctSaving || ccSaving) && <Loader2 className="w-3 h-3 animate-spin" />} Save Settings
                      </button>
                    </div>
                  </div>
                ) : (
                  <button onClick={saveCommsSettings} disabled={ctSaving || ccSaving} className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 transition-colors disabled:opacity-50">
                    {(ctSaving || ccSaving) ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save Settings
                  </button>
                )}
              </div>
            </div>
          </ServiceCard>

          {/* 4. Yelp Automation — Coming Soon */}
          <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden opacity-60 pointer-events-none select-none">
            <div className="p-6 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-red-50 rounded-2xl flex items-center justify-center">
                  <MessageSquare className="w-7 h-7 text-red-600" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-bold text-slate-900">Yelp Automation</h3>
                    <span className="px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-red-100 text-red-600 rounded-full">Coming Soon</span>
                  </div>
                  <p className="text-sm text-slate-400 mt-0.5">Schedule replies and follow-ups for Yelp conversations.</p>
                </div>
              </div>
              <div className="relative w-11 h-6 bg-slate-200 rounded-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5" />
            </div>
          </div>

          {/* 5. AI Optimization — BYO Phone Connection + AI Suggestions */}
          <div className="bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
            <div
              className="p-6 flex items-center justify-between cursor-pointer hover:bg-slate-50/50 transition-colors"
              onClick={() => setExpandedCard(expandedCard === 'ai-optimization' ? null : 'ai-optimization')}
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-purple-50 rounded-2xl flex items-center justify-center">
                  <Sparkles className="w-7 h-7 text-purple-600" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-bold text-slate-900">AI Optimization</h3>
                    {csConnected && (
                      <span className="px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-green-100 text-green-600 rounded-full">Connected</span>
                    )}
                  </div>
                  <p className="text-sm text-slate-400 mt-0.5">
                    Connect your business phone to enable AI-powered conversation insights.
                  </p>
                </div>
              </div>
              {expandedCard === 'ai-optimization' ? <ChevronUp className="w-5 h-5 text-slate-400" /> : <ChevronDown className="w-5 h-5 text-slate-400" />}
            </div>

            {expandedCard === 'ai-optimization' && (
              <div className="px-6 pb-6 border-t border-slate-100 pt-4 space-y-5">
                {/* Step 1: BYO Phone Connection */}
                <div>
                  <h4 className="text-xs font-semibold text-purple-600 uppercase tracking-wider mb-3">Step 1: Connect Business Phone</h4>

                  {!csConnected ? (
                    <div className="space-y-3">
                      <p className="text-sm text-slate-600">
                        Connect your OpenPhone account to sync lead conversations for AI analysis.
                      </p>
                      <div className="flex gap-3">
                        <input
                          type="password"
                          placeholder="OpenPhone API Key"
                          value={csApiKey}
                          onChange={e => { setCsApiKey(e.target.value); setCsError(null); }}
                          className="flex-1 px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                        />
                        <button
                          onClick={async () => {
                            if (!csApiKey.trim() || !selectedAccountId) return;
                            setCsConnecting(true);
                            setCsError(null);
                            try {
                              const result = await conversationSyncApi.connect(selectedAccountId, csApiKey.trim());
                              if (result.success) {
                                setCsConnected(true);
                                setCsPhoneNumbers(result.phoneNumbers || []);
                                setCsApiKey('');
                                setSuccessMessage('OpenPhone connected for AI Optimization');
                                setTimeout(() => setSuccessMessage(null), 3000);
                              } else {
                                setCsError(result.error || 'Connection failed');
                              }
                            } catch (err: any) {
                              setCsError(err.response?.data?.message || err.message || 'Connection failed');
                            } finally {
                              setCsConnecting(false);
                            }
                          }}
                          disabled={csConnecting || !csApiKey.trim()}
                          className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-purple-600 rounded-xl hover:bg-purple-700 transition-colors disabled:opacity-50"
                        >
                          {csConnecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                          Connect
                        </button>
                      </div>
                      {csError && (
                        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">
                          <AlertCircle className="w-4 h-4 flex-shrink-0" />
                          {csError}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {/* Connected Numbers */}
                      {csPhoneNumbers.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {csPhoneNumbers.map((pn, i) => (
                            <span key={i} className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-purple-50 text-purple-700 text-sm rounded-lg">
                              <Phone className="w-3.5 h-3.5" />
                              {pn.phoneNumber}
                              {pn.name && <span className="text-purple-400">({pn.name})</span>}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Actions */}
                      <div className="flex flex-wrap gap-3">
                        {/* Step 1: Sync from OpenPhone */}
                        <button
                          onClick={async () => {
                            if (!selectedAccountId) return;
                            setCsOpenPhoneSyncing(true);
                            setCsError(null);
                            setCsSyncProgress({ status: 'starting' });
                            try {
                              const result = await conversationSyncApi.syncOpenPhone(selectedAccountId);
                              if (!result.success) {
                                setCsError(result.error || 'Sync trigger failed');
                                setCsOpenPhoneSyncing(false);
                                setCsSyncProgress(null);
                                return;
                              }
                              // Poll for progress
                              const pollInterval = setInterval(async () => {
                                try {
                                  const status = await conversationSyncApi.getSyncStatus(selectedAccountId);
                                  setCsSyncProgress(status);
                                  if (status.status === 'completed' || status.status === 'idle' || status.status === 'error') {
                                    clearInterval(pollInterval);
                                    setCsOpenPhoneSyncing(false);
                                    if (status.status === 'error') {
                                      setCsError(status.error || 'Sync failed');
                                    } else {
                                      setSuccessMessage('OpenPhone sync completed');
                                      setTimeout(() => setSuccessMessage(null), 4000);
                                    }
                                  }
                                } catch {
                                  clearInterval(pollInterval);
                                  setCsOpenPhoneSyncing(false);
                                  setCsSyncProgress(null);
                                }
                              }, 3000);
                            } catch (err: any) {
                              setCsError(err.response?.data?.message || err.message || 'Sync failed');
                              setCsOpenPhoneSyncing(false);
                              setCsSyncProgress(null);
                            }
                          }}
                          disabled={csOpenPhoneSyncing || csMatchingLeads}
                          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-purple-700 bg-purple-50 rounded-xl hover:bg-purple-100 transition-colors disabled:opacity-50"
                        >
                          {csOpenPhoneSyncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                          Sync from OpenPhone
                        </button>

                        {/* Step 2: Match to Leads */}
                        <button
                          onClick={async () => {
                            if (!selectedAccountId) return;
                            setCsMatchingLeads(true);
                            setCsError(null);
                            setCsMatchResult(null);
                            try {
                              const result = await conversationSyncApi.matchLeads(selectedAccountId);
                              if (result.success) {
                                setCsMatchResult({ synced: result.synced, totalConversations: result.totalConversations, totalLeads: result.totalLeads });
                                setSuccessMessage(`Matched ${result.synced} conversations to leads`);
                                setTimeout(() => setSuccessMessage(null), 4000);
                              } else {
                                setCsError(result.error || 'Matching failed');
                              }
                            } catch (err: any) {
                              setCsError(err.response?.data?.message || err.message || 'Matching failed');
                            } finally {
                              setCsMatchingLeads(false);
                            }
                          }}
                          disabled={csOpenPhoneSyncing || csMatchingLeads}
                          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-indigo-700 bg-indigo-50 rounded-xl hover:bg-indigo-100 transition-colors disabled:opacity-50"
                        >
                          {csMatchingLeads ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                          Match to Leads
                        </button>

                        {/* Disconnect */}
                        <button
                          onClick={async () => {
                            if (!selectedAccountId) return;
                            try {
                              await conversationSyncApi.disconnect(selectedAccountId);
                              setCsConnected(false);
                              setCsPhoneNumbers([]);
                              setCsSyncProgress(null);
                              setCsMatchResult(null);
                              setSuccessMessage('Phone disconnected');
                              setTimeout(() => setSuccessMessage(null), 3000);
                            } catch (err: any) {
                              setCsError(err.response?.data?.message || err.message || 'Disconnect failed');
                            }
                          }}
                          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-red-600 bg-red-50 rounded-xl hover:bg-red-100 transition-colors"
                        >
                          <Unlink className="w-4 h-4" />
                          Disconnect
                        </button>
                      </div>

                      {/* Sync Progress */}
                      {csOpenPhoneSyncing && csSyncProgress && (
                        <div className="bg-purple-50 rounded-xl px-4 py-3 space-y-2">
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-medium text-purple-700">
                              {csSyncProgress.status === 'starting' ? 'Starting sync...' :
                               csSyncProgress.status === 'syncing' || csSyncProgress.status === 'in_progress' ? 'Syncing conversations...' :
                               csSyncProgress.status}
                            </span>
                            {csSyncProgress.progress != null && csSyncProgress.total != null && csSyncProgress.total > 0 && (
                              <span className="text-purple-500">{csSyncProgress.progress} / {csSyncProgress.total}</span>
                            )}
                          </div>
                          {csSyncProgress.progress != null && csSyncProgress.total != null && csSyncProgress.total > 0 && (
                            <div className="w-full bg-purple-200 rounded-full h-2">
                              <div
                                className="bg-purple-600 h-2 rounded-full transition-all duration-500"
                                style={{ width: `${Math.min(100, Math.round((csSyncProgress.progress / csSyncProgress.total) * 100))}%` }}
                              />
                            </div>
                          )}
                        </div>
                      )}

                      {/* Match Result */}
                      {csMatchResult && (
                        <div className="bg-indigo-50 rounded-xl px-4 py-3 text-sm text-indigo-700">
                          Matched <strong>{csMatchResult.synced}</strong> of {csMatchResult.totalConversations} conversations across {csMatchResult.totalLeads} leads
                        </div>
                      )}

                      {csError && (
                        <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">
                          <AlertCircle className="w-4 h-4 flex-shrink-0" />
                          {csError}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Step 2: AI Suggestions (Coming Soon) */}
                <div className="opacity-50 pointer-events-none">
                  <h4 className="text-xs font-semibold text-purple-600 uppercase tracking-wider mb-2">Step 3: AI Suggestions</h4>
                  <p className="text-sm text-slate-400">
                    Once connected, AI will analyze your lead conversations and suggest optimal reply timing, message variations, and follow-up strategies.
                  </p>
                </div>
              </div>
            )}
          </div>

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

      {/* Phone type selector — shown from "+ Add phone number" dropdown */}
      {showPhoneSetupModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setShowPhoneSetupModal(false)}>
          <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-8 relative" onClick={e => e.stopPropagation()}>
            <button onClick={() => setShowPhoneSetupModal(false)} className="absolute top-5 right-5 text-slate-400 hover:text-slate-600 transition-colors">
              <X className="w-5 h-5" />
            </button>
            <h3 className="text-xl font-bold text-slate-900 mb-2">Add a Phone Number</h3>
            <p className="text-sm text-slate-500 mb-6 leading-relaxed">
              Choose how you want to add a send-from number for customer texting:
            </p>
            <div className="space-y-4">
              <div className="border border-slate-200 rounded-2xl p-5 hover:border-blue-200 transition-all cursor-pointer" onClick={() => { setShowPhoneSetupModal(false); setShowOpenPhoneModal(true); }}>
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center shrink-0 mt-0.5"><Phone className="w-4 h-4" /></div>
                  <div>
                    <p className="font-semibold text-slate-900 text-sm">Option 2 — Bring Your Own Phone</p>
                    <p className="text-xs text-slate-500 mt-1">Connect your Quo, OpenPhone, or other provider.</p>
                  </div>
                </div>
              </div>
              <div className="border border-slate-200 rounded-2xl p-5 hover:border-indigo-200 transition-all cursor-pointer" onClick={() => openDedicatedModal()}>
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center shrink-0 mt-0.5"><Briefcase className="w-4 h-4" /></div>
                  <div>
                    <p className="font-semibold text-slate-900 text-sm">Option 3 — Dedicated Number</p>
                    <p className="text-xs text-slate-500 mt-1">Get a Twilio number exclusively assigned to your account.</p>
                  </div>
                </div>
              </div>
            </div>
            <p className="mt-5 text-xs text-slate-400 text-center">Shared pool numbers (Option 1) cannot be used for customer texting.</p>
          </div>
        </div>
      )}

      {/* OpenPhone Setup Modal */}
      {showOpenPhoneModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setShowOpenPhoneModal(false)}>
          <div className="bg-white rounded-3xl shadow-2xl max-w-md w-full p-8 relative" onClick={e => e.stopPropagation()}>
            <button onClick={() => setShowOpenPhoneModal(false)} className="absolute top-5 right-5 text-slate-400 hover:text-slate-600 transition-colors">
              <X className="w-5 h-5" />
            </button>
            <h3 className="text-xl font-bold text-slate-900 mb-2">Bring Your Own Phone</h3>
            <p className="text-sm text-slate-500 mb-6 leading-relaxed">
              Enter your Quo, OpenPhone, or compatible provider API key to use your own phone numbers for customer texting.{' '}
              <a href="https://my.quo.com/settings/api" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">
                Get your Quo API key <ExternalLink size={11} />
              </a>
            </p>
            {opConnectError && (
              <div className="mb-4 bg-red-50 border border-red-100 rounded-xl p-3 flex items-center gap-2 text-red-600 text-sm">
                <AlertCircle size={14} className="shrink-0" />
                <span className="flex-1">{opConnectError}</span>
                <button onClick={() => setOpConnectError(null)}><X size={14} /></button>
              </div>
            )}
            <div className="flex gap-3">
              <div className="relative flex-1">
                <Key size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="password"
                  value={opApiKey}
                  onChange={e => setOpApiKey(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleOpConnect()}
                  placeholder="OpenPhone API key"
                  className="w-full pl-8 pr-4 py-3 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono"
                />
              </div>
              <button
                onClick={handleOpConnect}
                disabled={opConnecting || !opApiKey.trim()}
                className="px-5 py-3 bg-blue-600 text-white rounded-xl font-semibold text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 shadow-lg shadow-blue-200 transition-all"
              >
                {opConnecting ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
                {opConnecting ? 'Connecting...' : 'Connect'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* LeadBridge Number Setup Modal */}
      {showDedicatedModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setShowDedicatedModal(false)}>
          <div className="bg-white rounded-3xl shadow-2xl max-w-xl w-full p-8 relative" onClick={e => e.stopPropagation()}>
            <button onClick={() => setShowDedicatedModal(false)} className="absolute top-5 right-5 text-slate-400 hover:text-slate-600 transition-colors">
              <X className="w-5 h-5" />
            </button>
            <h3 className="text-xl font-bold text-slate-900 mb-2">Get a LeadBridge Number</h3>
            <p className="text-sm text-slate-500 mb-5 leading-relaxed">Search for an available number by area code or city, then purchase it for your account.</p>

            {dpSearchError && (
              <div className="mb-4 bg-red-50 border border-red-100 rounded-xl p-3 flex items-center gap-2 text-red-600 text-sm">
                <AlertCircle size={14} className="shrink-0" />
                <span className="flex-1">{dpSearchError}</span>
                <button onClick={() => setDpSearchError(null)}><X size={14} /></button>
              </div>
            )}

            {/* SMS Consent */}
            <div className={`rounded-xl border p-3 mb-4 ${dpSmsConsent ? 'bg-emerald-50/50 border-emerald-200' : 'bg-amber-50/50 border-amber-200'}`}>
              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={dpSmsConsent}
                  onChange={e => setDpSmsConsent(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-xs text-slate-600 leading-relaxed">
                  I agree to receive SMS notifications from Geos LLC regarding account alerts and new leads. Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe or HELP for assistance.
                </span>
              </label>
              {!dpSmsConsent && (
                <div className="mt-2 ml-7 flex items-center gap-1.5 text-amber-600 text-xs font-medium">
                  <AlertCircle size={11} className="shrink-0" />
                  You must accept the SMS consent to purchase a number.
                </div>
              )}
            </div>

            {/* Search inputs */}
            <div className="flex flex-wrap gap-3 mb-4">
              <input
                type="text"
                value={dpAreaCode}
                onChange={e => setDpAreaCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
                onKeyDown={e => e.key === 'Enter' && handleDpSearch()}
                placeholder="Area code (e.g. 415)"
                maxLength={3}
                className="w-36 px-4 py-3 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono tracking-widest"
              />
              <input
                type="text"
                value={dpLocality}
                onChange={e => setDpLocality(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleDpSearch()}
                placeholder="City (e.g. San Francisco)"
                className="flex-1 min-w-40 px-4 py-3 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <button
                onClick={handleDpSearch}
                disabled={dpSearchLoading}
                className="px-5 py-3 bg-blue-600 text-white rounded-xl font-semibold text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 shadow-lg shadow-blue-200 transition-all"
              >
                {dpSearchLoading ? <Loader2 size={14} className="animate-spin" /> : <Hash size={14} />}
                {dpSearchLoading ? 'Searching...' : 'Search Numbers'}
              </button>
            </div>

            {/* Available numbers grid */}
            {dpAvailableNumbers.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-64 overflow-y-auto">
                {dpAvailableNumbers.map(num => (
                  <div key={num.phoneNumber} className="bg-slate-50 rounded-xl border border-slate-200 p-3 flex flex-col gap-2 hover:border-blue-200 transition-all">
                    <div>
                      <div className="font-bold text-slate-900 font-mono text-sm">{num.phoneNumber}</div>
                      <div className="text-xs text-slate-500">{[num.locality, num.region].filter(Boolean).join(', ') || 'US'}</div>
                      {dpPhonePrice != null && <div className="text-xs text-slate-400">${dpPhonePrice.toFixed(2)}/mo</div>}
                    </div>
                    <button
                      onClick={() => handleDpPurchase(num.phoneNumber)}
                      disabled={dpPurchasingNumber !== null || !dpSmsConsent}
                      className="w-full px-3 py-2 bg-blue-600 text-white rounded-lg font-semibold text-xs hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2 transition-all"
                    >
                      {dpPurchasingNumber === num.phoneNumber ? <><Loader2 size={12} className="animate-spin" /> Getting...</> : 'Get this number'}
                    </button>
                  </div>
                ))}
              </div>
            )}
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

      {/* Onboarding Tour */}
      <OnboardingTour active={tourActive} onComplete={() => setTourActive(false)} />
    </div>
  );
}
