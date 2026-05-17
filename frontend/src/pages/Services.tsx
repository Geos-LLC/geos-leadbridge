import { useState, useEffect, useRef } from 'react';
import {
  Loader2, ChevronDown, MessageSquare, Bell, PhoneCall,
  Zap, Briefcase, AlertCircle, AlertTriangle, CheckCircle, X,
  Pencil, Phone, ChevronUp, Trash2, Save,
  Link2, Sparkles, RefreshCw, Unlink, Clock, Lock, Plus,
} from 'lucide-react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import {
  automationApi, notificationsApi, thumbtackApi, templatesApi, callConnectApi, conversationSyncApi, followUpApi, usersApi, authApi,
} from '../services/api';
import type { TenantPhoneNumber } from '../services/api';
import type {
  AutomationRule, NotificationRule, SavedAccount, MessageTemplate,
  CallConnectMode, AgentStrategy, SigcorePhoneNumber,
} from '../types';
import { TemplateEditorModal, AUTO_REPLY_VARIABLES, SMS_VARIABLES } from '../components/TemplateEditorModal';
import ServicePricingForm, { DEFAULT_CLEANING_PRICING } from '../components/ServicePricingForm';
import AdminNoAccountsState from '../components/AdminNoAccountsState';
import NoAccountsOverlay from '../components/NoAccountsOverlay';
import { useAppStore } from '../store/appStore';
import { useAuthStore } from '../store/authStore';
import { TierBadge, LockedFeatureOverlay } from '../components/TierBadges';
import { AccountHoursControl } from '../components/AccountHoursControl';

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
  titleBadge?: React.ReactNode;
  // When true, the toggle renders in an amber "indeterminate" state to signal
  // that accounts disagree on this setting (only meaningful in All-Accounts mode).
  mixed?: boolean;
}

function ServiceCard({ icon, title, description, enabled, onToggle, comingSoon, expanded, onExpand, statusText, warningText, setupRequired, children, cardRef, titleBadge, mixed }: ServiceCardProps) {
  const borderColor = comingSoon
    ? 'var(--lb-line-soft)'
    : setupRequired
      ? 'oklch(0.85 0.1 75)'
      : enabled
        ? 'var(--lb-accent-line)'
        : 'var(--lb-line)';

  return (
    <div
      ref={cardRef}
      style={{
        background: 'var(--lb-surface)',
        border: `1px solid ${borderColor}`,
        borderRadius: 'var(--lb-radius-lg)',
        overflow: 'hidden',
        transition: 'border-color 160ms ease, opacity 160ms ease',
        opacity: comingSoon ? 0.7 : enabled ? 1 : 0.82,
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '36px 1fr auto',
          gap: 14,
          padding: '14px 18px',
          alignItems: 'center',
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            background: comingSoon ? 'var(--lb-ink-10)' : enabled ? 'var(--lb-accent-tint)' : 'var(--lb-ink-10)',
            color: comingSoon ? 'var(--lb-ink-6)' : enabled ? 'var(--lb-accent)' : 'var(--lb-ink-5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 160ms ease',
          }}
        >
          <span style={{ display: 'inline-flex', width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}>
            {icon}
          </span>
        </div>

        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h3
              style={{
                margin: 0,
                fontSize: 14,
                fontWeight: 600,
                color: comingSoon ? 'var(--lb-ink-5)' : 'var(--lb-ink-1)',
                letterSpacing: '-0.005em',
              }}
            >
              {title}
            </h3>
            {titleBadge}
            {comingSoon && (
              <span
                style={{
                  fontSize: 10,
                  fontFamily: 'var(--lb-font-mono)',
                  fontWeight: 600,
                  padding: '1px 6px',
                  borderRadius: 99,
                  background: 'var(--lb-ink-10)',
                  color: 'var(--lb-ink-5)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.06,
                }}
              >
                Coming soon
              </span>
            )}
            {setupRequired && !comingSoon && (
              <span
                style={{
                  fontSize: 10,
                  fontFamily: 'var(--lb-font-mono)',
                  fontWeight: 600,
                  padding: '1px 6px',
                  borderRadius: 99,
                  background: 'oklch(0.95 0.04 75)',
                  color: '#5e3b0a',
                  textTransform: 'uppercase',
                  letterSpacing: 0.06,
                }}
              >
                Setup required
              </span>
            )}
          </div>
          <p
            style={{
              margin: '3px 0 0',
              fontSize: 12,
              color: 'var(--lb-ink-5)',
            }}
          >
            {description}
          </p>
          {warningText && !comingSoon && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--lb-warn)' }} />
              <span
                style={{
                  fontSize: 11,
                  fontFamily: 'var(--lb-font-mono)',
                  fontWeight: 600,
                  color: '#5e3b0a',
                  textTransform: 'uppercase',
                  letterSpacing: 0.04,
                }}
              >
                {warningText}
              </span>
            </div>
          )}
          {statusText && !warningText && !comingSoon && enabled && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--lb-success)' }} />
              <span
                style={{
                  fontSize: 11,
                  fontFamily: 'var(--lb-font-mono)',
                  fontWeight: 500,
                  color: 'var(--lb-ink-4)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.04,
                }}
              >
                {statusText}
              </span>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {!comingSoon && onExpand && (
            <button
              onClick={onExpand}
              style={{
                width: 28,
                height: 28,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'transparent',
                border: 0,
                borderRadius: 4,
                cursor: 'pointer',
                color: 'var(--lb-ink-5)',
              }}
              title={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          )}
          <label
            style={{ display: 'inline-flex', alignItems: 'center', cursor: comingSoon ? 'not-allowed' : 'pointer' }}
            title={mixed ? 'Settings differ across accounts — pick a specific account to view or edit' : undefined}
          >
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => onToggle(e.target.checked)}
              disabled={comingSoon}
              className="sr-only peer"
            />
            <span
              style={{
                position: 'relative',
                width: 36,
                height: 20,
                background: mixed ? '#f59e0b' : enabled ? 'var(--lb-accent)' : 'var(--lb-ink-8)',
                borderRadius: 999,
                transition: 'background 160ms ease',
                display: 'inline-block',
                opacity: comingSoon ? 0.5 : 1,
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: 2,
                  left: mixed ? 10 : enabled ? 18 : 2,
                  width: 16,
                  height: 16,
                  borderRadius: 99,
                  background: 'white',
                  transition: 'left 160ms ease',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
                }}
              />
            </span>
          </label>
        </div>
      </div>

      {expanded && children && (
        <div
          style={{
            padding: '18px 18px 20px',
            background: 'var(--lb-bg)',
            borderTop: '1px solid var(--lb-line-soft)',
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// Module-level cache — survives navigation unmounts within SPA session
// Keyed by accountId so switching accounts still fetches fresh data
const _svcCache = new Map<string, Record<string, any>>();
let _svcLoaded = false; // true once we've fetched at least once (even if no accounts)

// Tier badges — flow stays the page's structure, tiers get annotated per feature block.
// Respond = STARTER (included), Engage = PRO, Convert = ENTERPRISE.
// TierBadge + LockedFeatureOverlay moved to ../components/TierBadges so the new
// /settings/communication page can reuse them.

// -- Main Services Page --
export function Services() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const subscriptionTier = useAuthStore(s => s.user?.subscriptionTier);
  const trialActive = useAuthStore(s => s.user?.trialActive);
  const setAuthUser = useAuthStore(s => s.setAuth);
  const authToken = useAuthStore(s => s.token);
  // Refresh the cached user on mount so a newly-purchased plan applies without requiring re-login.
  // Zustand persist keeps the old subscriptionTier around across sessions — this reconciles it.
  useEffect(() => {
    if (!authToken) return;
    authApi.getProfile()
      .then((profile: any) => {
        const freshUser = profile?.user ?? profile;
        if (freshUser?.id) setAuthUser(freshUser, authToken);
      })
      .catch(() => { /* silent: stale cache is not fatal */ });
  }, [authToken, setAuthUser]);
  // Engage/Convert unlock: paid PRO/ENTERPRISE or active adaptive trial.
  // Trial users get the full feature set during the trial so they actually
  // exercise SMS/calls/follow-ups before deciding to upgrade.
  const canUseEngage = trialActive || subscriptionTier === 'PRO' || subscriptionTier === 'ENTERPRISE';
  const canUseConvert = trialActive || subscriptionTier === 'ENTERPRISE';
  const storedAccounts = useAppStore(state => state.savedAccounts);
  const setSavedAccounts = useAppStore(state => state.setSavedAccounts);
  const setAccountDiagnostics = useAppStore(state => state.setAccountDiagnostics);

  // Account state — seed from Zustand store, restore last used account
  const [accounts, setAccounts] = useState<SavedAccount[]>(storedAccounts);
  const lastUsedAccountId = localStorage.getItem('lb_last_account_id');
  const initialAccountId = (lastUsedAccountId && storedAccounts.some(a => a.id === lastUsedAccountId) ? lastUsedAccountId : storedAccounts[0]?.id) || '';
  const [selectedAccountId, _setSelectedAccountId] = useState(initialAccountId);
  const setSelectedAccountId = (id: string) => {
    _setSelectedAccountId(id);
    localStorage.setItem('lb_last_account_id', id);
    const acc = accounts.find(a => a.id === id) || storedAccounts.find(a => a.id === id);
    if (acc?.businessId) localStorage.setItem('lb_last_account_filter', acc.businessId);
  };

  // "All accounts" mode — when on, save handlers fan out to every account.
  // Form continues to render data from `selectedAccountId` (the last real
  // account picked). The per-platform 'All Yelp' / 'All Thumbtack' checkbox
  // toggles were removed; the account dropdown is now the single control:
  //   • pick 'All accounts'  → save fans out to every account
  //   • pick one account     → save only that account
  const [allAccountsMode, _setAllAccountsMode] = useState<boolean>(() => localStorage.getItem('lb_all_accounts_mode') === '1');
  const setAllAccountsMode = (v: boolean) => { _setAllAccountsMode(v); localStorage.setItem('lb_all_accounts_mode', v ? '1' : '0'); };
  const ALL_ACCOUNTS_SENTINEL = '__ALL_ACCOUNTS__';
  const getApplyTargets = (): string[] => {
    if (allAccountsMode) {
      const ids = accounts.map(a => a.id);
      return ids.length > 0 ? ids : (selectedAccountId ? [selectedAccountId] : []);
    }
    return selectedAccountId ? [selectedAccountId] : [];
  };
  const fanoutOthers = (): string[] => getApplyTargets().filter(id => id !== selectedAccountId);

  // Cross-account mixed-state detection — when the user picks "All accounts"
  // and accounts disagree on a toggle (e.g. Yelp on / Thumbtack off), surface
  // an amber indeterminate state on the relevant ServiceCard switch.
  const [mixedToggles, setMixedToggles] = useState<{
    whenLeadArrives: boolean;
    followUps: boolean;
    aiConversation: boolean;
  }>({ whenLeadArrives: false, followUps: false, aiConversation: false });

  const sc = _svcCache.get(initialAccountId); // cached service data for this account
  const [loading, setLoading] = useState(!sc);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'sending' | 'delivered' | 'failed'>('idle');
  // deletingAlert/confirmDeleteAlert/toggleLeadAlerts/deleteLeadAlertRule below
  // are kept available even though the alerts UI on this page moved to
  // /settings/communication — the handlers and their state could be revived if
  // a future PR brings alert controls back to the Automation surface. void refs
  // at the bottom of this component silence noUnusedLocals without dropping the
  // code.
  const [deletingAlert, setDeletingAlert] = useState(false);
  const [confirmDeleteAlert, setConfirmDeleteAlert] = useState(false);

  // Auto Reply rules (dynamic array of all new_lead automation rules)
  const [autoReplyRules, setAutoReplyRules] = useState<AutomationRule[]>(sc?.autoReplyRules ?? []);
  const autoReplyEnabled = autoReplyRules.some(r => r.enabled);
  const firstReplyRule = autoReplyRules.find(r => r.delayMinutes === 0 || !r.delayMinutes) || null;
  const [autoReplyUseAi, setAutoReplyUseAi] = useState<boolean>(firstReplyRule?.useAi ?? false);
  const [replyMode, setReplyMode] = useState<'custom' | 'price' | 'auto'>(
    firstReplyRule?.replyMode ?? (firstReplyRule?.useAi ? 'auto' : 'custom')
  );
  const [showPricingModal, setShowPricingModal] = useState(false);
  const [pricingModalTab, setPricingModalTab] = useState<'view' | 'edit'>('view');
  const [pricingPreview, setPricingPreview] = useState<any>(null);
  const [pricingPreviewLoading, setPricingPreviewLoading] = useState(false);
  const [pricingPreviewInherited, setPricingPreviewInherited] = useState(false);
  const [copyingPricingToAll, setCopyingPricingToAll] = useState(false);
  const [copyPricingResult, setCopyPricingResult] = useState<string | null>(null);
  const [autoReplyAiPrompt, setAutoReplyAiPrompt] = useState<string>(firstReplyRule?.aiSystemPrompt ?? '');
  const [autoReplyPromptTemplateId, setAutoReplyPromptTemplateId] = useState<string>(firstReplyRule?.promptTemplateId || '');
  const [promptTemplates, setPromptTemplates] = useState<MessageTemplate[]>([]);
  const [, setPromptTemplatesLoaded] = useState(false);

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
  // Dedicated number management moved to Settings — see LeadBridgeNumberManager
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // Template editor modal state
  const [templateEditor, setTemplateEditor] = useState<{
    mode: 'create' | 'service-edit';
    ruleId: string;
    templateId?: string;
    templateName?: string;
    content: string;
    type: 'autoReply' | 'alert' | 'cc-whisper' | 'cc-greeting' | 'cc-voicemail' | 'ct' | string;
  } | null>(null);
  // Follow-up step editor — opens when the user clicks a chip in the
  // template-mode follow-up plan. Edits both delay + message in a single
  // popup. Local-only state; the actual persist happens via Save Settings.
  const [fuStepEditor, setFuStepEditor] = useState<{
    idx: number;
    delay: string;
    message: string;
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
  const [ccBotNumber, setCcBotNumber] = useState(sc?.ccBotNumber ?? '');
  const [ccSaving, setCcSaving] = useState(false);
  const [ccTestPhone, setCcTestPhone] = useState(() => {
    if (selectedAccountId) return localStorage.getItem(`cc_test_phone_${selectedAccountId}`) || '';
    return '';
  });
  const [ccTesting, setCcTesting] = useState(false);
  // Yelp follow-up settings
  const [fuMode, setFuMode] = useState<'off' | 'suggest' | 'auto_send'>('suggest');
  const [fuReplyType, setFuReplyType] = useState<'template' | 'ai'>('ai');
  // Timing mode removed — one editable sequence for both Manual and Auto-send
  type FuStep = { label: string; delay: string; message: string; mode: 'template' | 'ai' };
  const SMART_DEFAULTS: FuStep[] = [
    { label: '1st', delay: '2 min', mode: 'template', message: 'Hi {{lead.name}}, just wanted to make sure you saw my message. Happy to answer any questions!' },
    { label: '2nd', delay: '10 min', mode: 'template', message: 'Quick follow-up — I have availability this week if you\'d like to get on the schedule. Let me know what works for you!' },
    { label: '3rd', delay: '1 hour', mode: 'template', message: 'Hi {{lead.name}}, still here if you need anything. Would you like a price estimate based on your home details?' },
    { label: '4th', delay: '1 day', mode: 'template', message: 'Hey {{lead.name}}, just checking in. I\'d love to help with your {{lead.category}} — want me to put together a quote?' },
    { label: '5th', delay: '3 days', mode: 'template', message: 'Hi {{lead.name}}, I know things get busy! I still have openings this week for {{lead.category}}. Let me know if you\'re still interested.' },
    { label: '6th', delay: '7 days', mode: 'template', message: 'Hi {{lead.name}}, following up one more time. If you\'re still looking for {{lead.category}}, I\'d be happy to help. No pressure either way!' },
    { label: '7th', delay: '2 weeks', mode: 'template', message: 'Hey {{lead.name}}, it\'s been a couple weeks — just wanted to check if you still need {{lead.category}}. We\'re here if you do!' },
    { label: '8th', delay: '1 month', mode: 'template', message: 'Hi {{lead.name}}, hope you\'re doing well! If you\'re still thinking about {{lead.category}}, we have some availability coming up. Just let me know.' },
    { label: '9th', delay: '3 months', mode: 'template', message: 'Hi {{lead.name}}, it\'s been a while! If you ever need {{lead.category}} in the future, don\'t hesitate to reach out. We\'d love to help.' },
    { label: '10th', delay: '6 months', mode: 'template', message: 'Hey {{lead.name}}, just a friendly check-in. If you need {{lead.category}} or know someone who does, we\'re always here!' },
    { label: '11th', delay: '1 year', mode: 'template', message: 'Hi {{lead.name}}, it\'s been a year since you reached out about {{lead.category}}. If you ever need us again, we\'d love to hear from you!' },
  ];
  // Coerce a possibly-legacy step from the API (no `mode` field) into the strict
  // FuStep shape: explicit s.mode wins; else infer 'template' if a message is
  // saved, 'ai' otherwise. Keeps the typed template around in state even when
  // the user toggles to AI, so flipping back doesn't lose the text.
  const hydrateStep = (s: any, idx: number): FuStep => ({
    label: s?.label ?? `${idx + 1}th`,
    delay: s?.delay ?? '',
    message: s?.message ?? '',
    mode: s?.mode === 'ai' || s?.mode === 'template' ? s.mode : (s?.message ? 'template' : 'ai'),
  });
  const [fuSmartSteps, setFuSmartSteps] = useState<FuStep[]>(SMART_DEFAULTS.map(s => ({ ...s })));
  const [fuAvailability, setFuAvailability] = useState<'always' | 'active_hours'>('active_hours');
  // Active hours window — defaults to standard business hours 09:00–18:00.
  // Earlier defaults were inverted (18:00 start / 09:00 end), which read as
  // "active overnight, blocked all day" and silently delayed every daytime
  // follow-up to 18:00 local. See backfill-fix-inverted-active-hours.js.
  const [fuStart, setFuStart] = useState('09:00');
  const [fuEnd, setFuEnd] = useState('18:00');
  const [fuTz, setFuTz] = useState('America/New_York');
  const [fuExtraWindows, setFuExtraWindows] = useState<{ start: string; end: string }[]>([]);
  const fuStopOnReply = true; // always on — internal rule, not user-configurable
  const [fuStopOnOptOut, setFuStopOnOptOut] = useState(true);
  const [fuStopOnBooked, setFuStopOnBooked] = useState(true);
  const [fuStrategy, setFuStrategy] = useState<'auto' | 'hybrid' | 'price' | 'qualify' | 'convert' | 'phone'>('auto');
  const [fuStrategyPrompt, setFuStrategyPrompt] = useState('');
  // Switch the AI between "range" quoting (e.g. $179–$219) and "exact" quoting
  // (single table price). Stored in followUpSettingsJson.priceQuoteMode.
  const [priceQuoteMode, setPriceQuoteMode] = useState<'range' | 'exact'>('range');
  const [fuUrgentCapability, setFuUrgentCapability] = useState<'same_day' | '24h' | '48h' | 'none'>('24h');
  const [fuReEnrollOnSilence, setFuReEnrollOnSilence] = useState(true);
  const [fuReEnrollDelay, setFuReEnrollDelay] = useState('24h');
  const [fuQuietHoursStart, setFuQuietHoursStart] = useState('22:00');
  const [fuQuietHoursEnd, setFuQuietHoursEnd] = useState('08:00');
  const [fuQuietHoursEnabled, setFuQuietHoursEnabled] = useState(true);
  // fuShowRules removed — the "Smart Follow-up Rules" collapsible was replaced
  // by the inline "When the customer replies" + "Urgent request handling" blocks.
  const [aiConversationOn, setAiConversationOn] = useState(false);
  const [aiShowRules, setAiShowRules] = useState(false);
  const [aiStopOnOptOut, setAiStopOnOptOut] = useState(true);
  const [aiStopOnBooked, setAiStopOnBooked] = useState(true);
  const [aiStopOnPriceAgreed, setAiStopOnPriceAgreed] = useState(true);
  // Human Takeover trigger toggles — per-account flags stored in
  // followUpSettingsJson. Default true so existing accounts keep firing
  // on agreed / wants_live_contact without a UI visit. The three new
  // reasons (provided_phone_number, provided_square_footage,
  // qualification_complete) also default ON but are strategy-gated on
  // the backend (only fire when the AI Strategy makes them actionable).
  const [handoffTriggerAgreed, setHandoffTriggerAgreed] = useState(true);
  const [handoffTriggerWantsLiveContact, setHandoffTriggerWantsLiveContact] = useState(true);
  const [handoffTriggerProvidedPhone, setHandoffTriggerProvidedPhone] = useState(true);
  const [handoffTriggerProvidedSquareFootage, setHandoffTriggerProvidedSquareFootage] = useState(true);
  const [handoffTriggerQualificationComplete, setHandoffTriggerQualificationComplete] = useState(true);
  // Customer-reply trigger follow-ups (deferral / hired-competitor).
  // Toggles default ON; the backend looks for the per-account
  // FollowUpSequenceTemplate (lazy-seeded if missing) and enrolls a
  // single-step sequence. Delay + message are stored on the template.
  const DEFAULT_DEFERRAL_MSG = "Hi {{lead.name}}, just circling back — did you get a chance to think it over? Happy to answer any questions or help get you on the schedule if you're ready.";
  const DEFAULT_HIRED_MSG = "Hi {{lead.name}}, hope your cleaning went well! If anything didn't go the way you hoped, we'd be happy to help next time. No pressure either way.";
  const [aiDeferralCheckIn, setAiDeferralCheckIn] = useState(true);
  const [aiDeferralDelay, setAiDeferralDelay] = useState('3d');
  const [aiDeferralMessage, setAiDeferralMessage] = useState(DEFAULT_DEFERRAL_MSG);
  const [aiHiredReengage, setAiHiredReengage] = useState(true);
  const [aiHiredDelay, setAiHiredDelay] = useState('21d');
  const [aiHiredMessage, setAiHiredMessage] = useState(DEFAULT_HIRED_MSG);
  // Single user-facing alerts toggle. Also gates Handoff Alerts (AI-
  // conversation high-intent SMS) — backend auto-fires handoff when this
  // toggle is ON AND AI Conversation is enabled. No separate UI switch.
  const [reEngagementAlertOn, setReEngagementAlertOn] = useState(true);
  const [reEngagementTemplate, setReEngagementTemplate] = useState('Lead {{lead.name}} replied: "{{message}}"');
  // Handoff Alert Template — surfaces an existing `handoffAlertTemplate` field
  // in followUpSettingsJson that previously had no UI. The same single alert
  // toggle (`reEngagementAlertEnabled`) still gates the handoff firing path
  // server-side, auto-gated on `aiConversationEnabled`. No new toggle key.
  const [handoffAlertTemplate, setHandoffAlertTemplate] = useState('Lead {{lead.name}} ready for handoff ({{intent}}): "{{message}}"');
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

  // Load pricing preview whenever we're in Price mode or the modal is on the View tab
  useEffect(() => {
    if (!selectedAccountId) return;
    const needsPricing = replyMode === 'price' || (showPricingModal && pricingModalTab === 'view');
    if (!needsPricing) return;
    setPricingPreviewLoading(true);
    usersApi.getServicePricing(selectedAccountId)
      .then(res => {
        setPricingPreview(res.pricing || null);
        setPricingPreviewInherited(!!res.inherited);
      })
      .catch(() => { setPricingPreview(null); setPricingPreviewInherited(false); })
      .finally(() => setPricingPreviewLoading(false));
  }, [replyMode, showPricingModal, pricingModalTab, selectedAccountId]);

  async function handlePriceRangeChange(side: 'minus' | 'plus', field: 'value' | 'type', next: number | string) {
    if (!selectedAccountId) return;
    const base = pricingPreview || {};
    const current = base.priceRange || { minus: { type: '%', value: 10 }, plus: { type: '%', value: 10 } };
    const sideCurrent = current[side] || { type: '%', value: 10 };
    const updatedSide = field === 'value'
      ? { ...sideCurrent, value: Math.max(0, Number(next) || 0) }
      : { ...sideCurrent, type: next as '%' | '$' };
    const nextPricing = { ...base, priceRange: { ...current, [side]: updatedSide } };
    // Optimistic
    setPricingPreview(nextPricing);
    try {
      await usersApi.updateServicePricing(selectedAccountId, nextPricing);
    } catch (err: any) {
      setError(err?.message || 'Failed to save price range');
    }
  }

  async function handleCopyPricingToAll() {
    if (!selectedAccountId || copyingPricingToAll) return;
    setCopyingPricingToAll(true);
    setCopyPricingResult(null);
    try {
      const res = await usersApi.copyServicePricingToAll(selectedAccountId);
      setCopyPricingResult(`Copied to ${res.updated} other account${res.updated === 1 ? '' : 's'}.`);
    } catch (err: any) {
      setCopyPricingResult(err?.response?.data?.message || err?.message || 'Failed to copy pricing');
    } finally {
      setCopyingPricingToAll(false);
    }
  }

  // Tracks which account we've finished hydrating from the API. The auto-save
  // effect below uses this to skip the initial render that fires immediately
  // after setState() flushes the loaded values — without it, we'd round-trip
  // the loaded data right back to the server on every account switch.
  const fuBootstrappedFor = useRef<string | null>(null);

  // Load follow-up settings when account changes
  useEffect(() => {
    if (!selectedAccountId) return;
    fuBootstrappedFor.current = null;
    followUpApi.getSettings(selectedAccountId).then(res => {
      if (res.success && res.settings) {
        const s = res.settings as any;
        if (s.followUpMode) setFuMode(s.followUpMode);
        if (s.followUpActiveHoursStart) setFuStart(s.followUpActiveHoursStart);
        if (s.followUpActiveHoursEnd) setFuEnd(s.followUpActiveHoursEnd);
        if (s.followUpTimezone) setFuTz(s.followUpTimezone);
        // New fields (stored in extended settings JSON)
        // timing mode removed — single sequence
        const rawSteps = s.followUpSteps || s.followUpSmartSteps || s.followUpCustomSteps;
        const hydratedSteps = Array.isArray(rawSteps) ? rawSteps.map(hydrateStep) : null;
        if (hydratedSteps) setFuSmartSteps(hydratedSteps);
        // Resolve sequence-level mode AFTER hydrating steps:
        //   1. explicit followUpReplyType from the API wins
        //   2. else infer from saved data: any step with a message → 'template'
        //   3. else default to 'ai' (covers fresh accounts and AI-only setups)
        if (s.followUpReplyType === 'template' || s.followUpReplyType === 'ai') {
          setFuReplyType(s.followUpReplyType);
        } else if (hydratedSteps && hydratedSteps.some(st => st.message)) {
          setFuReplyType('template');
        } else {
          setFuReplyType('ai');
        }
        if (s.followUpAvailability) setFuAvailability(s.followUpAvailability);
        // Strategy mode is always 'auto', scenarios always all-enabled
        // fuStopOnReply is always true (internal rule)
        if (s.followUpStopOnOptOut !== undefined) setFuStopOnOptOut(s.followUpStopOnOptOut);
        if (s.followUpStopOnBooked !== undefined) setFuStopOnBooked(s.followUpStopOnBooked);
        // "If customer says no" removed — handled internally
        if (s.followUpUrgentCapability) setFuUrgentCapability(s.followUpUrgentCapability);
        if (s.followUpStrategy) setFuStrategy(s.followUpStrategy);
        if (s.followUpStrategyPrompt) setFuStrategyPrompt(s.followUpStrategyPrompt);
        if (s.priceQuoteMode === 'exact' || s.priceQuoteMode === 'range') setPriceQuoteMode(s.priceQuoteMode);
        // Follow-up plan settings
        if (s.fuExtraWindows) setFuExtraWindows(s.fuExtraWindows);
        if (s.fuReEnrollOnSilence !== undefined) setFuReEnrollOnSilence(s.fuReEnrollOnSilence);
        if (s.fuReEnrollDelay) setFuReEnrollDelay(s.fuReEnrollDelay);
        if (s.fuQuietHoursEnabled !== undefined) setFuQuietHoursEnabled(s.fuQuietHoursEnabled);
        if (s.fuQuietHoursStart) setFuQuietHoursStart(s.fuQuietHoursStart);
        if (s.fuQuietHoursEnd) setFuQuietHoursEnd(s.fuQuietHoursEnd);
        // AI Conversation
        if ((res.settings as any)?.aiConversationEnabled !== undefined) setAiConversationOn((res.settings as any).aiConversationEnabled);
        // AI Conversation rules
        if (s.aiStopOnOptOut !== undefined) setAiStopOnOptOut(s.aiStopOnOptOut);
        if (s.aiStopOnBooked !== undefined) setAiStopOnBooked(s.aiStopOnBooked);
        if (s.aiStopOnPriceAgreed !== undefined) setAiStopOnPriceAgreed(s.aiStopOnPriceAgreed);
        // Human Takeover trigger toggles (default true if unset).
        if (s.handoffTriggerAgreed !== undefined) setHandoffTriggerAgreed(!!s.handoffTriggerAgreed);
        if (s.handoffTriggerWantsLiveContact !== undefined) setHandoffTriggerWantsLiveContact(!!s.handoffTriggerWantsLiveContact);
        if (s.handoffTriggerProvidedPhone !== undefined) setHandoffTriggerProvidedPhone(!!s.handoffTriggerProvidedPhone);
        if (s.handoffTriggerProvidedSquareFootage !== undefined) setHandoffTriggerProvidedSquareFootage(!!s.handoffTriggerProvidedSquareFootage);
        if (s.handoffTriggerQualificationComplete !== undefined) setHandoffTriggerQualificationComplete(!!s.handoffTriggerQualificationComplete);
        if (s.aiDeferralCheckIn !== undefined) setAiDeferralCheckIn(s.aiDeferralCheckIn);
        if (s.aiDeferralDelay) setAiDeferralDelay(s.aiDeferralDelay);
        if (s.aiDeferralMessage) setAiDeferralMessage(s.aiDeferralMessage);
        if (s.aiHiredCompetitorReengage !== undefined) setAiHiredReengage(s.aiHiredCompetitorReengage);
        if (s.aiHiredCompetitorDelay) setAiHiredDelay(s.aiHiredCompetitorDelay);
        if (s.aiHiredCompetitorMessage) setAiHiredMessage(s.aiHiredCompetitorMessage);
        // Re-engagement alerts (also gates Handoff alerts — backend auto-fires
        // handoff when this toggle is ON AND AI Conversation is enabled).
        if (s.reEngagementAlertEnabled !== undefined) setReEngagementAlertOn(s.reEngagementAlertEnabled);
        if (s.reEngagementTemplate) setReEngagementTemplate(s.reEngagementTemplate);
        if (s.handoffAlertTemplate) setHandoffAlertTemplate(s.handoffAlertTemplate);
      }
    }).catch(() => {}).finally(() => {
      // Mark hydration complete so auto-save can run for subsequent state changes.
      // Wait one tick so the setState calls above flush before the auto-save effect
      // observes them — otherwise the auto-save would race the bootstrap flag.
      Promise.resolve().then(() => {
        fuBootstrappedFor.current = selectedAccountId;
      });
    });
  }, [selectedAccountId]);

  // Compute cross-account mixed state for the three big toggles. Runs whenever
  // the account list changes or All-Accounts mode flips on. Reset to all-false
  // when in single-account mode so the visual never lies about the selection.
  useEffect(() => {
    if (!allAccountsMode || accounts.length < 2) {
      setMixedToggles({ whenLeadArrives: false, followUps: false, aiConversation: false });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [rulesRes, ...fuResults] = await Promise.all([
          automationApi.getRules().catch(() => ({ rules: [] as AutomationRule[] })),
          ...accounts.map(a => followUpApi.getSettings(a.id).catch(() => ({ settings: null as any }))),
        ]);
        if (cancelled) return;

        const arrivesByAccount = accounts.map(a =>
          (rulesRes.rules || []).some(r => r.savedAccountId === a.id && r.triggerType === 'new_lead' && r.enabled)
        );
        const fuByAccount = fuResults.map(res => {
          const mode = (res?.settings as any)?.followUpMode;
          return mode != null && mode !== 'off';
        });
        const aiByAccount = fuResults.map(res => Boolean((res?.settings as any)?.aiConversationEnabled));

        const isMixed = (vals: boolean[]) => vals.length > 1 && new Set(vals).size > 1;

        setMixedToggles({
          whenLeadArrives: isMixed(arrivesByAccount),
          followUps: isMixed(fuByAccount),
          aiConversation: isMixed(aiByAccount),
        });
      } catch {
        // non-fatal; leave previous state
      }
    })();
    return () => { cancelled = true; };
  }, [allAccountsMode, accounts]);

  // Debounced auto-save: any change to the follow-up / AI Conversation /
  // re-engagement state below persists ~600ms after the user stops typing or
  // toggling. Replaces the old Save Settings button. Skips firing on initial
  // hydration via fuBootstrappedFor — see ref above.
  // Specific actions (chip clicks, ServiceCard toggles, availability buttons)
  // still call quickSaveSettings/saveAvailabilityNow directly for instant
  // feedback + the apply-to-all fan-out, but for everything else this effect
  // is the only persistence path.
  useEffect(() => {
    if (!selectedAccountId) return;
    if (fuBootstrappedFor.current !== selectedAccountId) return;
    const t = setTimeout(() => {
      const payload = {
        // Follow-ups
        mode: fuMode,
        replyType: fuReplyType,
        steps: fuSmartSteps.map((s, i) => ({
          ...s,
          message: fuReplyType === 'ai'
            ? ''
            : (s.message || SMART_DEFAULTS[i]?.message || `Hi {{lead.name}}, just following up on your request. Let me know if you'd still like to move forward.`),
        })),
        availability: fuAvailability,
        activeHoursStart: fuAvailability === 'active_hours' ? fuStart : null,
        activeHoursEnd: fuAvailability === 'active_hours' ? fuEnd : null,
        timezone: fuTz,
        platform: accounts.find(a => a.id === selectedAccountId)?.platform || 'yelp',
        strategyMode: 'auto',
        scenarios: { hybrid: true, price: true, qualify: true, convert: true, phone: true },
        stopOnReply: fuStopOnReply,
        stopOnOptOut: fuStopOnOptOut,
        stopOnBooked: fuStopOnBooked,
        urgentCapability: fuUrgentCapability,
        followUpStrategy: fuStrategy,
        followUpStrategyPrompt: fuStrategy !== 'auto' && fuStrategyPrompt ? fuStrategyPrompt : null,
        priceQuoteMode,
        // includeHistorical / applyToExisting are now owned by Settings → Import Negotiations.
        fuExtraWindows: fuExtraWindows.length > 0 ? fuExtraWindows : undefined,
        fuReEnrollOnSilence,
        fuReEnrollDelay,
        fuQuietHoursEnabled,
        fuQuietHoursStart,
        fuQuietHoursEnd,
        // AI Conversation rules
        // (aiConversationEnabled intentionally omitted — see note below)
        aiStopOnOptOut,
        aiStopOnBooked,
        aiStopOnPriceAgreed,
        // Human Takeover trigger toggles — per-account, default true.
        handoffTriggerAgreed,
        handoffTriggerWantsLiveContact,
        handoffTriggerProvidedPhone,
        handoffTriggerProvidedSquareFootage,
        handoffTriggerQualificationComplete,
        aiDeferralCheckIn,
        aiDeferralDelay,
        aiDeferralMessage,
        aiHiredCompetitorReengage: aiHiredReengage,
        aiHiredCompetitorDelay: aiHiredDelay,
        aiHiredCompetitorMessage: aiHiredMessage,
        // Re-engagement alerts — also gates Handoff alerts (no separate UI switch).
        reEngagementAlertEnabled: reEngagementAlertOn,
        reEngagementTemplate,
        handoffAlertTemplate,
        // NOTE: aiConversationEnabled is intentionally NOT in this payload.
        // The toggle handler is the sole writer of that field — including
        // it here re-introduces a race: a toggle save may land first, then
        // the debounced auto-save fires with whatever React state had at
        // the time the effect was scheduled (often the pre-toggle value)
        // and silently overwrites the DB back to the old value. Keeping
        // it out makes the toggle authoritative.
      };
      followUpApi.saveSettings(selectedAccountId, payload as any).catch((err: any) => {
        setError(err?.response?.data?.message || err?.message || 'Failed to save');
      });
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedAccountId,
    fuMode, fuReplyType, fuSmartSteps,
    fuAvailability, fuStart, fuEnd, fuTz,
    fuStopOnReply, fuStopOnOptOut, fuStopOnBooked, fuUrgentCapability,
    fuStrategy, fuStrategyPrompt, priceQuoteMode,
    fuExtraWindows,
    fuReEnrollOnSilence, fuReEnrollDelay,
    fuQuietHoursEnabled, fuQuietHoursStart, fuQuietHoursEnd,
    // aiConversationOn intentionally omitted — see note in payload.
    aiStopOnOptOut, aiStopOnBooked, aiStopOnPriceAgreed,
    handoffTriggerAgreed, handoffTriggerWantsLiveContact, handoffTriggerProvidedPhone,
    handoffTriggerProvidedSquareFootage, handoffTriggerQualificationComplete,
    aiDeferralCheckIn, aiDeferralDelay, aiDeferralMessage,
    aiHiredReengage, aiHiredDelay, aiHiredMessage,
    reEngagementAlertOn, reEngagementTemplate, handoffAlertTemplate,
  ]);

  // Debounced auto-save for Lead Alerts. Fires when alertDirty flips true.
  // The save function updates the snapshot which clears dirty — no loop.
  useEffect(() => {
    if (!alertDirty) return;
    const t = setTimeout(() => { saveAlertSettings(); }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertDirty, alertToPhone]);

  // Debounced auto-save for Customer Texting (Instant Text).
  useEffect(() => {
    if (!ctDirty) return;
    const t = setTimeout(() => { saveCtSettings(); }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctDirty, ctAutoReplyTemplate]);

  // Debounced auto-save for Call Connect (Instant Call).
  useEffect(() => {
    if (!ccDirty) return;
    const t = setTimeout(() => { saveCcSettings(); }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ccDirty, ccMode, ccAgentPhone, ccBotNumber, ccAgentWhisperMessage, ccLeadGreetingMessage, ccVoicemailMessage, ccCallForwardingNumber]);

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

      const [automationRes, notifRes, templatesRes, promptsRes, poolRes, ccRes, ctRes, notifSettingsRes, tenantPhonesRes] = await Promise.all([
        automationApi.getRulesForAccount(accountId).catch(() => ({ rules: [] as AutomationRule[] })),
        notificationsApi.getRules(accountId).catch(() => ({ rules: [] as NotificationRule[] })),
        templatesApi.getTemplates('message').catch(() => ({ templates: [] as MessageTemplate[] })),
        templatesApi.getTemplates('prompt').catch(() => ({ templates: [] as MessageTemplate[] })),
        Promise.resolve({ phoneNumbers: [] }),
        callConnectApi.getSettings(accountId).catch(() => ({ settings: null })),
        notificationsApi.getCustomerTextingSettings(accountId).catch(() => null),
        notificationsApi.getSettings(accountId).catch(() => null),
        notificationsApi.listTenantPhones().catch((): { success: boolean; data: TenantPhoneNumber[] } => ({ success: false, data: [] })),
      ]);

      const ccs = ccRes.settings;
      const visibleTenantPhones = tenantPhonesRes.success
        ? tenantPhonesRes.data
            .filter(tp => tp.status === 'ACTIVE' || tp.status === 'GRACE_PERIOD')
            .sort((a, b) => {
              if (a.status === b.status) return 0;
              return a.status === 'ACTIVE' ? -1 : 1;
            })
        : [];
      setTenantPhones(visibleTenantPhones);
      // Bot number defaults to first ACTIVE dedicated (tenant) phone — never pool, never grace period
      const defaultBotNumber = visibleTenantPhones.find(tp => tp.status === 'ACTIVE')?.phoneNumber || '';
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
      const loadedFirstRule = allAutoReplies.find((r: AutomationRule) => r.delayMinutes === 0 || !r.delayMinutes) || null;
      if (loadedFirstRule) {
        setAutoReplyUseAi(loadedFirstRule.useAi ?? false);
        setReplyMode(loadedFirstRule.replyMode ?? (loadedFirstRule.useAi ? 'auto' : 'custom'));
        setAutoReplyAiPrompt(loadedFirstRule.aiSystemPrompt ?? '');
        setAutoReplyPromptTemplateId(loadedFirstRule.promptTemplateId || '');
      } else {
        // No rules for this account — reset to defaults so auto-select can run
        setAutoReplyUseAi(false);
        setReplyMode('custom');
        setAutoReplyAiPrompt('');
        setAutoReplyPromptTemplateId('');
      }

      // Find lead alert rules (non-customer-facing)
      const leadAlert = notifRes.rules.find(
        (r: NotificationRule) => r.triggerType === 'new_lead' && !r.sendToCustomer
      ) || null;

      setLeadAlertRule(leadAlert);

      // Agent phone: per-business override → CC saved value → destination phone
      const currentAccount = accounts.find(a => a.id === accountId);
      const agentPhoneDefault = currentAccount?.agentPhoneOverride || ccs?.agentPhoneE164 || notifSettingsRes?.settings?.destinationPhone || '';
      setCcAgentPhone(agentPhoneDefault);
      // Forward calls to: same as agent phone (destinationPhone)
      setCcCallForwardingNumber(agentPhoneDefault);
      // No more phone number dropdowns — dedicated number is auto-resolved
      setCtOwnPhoneNumbers([]);

      // Seed CC default templates for every user on first page visit
      const DEFAULT_CC_WHISPER = 'You have a new lead for {category}. Customer name: {customerName}. Press any key to connect with the customer.';
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
      setPromptTemplates(promptsRes.templates);
      setPromptTemplatesLoaded(true);

      // Auto-select Hybrid (default) prompt if nothing selected yet
      // Use loadedFirstRule (local) instead of state to avoid stale closure
      const currentPromptId = loadedFirstRule?.promptTemplateId || '';
      if (!currentPromptId && promptsRes.templates.length > 0) {
        const hybrid = promptsRes.templates.find((p: any) => p.isDefault) || promptsRes.templates[0];
        setAutoReplyPromptTemplateId(hybrid.id);
        setAutoReplyAiPrompt(hybrid.content);
      }

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

      // Legacy deep-link — buy flow now lives in Settings
      if (searchParams.get('buyNumber') === '1') {
        navigate('/settings');
      }

      // Persist to module-level cache so returning to this page is instant
      _svcCache.set(accountId, {
        autoReplyRules: allAutoReplies, leadAlertRule: leadAlert, templates: allTemplates,
        poolPhones: poolRes.phoneNumbers, tenantPhones: visibleTenantPhones, ctOwnPhoneNumbers: [],
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

  // Persist a small partial settings payload to the selected account (and
  // optionally fan out to other accounts on the same platform). Used by
  // save-on-toggle handlers so a user's flip is durable even if they navigate
  // away without clicking a section's "Save" button. Detailed sub-settings
  // still go through the section's full Save button.
  async function quickSaveSettings(payload: Record<string, any>, opts?: { successMsg?: string; fanout?: boolean }): Promise<void> {
    if (!selectedAccountId) return;
    try {
      await followUpApi.saveSettings(selectedAccountId, payload as any);
      let count = 1;
      if (opts?.fanout) {
        const others = fanoutOthers();
        if (others.length > 0) {
          await Promise.allSettled(others.map(id => followUpApi.saveSettings(id, payload as any)));
          count += others.length;
        }
      }
      const suffix = count > 1 ? ` to ${count} accounts` : '';
      if (opts?.successMsg) showSuccess(`${opts.successMsg}${suffix}`);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Failed to save');
    }
  }

  // Save the availability mode together with the active-hours start/end,
  // timezone, and extra time windows. Backend stores `availability` in
  // followUpSettingsJson; activeHoursStart/End/timezone are SavedAccount
  // columns shared by AI Conversation and Follow-ups (single source of truth).
  // Pass `next` to override the mode; pass overrides for any field whose
  // React state hasn't flushed yet (e.g. the click that flipped the mode).
  function saveAvailabilityNow(
    next: 'always' | 'active_hours' = fuAvailability,
    overrides?: { start?: string; end?: string; tz?: string; extraWindows?: { start: string; end: string }[] },
  ) {
    const payload: Record<string, any> = { availability: next };
    if (next === 'active_hours') {
      payload.activeHoursStart = overrides?.start ?? fuStart;
      payload.activeHoursEnd = overrides?.end ?? fuEnd;
      payload.timezone = overrides?.tz ?? fuTz;
      const wins = overrides?.extraWindows ?? fuExtraWindows;
      payload.fuExtraWindows = wins.length > 0 ? wins : undefined;
    } else {
      payload.activeHoursStart = null;
      payload.activeHoursEnd = null;
    }
    return quickSaveSettings(payload, {
      successMsg: next === 'always' ? 'Availability: Always (24/7)' : 'Active hours saved',
    });
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
        // First time: create rule in AI or template mode based on current selection
        if (autoReplyUseAi) {
          const { rule } = await automationApi.createRule({
            savedAccountId: selectedAccountId,
            name: 'Auto Reply - Immediate',
            triggerType: 'new_lead',
            useAi: true,
            promptTemplateId: autoReplyPromptTemplateId || undefined,
            aiSystemPrompt: autoReplyAiPrompt || undefined,
            delayMinutes: 0,
            enabled: true,
          });
          setAutoReplyRules([rule]);
        } else {
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
      }
      // Fan out to other platform accounts when "Apply to all" is checked
      const others = fanoutOthers();
      if (others.length > 0) {
        await Promise.allSettled(others.map(async (id) => {
          const { rules } = await automationApi.getRulesForAccount(id);
          const existing = rules.filter(r => r.triggerType === 'new_lead');
          if (existing.length > 0) {
            await Promise.all(existing.map(r => automationApi.updateRule(r.id, { enabled })));
          } else if (enabled) {
            if (autoReplyUseAi) {
              await automationApi.createRule({
                savedAccountId: id,
                name: 'Auto Reply - Immediate',
                triggerType: 'new_lead',
                useAi: true,
                promptTemplateId: autoReplyPromptTemplateId || undefined,
                aiSystemPrompt: autoReplyAiPrompt || undefined,
                delayMinutes: 0,
                enabled: true,
              } as any);
            } else {
              const tplId = templates.find(t => t.name.includes('Auto Reply'))?.id;
              if (tplId) {
                await automationApi.createRule({
                  savedAccountId: id,
                  name: 'Auto Reply - Immediate',
                  triggerType: 'new_lead',
                  templateId: tplId,
                  delayMinutes: 0,
                  enabled: true,
                } as any);
              }
            }
          }
        }));
      }
    } catch (err: any) {
      console.error('[toggleAutoReply] FAILED:', err.response?.data || err.message);
      // Rollback on error
      setAutoReplyRules(prevRules);
      setError(err.response?.data?.message || err.message || 'Failed to toggle Instant Reply');
    } finally {
      setSaving(false);
    }
  }

  async function toggleLeadAlerts(enabled: boolean) {
    if (enabled && tenantPhones.length === 0) {
      setError('Set up a LeadBridge Number in Settings first.');
      navigate('/settings');
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
        // Platform-specific default template — Thumbtack and Yelp have different data structures
        const accountPlatform = accounts.find(a => a.id === selectedAccountId)?.platform || 'yelp';

        const THUMBTACK_ALERT_TEMPLATE =
          'New lead for {account.name}\n' +
          '{lead.name}, Price {lead.price}\n' +
          'Location: {lead.location}, {lead.zip}\n' +
          'Service: {lead.service} {lead.bedrooms} bed / {lead.bathrooms} bath\n' +
          'Frequency: {lead.frequency}\n' +
          'Description: {lead.serviceDescription}\n' +
          'Add-ons: {lead.addons}\n' +
          'Pets: {lead.pets}\n' +
          'Message: {lead.message}\n' +
          'Phone: {lead.phone}';

        const YELP_ALERT_TEMPLATE =
          'New Yelp lead for {account.name}\n' +
          '{lead.name}\n' +
          'Service: {lead.service}\n' +
          'Location: {lead.location}, {lead.zip}\n' +
          'Availability: {lead.availability}\n' +
          'Message: {lead.message}\n' +
          'Phone: {lead.phone}\n' +
          'Email: {lead.email}';

        const DEFAULT_ALERT_TEMPLATE = accountPlatform === 'yelp' ? YELP_ALERT_TEMPLATE : THUMBTACK_ALERT_TEMPLATE;
        const templateName = accountPlatform === 'yelp' ? 'Lead Alert - Yelp' : 'Lead Alert - Thumbtack';

        // Find existing template by platform-specific name
        let templateId = templates.find(t => t.name === templateName)?.id;
        if (!templateId) {
          const { template } = await templatesApi.createTemplate(
            templateName,
            DEFAULT_ALERT_TEMPLATE,
          );
          templateId = template.id;
          setTemplates(prev => [template, ...prev]);
        }

        const { rule } = await notificationsApi.createRule(selectedAccountId, {
          name: templateName,
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
      // Fan out to other platform accounts when "Apply to all" is checked
      const others = fanoutOthers();
      if (others.length > 0) {
        const THUMBTACK_ALERT_TEMPLATE_FANOUT =
          'New lead for {account.name}\n' +
          '{lead.name}, Price {lead.price}\n' +
          'Location: {lead.location}, {lead.zip}\n' +
          'Service: {lead.service} {lead.bedrooms} bed / {lead.bathrooms} bath\n' +
          'Frequency: {lead.frequency}\n' +
          'Description: {lead.serviceDescription}\n' +
          'Add-ons: {lead.addons}\n' +
          'Pets: {lead.pets}\n' +
          'Message: {lead.message}\n' +
          'Phone: {lead.phone}';
        const YELP_ALERT_TEMPLATE_FANOUT =
          'New Yelp lead for {account.name}\n' +
          '{lead.name}\n' +
          'Service: {lead.service}\n' +
          'Location: {lead.location}, {lead.zip}\n' +
          'Availability: {lead.availability}\n' +
          'Message: {lead.message}\n' +
          'Phone: {lead.phone}\n' +
          'Email: {lead.email}';
        await Promise.allSettled(others.map(async (id) => {
          const { rules } = await notificationsApi.getRules(id);
          const existing = rules.find(r => r.triggerType === 'new_lead');
          if (existing) {
            await notificationsApi.updateRule(id, existing.id, { enabled });
          } else if (enabled) {
            const accPlatform = accounts.find(a => a.id === id)?.platform || 'yelp';
            const tpl = accPlatform === 'yelp' ? YELP_ALERT_TEMPLATE_FANOUT : THUMBTACK_ALERT_TEMPLATE_FANOUT;
            const tplName = accPlatform === 'yelp' ? 'Lead Alert - Yelp' : 'Lead Alert - Thumbtack';
            await notificationsApi.createRule(id, {
              name: tplName,
              triggerType: 'new_lead',
              toPhone: alertToPhone,
              sendToCustomer: false,
              template: tpl,
              enabled: true,
            } as any);
          }
        }));
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
      setError('Set up a LeadBridge Number in Settings first.');
      navigate('/settings');
      return;
    }
    setCcEnabled(enabled); // optimistic
    setCcSaving(true);
    try {
      const { settings } = await callConnectApi.saveSettings(selectedAccountId, { enabled });
      setCcEnabled(settings.enabled);
      const others = fanoutOthers();
      if (others.length > 0) {
        await Promise.allSettled(others.map(id => callConnectApi.saveSettings(id, { enabled })));
      }
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
      const payload = {
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
        botNumberE164: ccBotNumber || undefined,
      };
      await callConnectApi.saveSettings(selectedAccountId, payload);
      const others = fanoutOthers();
      if (others.length > 0) {
        await Promise.allSettled(others.map(id => callConnectApi.saveSettings(id, payload)));
        showSuccess(`Instant Call settings saved to ${others.length + 1} accounts`);
      } else {
        showSuccess('Instant Call settings saved');
      }
      setCcSavedSnapshot({
        mode: ccMode,
        agentPhone: ccAgentPhone,
        botNumber: ccBotNumber,
        agentWhisperMessage: ccAgentWhisperMessage,
        leadGreetingMessage: ccLeadGreetingMessage,
        voicemailMessage: ccVoicemailMessage,
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
      setError('Set up a LeadBridge Number in Settings first.');
      navigate('/settings');
      return;
    }
    setCtEnabled(enabled); // optimistic
    setCtSaving(true);
    try {
      const payload = { enabled, autoReplyTemplate: ctAutoReplyTemplate };
      await notificationsApi.saveCustomerTextingSettings(selectedAccountId, payload);
      const others = fanoutOthers();
      if (others.length > 0) {
        await Promise.allSettled(others.map(id => notificationsApi.saveCustomerTextingSettings(id, payload)));
      }
    } catch (err: any) {
      console.error('Failed to toggle Instant Text:', err.response?.data || err.message);
      setCtEnabled(!enabled); // rollback
      setError(err.response?.data?.message || err.message || 'Failed to toggle Instant Text');
    } finally {
      setCtSaving(false);
    }
  }

  async function saveCtSettings() {
    if (!selectedAccountId) return;
    setCtSaving(true);
    try {
      const payload = { enabled: ctEnabled, autoReplyTemplate: ctAutoReplyTemplate };
      await notificationsApi.saveCustomerTextingSettings(selectedAccountId, payload);
      const others = fanoutOthers();
      if (others.length > 0) {
        await Promise.allSettled(others.map(id => notificationsApi.saveCustomerTextingSettings(id, payload)));
        showSuccess(`Instant Text settings saved to ${others.length + 1} accounts`);
      } else {
        showSuccess('Instant Text settings saved');
      }
      setCtSavedSnapshot({ autoReplyTemplate: ctAutoReplyTemplate });
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to save Instant Text settings');
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
    // Save per-business agent phone override
    promises.push(
      thumbtackApi.updateSavedAccount(selectedAccountId, { agentPhoneOverride: finalPhone })
        .catch(() => { setError('Failed to save business phone override'); })
    );
    // Fan out to other accounts of the same platform when "Apply to all" is checked
    const others = fanoutOthers();
    for (const id of others) {
      promises.push(callConnectApi.saveSettings(id, { agentPhoneE164: finalPhone }).catch(() => {}));
      promises.push(thumbtackApi.updateSavedAccount(id, { agentPhoneOverride: finalPhone }).catch(() => {}));
    }
    await Promise.all(promises);
    savingAgentPhoneRef.current = false;
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

  async function changeRuleReplyMode(ruleId: string, mode: 'custom' | 'price' | 'auto', aiSystemPrompt?: string) {
    if (!ruleId || ruleId === '_pending') return;
    const useAi = mode !== 'custom';
    const prevMode = replyMode;
    const prevUseAi = autoReplyUseAi;
    // Optimistic update
    setReplyMode(mode);
    setAutoReplyUseAi(useAi);
    setAutoReplyRules(prev => prev.map(r => r.id === ruleId ? { ...r, useAi, replyMode: mode, aiSystemPrompt: aiSystemPrompt ?? r.aiSystemPrompt ?? null } : r));
    try {
      const payload: any = {
        useAi,
        replyMode: mode,
        aiSystemPrompt: mode === 'auto' ? (aiSystemPrompt ?? '') : undefined,
        templateId: mode === 'custom' ? (firstReplyRule?.templateId ?? undefined) : undefined,
      };
      const { rule } = await automationApi.updateRule(ruleId, payload);
      setAutoReplyRules(prev => prev.map(r => r.id === ruleId ? rule : r));
    } catch (err: any) {
      // Revert on failure
      setReplyMode(prevMode);
      setAutoReplyUseAi(prevUseAi);
      setAutoReplyRules(prev => prev.map(r => r.id === ruleId ? { ...r, useAi: prevUseAi, replyMode: prevMode } : r));
      setError(err.message || 'Failed to update reply mode');
    }
  }

  // Back-compat shim — existing call sites still pass (ruleId, useAi, prompt)
  async function changeRuleAiMode(ruleId: string, useAi: boolean, aiSystemPrompt?: string) {
    return changeRuleReplyMode(ruleId, useAi ? 'auto' : 'custom', aiSystemPrompt);
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
      const others = fanoutOthers();
      if (others.length > 0) {
        // Fetch each target's existing alert rule and update its toPhone.
        // Skip accounts without an alert rule — they need to be enabled first.
        await Promise.allSettled(others.map(async (id) => {
          const { rules } = await notificationsApi.getRules(id);
          const existing = rules.find(r => r.triggerType === 'new_lead');
          if (existing) {
            await notificationsApi.updateRule(id, existing.id, { toPhone: alertToPhone });
          }
        }));
        showSuccess(`Lead Alert settings saved to ${others.length + 1} accounts`);
      } else {
        showSuccess('Lead Alert settings saved');
      }
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
      const isPromptType = templateEditor.type === 'autoReplyPrompt' || (typeof templateEditor.type === 'string' && templateEditor.type.startsWith('fu-strategy-'));
      const { template } = await templatesApi.createTemplate(name, content || 'Hi {{lead.name}}, ', undefined, isPromptType ? 'prompt' : undefined);
      setTemplates(prev => [template, ...prev]);
      if (templateEditor.type === 'autoReplyPrompt') {
        setPromptTemplates(prev => [template, ...prev]);
        setAutoReplyPromptTemplateId(template.id);
        setAutoReplyAiPrompt(template.content);
        if (firstReplyRule) await changeRuleAiMode(firstReplyRule.id, true, template.content);
      } else if (templateEditor.type === 'autoReply') {
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
      } else if (typeof templateEditor.type === 'string' && templateEditor.type.startsWith('fu-smart-')) {
        const idx = parseInt(templateEditor.type.replace('fu-smart-', ''));
        setFuSmartSteps(prev => prev.map((s, i) => i === idx ? { ...s, message: template.content } : s));
      } else if (typeof templateEditor.type === 'string' && (templateEditor.type.startsWith('fu-custom-') || templateEditor.type.startsWith('fu-step-'))) {
        const idx = parseInt(templateEditor.type.replace(/fu-(custom|step)-/, ''));
        setFuSmartSteps(prev => prev.map((s, i) => i === idx ? { ...s, message: template.content } : s));
      } else if (typeof templateEditor.type === 'string' && templateEditor.type.startsWith('fu-strategy-')) {
        setFuStrategyPrompt(template.content);
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
      if (type === 'autoReplyPrompt') {
        setAutoReplyAiPrompt(template.content);
        if (firstReplyRule) await changeRuleAiMode(firstReplyRule.id, true, template.content);
      } else if (type === 'cc-whisper') setCcAgentWhisperMessage(template.content);
      else if (type === 'cc-greeting') setCcLeadGreetingMessage(template.content);
      else if (type === 'cc-voicemail') setCcVoicemailMessage(template.content);
      else if (type === 'ct') setCtAutoReplyTemplate(template.content);
      else if (typeof type === 'string' && type.startsWith('fu-smart-')) {
        const idx = parseInt(type.replace('fu-smart-', ''));
        setFuSmartSteps(prev => prev.map((s, i) => i === idx ? { ...s, message: template.content } : s));
      } else if (typeof type === 'string' && (type.startsWith('fu-custom-') || type.startsWith('fu-step-'))) {
        const idx = parseInt(type.replace(/fu-(custom|step)-/, ''));
        setFuSmartSteps(prev => prev.map((s, i) => i === idx ? { ...s, message: template.content } : s));
      } else if (typeof type === 'string' && type.startsWith('fu-strategy-')) {
        setFuStrategyPrompt(template.content);
      }
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
      const isPrompt = templateEditor.type === 'autoReplyPrompt' || (typeof templateEditor.type === 'string' && templateEditor.type.startsWith('fu-strategy-'));
      const { template } = await templatesApi.createTemplate(name, content, undefined, isPrompt ? 'prompt' : undefined);
      setTemplates(prev => [template, ...prev]);
      if (templateEditor.type === 'autoReplyPrompt') {
        setPromptTemplates(prev => [template, ...prev]);
        setAutoReplyPromptTemplateId(template.id);
        setAutoReplyAiPrompt(template.content);
        if (firstReplyRule) await changeRuleAiMode(firstReplyRule.id, true, template.content);
      } else if (templateEditor.type === 'autoReply') {
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

  const selectedAccountIsYelp = accounts.find(a => a.id === selectedAccountId)?.platform === 'yelp';

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

  // Communication & Alerts moved to /settings/communication. Handler and
  // state below are kept as dead code so reviving an inline editor is a
  // one-liner. void refs silence noUnusedLocals.
  void deletingAlert; void confirmDeleteAlert; void toggleLeadAlerts; void deleteLeadAlertRule;
  void testStatus; void ccTesting; void editingAgentPhone; void ctTestStatus;
  void commsDirty; void agentPhoneSaveStatus;
  void saveAgentPhone; void handleTestCall; void sendTestAlert; void sendCtTest;

  return (
    <div style={{ padding: '24px 28px', maxWidth: 980, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 22 }}>
      {accounts.length === 0 && <NoAccountsOverlay />}
      {/* Floating Notifications */}
      {error && (
        <div
          className="fixed top-20 left-1/2 -translate-x-1/2 z-50 max-w-md w-full mx-4 animate-in slide-in-from-top-2"
          style={{
            background: 'oklch(0.96 0.04 27)',
            border: '1px solid oklch(0.88 0.08 27)',
            borderRadius: 'var(--lb-radius-lg)',
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: '#7a1a14',
            fontSize: 13,
            fontWeight: 500,
            boxShadow: 'var(--lb-shadow-md)',
          }}
        >
          <AlertCircle size={16} className="shrink-0" />
          <span className="flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            style={{ background: 'transparent', border: 0, cursor: 'pointer', color: 'var(--lb-danger)', padding: 2 }}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {successMessage && (
        <div
          className="fixed top-20 left-1/2 -translate-x-1/2 z-50 max-w-md w-full mx-4 animate-in slide-in-from-top-2"
          style={{
            background: 'oklch(0.95 0.04 150)',
            border: '1px solid oklch(0.85 0.08 150)',
            borderRadius: 'var(--lb-radius-lg)',
            padding: '12px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: '#0c4a2b',
            fontSize: 13,
            fontWeight: 500,
            boxShadow: 'var(--lb-shadow-md)',
          }}
        >
          <CheckCircle size={16} className="shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      {/* Account Selector */}
      <div
        style={{
          background: 'var(--lb-surface)',
          border: '1px solid var(--lb-line)',
          borderRadius: 'var(--lb-radius-lg)',
          padding: '14px 18px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div
            style={{
              fontSize: 10,
              fontFamily: 'var(--lb-font-mono)',
              fontWeight: 700,
              color: 'var(--lb-accent)',
              textTransform: 'uppercase',
              letterSpacing: 0.1,
            }}
          >
            Defaults
          </div>
          <h2 style={{ margin: '3px 0 2px', fontSize: 16, fontWeight: 600, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
            Configure automation
          </h2>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--lb-ink-5)' }}>
            The big switches. Turn these on and Leadbridge handles new leads for you.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
          {/* Per-platform 'All Yelp' / 'All Thumbtack' checkboxes removed —
              fan-out is now driven solely by the account dropdown:
              pick 'All accounts' to save everywhere, or pick a single account
              to save only there. */}
          <div style={{ position: 'relative', minWidth: 240, flexShrink: 0 }}>
            <select
              value={allAccountsMode ? ALL_ACCOUNTS_SENTINEL : selectedAccountId}
              onChange={e => {
                if (e.target.value === ALL_ACCOUNTS_SENTINEL) {
                  setAllAccountsMode(true);
                  // Keep selectedAccountId as-is so the form continues to render data.
                } else {
                  setAllAccountsMode(false);
                  setSelectedAccountId(e.target.value);
                }
              }}
              style={{
                width: '100%',
                padding: '8px 36px 8px 12px',
                fontSize: 13,
                fontFamily: 'inherit',
                fontWeight: allAccountsMode ? 700 : 500,
                background: allAccountsMode ? 'oklch(0.95 0.04 270)' : 'var(--lb-ink-10)',
                border: allAccountsMode ? '1px solid oklch(0.7 0.15 270)' : '1px solid var(--lb-line)',
                color: allAccountsMode ? 'oklch(0.35 0.18 270)' : 'var(--lb-ink-1)',
                borderRadius: 'var(--lb-radius)',
                outline: 'none',
                appearance: 'none',
                cursor: 'pointer',
              }}
            >
              {accounts.length > 1 && (
                <option value={ALL_ACCOUNTS_SENTINEL}>{'\uD83C\uDF10 All accounts (' + accounts.length + ')'}</option>
              )}
              {accounts.map(acc => (
                <option key={acc.id} value={acc.id}>{acc.platform === 'yelp' ? '\uD83D\uDD34 ' : '\uD83D\uDD35 '}{acc.businessName}</option>
              ))}
            </select>
            <div style={{ position: 'absolute', top: 0, right: 10, bottom: 0, display: 'flex', alignItems: 'center', pointerEvents: 'none', color: 'var(--lb-ink-5)' }}>
              <ChevronDown size={14} />
            </div>
          </div>
        </div>
      </div>

      {/* Communication & Alerts summary — full editor lives at /settings/communication.
          The detailed phone editor + test buttons + alert-template editors were
          moved off the Automation page so this surface stays focused on lead
          behavior. */}
      {!loading && (
        <div
          style={{
            background: 'var(--lb-surface)',
            border: '1px solid var(--lb-line)',
            borderRadius: 'var(--lb-radius-lg)',
            padding: '16px 18px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: 6,
                background: 'var(--lb-accent-tint)',
                color: 'var(--lb-accent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Phone size={15} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-1)' }}>Communication & Alerts</h2>
              <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--lb-ink-5)' }}>Manage phone numbers and team notifications.</p>
            </div>
            <Link to="/settings#communication-alerts" className="text-xs font-semibold text-blue-600 hover:underline shrink-0">
              Manage in Settings →
            </Link>
          </div>

          {(() => {
            const accountPhone = tenantPhones.find(p => p.savedAccountId === selectedAccountId && p.status === 'ACTIVE')
              || tenantPhones.find(p => !p.savedAccountId && p.status === 'ACTIVE')
              || tenantPhones.find(p => p.status === 'ACTIVE');
            const SummaryRow = ({ label, value, tier, muted = false }: { label: string; value: React.ReactNode; tier: 'respond' | 'engage' | 'convert'; muted?: boolean }) => (
              <div className="flex items-center justify-between gap-3 py-1.5">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[11px] font-semibold text-slate-500 truncate">{label}</span>
                  <TierBadge tier={tier} />
                </div>
                <span className={`text-xs font-mono shrink-0 ${muted ? 'text-slate-400' : 'text-slate-800'}`}>{value}</span>
              </div>
            );
            return (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-0">
                <SummaryRow label="Business Phone" tier="respond" value={ccAgentPhone || 'Not set'} muted={!ccAgentPhone} />
                <SummaryRow label="LeadBridge Number" tier="engage" value={accountPhone?.phoneNumber || 'Not assigned'} muted={!accountPhone} />
                <SummaryRow label="New Lead Alerts" tier="respond" value={leadAlertRule?.enabled ? 'Enabled' : 'Disabled'} muted={!leadAlertRule?.enabled} />
                <SummaryRow label="Reply Alerts" tier="engage" value={reEngagementAlertOn ? 'Enabled' : 'Disabled'} muted={!reEngagementAlertOn} />
                <SummaryRow label="AI Takeover Alerts" tier="convert" value={aiConversationOn && reEngagementAlertOn ? 'Enabled' : 'Disabled'} muted={!(aiConversationOn && reEngagementAlertOn)} />
              </div>
            );
          })()}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 size={24} className="animate-spin text-blue-600" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6">
          {/* Alerts & Notifications card moved to /settings/communication. Summary lives at top of page. */}

          {/* AI Strategy card moved into AI Conversation below. The
              [data-tour="ai-strategy-card"] anchor lives at its new location,
              so the small "Strategy: qualify" badges in Instant Reply and
              Follow-up Mode still scroll to it. */}

          {/* 1. Lead Notifications (combined Auto-Reply + Lead Alerts) */}
          {(() => {
            const noPhone = tenantPhones.length === 0;
            console.log('[Services Debug]', {
              selectedAccountId,
              expandedCard,
              noPhone,
              tenantPhonesCount: tenantPhones.length,
              autoReplyEnabled,
              autoReplyRulesCount: autoReplyRules.length,
              firstReplyRule: firstReplyRule ? { id: firstReplyRule.id, useAi: firstReplyRule.useAi } : null,
              autoReplyUseAi,
              loading,
            });
            // Lead-alert completeness moved with the alert UI to top-level
            // "Alerts & Notifications" card. The When-a-Lead-Arrives card now
            // only gates on Instant Reply state.
            return (
          <ServiceCard
            icon={<Bell className="w-7 h-7" />}
            title="When a Lead Arrives"
            description="Choose what happens immediately when a new lead comes in."
            enabled={autoReplyEnabled}
            mixed={allAccountsMode && mixedToggles.whenLeadArrives}
            onToggle={(on) => {
              if (on && noPhone) { setError('Set up a LeadBridge Number in Settings first.'); navigate('/settings'); return; }
              if (on) {
                if (!autoReplyEnabled) setAutoReplyRules(prev => prev.length ? prev.map(r => ({ ...r, enabled: true })) : [{ id: '_pending', enabled: true } as any]);
              } else {
                setAutoReplyRules(prev => prev.map(r => ({ ...r, enabled: false })));
              }
              if (!expandedCard || expandedCard !== 'notifications') setExpandedCard('notifications');
              if (on) {
                if (!autoReplyEnabled) toggleAutoReply(true);
              } else {
                if (autoReplyEnabled) toggleAutoReply(false);
              }
            }}
            expanded={expandedCard === 'notifications'}
            onExpand={() => toggleExpand('notifications')}
            setupRequired={noPhone}
            warningText={noPhone ? 'LeadBridge number required' : undefined}
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
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-bold text-slate-800">Instant Reply</h4>
                        <TierBadge tier="respond" />
                      </div>
                      <p className="text-xs text-slate-400">Send the first message automatically when a new lead arrives</p>
                    </div>
                  </div>
                  <label className="inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoReplyEnabled}
                      onChange={e => toggleAutoReply(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="relative w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-100 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
                  </label>
                </div>
                <div className="px-5 py-4 space-y-4">
                  {/* Reply Type selector — Custom Template vs AI. The legacy
                      'price' replyMode is treated as AI in the UI; users now
                      pick Price as their AI Strategy at the top of the page. */}
                  <div>
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Instant Reply Mode</label>
                    <p className="text-[10px] text-slate-400 mb-2">How the first reply is composed.</p>
                    <div className="grid grid-cols-2 gap-2">
                      {(() => {
                        const modes: Array<{ key: 'custom' | 'auto'; emoji: string; label: string; active: string; desc: string }> = [
                          { key: 'custom', emoji: '🟢', label: 'Custom Template', active: '#16a34a', desc: 'Send your saved template literally — no AI generation' },
                          { key: 'auto',   emoji: '🟣', label: 'AI', active: '#7c3aed', desc: 'AI generates the reply using your AI Strategy (top of page)' },
                        ];
                        const uiMode: 'custom' | 'auto' = replyMode === 'custom' ? 'custom' : 'auto';
                        return modes.map(m => {
                          const isActive = uiMode === m.key;
                          return (
                            <button
                              key={m.key}
                              title={m.desc}
                              onClick={() => { if (firstReplyRule) changeRuleReplyMode(firstReplyRule.id, m.key, m.key === 'auto' ? autoReplyAiPrompt : undefined); }}
                              className="py-2 px-3 rounded-xl text-xs font-semibold border-2 transition-all"
                              style={{
                                background: isActive ? m.active : '#f1f5f9',
                                color: isActive ? '#fff' : '#64748b',
                                borderColor: isActive ? m.active : '#e2e8f0',
                              }}
                            >
                              {m.emoji} {m.label}
                            </button>
                          );
                        });
                      })()}
                    </div>
                  </div>

                  <div className={!autoReplyEnabled ? 'opacity-40 pointer-events-none select-none' : ''}>
                  {firstReplyRule && (
                    <div className="space-y-4">
                      {replyMode === 'custom' ? (
                        /* Template selector */
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
                      ) : false && replyMode === 'price' ? (
                        /* Legacy 'price' content kept for now (gated off) — UI now treats price as AI mode and routes pricing setup through the unified AI Strategy panel. Kept for historical reference; safe to remove once we're confident no rules need the inline table here. */
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest block">Pricing Source</label>
                            <button
                              type="button"
                              onClick={() => { setPricingModalTab('edit'); setShowPricingModal(true); }}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white border border-slate-200 rounded-lg text-[11px] font-semibold text-slate-600 hover:text-blue-700 hover:border-blue-200 transition-colors"
                            >
                              <Pencil className="w-3 h-3" />
                              Edit pricing
                            </button>
                          </div>
                          <div className="bg-blue-50/60 border border-blue-100 rounded-xl p-4 text-sm text-slate-700 leading-relaxed">
                            <p className="mb-3 text-xs">
                              AI writes the first reply using your <span className="font-semibold text-blue-700">pricing table</span>. It matches the lead's bedrooms/bathrooms and quotes a price range based on these rates.
                            </p>
                            {pricingPreviewInherited && (
                              <div className="mb-3 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 text-[11px] text-amber-800">
                                <span className="font-semibold">Inherited pricing.</span> This account has no pricing of its own — the AI uses pricing from another of your accounts. Click <span className="font-semibold">Edit pricing</span> to customize for this account.
                              </div>
                            )}
                            {!pricingPreview && !pricingPreviewLoading && !pricingPreviewInherited && (
                              <div className="mb-3 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-[11px] text-slate-600">
                                <span className="font-semibold">Default pricing shown.</span> Click <button className="text-blue-600 font-semibold" onClick={() => { setPricingModalTab('edit'); setShowPricingModal(true); }}>Edit pricing</button> to customize rates for this account.
                              </div>
                            )}
                            {pricingPreviewLoading ? (
                              <div className="flex items-center gap-2 text-xs text-slate-400 py-3">
                                <Loader2 size={12} className="animate-spin" /> Loading pricing...
                              </div>
                            ) : (() => {
                              const p = pricingPreview || DEFAULT_CLEANING_PRICING;
                              const enabledTypes = (p.cleaningTypes || []).filter((t: any) => t.enabled);
                              const hasTable = p.priceTable?.length > 0 && enabledTypes.length > 0;
                              return (
                                <div className="space-y-3">
                                  {enabledTypes.length > 0 && (
                                    <div className="flex items-center flex-wrap gap-1.5">
                                      {enabledTypes.map((t: any) => (
                                        <span key={t.key} className="px-2 py-0.5 bg-white border border-blue-200 text-blue-700 rounded-md text-[10px] font-semibold">{t.label}</span>
                                      ))}
                                    </div>
                                  )}
                                  {hasTable && (
                                    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden max-h-64 overflow-y-auto">
                                      <table className="w-full text-xs">
                                        <thead className="bg-slate-50 sticky top-0">
                                          <tr className="text-slate-500">
                                            <th className="px-2 py-1.5 text-left font-semibold">Bed</th>
                                            <th className="px-2 py-1.5 text-left font-semibold">Bath</th>
                                            {enabledTypes.map((t: any) => (
                                              <th key={t.key} className="px-2 py-1.5 text-left font-semibold">{t.label}</th>
                                            ))}
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {p.priceTable.map((row: any, i: number) => (
                                            <tr key={i} className="border-t border-slate-100">
                                              <td className="px-2 py-1.5 text-slate-700">{row.bed}</td>
                                              <td className="px-2 py-1.5 text-slate-700">{row.bath}</td>
                                              {enabledTypes.map((t: any) => (
                                                <td key={t.key} className="px-2 py-1.5 text-slate-900 font-semibold">${row[t.key] || '—'}</td>
                                              ))}
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  )}
                                  {/* Quote range gap — how wide of a range the AI quotes around the table price */}
                                  {(() => {
                                    const range = p.priceRange || { minus: { type: '%', value: 10 }, plus: { type: '%', value: 10 } };
                                    const mVal = Number(range.minus?.value) || 0;
                                    const pVal = Number(range.plus?.value) || 0;
                                    const mType = range.minus?.type === '$' ? '$' : '%';
                                    const pType = range.plus?.type === '$' ? '$' : '%';
                                    const isExact = mVal === 0 && pVal === 0;
                                    return (
                                      <div className="bg-white border border-slate-200 rounded-lg p-3">
                                        <div className="flex items-center justify-between mb-2">
                                          <div className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Quote Range Gap</div>
                                          <div className="text-[10px] text-slate-400">{isExact ? 'AI quotes the exact price' : 'AI quotes a range around the price'}</div>
                                        </div>
                                        <div className="flex items-center gap-2 flex-wrap">
                                          <span className="text-xs font-semibold text-slate-500 w-5 text-right">−</span>
                                          <input
                                            type="number"
                                            min={0}
                                            value={mVal}
                                            onChange={e => handlePriceRangeChange('minus', 'value', e.target.value)}
                                            className="w-16 px-2 py-1.5 bg-white border border-slate-200 rounded-md text-xs font-semibold text-right"
                                          />
                                          <select
                                            value={mType}
                                            onChange={e => handlePriceRangeChange('minus', 'type', e.target.value)}
                                            className="px-2 py-1.5 bg-white border border-slate-200 rounded-md text-xs font-semibold"
                                          >
                                            <option value="%">%</option>
                                            <option value="$">$</option>
                                          </select>
                                          <span className="text-xs text-slate-400 px-1">to</span>
                                          <span className="text-xs font-semibold text-slate-500 w-5 text-right">+</span>
                                          <input
                                            type="number"
                                            min={0}
                                            value={pVal}
                                            onChange={e => handlePriceRangeChange('plus', 'value', e.target.value)}
                                            className="w-16 px-2 py-1.5 bg-white border border-slate-200 rounded-md text-xs font-semibold text-right"
                                          />
                                          <select
                                            value={pType}
                                            onChange={e => handlePriceRangeChange('plus', 'type', e.target.value)}
                                            className="px-2 py-1.5 bg-white border border-slate-200 rounded-md text-xs font-semibold"
                                          >
                                            <option value="%">%</option>
                                            <option value="$">$</option>
                                          </select>
                                          <span className="text-[11px] text-slate-500 ml-1">
                                            {isExact
                                              ? ''
                                              : `(e.g. table $200 → ${mType === '%' ? `$${Math.round(200 * (1 - mVal/100))}` : `$${200 - mVal}`}–${pType === '%' ? `$${Math.round(200 * (1 + pVal/100))}` : `$${200 + pVal}`})`
                                            }
                                          </span>
                                        </div>
                                        <div className="text-[10px] text-slate-400 mt-1.5">Set both to 0 to quote the exact price with no range.</div>
                                      </div>
                                    );
                                  })()}
                                  {/* Compact extras summary */}
                                  {(p.frequencyDiscounts?.some((fd: any) => fd.discount > 0) || p.extras?.some((e: any) => e.label && e.price > 0) || p.petSurcharge > 0) && (
                                    <div className="flex flex-wrap gap-1.5 text-[10px]">
                                      {p.frequencyDiscounts?.filter((fd: any) => fd.discount > 0).map((fd: any) => (
                                        <span key={fd.key} className="px-1.5 py-0.5 bg-emerald-50 text-emerald-700 rounded font-semibold">{fd.label}: {fd.discount}%</span>
                                      ))}
                                      {p.extras?.filter((e: any) => e.label && e.price > 0).slice(0, 4).map((e: any) => (
                                        <span key={e.key} className="px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded">{e.label}: +${e.price}</span>
                                      ))}
                                      {p.extras?.filter((e: any) => e.label && e.price > 0).length > 4 && (
                                        <span className="px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded">+{p.extras.filter((e: any) => e.label && e.price > 0).length - 4} more</span>
                                      )}
                                      {p.petSurcharge > 0 && <span className="px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded">Pet: +${p.petSurcharge}</span>}
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        </div>
                      ) : (
                        /* Auto mode: shared AI Strategy badge + prompt selector */
                        <div className="space-y-3">
                          <div className="rounded-xl border border-violet-100 bg-violet-50/40 px-4 py-3 flex items-center gap-3">
                            <Zap className="w-4 h-4 text-violet-500 shrink-0" />
                            <div className="flex-1 min-w-0 text-xs">
                              <div className="font-semibold text-slate-700">
                                AI Strategy: <span className="text-violet-700 capitalize">{fuStrategy}</span>
                              </div>
                              <div className="text-[10px] text-slate-500">Used only when <span className="font-semibold">Instant Reply Mode</span> is set to AI. Set globally in <span className="font-semibold">AI Strategy</span> above.</div>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                const el = document.querySelector('[data-tour="ai-strategy-card"]') as HTMLElement | null;
                                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                              }}
                              className="shrink-0 text-[11px] font-semibold text-violet-700 hover:text-violet-900 underline underline-offset-2"
                            >Change</button>
                          </div>
                        <div>
                          <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">First-Reply Prompt Override (optional)</label>
                          <select
                            value={autoReplyPromptTemplateId}
                            onChange={e => {
                              const id = e.target.value;
                              setAutoReplyPromptTemplateId(id);
                              if (id) {
                                const selected = promptTemplates.find(p => p.id === id);
                                if (selected) {
                                  setAutoReplyAiPrompt(selected.content);
                                  if (firstReplyRule) {
                                    // Save both the prompt content AND the template ID
                                    automationApi.updateRule(firstReplyRule.id, {
                                      useAi: true,
                                      replyMode: 'auto',
                                      aiSystemPrompt: selected.content,
                                      promptTemplateId: id,
                                    } as any).then(({ rule }) => {
                                      setAutoReplyRules(prev => prev.map(r => r.id === firstReplyRule.id ? rule : r));
                                    }).catch(() => {});
                                  }
                                }
                              }
                            }}
                            className="w-full bg-white border border-slate-200 rounded-xl p-2.5 text-sm font-medium mb-2"
                          >
                            {promptTemplates.map(p => (
                              <option key={p.id} value={p.id}>{p.name}{p.isDefault ? ' (default)' : ''}</option>
                            ))}
                          </select>
                          <div className="bg-white p-3 rounded-xl border border-dashed border-slate-200 text-slate-600 text-xs leading-relaxed relative group whitespace-pre-wrap max-h-36 overflow-y-auto">
                            {autoReplyAiPrompt || 'Select a prompt above'}
                            <button
                              onClick={() => setTemplateEditor({
                                mode: 'create',
                                ruleId: firstReplyRule?.id || '',
                                templateId: undefined,
                                templateName: undefined,
                                content: autoReplyAiPrompt || '',
                                type: 'autoReplyPrompt',
                              })}
                              className="absolute top-2 right-2 p-1.5 bg-slate-50 rounded-lg text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity hover:text-blue-600"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                        </div>
                      )}
                    </div>
                  )}
                  </div>
                </div>
              </div>

              {/* New Lead Alerts moved to top-level "Alerts & Notifications" card above. */}

              {/* ── Contact Immediately ── */}
              <div className="px-1 pt-2">
                <h4 className="text-sm font-bold text-slate-800">Contact Immediately</h4>
                <p className="text-xs text-slate-400 mt-0.5">Reach out to the lead right away by text or call.</p>
              </div>

              {/* ── Instant Text sub-section ── */}
              <div className="relative border border-slate-100 rounded-2xl overflow-hidden">
                {!canUseEngage && <LockedFeatureOverlay ctaLabel="Upgrade to Engage · $89/mo" />}
                <div className={`flex items-center justify-between px-5 py-4 bg-slate-50/50${!canUseEngage ? ' opacity-60' : ''}`}>
                  <div className="flex items-center gap-3">
                    <MessageSquare className="w-5 h-5 text-emerald-600" />
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-bold text-slate-800">Instant Text</h4>
                        <TierBadge tier="engage" />
                      </div>
                      <p className="text-xs text-slate-400">Automatically text the lead when a new lead arrives</p>
                    </div>
                  </div>
                  <label className={`inline-flex items-center ${canUseEngage ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                    <input
                      type="checkbox"
                      checked={ctEnabled}
                      onChange={e => toggleCustomerTexting(e.target.checked)}
                      disabled={ctSaving || !canUseEngage}
                      className="sr-only peer"
                    />
                    <div className="relative w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-100 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
                  </label>
                </div>
                <div className={`px-5 py-4 space-y-4${!ctEnabled ? ' opacity-40 pointer-events-none select-none' : ''}`}>
                  {selectedAccountIsYelp && (
                    <div className="flex items-start gap-2 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 text-[11px] text-amber-800">
                      <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                      <span>
                        <span className="font-semibold">Yelp accounts:</span> Yelp leads don't always include a phone number. Instant Text only fires when the customer has shared their phone (via Yelp's phone opt-in). Otherwise it's silently skipped.
                      </span>
                    </div>
                  )}
                  {selectedAccountId && <AccountHoursControl accountId={selectedAccountId} feature="firstMsg" />}
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
              <div className="relative border border-slate-100 rounded-2xl overflow-hidden">
                {!canUseEngage && <LockedFeatureOverlay ctaLabel="Upgrade to Engage · $89/mo" />}
                <div className={`flex items-center justify-between px-5 py-4 bg-slate-50/50${!canUseEngage ? ' opacity-60' : ''}`}>
                  <div className="flex items-center gap-3">
                    <PhoneCall className="w-5 h-5 text-violet-600" />
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-bold text-slate-800">Instant Call</h4>
                        <TierBadge tier="engage" />
                      </div>
                      <p className="text-xs text-slate-400">Call your team and connect to the lead right away</p>
                    </div>
                  </div>
                  <label className={`inline-flex items-center ${canUseEngage ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                    <input
                      type="checkbox"
                      checked={ccEnabled}
                      onChange={e => toggleCallConnect(e.target.checked)}
                      disabled={ccSaving || !canUseEngage}
                      className="sr-only peer"
                    />
                    <div className="relative w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-100 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
                  </label>
                </div>
                <div className={`px-5 py-4 space-y-4${!ccEnabled ? ' opacity-40 pointer-events-none select-none' : ''}`}>
                  {selectedAccountIsYelp && (
                    <div className="flex items-start gap-2 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 text-[11px] text-amber-800">
                      <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                      <span>
                        <span className="font-semibold">Yelp accounts:</span> Yelp leads don't always include a phone number. Instant Call only fires when the customer has shared their phone (via Yelp's phone opt-in). Otherwise it's silently skipped.
                      </span>
                    </div>
                  )}
                  {selectedAccountId && <AccountHoursControl accountId={selectedAccountId} feature="call" />}
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
                  </div>

                </div>
              </div>

              {/* Auto-saves on change (debounced ~600ms). */}
              {(ctSaving || ccSaving) && (
                <div className="pt-3 text-[11px] text-slate-400 flex items-center gap-2">
                  <Loader2 className="w-3 h-3 animate-spin" /> Saving…
                </div>
              )}

            </div>
          </ServiceCard>
            );
          })()}


          {/* 3. Follow-ups (was "If the Lead Doesn't Respond"). Flattened: the
                 outer card now carries the tier badge + the Engage-gated toggle;
                 the inner duplicate sub-card header/badge/toggle was removed. */}
          {selectedAccountId && (
            <ServiceCard
              icon={<Clock className="w-7 h-7" />}
              title="Follow-ups"
              titleBadge={<TierBadge tier="engage" />}
              description="Automatically follow up with leads who stop responding."
              enabled={fuMode !== 'off'}
              mixed={allAccountsMode && mixedToggles.followUps}
              onToggle={(on) => {
                const next = on ? 'suggest' : 'off';
                setFuMode(next);
                quickSaveSettings(
                  { mode: next },
                  { successMsg: on ? 'Follow-ups enabled' : 'Follow-ups disabled' },
                );
              }}
              expanded={expandedCard === 'yelp-followups'}
              onExpand={() => setExpandedCard(expandedCard === 'yelp-followups' ? null : 'yelp-followups')}
              iconBgColor="bg-red-50"
              iconTextColor="text-red-600"
            >

              {/* Follow-up controls — flattened from the old inner sub-card.
                  Tier gating moved to the outer ServiceCard's titleBadge; the
                  Engage paywall overlay still wraps the controls below. */}
              <div className="relative">
                {!canUseEngage && <LockedFeatureOverlay ctaLabel="Upgrade to Engage · $89/mo" />}
                <div className={`space-y-4${!canUseEngage ? ' opacity-60 pointer-events-none' : ''}`}>
                    {selectedAccountId && <AccountHoursControl accountId={selectedAccountId} feature="applyQuietHours" />}
                    <div>
                      <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Follow-up Mode</label>
                      <p className="text-[10px] text-slate-400 mb-2">Choose how follow-ups are delivered.</p>
                      <div className="flex gap-2">
                        {([
                          { value: 'suggest' as const, label: 'Suggest', desc: 'Draft follow-ups for you to approve before sending', replyType: 'ai' as const },
                          { value: 'auto_send' as const, label: 'Active', desc: 'Send follow-ups automatically without approval', replyType: 'ai' as const },
                        ]).map(opt => (
                          <button key={opt.value}
                            onClick={() => { setFuMode(opt.value); setFuReplyType(opt.replyType); }}
                            className={`flex-1 py-2.5 px-2 rounded-xl text-xs font-semibold border-2 transition-all ${
                              fuMode === opt.value ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 text-slate-500 border-slate-200 hover:border-blue-200'
                            }`}
                          >
                            {opt.label}
                            <span className="block text-[9px] font-normal opacity-70 mt-0.5">{opt.desc}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Inherited AI Strategy badge — follow-up AI generation uses the central strategy. */}
                    <div className="rounded-xl border border-violet-100 bg-violet-50/40 px-4 py-3 flex items-center gap-3">
                      <Zap className="w-4 h-4 text-violet-500 shrink-0" />
                      <div className="flex-1 min-w-0 text-xs">
                        <div className="font-semibold text-slate-700">
                          AI Strategy: <span className="text-violet-700 capitalize">{fuStrategy}</span>
                        </div>
                        <div className="text-[10px] text-slate-500">Used only when <span className="font-semibold">Follow-up Mode</span> is set to AI. Set globally in <span className="font-semibold">AI Strategy</span> above.</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const el = document.querySelector('[data-tour="ai-strategy-card"]') as HTMLElement | null;
                          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }}
                        className="shrink-0 text-[11px] font-semibold text-violet-700 hover:text-violet-900 underline underline-offset-2"
                      >Change</button>
                    </div>

                    {/* Follow-up Plan — single sequence-level Template/AI picker mirrors Instant Reply Mode UI. */}
                    <div>
                      <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Follow-up Mode</label>
                      <p className="text-[10px] text-slate-400 mb-2">How follow-up messages are composed.</p>
                      <div className="grid grid-cols-2 gap-2 mb-3">
                        {(() => {
                          const modes: Array<{ key: 'template' | 'ai'; emoji: string; label: string; active: string; desc: string }> = [
                            { key: 'template', emoji: '🟢', label: 'Custom Template', active: '#16a34a', desc: 'Send your saved templates literally — no AI generation' },
                            { key: 'ai',       emoji: '🟣', label: 'AI',              active: '#7c3aed', desc: 'AI generates each step from the conversation using your AI Strategy' },
                          ];
                          return modes.map(m => {
                            const isActive = fuReplyType === m.key;
                            return (
                              <button
                                key={m.key}
                                title={m.desc}
                                onClick={() => setFuReplyType(m.key)}
                                className="py-2 px-3 rounded-xl text-xs font-semibold border-2 transition-all"
                                style={{
                                  background: isActive ? m.active : '#f1f5f9',
                                  color: isActive ? '#fff' : '#64748b',
                                  borderColor: isActive ? m.active : '#e2e8f0',
                                }}
                              >
                                {m.emoji} {m.label}
                              </button>
                            );
                          });
                        })()}
                      </div>
                      <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">Follow-up Plan</label>
                      <p className="text-[11px] text-slate-400 mb-2">
                        {fuReplyType === 'template'
                          ? 'Preset messages sent on schedule. Edit each template below.'
                          : <>AI writes each step from the live conversation using <span className="font-semibold capitalize text-slate-700">{fuStrategy}</span> strategy. You only set the timing.</>}
                      </p>
                      {/* Horizontal chip row works for both Template and AI mode.
                          In Template mode, the popup edits delay + message.
                          In AI mode, the popup edits delay only (message is
                          AI-generated at fire time). */}
                      <div className="space-y-2">
                        <div className="flex flex-wrap gap-2 items-center">
                          {fuSmartSteps.map((step, i) => {
                            const fallbackMsg = SMART_DEFAULTS[i]?.message || '';
                            const effectiveMsg = step.message || fallbackMsg;
                            const hasCustomMsg = !!step.message;
                            const isAi = fuReplyType === 'ai';
                            return (
                              <div key={i} className="relative group">
                                <button
                                  type="button"
                                  onClick={() => setFuStepEditor({ idx: i, delay: step.delay || '', message: isAi ? '' : effectiveMsg })}
                                  title={isAi
                                    ? `Click to edit timing — message is AI-generated at fire time`
                                    : (effectiveMsg ? `Click to edit\n\n${effectiveMsg.slice(0, 200)}${effectiveMsg.length > 200 ? '…' : ''}` : 'Click to edit')
                                  }
                                  className={`flex flex-col items-center justify-center px-3 py-2 rounded-xl border-2 transition-all min-w-[78px] ${
                                    isAi
                                      ? 'bg-violet-50/60 border-violet-200 hover:border-violet-400 hover:shadow-sm'
                                      : hasCustomMsg
                                        ? 'bg-violet-50 border-violet-200 hover:border-violet-400 hover:shadow-sm'
                                        : 'bg-slate-50 border-slate-200 hover:border-violet-300 hover:bg-violet-50/40'
                                  }`}
                                >
                                  <span className="text-[10px] font-bold text-slate-400 leading-none flex items-center gap-1">
                                    {isAi && <Zap className="w-2.5 h-2.5 text-violet-500" />}
                                    #{i + 1}
                                  </span>
                                  <span className="text-xs font-bold text-slate-700 leading-tight mt-1">{step.delay || '—'}</span>
                                </button>
                                {fuSmartSteps.length > 1 && (
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); setFuSmartSteps(fuSmartSteps.filter((_, j) => j !== i)); }}
                                    className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-white border border-slate-200 rounded-full text-slate-300 hover:text-red-500 hover:border-red-200 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center shadow-sm"
                                    title="Remove step"
                                  >
                                    <Trash2 className="w-2.5 h-2.5" />
                                  </button>
                                )}
                              </div>
                            );
                          })}
                          <button
                            type="button"
                            onClick={() => {
                              const newIdx = fuSmartSteps.length;
                              const def = SMART_DEFAULTS[newIdx];
                              setFuSmartSteps([
                                ...fuSmartSteps,
                                {
                                  label: def?.label || `${newIdx + 1}th`,
                                  delay: def?.delay || '1 day',
                                  message: def?.message || `Hi {{lead.name}}, just following up on your request. Let me know if you'd still like to move forward.`,
                                  mode: fuReplyType === 'ai' ? 'ai' : 'template',
                                },
                              ]);
                            }}
                            className="flex flex-col items-center justify-center px-3 py-2 rounded-xl border-2 border-dashed border-slate-300 text-slate-500 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-all min-w-[78px]"
                            title="Add another step"
                          >
                            <Plus className="w-4 h-4" />
                            <span className="text-[10px] font-bold leading-tight mt-0.5">Add</span>
                          </button>
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-slate-400">
                          <span>Click any step to edit{fuReplyType === 'ai' ? ' its timing.' : ' its delay and message.'}</span>
                          <button
                            type="button"
                            onClick={() => setFuSmartSteps(SMART_DEFAULTS.map(s => ({ ...s })))}
                            className="text-slate-400 hover:text-slate-600 font-semibold"
                          >
                            Reset to defaults
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Re-enroll after customer reply */}
                    <div className="rounded-xl border border-slate-200 overflow-hidden">
                      <label className="flex items-center gap-3 p-3 bg-slate-50 cursor-pointer hover:bg-slate-100 transition-colors">
                        <input type="checkbox" checked={fuReEnrollOnSilence} onChange={(e) => setFuReEnrollOnSilence(e.target.checked)}
                          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                        <div>
                          <span className="text-xs font-semibold text-slate-700">Resume follow-ups after conversation</span>
                          <span className="block text-[10px] text-slate-400">When a customer replies and then goes silent again, start a new follow-up sequence</span>
                        </div>
                      </label>
                      {fuReEnrollOnSilence && (
                        <div className="px-3 py-3 border-t border-slate-100">
                          <label className="text-[10px] font-bold text-slate-500 uppercase mb-2 block">Wait before resuming</label>
                          <div className="flex flex-wrap gap-1.5">
                            {([
                              { value: '1h', label: '1 hour' },
                              { value: '4h', label: '4 hours' },
                              { value: '12h', label: '12 hours' },
                              { value: '24h', label: '24 hours' },
                              { value: '48h', label: '2 days' },
                              { value: '72h', label: '3 days' },
                              { value: '7d', label: '1 week' },
                            ]).map(opt => (
                              <button key={opt.value} onClick={() => setFuReEnrollDelay(opt.value)}
                                className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border-2 transition-all ${
                                  fuReEnrollDelay === opt.value ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 text-slate-500 border-slate-200 hover:border-blue-200'
                                }`}>
                                {opt.label}
                              </button>
                            ))}
                          </div>
                          <p className="text-[10px] text-slate-400 mt-2">How long to wait after your last message before starting follow-ups again.</p>
                        </div>
                      )}
                    </div>

                    {/* Check in after customer deferral */}
                    <div className="rounded-xl border border-slate-200 overflow-hidden">
                      <label className="flex items-center gap-3 p-3 bg-slate-50 cursor-pointer hover:bg-slate-100 transition-colors">
                        <input type="checkbox" checked={aiDeferralCheckIn} onChange={(e) => setAiDeferralCheckIn(e.target.checked)}
                          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                        <div>
                          <span className="text-xs font-semibold text-slate-700">Check in after customer deferral</span>
                          <span className="block text-[10px] text-slate-400">When customer says "I'll get back to you" / "let me think", silence the AI and schedule one nudge later. Cancels if they reply first.</span>
                        </div>
                      </label>
                      {aiDeferralCheckIn && (
                        <div className="px-3 py-3 border-t border-slate-100 space-y-3">
                          <div>
                            <label className="text-[10px] font-bold text-slate-500 uppercase mb-2 block">Send check-in after</label>
                            <div className="flex flex-wrap gap-1.5">
                              {([
                                { value: '1d', label: '1 day' },
                                { value: '2d', label: '2 days' },
                                { value: '3d', label: '3 days' },
                                { value: '5d', label: '5 days' },
                                { value: '7d', label: '1 week' },
                                { value: '14d', label: '2 weeks' },
                              ]).map(opt => (
                                <button key={opt.value} onClick={() => setAiDeferralDelay(opt.value)}
                                  className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border-2 transition-all ${
                                    aiDeferralDelay === opt.value ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 text-slate-500 border-slate-200 hover:border-blue-200'
                                  }`}>
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                          </div>
                          {fuReplyType === 'template' ? (
                            <div>
                              <label className="text-[10px] font-bold text-slate-500 uppercase mb-2 block">Message</label>
                              <textarea
                                value={aiDeferralMessage}
                                onChange={e => setAiDeferralMessage(e.target.value)}
                                rows={3}
                                className="w-full bg-white border border-slate-200 rounded-lg p-2.5 text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                              />
                              <div className="flex items-center justify-between mt-1">
                                <p className="text-[10px] text-slate-400">{'{{lead.name}}'} is replaced with the customer's name.</p>
                                <button type="button" onClick={() => setAiDeferralMessage(DEFAULT_DEFERRAL_MSG)} className="text-[10px] text-slate-400 hover:text-slate-600 font-semibold">Reset to default</button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-start gap-2 text-[11px] text-slate-500 leading-relaxed bg-violet-50/40 border border-violet-100 rounded-lg px-3 py-2">
                              <Zap className="w-3.5 h-3.5 text-violet-500 mt-0.5 shrink-0" />
                              <span>AI generates this check-in from the conversation using your <span className="font-semibold capitalize text-slate-700">{fuStrategy}</span> strategy. Switch Follow-up Mode to <span className="font-semibold">Custom Template</span> above to write a fixed message instead.</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Re-engage after customer hired competitor */}
                    <div className="rounded-xl border border-slate-200 overflow-hidden">
                      <label className="flex items-center gap-3 p-3 bg-slate-50 cursor-pointer hover:bg-slate-100 transition-colors">
                        <input type="checkbox" checked={aiHiredReengage} onChange={(e) => setAiHiredReengage(e.target.checked)}
                          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                        <div>
                          <span className="text-xs font-semibold text-slate-700">Re-engage after customer hired competitor</span>
                          <span className="block text-[10px] text-slate-400">When customer says they hired someone else, send one polite check-in later. Captures the dissatisfied ones.</span>
                        </div>
                      </label>
                      {aiHiredReengage && (
                        <div className="px-3 py-3 border-t border-slate-100 space-y-3">
                          <div>
                            <label className="text-[10px] font-bold text-slate-500 uppercase mb-2 block">Send re-engage after</label>
                            <div className="flex flex-wrap gap-1.5">
                              {([
                                { value: '14d', label: '2 weeks' },
                                { value: '21d', label: '3 weeks' },
                                { value: '30d', label: '1 month' },
                                { value: '42d', label: '6 weeks' },
                                { value: '60d', label: '2 months' },
                              ]).map(opt => (
                                <button key={opt.value} onClick={() => setAiHiredDelay(opt.value)}
                                  className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold border-2 transition-all ${
                                    aiHiredDelay === opt.value ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 text-slate-500 border-slate-200 hover:border-blue-200'
                                  }`}>
                                  {opt.label}
                                </button>
                              ))}
                            </div>
                          </div>
                          {fuReplyType === 'template' ? (
                            <div>
                              <label className="text-[10px] font-bold text-slate-500 uppercase mb-2 block">Message</label>
                              <textarea
                                value={aiHiredMessage}
                                onChange={e => setAiHiredMessage(e.target.value)}
                                rows={3}
                                className="w-full bg-white border border-slate-200 rounded-lg p-2.5 text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                              />
                              <div className="flex items-center justify-between mt-1">
                                <p className="text-[10px] text-slate-400">{'{{lead.name}}'} is replaced with the customer's name.</p>
                                <button type="button" onClick={() => setAiHiredMessage(DEFAULT_HIRED_MSG)} className="text-[10px] text-slate-400 hover:text-slate-600 font-semibold">Reset to default</button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-start gap-2 text-[11px] text-slate-500 leading-relaxed bg-violet-50/40 border border-violet-100 rounded-lg px-3 py-2">
                              <Zap className="w-3.5 h-3.5 text-violet-500 mt-0.5 shrink-0" />
                              <span>AI generates this re-engage from the conversation using your <span className="font-semibold capitalize text-slate-700">{fuStrategy}</span> strategy. Switch Follow-up Mode to <span className="font-semibold">Custom Template</span> above to write a fixed message instead.</span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Quiet hours config moved to Settings → General → Quiet Hours.
                        The per-account opt-in toggle is rendered at the top of this card via
                        AccountHoursControl feature="applyQuietHours". */}

                    {/* "Follow up historical leads" relocated to Settings → Import Negotiations. */}

                    {/* Urgent request handling block removed — was not in the
                        spec's "show follow-up controls directly" list. State
                        (fuUrgentCapability) still saves its current value so
                        backend behavior is unchanged. */}
                  </div>
              </div>

              {/* ── AI Conversation subsection relocated to its own ServiceCard below. Legacy block hidden to preserve state hooks. ── */}
              {false && (
              <div className="border border-slate-100 rounded-2xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 bg-slate-50/50">
                  <div className="flex items-center gap-3">
                    <Zap className="w-5 h-5 text-violet-600" />
                    <div>
                      <h4 className="text-sm font-bold text-slate-800">AI Conversation</h4>
                      <p className="text-xs text-slate-400">Let AI continue the conversation after the first reply</p>
                    </div>
                  </div>
                  <label className="inline-flex items-center cursor-pointer">
                    <input type="checkbox" checked={aiConversationOn} onChange={e => setAiConversationOn(e.target.checked)} className="sr-only peer" />
                    <div className="relative w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-100 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
                  </label>
                </div>
                {aiConversationOn && (
                  <div className="px-5 py-4 space-y-4">
                    {/* AI Strategy */}
                    <div>
                      <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">AI Conversation Strategy</label>
                      <p className="text-[10px] text-slate-400 mb-2">Choose how AI should guide the conversation.</p>
                      <div className="flex flex-wrap gap-1.5 mb-2">
                        {([
                          { key: 'auto' as const, emoji: '🤖', label: 'Auto', desc: 'AI picks best strategy per conversation' },
                          { key: 'hybrid' as const, emoji: '⚖️', label: 'Hybrid', desc: 'Price + one question' },
                          { key: 'price' as const, emoji: '💰', label: 'Price', desc: 'Lead with pricing' },
                          { key: 'qualify' as const, emoji: '🧠', label: 'Qualify', desc: 'Ask for details' },
                          { key: 'convert' as const, emoji: '📞', label: 'Convert', desc: 'Push to booking' },
                          { key: 'phone' as const, emoji: '📱', label: 'Phone', desc: 'Escalate to call' },
                        ]).map(s => (
                          <button key={s.key}
                            onClick={() => {
                              setFuStrategy(s.key);
                              // Don't pre-fill — backend STRATEGY_PROMPTS owns the prompt.
                              setFuStrategyPrompt('');
                            }}
                            className={`text-[11px] px-2.5 py-1.5 rounded-lg font-semibold border-2 transition-all ${fuStrategy === s.key ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 text-slate-500 border-slate-200 hover:border-blue-200'}`}
                            title={s.desc}>
                            {s.emoji} {s.label}
                          </button>
                        ))}
                      </div>
                      {fuStrategy === 'auto' ? (
                        <p className="text-[11px] text-slate-400">AI picks the best strategy based on conversation context.</p>
                      ) : (
                        <div className="bg-white p-3 rounded-xl border border-dashed border-slate-200 text-slate-600 text-xs leading-relaxed max-h-28 overflow-y-auto whitespace-pre-wrap relative group">
                          {fuStrategyPrompt || 'No prompt set'}
                          <button onClick={() => setTemplateEditor({ mode: 'create', ruleId: '', templateId: undefined, templateName: `Follow-up — ${fuStrategy.charAt(0).toUpperCase() + fuStrategy.slice(1)}`, content: fuStrategyPrompt || '', type: `fu-strategy-${fuStrategy}` })}
                            className="absolute top-2 right-2 p-1.5 bg-slate-50 rounded-lg text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity hover:text-violet-600">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Availability */}
                    <div>
                      <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">Auto Reply Availability</label>
                      <p className="text-[11px] text-slate-400 mb-2">Choose when follow-ups can be sent automatically.</p>
                      <div className="flex gap-2 mb-3">
                        <button onClick={() => { setFuAvailability('always'); saveAvailabilityNow('always'); }}
                          className={`flex-1 py-2 px-3 rounded-xl text-xs font-semibold border-2 transition-all ${fuAvailability === 'always' ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 text-slate-500 border-slate-200 hover:border-blue-200'}`}>
                          Always (24/7)
                        </button>
                        <button onClick={() => { setFuAvailability('active_hours'); saveAvailabilityNow('active_hours'); }}
                          className={`flex-1 py-2 px-3 rounded-xl text-xs font-semibold border-2 transition-all ${fuAvailability === 'active_hours' ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 text-slate-500 border-slate-200 hover:border-blue-200'}`}>
                          Set up active time
                        </button>
                      </div>
                      {fuAvailability === 'active_hours' && (
                        <div className="space-y-2">
                          {/* Primary time window */}
                          <div className="grid grid-cols-3 gap-3 bg-slate-50 rounded-xl p-3 border border-slate-100">
                            <div>
                              <label className="text-[10px] font-bold text-slate-500 uppercase mb-1 block">Start</label>
                              <input type="time" value={fuStart} onChange={e => setFuStart(e.target.value)} onBlur={() => saveAvailabilityNow('active_hours')} className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm" />
                            </div>
                            <div>
                              <label className="text-[10px] font-bold text-slate-500 uppercase mb-1 block">End</label>
                              <input type="time" value={fuEnd} onChange={e => setFuEnd(e.target.value)} onBlur={() => saveAvailabilityNow('active_hours')} className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm" />
                            </div>
                            <div>
                              <label className="text-[10px] font-bold text-slate-500 uppercase mb-1 block">Timezone</label>
                              <select value={fuTz} onChange={e => { setFuTz(e.target.value); saveAvailabilityNow('active_hours', { tz: e.target.value }); }} className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm">
                                <option value="America/New_York">Eastern</option>
                                <option value="America/Chicago">Central</option>
                                <option value="America/Denver">Mountain</option>
                                <option value="America/Los_Angeles">Pacific</option>
                              </select>
                            </div>
                          </div>
                          {/* Extra time windows */}
                          {fuExtraWindows.map((w, i) => (
                            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-3 bg-slate-50 rounded-xl p-3 border border-slate-100">
                              <div>
                                <label className="text-[10px] font-bold text-slate-500 uppercase mb-1 block">Start</label>
                                <input type="time" value={w.start} onChange={e => { const u = [...fuExtraWindows]; u[i] = { ...u[i], start: e.target.value }; setFuExtraWindows(u); }} onBlur={() => saveAvailabilityNow('active_hours')}
                                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm" />
                              </div>
                              <div>
                                <label className="text-[10px] font-bold text-slate-500 uppercase mb-1 block">End</label>
                                <input type="time" value={w.end} onChange={e => { const u = [...fuExtraWindows]; u[i] = { ...u[i], end: e.target.value }; setFuExtraWindows(u); }} onBlur={() => saveAvailabilityNow('active_hours')}
                                  className="w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm" />
                              </div>
                              <div className="flex items-end pb-1">
                                <button onClick={() => { const u = fuExtraWindows.filter((_, j) => j !== i); setFuExtraWindows(u); saveAvailabilityNow('active_hours', { extraWindows: u }); }}
                                  className="p-2 text-slate-400 hover:text-red-500 transition-colors">
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </div>
                          ))}
                          <button onClick={() => { const u = [...fuExtraWindows, { start: '13:00', end: '17:00' }]; setFuExtraWindows(u); saveAvailabilityNow('active_hours', { extraWindows: u }); }}
                            className="text-[10px] text-blue-600 hover:text-blue-700 font-semibold flex items-center gap-1">
                            + Add time window
                          </button>
                        </div>
                      )}
                    </div>

                    {/* AI Conversation Rules (collapsed) */}
                    <div className="border border-slate-200 rounded-xl overflow-hidden">
                      <button onClick={() => setAiShowRules(!aiShowRules)} className="w-full px-4 py-3 flex items-center justify-between bg-slate-50 hover:bg-slate-100 transition-colors">
                        <div>
                          <span className="text-[11px] font-bold text-slate-600 uppercase tracking-widest">AI Conversation Rules</span>
                          <p className="text-[10px] text-slate-400 mt-0.5">Control when AI stops replying and special handling.</p>
                        </div>
                        {aiShowRules ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                      </button>
                      {aiShowRules && (
                        <div className="px-4 py-4 space-y-4 border-t border-slate-100">
                          {/* Stop conditions */}
                          <div>
                            <div className="text-[11px] font-semibold text-slate-600 mb-2">AI stops replying when:</div>
                            <div className="space-y-1.5">
                              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                                <input type="checkbox" checked={aiStopOnOptOut} onChange={e => setAiStopOnOptOut(e.target.checked)} className="accent-violet-600 w-3.5 h-3.5" />
                                Customer asks not to be contacted
                              </label>
                              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                                <input type="checkbox" checked={aiStopOnBooked} onChange={e => setAiStopOnBooked(e.target.checked)} className="accent-violet-600 w-3.5 h-3.5" />
                                Job is booked or confirmed
                              </label>
                              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                                <input type="checkbox" checked={aiStopOnPriceAgreed} onChange={e => setAiStopOnPriceAgreed(e.target.checked)} className="accent-violet-600 w-3.5 h-3.5" />
                                Customer agrees on price — hand off to manager
                              </label>
                              <div className="flex items-center gap-2 text-sm text-slate-500">
                                <span className="text-emerald-500 text-xs">&#10003;</span> Lead is done, scheduled, or archived
                              </div>
                            </div>
                          </div>

                          {/* Always active */}
                          <div className="flex items-center gap-2 text-sm text-slate-500 bg-slate-50 rounded-lg px-3 py-2">
                            <span className="text-emerald-500 text-xs">&#10003;</span>
                            Manager can always take over by sending a message manually
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
              )}

              {/* Reply Alerts moved to top-level "Alerts & Notifications" card. */}

              {/* Settings auto-save on change (debounced ~600ms). No Save button needed. */}
            </ServiceCard>
          )}

          {/* 4. AI Conversation — standalone card (decision engine) */}
          {selectedAccountId && (
            <ServiceCard
              icon={<Zap className="w-7 h-7" />}
              title="AI Conversation"
              titleBadge={<TierBadge tier="convert" />}
              description="Let the system continue the conversation based on previous messages."
              enabled={aiConversationOn && canUseConvert}
              mixed={allAccountsMode && mixedToggles.aiConversation}
              onToggle={(on) => {
                // Always allow turning OFF. Only block turning ON for non-Convert tiers.
                if (on && !canUseConvert) return;
                setAiConversationOn(on);
                // Save synchronously (await), then refetch to guarantee DB state
                // matches what the user sees in the toggle. Catches the case where
                // the immediate save succeeds but a stale auto-save from earlier
                // overwrites it with the previous value.
                (async () => {
                  try {
                    await followUpApi.saveSettings(selectedAccountId, { aiConversationEnabled: on } as any);
                    const others = fanoutOthers();
                    if (others.length > 0) {
                      await Promise.allSettled(others.map(id =>
                        followUpApi.saveSettings(id, { aiConversationEnabled: on } as any)
                      ));
                    }
                    // Refetch and confirm the DB value matches our optimistic state
                    const fresh = await followUpApi.getSettings(selectedAccountId);
                    const dbValue = (fresh?.settings as any)?.aiConversationEnabled;
                    if (typeof dbValue === 'boolean' && dbValue !== on) {
                      // DB came back different — something is overwriting. Sync UI to DB.
                      setAiConversationOn(dbValue);
                      setError(`AI Conversation save mismatch (DB=${dbValue}). Try again or hard-refresh.`);
                    } else {
                      const fanoutSuffix = others.length > 0 ? ` to ${others.length + 1} accounts` : '';
                      showSuccess(`AI Conversation ${on ? 'enabled' : 'disabled'}${fanoutSuffix}`);
                    }
                  } catch (err: any) {
                    setAiConversationOn(!on); // rollback
                    setError(err?.response?.data?.message || err?.message || 'Failed to save AI Conversation toggle');
                  }
                })();
              }}
              expanded={expandedCard === 'ai-conversation'}
              onExpand={() => setExpandedCard(expandedCard === 'ai-conversation' ? null : 'ai-conversation')}
              iconBgColor="bg-violet-50"
              iconTextColor="text-violet-600"
            >
              {!canUseConvert && (
                <div className="mb-4 rounded-2xl border border-violet-200 bg-violet-50/70 p-4 flex items-start gap-3">
                  <Lock className="w-4 h-4 text-violet-600 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold text-violet-900">AI Conversation — Convert plan</span>
                      <TierBadge tier="convert" />
                    </div>
                    <p className="text-xs text-violet-800 mt-1">Let the system handle conversations and convert leads automatically.</p>
                  </div>
                  <Link to="/pricing" className="shrink-0 px-3 py-1.5 bg-violet-600 text-white text-xs font-semibold rounded-lg hover:bg-violet-700 transition-colors whitespace-nowrap">
                    Upgrade to Convert · $139/mo
                  </Link>
                </div>
              )}
              <div className={`space-y-4 relative${!canUseConvert ? ' opacity-60 pointer-events-none select-none' : ''}`}>
                  {/* AI Strategy editor — moved here from the top of the page.
                      Single source of truth for AI-generated messages across
                      AI Conversation, Follow-up AI mode, and Instant Reply
                      Auto mode. The [data-tour="ai-strategy-card"] anchor is
                      preserved so the smaller "Strategy: qualify" badges in
                      those other sections still scroll to this editor. */}
                  {(() => {
                    const STRATEGIES: Array<{ key: 'auto' | 'hybrid' | 'price' | 'qualify' | 'convert' | 'phone'; emoji: string; label: string; desc: string }> = [
                      { key: 'auto',    emoji: '🤖', label: 'Auto',    desc: 'AI picks the strategy per conversation' },
                      { key: 'hybrid',  emoji: '⚖️', label: 'Hybrid',  desc: 'Acknowledge + one question; price only if asked' },
                      { key: 'price',   emoji: '💰', label: 'Price',   desc: 'Lead with a price range from your pricing table' },
                      { key: 'qualify', emoji: '🧠', label: 'Qualify', desc: 'Ask for missing detail (size, condition); no pricing' },
                      { key: 'convert', emoji: '📅', label: 'Convert', desc: 'Push toward scheduling; price only if asked' },
                      { key: 'phone',   emoji: '📱', label: 'Phone',   desc: 'Escalate to a call; no quoting' },
                    ];
                    const STRATEGY_PROMPT_PREVIEWS: Record<string, string> = {
                      hybrid: 'STRATEGY: HYBRID\n\nYou MUST:\n- Acknowledge the customer\'s specific request (reference their details)\n- Move forward with EXACTLY ONE question (timing or confirmation)\n\nDO NOT:\n- Volunteer a price unless the customer asks about price or budget\n- Ask more than one question\n\nIf the customer asks about price, use the pricing table to answer accurately.',
                      price: 'STRATEGY: PRICE ANCHOR\n\nYou MUST:\n- Lead with a price range based on the pricing table for the customer\'s BR/BA\n- Briefly explain what is included\n\nDO NOT:\n- Ask questions\n- Invent prices unrelated to the table',
                      qualify: 'STRATEGY: QUALIFICATION\n\nYou MUST:\n- Ask 1-2 specific questions about the missing critical detail (e.g. square footage, condition, timing)\n- Briefly explain why you need it\n\nDO NOT:\n- Volunteer pricing — qualification comes first\n- Ask about info the customer already provided',
                      convert: 'STRATEGY: CONVERSION\n\nYou MUST:\n- Push toward scheduling (ask what time works, or offer a broad window matching your turnaround)\n\nDO NOT:\n- Volunteer a price unless the customer asks (the goal here is closing on time, not on price)\n- Claim a SPECIFIC time slot is open\n- Ask open-ended questions',
                      phone: 'STRATEGY: PHONE / ESCALATION\n\nYou MUST:\n- Explain why a call is needed (without quoting a number)\n- Ask for the best phone number naturally\n\nDO NOT:\n- Volunteer a price\n- Push phone too early or sound forceful',
                    };
                    return (
                    <div data-tour="ai-strategy-card" className="rounded-2xl border border-violet-100 bg-violet-50/30 overflow-hidden">
                      <div className="flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-violet-50/60 to-white border-b border-violet-100">
                        <Zap className="w-4 h-4 text-violet-500 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[11px] font-bold text-violet-700 uppercase tracking-widest">AI Strategy</span>
                            <span className="px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 text-[9px] font-semibold uppercase tracking-wide">Applies everywhere</span>
                          </div>
                          <p className="text-[10px] text-slate-500 mt-0.5 leading-relaxed">
                            Single source of truth for how AI-generated messages are written. Used by <span className="font-semibold text-slate-700">Instant Reply AI mode</span>, <span className="font-semibold text-slate-700">Follow-up AI mode</span>, and <span className="font-semibold text-slate-700">AI Conversation</span>.
                          </p>
                        </div>
                      </div>
                      <div className="px-4 py-3 space-y-3">
                        <p className="text-[11px] text-slate-500">Pick the goal for each reply. Only <span className="font-semibold text-slate-700">Price</span> volunteers a price proactively — the other strategies stay focused on their own goal and only quote when the customer asks.</p>
                        <p className="text-[11px] text-slate-400 italic">AI Strategy controls how AI writes replies. Human takeover rules are configured below.</p>
                        <div className="flex flex-wrap gap-1.5">
                          {STRATEGIES.map(s => (
                            <button key={s.key}
                              onClick={() => {
                                setFuStrategy(s.key);
                                setFuStrategyPrompt('');
                                quickSaveSettings(
                                  { followUpStrategy: s.key, followUpStrategyPrompt: null },
                                  { successMsg: `Strategy: ${s.label}`, fanout: true },
                                );
                              }}
                              className={`text-[11px] px-2.5 py-1.5 rounded-lg font-semibold border-2 transition-all ${fuStrategy === s.key ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-slate-500 border-slate-200 hover:border-violet-200'}`}
                              title={s.desc}>
                              {s.emoji} {s.label}
                            </button>
                          ))}
                        </div>
                        {fuStrategy === 'auto' ? (
                          <p className="text-[11px] text-slate-400">AI picks the best strategy based on conversation context.</p>
                        ) : (
                          <div className="bg-white p-3 rounded-xl border border-dashed border-slate-200 text-slate-600 text-xs leading-relaxed max-h-32 overflow-y-auto whitespace-pre-wrap relative group">
                            {fuStrategyPrompt || `${STRATEGY_PROMPT_PREVIEWS[fuStrategy] || ''}\n\n(Using backend default — click the pencil to customize.)`}
                            <button onClick={() => setTemplateEditor({ mode: 'create', ruleId: '', templateId: undefined, templateName: `AI Strategy — ${fuStrategy.charAt(0).toUpperCase() + fuStrategy.slice(1)}`, content: fuStrategyPrompt || STRATEGY_PROMPT_PREVIEWS[fuStrategy] || '', type: `fu-strategy-${fuStrategy}` })}
                              className="absolute top-2 right-2 p-1.5 bg-slate-50 rounded-lg text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity hover:text-violet-600">
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                        <div className="pt-2 border-t border-violet-100">
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="text-[11px] font-semibold text-slate-700">How AI quotes price</div>
                              <p className="text-[10px] text-slate-400 mt-0.5">
                                {priceQuoteMode === 'range'
                                  ? 'AI gives a price range and tells the customer the dispatcher will confirm the exact number.'
                                  : 'AI quotes the exact table price — no range, no dispatcher hand-off.'}
                              </p>
                            </div>
                            <div className="flex gap-1.5 shrink-0">
                              {(['range', 'exact'] as const).map(m => (
                                <button
                                  key={m}
                                  onClick={() => {
                                    setPriceQuoteMode(m);
                                    quickSaveSettings({ priceQuoteMode: m }, { successMsg: `Price: ${m === 'range' ? 'Range' : 'Exact'}`, fanout: true });
                                  }}
                                  className={`text-[11px] px-2.5 py-1.5 rounded-lg font-semibold border-2 transition-all ${priceQuoteMode === m ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-slate-500 border-slate-200 hover:border-violet-200'}`}
                                >
                                  {m === 'range' ? 'Range' : 'Exact'}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    );
                  })()}

                  {/* Auto Reply Availability — gates when AI replies.
                      "Always (24/7)" → aiConversationMode='always'.
                      "Outside of business hours" → aiConversationMode='when_dispatcher_unavailable'
                      (AI replies only outside the User's Business Hours window;
                      configure that window in Settings → General). */}
                  <div>
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">Auto Reply Availability</label>
                    <p className="text-[11px] text-slate-400 mb-2">Choose when AI can reply automatically.</p>
                    <div className="flex gap-2">
                      <button onClick={() => {
                          setFuAvailability('always');
                          saveAvailabilityNow('always');
                          if (selectedAccountId) usersApi.updateAccountHours(selectedAccountId, { aiConversationMode: 'always' }).catch(() => {});
                        }}
                        className={`flex-1 py-2 px-3 rounded-xl text-xs font-semibold border-2 transition-all ${fuAvailability === 'always' ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 text-slate-500 border-slate-200 hover:border-blue-200'}`}>
                        Always (24/7)
                      </button>
                      <button onClick={() => {
                          setFuAvailability('active_hours');
                          saveAvailabilityNow('active_hours');
                          if (selectedAccountId) usersApi.updateAccountHours(selectedAccountId, { aiConversationMode: 'when_dispatcher_unavailable' }).catch(() => {});
                        }}
                        className={`flex-1 py-2 px-3 rounded-xl text-xs font-semibold border-2 transition-all ${fuAvailability === 'active_hours' ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 text-slate-500 border-slate-200 hover:border-blue-200'}`}>
                        Outside of business hours
                      </button>
                    </div>
                    {fuAvailability === 'active_hours' && (
                      <p className="text-[11px] text-slate-400 mt-2">
                        Using the master Business Hours window from <span className="font-semibold">Settings → General</span>. AI replies only outside it.
                      </p>
                    )}
                  </div>

                  {/* AI Conversation Rules (collapsed) */}
                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <button onClick={() => setAiShowRules(!aiShowRules)} className="w-full px-4 py-3 flex items-center justify-between bg-slate-50 hover:bg-slate-100 transition-colors">
                      <div>
                        <span className="text-[11px] font-bold text-slate-600 uppercase tracking-widest">AI Conversation Rules</span>
                        <p className="text-[10px] text-slate-400 mt-0.5">Control when AI replies, pauses, or hands off to a manager.</p>
                      </div>
                      {aiShowRules ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                    </button>
                    {aiShowRules && (
                      <div className="px-4 py-4 space-y-5 border-t border-slate-100">
                        <p className="text-[11px] text-slate-400">Control when AI stops replying and when a manager should take over.</p>
                        <div>
                          <div className="text-[11px] font-semibold text-slate-600 mb-2">AI stops replying when:</div>
                          <div className="space-y-1.5">
                            <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                              <input type="checkbox" checked={aiStopOnOptOut} onChange={e => setAiStopOnOptOut(e.target.checked)} className="accent-violet-600 w-3.5 h-3.5" />
                              Customer asks not to be contacted
                            </label>
                            <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                              <input type="checkbox" checked={aiStopOnBooked} onChange={e => setAiStopOnBooked(e.target.checked)} className="accent-violet-600 w-3.5 h-3.5" />
                              Job is booked or confirmed
                            </label>
                            <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                              <input type="checkbox" checked={aiStopOnPriceAgreed} onChange={e => setAiStopOnPriceAgreed(e.target.checked)} className="accent-violet-600 w-3.5 h-3.5" />
                              Customer agrees on price — hand off to manager
                            </label>
                            <div className="flex items-center gap-2 text-sm text-slate-500">
                              <span className="text-emerald-500 text-xs">&#10003;</span> Lead is done, scheduled, or archived
                            </div>
                          </div>
                        </div>

                        {/* ── Human Takeover — five per-account trigger toggles.
                            Each maps to a backend handoff reason. Three of them
                            (provided_phone_number, provided_square_footage,
                            qualification_complete) are also strategy-gated on
                            the backend (only fire when the active AI Strategy
                            makes the data point actionable). The alert template
                            itself lives in Settings → Communication so this
                            block stays focused on WHEN to hand off, not HOW the
                            SMS reads. */}
                        <div className="rounded-xl border border-violet-100 bg-violet-50/30 px-4 py-3 space-y-3">
                          <div>
                            <div className="text-[11px] font-bold text-violet-700 uppercase tracking-widest">Human Takeover</div>
                            <p className="text-[10px] text-slate-500 mt-0.5 leading-relaxed">
                              Notify manager when AI detects the customer needs a human. These rules only apply while <span className="font-semibold text-slate-600">AI Conversation</span> is active. Alert templates are managed in <Link to="/settings#communication-alerts" className="font-semibold text-blue-600 hover:underline">Settings → Communication</Link>.
                            </p>
                          </div>
                          <div className="space-y-1.5">
                            <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                              <input type="checkbox" checked={handoffTriggerAgreed} onChange={e => setHandoffTriggerAgreed(e.target.checked)} className="accent-violet-600 w-3.5 h-3.5" />
                              Ready to book
                            </label>
                            <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                              <input type="checkbox" checked={handoffTriggerWantsLiveContact} onChange={e => setHandoffTriggerWantsLiveContact(e.target.checked)} className="accent-violet-600 w-3.5 h-3.5" />
                              Wants live contact
                            </label>
                            <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer" title="Only fires when AI Strategy is set to Phone, or the lead has no usable phone number yet.">
                              <input type="checkbox" checked={handoffTriggerProvidedPhone} onChange={e => setHandoffTriggerProvidedPhone(e.target.checked)} className="accent-violet-600 w-3.5 h-3.5" />
                              Provided phone number
                            </label>
                            <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer" title="Only fires when AI Strategy is set to Qualify, or price quote mode is Exact.">
                              <input type="checkbox" checked={handoffTriggerProvidedSquareFootage} onChange={e => setHandoffTriggerProvidedSquareFootage(e.target.checked)} className="accent-violet-600 w-3.5 h-3.5" />
                              Provided square footage
                            </label>
                            <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer" title="Fires when the customer has answered enough details (cleaning type, beds, baths, size, date) for the dispatcher to act.">
                              <input type="checkbox" checked={handoffTriggerQualificationComplete} onChange={e => setHandoffTriggerQualificationComplete(e.target.checked)} className="accent-violet-600 w-3.5 h-3.5" />
                              Qualification complete
                            </label>
                          </div>
                          <Link to="/settings#communication-alerts" className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 hover:underline">
                            Edit alert template →
                          </Link>
                          <div className="flex items-center gap-2 text-sm text-slate-500 bg-white/70 border border-violet-100 rounded-lg px-3 py-2">
                            <span className="text-emerald-500 text-xs">&#10003;</span>
                            Manager can always take over by sending a message manually
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
            </ServiceCard>
          )}

          {/* 5. AI Optimization — disabled */}
          <div className="hidden bg-white rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
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
              <div className="border border-slate-200 rounded-2xl p-5 hover:border-indigo-200 transition-all cursor-pointer" onClick={() => { setShowPhoneSetupModal(false); navigate('/settings'); }}>
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center shrink-0 mt-0.5"><Briefcase className="w-4 h-4" /></div>
                  <div>
                    <p className="font-semibold text-slate-900 text-sm">Dedicated Number</p>
                    <p className="text-xs text-slate-500 mt-1">Get a Twilio number exclusively assigned to your account.</p>
                  </div>
                </div>
              </div>
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

      {/* Follow-up step popup (chip click) — edits delay + (Template-mode only) message */}
      <TemplateEditorModal
        isOpen={!!fuStepEditor}
        onClose={() => setFuStepEditor(null)}
        mode="service-edit"
        initialName=""
        initialContent={fuStepEditor?.message || ''}
        initialDelay={fuStepEditor?.delay || ''}
        showDelayField={true}
        delayPresets={['2 min', '10 min', '1 hour', '4 hours', '1 day', '3 days', '7 days', '2 weeks', '1 month']}
        templateName={fuStepEditor != null ? `Step #${fuStepEditor.idx + 1}` : ''}
        saving={false}
        variables={SMS_VARIABLES}
        existingNames={[]}
        hideContentField={fuReplyType === 'ai'}
        contentPlaceholder={fuReplyType === 'ai' ? (
          <span>AI generates this message from the conversation when the step fires, using your <span className="font-semibold capitalize text-slate-700">{fuStrategy}</span> strategy. Switch Follow-up Mode to <span className="font-semibold">Custom Template</span> above to write a fixed message instead.</span>
        ) : undefined}
        onSave={({ content, delay }) => {
          if (fuStepEditor == null) return;
          const idx = fuStepEditor.idx;
          setFuSmartSteps(prev => prev.map((s, i) => {
            if (i !== idx) return s;
            // In AI mode the popup didn't edit the message, so keep the existing
            // (empty) message. In Template mode use the popup's content.
            return {
              ...s,
              delay: delay ?? s.delay,
              ...(fuReplyType === 'ai' ? {} : { message: content }),
            };
          }));
          setFuStepEditor(null);
        }}
      />

      {/* Pricing Table Modal — read-only View or full Edit */}
      {showPricingModal && selectedAccountId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setShowPricingModal(false)}>
          <div className="bg-white rounded-3xl shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col relative" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="shrink-0 bg-white border-b border-slate-100 px-8 pt-5 pb-0 rounded-t-3xl">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-xl font-bold text-slate-900">Pricing Table</h3>
                  <p className="text-sm text-slate-500 mt-0.5">AI will use these prices to write the first reply.</p>
                </div>
                <button onClick={() => setShowPricingModal(false)} className="text-slate-400 hover:text-slate-600 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
              {/* Tabs */}
              <div className="flex gap-1 mt-5 -mb-px">
                {(['view', 'edit'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setPricingModalTab(t)}
                    className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${
                      pricingModalTab === t
                        ? 'border-blue-600 text-blue-700'
                        : 'border-transparent text-slate-400 hover:text-slate-600'
                    }`}
                  >
                    {t === 'view' ? 'View' : 'Edit'}
                  </button>
                ))}
              </div>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto px-8 py-6">
              {pricingModalTab === 'edit' ? (
                <div className="space-y-5">
                  {accounts.length > 1 && (
                    <div className="flex items-center justify-between gap-3 bg-blue-50/60 border border-blue-100 rounded-xl px-4 py-3">
                      <div className="text-xs text-slate-700 leading-relaxed">
                        <span className="font-semibold text-slate-900">Pricing is per-account.</span> Save your changes below, then use this button to copy the same prices to every other account.
                      </div>
                      <button
                        type="button"
                        onClick={handleCopyPricingToAll}
                        disabled={copyingPricingToAll}
                        className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
                      >
                        {copyingPricingToAll ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                        Copy to all accounts
                      </button>
                    </div>
                  )}
                  {copyPricingResult && (
                    <div className="text-xs text-slate-600 px-2">{copyPricingResult}</div>
                  )}
                  <ServicePricingForm
                    accountId={selectedAccountId}
                    accountName={accounts.find(a => a.id === selectedAccountId)?.businessName || ''}
                  />
                </div>
              ) : pricingPreviewLoading ? (
                <div className="flex items-center gap-2 text-sm text-slate-400 py-8 justify-center">
                  <Loader2 size={16} className="animate-spin" /> Loading pricing...
                </div>
              ) : (() => {
                const p = pricingPreview || DEFAULT_CLEANING_PRICING;
                const enabledTypes = (p.cleaningTypes || []).filter((t: any) => t.enabled);
                const isDefault = !pricingPreview && !pricingPreviewInherited;
                return (
                  <div className="space-y-6 text-sm">
                    {isDefault && (
                      <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-xs text-slate-600 leading-relaxed">
                        <span className="font-semibold">Default pricing shown.</span> Switch to <button className="underline font-semibold" onClick={() => setPricingModalTab('edit')}>Edit</button> to customize rates for this account.
                      </div>
                    )}
                    {pricingPreviewInherited && (
                      <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-3 text-xs text-amber-800 leading-relaxed">
                        <span className="font-semibold">Inherited pricing.</span> This account has no pricing of its own, so the AI will use the pricing from another one of your accounts. Switch to <button className="underline font-semibold" onClick={() => setPricingModalTab('edit')}>Edit</button> to set pricing specifically for this account.
                      </div>
                    )}
                    {/* Service type + enabled types */}
                    <div>
                      <div className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">Service</div>
                      <div className="flex items-center flex-wrap gap-2">
                        <span className="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold capitalize">{p.serviceType || 'cleaning'}</span>
                        {enabledTypes.map((t: any) => (
                          <span key={t.key} className="px-2.5 py-1 bg-blue-50 text-blue-700 rounded-lg text-xs font-semibold">{t.label}</span>
                        ))}
                      </div>
                    </div>

                    {/* Price table */}
                    {p.priceTable?.length > 0 && enabledTypes.length > 0 && (
                      <div>
                        <div className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">Base Prices</div>
                        <div className="border border-slate-200 rounded-xl overflow-hidden">
                          <table className="w-full text-sm">
                            <thead className="bg-slate-50">
                              <tr className="text-slate-500">
                                <th className="px-3 py-2 text-left font-semibold text-xs">Bed</th>
                                <th className="px-3 py-2 text-left font-semibold text-xs">Bath</th>
                                {enabledTypes.map((t: any) => (
                                  <th key={t.key} className="px-3 py-2 text-left font-semibold text-xs">{t.label}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {p.priceTable.map((row: any, i: number) => (
                                <tr key={i} className="border-t border-slate-100">
                                  <td className="px-3 py-2 text-slate-700 font-medium">{row.bed}</td>
                                  <td className="px-3 py-2 text-slate-700 font-medium">{row.bath}</td>
                                  {enabledTypes.map((t: any) => (
                                    <td key={t.key} className="px-3 py-2 text-slate-900 font-semibold">${row[t.key] || '—'}</td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {/* Frequency discounts */}
                    {p.frequencyDiscounts?.some((fd: any) => fd.discount > 0) && (
                      <div>
                        <div className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">Recurring Discounts</div>
                        <div className="flex flex-wrap gap-2">
                          {p.frequencyDiscounts.filter((fd: any) => fd.discount > 0).map((fd: any) => (
                            <span key={fd.key} className="px-2.5 py-1.5 bg-emerald-50 text-emerald-700 rounded-lg text-xs font-semibold">
                              {fd.label}: {fd.discount}% off
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Extras */}
                    {p.extras?.some((e: any) => e.label && e.price > 0) && (
                      <div>
                        <div className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">Add-ons</div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                          {p.extras.filter((e: any) => e.label && e.price > 0).map((e: any) => (
                            <div key={e.key} className="flex items-center justify-between px-3 py-1.5 bg-slate-50 rounded-lg">
                              <span className="text-slate-700">{e.label}</span>
                              <span className="text-slate-900 font-semibold">+${e.price}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Condition surcharges */}
                    {p.conditionSurcharges?.some((c: any) => c.surcharge > 0) && (
                      <div>
                        <div className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">Condition Surcharges</div>
                        <div className="flex flex-wrap gap-2">
                          {p.conditionSurcharges.filter((c: any) => c.surcharge > 0).map((c: any) => (
                            <span key={c.key} className="px-2.5 py-1.5 bg-amber-50 text-amber-700 rounded-lg text-xs font-semibold">
                              {c.label}: +${c.surcharge}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Misc */}
                    {(p.petSurcharge > 0 || p.recurringDiscount > 0 || p.orderDiscounts?.some((od: any) => od.minAmount > 0 && od.discount > 0)) && (
                      <div>
                        <div className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2">Other</div>
                        <div className="space-y-1.5">
                          {p.petSurcharge > 0 && <div className="text-slate-700">Pet surcharge: <span className="font-semibold text-slate-900">+${p.petSurcharge}</span></div>}
                          {p.recurringDiscount > 0 && <div className="text-slate-700">Recurring service discount: <span className="font-semibold text-slate-900">{p.recurringDiscount}% off</span></div>}
                          {p.orderDiscounts?.filter((od: any) => od.minAmount > 0 && od.discount > 0).map((od: any, i: number) => (
                            <div key={i} className="text-slate-700">Orders over ${od.minAmount}: <span className="font-semibold text-slate-900">{od.discount}% off</span></div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="pt-2 flex justify-end">
                      <button
                        onClick={() => setPricingModalTab('edit')}
                        className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-semibold hover:bg-blue-700 transition-colors"
                      >
                        <Pencil className="w-3 h-3" /> Edit pricing
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
