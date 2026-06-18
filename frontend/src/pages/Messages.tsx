import { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight,
  Send,
  Phone,
  MapPin,
  Calendar,
  DollarSign,
  Tag,
  User,
  Loader2,
  MessageSquare,
  RefreshCw,
  AlertCircle,
  Building2,
  X,
  Search,
  CheckSquare,
  Square,
  Mail,
  FileText,
  ChevronDown,
  ChevronRight,
  Smartphone,
  MessageCircle,
  Sparkles,
  AlertTriangle,
} from 'lucide-react';
import api, { leadsApi, thumbtackApi, templatesApi, bulkMessageApi, notificationsApi, aiApi, conversationContextApi, conversationRuntimeApi, followUpApi, type MessageAttachment, type StatusConflict, type RuntimeStateResponse, type PendingAiSuggestion } from '../services/api';
import { useAppStore } from '../store/appStore';
import { notify } from '../store/notificationStore';
import { useAuthStore } from '../store/authStore';
import AdminNoAccountsState from '../components/AdminNoAccountsState';
import NoAccountsOverlay from '../components/NoAccountsOverlay';
import { PlatformBadge, StatusPill } from '../components/ui';
import { displayLabel, displayPillKind, STATUS_FILTER_OPTIONS, matchesGroupFilter, matchesRefundedFilter, matchesRefundableFilter, type StatusGroupId } from '../lib/leadStatus';
import { LeadActivityTimeline } from '../components/LeadActivityTimeline';
import type { Lead, MessageTemplate, BulkMessagePreview, NotificationLog, TimelineEvent, TimelineChannel, CommunicationSummary } from '../types';

interface LocalMessage {
  id: string;
  content: string;
  sender: 'pro' | 'customer';
  senderType?: 'user' | 'ai' | null;
  sentAt: Date;
  externalId?: string;
  attachments?: MessageAttachment[];
  platform?: string;
  deliveredAt?: string;
  notificationLogId?: string;
}

// Helper to get/set last seen timestamps from localStorage
const LAST_SEEN_KEY = 'leads_last_seen';

function getLastSeenTimestamps(): Record<string, string> {
  try {
    const stored = localStorage.getItem(LAST_SEEN_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

function setLastSeenTimestamp(leadId: string, timestamp: string): void {
  const timestamps = getLastSeenTimestamps();
  timestamps[leadId] = timestamp;
  localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(timestamps));
}

// Module-level flag — once we've fetched leads at least once, don't show loading spinner on re-mount
let _messagesLoaded = false;

function hasNewUpdates(lead: Lead, lastSeenTimestamps: Record<string, string>): boolean {
  const lastSeen = lastSeenTimestamps[lead.id];
  // Use lastMessageAt if available, otherwise fall back to createdAt
  const lastMessageTime = lead.lastMessageAt || lead.createdAt;
  if (!lastSeen) {
    // Never seen - but only mark as "new" if there's been activity after the lead was created
    // This prevents newly imported leads from showing as "new"
    return lead.lastMessageAt ? new Date(lead.lastMessageAt) > new Date(lead.createdAt) : false;
  }
  return new Date(lastMessageTime) > new Date(lastSeen);
}

// Merge platform messages and SMS logs into a unified timeline
// customerPhone: filter to only show SMS sent TO the customer (exclude internal alerts to business owner)
function mergeTimeline(
  platformMessages: LocalMessage[],
  smsLogs: NotificationLog[],
  customerPhone?: string | null,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const smsLogIdsFromMessages = new Set<string>(); // Track SMS Message records to avoid duplicates

  for (const msg of platformMessages) {
    // SMS messages stored as Message records (platform: 'sms')
    if ((msg as any).platform === 'sms') {
      const logId = (msg as any).notificationLogId as string | undefined;
      // Cross-reference the NotificationLog to get the actual delivery status
      // (Message records have no failure state; the log has the authoritative status)
      const matchingLog = logId ? smsLogs.find(l => l.id === logId) : null;
      const smsStatus: TimelineEvent['smsStatus'] = matchingLog
        ? (matchingLog.status as TimelineEvent['smsStatus'])
        : ((msg as any).deliveredAt ? 'delivered' : 'sent');
      events.push({
        id: `sms-msg-${msg.id}`,
        channel: 'sms',
        direction: msg.sender === 'customer' ? 'inbound' : 'outbound',
        content: msg.content,
        timestamp: msg.sentAt,
        sender: msg.sender,
        smsStatus,
        smsError: matchingLog?.error ?? undefined,
      });
      if (logId) smsLogIdsFromMessages.add(logId);
      continue;
    }

    events.push({
      id: `platform-${msg.id}`,
      channel: 'platform',
      direction: msg.sender === 'pro' ? 'outbound' : 'inbound',
      content: msg.content,
      timestamp: msg.sentAt,
      sender: msg.sender,
      senderType: msg.senderType || null,
      externalId: msg.externalId,
      attachments: msg.attachments,
    });
  }

  // Only include SMS logs sent TO the customer (filter out internal alerts to business owner)
  // Also skip logs that already have a Message record (to avoid duplicates)
  for (const log of smsLogs) {
    // Skip if already added via Message record
    if (smsLogIdsFromMessages.has(log.id)) continue;

    // Skip if no customer phone or SMS wasn't sent to customer
    if (!customerPhone || !log.toPhone) continue;

    // Normalize phone numbers for comparison (remove non-digits)
    const normalizedCustomerPhone = customerPhone.replace(/\D/g, '');
    const normalizedToPhone = log.toPhone.replace(/\D/g, '');

    // Only include SMS sent to the customer (not alerts sent to business owner)
    if (normalizedToPhone !== normalizedCustomerPhone) continue;

    events.push({
      id: `sms-${log.id}`,
      channel: 'sms',
      direction: 'outbound',
      content: log.messageBody,
      timestamp: new Date(log.sentAt || log.createdAt),
      sender: 'system',
      smsStatus: log.status as TimelineEvent['smsStatus'],
      smsError: log.error,
      toPhone: log.toPhone,
      fromPhone: log.fromPhone,
      ruleName: log.ruleName,
      deliveredAt: log.deliveredAt,
    });
  }

  events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return events;
}

/**
 * Build the inline "needs-dispatcher" banner copy from the conversation
 * runtime state. Returns null when the AI is actively engaging (no banner).
 *
 * Mapping mirrors AI_STATUS_REASONS in src/conversation-context/conversation-runtime.ts
 * — keep the two in sync when new reasons are added on the backend.
 */
function getDispatcherBannerCopy(
  rt: RuntimeStateResponse | null,
  lastEventInbound: boolean,
): { title: string; reason: string | null } | null {
  if (!rt?.threadContext) return null;
  const tc = rt.threadContext;
  const handoffOpen = !!tc.handoffRequestedAt && !tc.handoffResolvedAt;
  const aiStatus = tc.aiStatus;
  const reasonTag = tc.aiStatusReason;

  // Only suggest the dispatcher act when the customer is the latest speaker.
  if (!lastEventInbound && !handoffOpen) return null;

  if (handoffOpen) {
    const reasonMap: Record<string, string> = {
      agreed: 'Customer is ready to book.',
      wants_live_contact: 'Customer asked to speak with a person.',
      provided_phone_number: 'Customer shared a phone number.',
      provided_square_footage: 'Customer shared square footage.',
      qualification_complete: 'Qualification questions are answered.',
    };
    const why = tc.handoffRequestedReason
      ? reasonMap[tc.handoffRequestedReason] || `Handoff: ${tc.handoffRequestedReason}.`
      : null;
    return { title: 'Handoff requested — please reply', reason: why };
  }

  if (!aiStatus || aiStatus === 'active' || aiStatus === 'ai_engaging') return null;

  const reasonCopy: Record<string, string> = {
    user_ai_conversation_disabled: 'AI Conversation is turned off in your settings.',
    outside_business_hours: 'AI is set to reply only when the dispatcher is unavailable, and we are inside business hours.',
    manual_reply_recency_window: 'A manual reply was sent recently — AI is paused while you handle this thread.',
    classifier_opt_out: 'Customer opted out — AI stopped.',
    classifier_hired_elsewhere: 'Customer hired someone else — AI stopped.',
    classifier_agreed: 'Customer agreed to book — AI handed off to you.',
    classifier_wants_live_contact: 'Customer asked for a live person — AI handed off.',
    classifier_deferring: 'Customer is deferring — AI paused, follow-up scheduled.',
    crm_terminal_status_legacy: 'Lead status is terminal — AI stopped.',
  };

  const reason = reasonTag ? reasonCopy[reasonTag] || null : null;

  if (aiStatus === 'disabled') return { title: 'AI Conversation is off — please reply', reason };
  if (aiStatus === 'unavailable') return { title: 'AI is off duty — please reply', reason };
  if (aiStatus === 'paused_human') return { title: 'AI is paused — please reply', reason };
  if (aiStatus === 'paused_deferral') return { title: 'AI paused on deferral — please reply', reason };
  if (aiStatus === 'stopped_terminal' || aiStatus === 'stopped_booked') {
    return { title: 'AI stopped — please reply', reason };
  }
  return null;
}

/**
 * LeadBridge canonical pipeline statuses (mirrors LB_PIPELINE_STATUSES on the
 * backend — see src/integrations/service-flow/sf-status-map.ts). Manual writes
 * from the status dropdown must use one of these values.
 */
const LB_PIPELINE_STATUSES: Array<{ value: string; label: string; tone: string }> = [
  { value: 'new',         label: 'New',         tone: 'bg-blue-100 text-blue-700' },
  { value: 'contacted',   label: 'Contacted',   tone: 'bg-green-100 text-green-700' },
  { value: 'quoted',      label: 'Quoted',      tone: 'bg-orange-100 text-orange-700' },
  { value: 'scheduled',   label: 'Scheduled',   tone: 'bg-purple-100 text-purple-700' },
  { value: 'in_progress', label: 'In progress', tone: 'bg-amber-100 text-amber-700' },
  { value: 'completed',   label: 'Completed',   tone: 'bg-emerald-100 text-emerald-700' },
  { value: 'cancelled',   label: 'Cancelled',   tone: 'bg-slate-200 text-slate-700' },
  { value: 'no_show',     label: 'No show',     tone: 'bg-slate-200 text-slate-700' },
  { value: 'lost',        label: 'Lost',        tone: 'bg-red-100 text-red-700' },
  { value: 'archived',    label: 'Archived',    tone: 'bg-slate-100 text-slate-500' },
];

/**
 * Tone classes per UI status group, used by the detail-header pill so legacy
 * raw values fold into the same colour as the canonical group. Keys match
 * displayPillKind() output in lib/leadStatus.ts.
 */
const STATUS_GROUP_TONE: Record<string, string> = {
  active:      'bg-blue-100 text-blue-700',
  scheduled:   'bg-purple-100 text-purple-700',
  in_progress: 'bg-amber-100 text-amber-700',
  done:        'bg-emerald-100 text-emerald-700',
  no_hire:     'bg-red-100 text-red-700',
  archived:    'bg-slate-100 text-slate-500',
  neutral:     'bg-slate-100 text-slate-600',
};

// Mirrors SF_JOB_OUTCOME_LABELS in src/conversation-context/conversation-runtime-display.ts.
// Inlined here because the backend module isn't bundled for the frontend; if the
// runtime-state endpoint's display-label list is extended, mirror it below.
const SF_JOB_OUTCOME_LABEL: Record<string, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  scheduled: 'Scheduled',
  rescheduled: 'Rescheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
  archived: 'Archived',
  lost: 'Lost',
};

function computeSummary(
  platformMessages: LocalMessage[],
  smsLogs: NotificationLog[],
): CommunicationSummary {
  return {
    platformMessages: platformMessages.length,
    smsSent: smsLogs.filter(l => ['sent', 'delivered', 'queued'].includes(l.status)).length,
    smsDelivered: smsLogs.filter(l => l.status === 'delivered').length,
    smsFailed: smsLogs.filter(l => l.status === 'failed').length,
    calls: 0,
  };
}

export function Messages() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { leads, setLeads, selectedLead, setSelectedLead, configuredBusinessId, savedAccounts, setSavedAccounts } = useAppStore();
  const [loading, setLoading] = useState(!_messagesLoaded && leads.length === 0);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [aiPreview, setAiPreview] = useState<Record<string, { loading: boolean; reply: string | null; contextMode?: string }>>({});
  const aiContextMode = 'full' as const;
  const [strategySuggestion, setStrategySuggestion] = useState<{
    suggested: string; reason: string; confidence: number; scores: Record<string, number>; threadState: Record<string, any>;
  } | null>(null);
  const [activeStrategyKey, setActiveStrategyKey] = useState<string | null>(null);
  const [, setStrategySuggestionLoading] = useState(false);
  const [threadContextData, setThreadContextData] = useState<{
    systemContext: string; threadState: Record<string, any>;
  } | null>(null);
  // Per-thread strategy preview row. Narrowed from 5 → 3 to match the new
  // 4-goal model (Auto / Price / Qualify / Phone). Auto isn't a manual
  // override target — it means "no override, use suggestStrategy()" — so
  // it doesn't appear here. Hybrid + Convert removed from the UI; the
  // backend STRATEGY_PROMPTS still defines them, so any legacy
  // followUpStrategy='hybrid' / 'convert' value continues to work at
  // runtime. suggestStrategy() may still return 'hybrid' / 'convert' for
  // legacy-tuned threads; those just won't get a visible isSuggested
  // highlight on any button — soft graceful degradation.
  const AI_STRATEGIES = [
    { key: 'price', label: 'Price', emoji: '💰', prompt: 'STRATEGY: PRICE ANCHOR\n\nUse when:\n- Customer asks about price directly\n- Or pricing is the main concern\n\nYou MUST:\n- Lead with a price range based on pricing settings\n- Briefly explain what is included\n\nDO NOT:\n- Ask questions\n- Be vague or hesitant\n\nTone:\n- Confident and clear\n\nGoal: Give the customer a number to react to.\nExample style: "For a 1-bedroom home, pricing typically runs around $120-150 depending on condition. This includes kitchen, bathroom, and full surface cleaning."' },
    { key: 'qualify', label: 'Qualify', emoji: '🧠', prompt: 'STRATEGY: QUALIFICATION\n\nUse when:\n- Critical details are missing (home size, timing, condition)\n\nYou MUST:\n- Ask 2-3 specific questions\n- Briefly explain why you need the info\n\nDO NOT:\n- Give pricing\n- Use if enough info is already provided\n\nGoal: Collect only the minimum info needed to move to pricing or booking.\nExample style: "To give you an accurate quote, I just need a couple quick details — how many bedrooms and bathrooms, and what condition is the home in?"' },
    { key: 'phone', label: 'Phone', emoji: '📱', prompt: 'STRATEGY: PHONE / ESCALATION\n\nUse when:\n- Job is complex\n- Customer asks for exact quote\n- You need confirmation\n- High-intent lead\n\nFlow:\nStep 1 — explain why call is needed:\n- "Every home is a bit different..."\n- "We\'ll prepare an accurate estimate..."\n\nStep 2 — ask for phone naturally:\n- "What\'s the best number to reach you?"\n\nIf hesitation:\n- Offer texting option\n\nStep 3 — confirm next step:\n- "We\'ll call you shortly"\n- OR send booking link if requested\n\nDO NOT:\n- Push phone too early\n- Sound forceful\n\nTone:\n- Helpful, process-driven, professional\n\nExample style: "Every home is a little different — size and condition affect pricing. We can prepare an accurate estimate for you. What\'s the best number to reach you?"\n\nIf they resist: "No problem, we can text — just need your number to send the estimate and coordinate everything."\n\nIf they want booking: "Absolutely — you can book online here: [link]. We\'ll follow up to confirm details."' },
  ];
  const [resyncingMessages, setResyncingMessages] = useState(false);
  const [resyncError, setResyncError] = useState<string | null>(null);
  const [messageText, setMessageText] = useState('');
  const [, setMessages] = useState<LocalMessage[]>([]);
  const [lastSeenTimestamps, setLastSeenTimestamps] = useState<Record<string, string>>(() => getLastSeenTimestamps());
  const [searchQuery, setSearchQuery] = useState('');
  // Lead selected for the "Possibly refundable" proof modal. Null = closed.
  const [refundableProofLead, setRefundableProofLead] = useState<Lead | null>(null);
  // Get account filter from URL params, default to 'all'
  const accountFilter = searchParams.get('account') || localStorage.getItem('lb_last_account_filter') || 'all';
  // Get date filter from URL params, default to 'all' (no filter)
  const dateFilter = searchParams.get('date') || 'all';
  // Status group filter — keys match StatusGroupId in lib/leadStatus.ts.
  const statusFilter = (searchParams.get('status') || 'all') as 'all' | StatusGroupId;
  // Activity sub-bucket filter — only meaningful when statusFilter='active'.
  // Mirrors Lead.activityBucket (derived from ThreadContext.conversationState).
  type ActivityFilter = 'all' | 'engagement' | 'ai_conversation' | 'follow_up' | 'human_handoff';
  const activityFilter = (searchParams.get('activity') || 'all') as ActivityFilter;
  // "Hide auto-handled" toggle: hides leads whose only outbound activity is
  // AI sends (no human reply, no customer reply). Default on so the inbox
  // surfaces leads needing human attention; persisted per-browser.
  const [hideAutoHandled, setHideAutoHandled] = useState<boolean>(
    () => localStorage.getItem('lb_hide_auto_handled') !== 'false',
  );
  useEffect(() => {
    localStorage.setItem('lb_hide_auto_handled', String(hideAutoHandled));
  }, [hideAutoHandled]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Message cache: stores loaded timeline + summary per lead ID to avoid re-fetching
  const messageCache = useRef<Record<string, { timeline: TimelineEvent[]; summary: CommunicationSummary; cachedAt: number }>>({});
  // Mirrors `selectedLead` so the SSE handler (closed over once at mount) can
  // see the currently-active lead instead of the one selected at mount time.
  const selectedLeadRef = useRef<Lead | null>(null);
  // Mirrors `loadMessagesForLead` so the SSE handler invokes the latest closure
  // (which captures up-to-date state setters and the freshest dependencies).
  const loadMessagesForLeadRef = useRef<(lead: Lead, forceRefresh?: boolean) => void>(() => {});

  // Multi-select state
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(new Set());

  // Bulk send modal state
  const [showBulkSendModal, setShowBulkSendModal] = useState(false);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [customMessage, setCustomMessage] = useState('');
  const [bulkPreviews, setBulkPreviews] = useState<BulkMessagePreview[]>([]);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [sendingBulk, setSendingBulk] = useState(false);
  const [bulkSendProgress, setBulkSendProgress] = useState<{ sent: number; total: number } | null>(null);

  // Unified timeline state
  const [, setSmsLogs] = useState<NotificationLog[]>([]);
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const [channelFilter, setChannelFilter] = useState<'all' | TimelineChannel>('all');
  // Follow-up suggestions
  const [fuSuggestions, setFuSuggestions] = useState<any[]>([]);
  const [fuEditMsg, setFuEditMsg] = useState('');
  const [fuEditId, setFuEditId] = useState<string | null>(null);
  // V2 Review Mode: pending AI draft for the currently selected lead. Comes
  // from the messages payload (no extra fetch) so it appears on first paint
  // when the operator opens a thread with a parked draft.
  const [pendingAiSuggestion, setPendingAiSuggestion] = useState<PendingAiSuggestion | null>(null);
  const [aiSuggestionBusy, setAiSuggestionBusy] = useState<'sending' | 'discarding' | null>(null);
  // Leads that currently carry a parked draft. Populated from the same
  // payload as the active thread (per-lead pending-suggestion map). Drives
  // the yellow "AI Draft Pending" badge in the lead list. Resets when the
  // user navigates away from a lead so stale flags don't linger.
  const [leadsWithPendingDraft, setLeadsWithPendingDraft] = useState<Record<string, true>>({});
  const [fuActionLoading, setFuActionLoading] = useState(false);

  // Lead status editor state
  const [statusEditorOpen, setStatusEditorOpen] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);
  const [statusConflict, setStatusConflict] = useState<StatusConflict | null>(null);
  const [statusConflictLeadId, setStatusConflictLeadId] = useState<string | null>(null);

  // Load follow-up suggestions when selected lead changes
  useEffect(() => {
    if (!selectedLead) { setFuSuggestions([]); return; }
    followUpApi.getSuggestions().then(res => {
      setFuSuggestions((res.suggestions || []).filter(
        (s: any) => s.enrollment?.conversationId === selectedLead.threadId
      ));
    }).catch(() => setFuSuggestions([]));
  }, [selectedLead?.id]);

  // Load strategy suggestion + follow-up info when selected lead changes
  useEffect(() => {
    setStrategySuggestion(null);
    setThreadContextData(null);
    setActiveStrategyKey(null);
    setLeadFollowUpInfo(null);
    if (!selectedLead?.threadId) return;
    setStrategySuggestionLoading(true);
    conversationContextApi.suggestStrategy(selectedLead.threadId)
      .then(res => {
        if (res.success) setStrategySuggestion({ suggested: res.suggested, reason: res.reason, confidence: res.confidence, scores: res.scores || {}, threadState: res.threadState });
      })
      .catch(() => {})
      .finally(() => setStrategySuggestionLoading(false));

    // Load follow-up enrollment info (rich data for right panel)
    if (selectedLead?.id && selectedLead?.threadId) {
      followUpApi.getEnrollmentInfo(selectedLead.threadId)
        .then(res => {
          if (res.enrollment) {
            setLeadFollowUpInfo({
              enrollmentId: res.enrollment.id,
              nextFollowUpAt: res.enrollment.nextStepDueAt || null,
              followUpStatus: res.enrollment.status || null,
              currentStepIndex: res.enrollment.currentStepIndex ?? 0,
              totalSteps: res.enrollment.totalSteps ?? 0,
              sentCount: res.enrollment.sentCount ?? 0,
              nextStepObjective: res.enrollment.nextStepObjective || null,
              nextMessagePreview: res.enrollment.nextMessagePreview || null,
              nextMessageMode: res.enrollment.nextMessageMode || 'ai',
              pendingSuggestionId: res.enrollment.pendingSuggestionId || null,
              accountStrategy: res.enrollment.accountStrategy || null,
              aiConversationOn: res.enrollment.aiConversationOn ?? false,
              aiAvailability: res.enrollment.aiAvailability || 'always',
              aiActiveHoursStart: res.enrollment.aiActiveHoursStart || null,
              aiActiveHoursEnd: res.enrollment.aiActiveHoursEnd || null,
              aiTimezone: res.enrollment.aiTimezone || null,
              mode: res.enrollment.mode || 'auto_send',
            });
          } else {
            // No active enrollment — still show AI conversation status + last enrollment context
            const extra = res as any;
            setLeadFollowUpInfo({
              enrollmentId: '',
              nextFollowUpAt: null,
              followUpStatus: extra.lastEnrollment?.status || null,
              currentStepIndex: extra.lastEnrollment?.stepReached || 0,
              totalSteps: 0,
              sentCount: 0,
              nextStepObjective: null,
              nextMessagePreview: null,
              nextMessageMode: 'ai',
              pendingSuggestionId: null,
              accountStrategy: extra.accountStrategy || null,
              aiConversationOn: extra.aiConversationOn ?? false,
              aiAvailability: extra.aiAvailability || 'always',
              aiActiveHoursStart: extra.aiActiveHoursStart || null,
              aiActiveHoursEnd: extra.aiActiveHoursEnd || null,
              aiTimezone: extra.aiTimezone || null,
              mode: extra.followUpMode || 'off',
              lastStoppedReason: extra.lastEnrollment?.stoppedReason || null,
            });
          }
        })
        .catch((err: any) => { console.error('[FollowUp] enrollment-info failed:', err); });
    }
  }, [selectedLead?.id]);

  const [leadFollowUpInfo, setLeadFollowUpInfo] = useState<{
    enrollmentId: string;
    nextFollowUpAt: string | null;
    followUpStatus: string | null;
    currentStepIndex: number;
    totalSteps: number;
    sentCount: number;
    nextStepObjective: string | null;
    nextMessagePreview: string | null;
    nextMessageMode: 'template' | 'ai';
    pendingSuggestionId: string | null;
    accountStrategy: string | null;
    aiConversationOn: boolean;
    aiAvailability: string;
    aiActiveHoursStart: string | null;
    aiActiveHoursEnd: string | null;
    aiTimezone: string | null;
    mode: string;
    lastStoppedReason?: string | null;
  } | null>(null);

  // Per-lead AI runtime state — drives the "needs-dispatcher" inline banner.
  // Re-fetched whenever the timeline grows so the banner appears/disappears
  // in response to new customer replies and dispatcher responses.
  const [runtimeState, setRuntimeState] = useState<RuntimeStateResponse | null>(null);
  useEffect(() => {
    setRuntimeState(null);
    if (!selectedLead?.id) return;
    let cancelled = false;
    conversationRuntimeApi
      .getLeadRuntimeState(selectedLead.id)
      .then((res) => { if (!cancelled) setRuntimeState(res); })
      .catch(() => { if (!cancelled) setRuntimeState(null); });
    return () => { cancelled = true; };
  }, [selectedLead?.id, timelineEvents.length]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [editingPreview, setEditingPreview] = useState(false);
  const [editedMessage, setEditedMessage] = useState('');

  const [sendChannel, setSendChannel] = useState<'platform' | 'sms'>('platform');

  // Mobile panel state: 'list' (leads), 'chat' (conversation), 'details' (lead details)
  const [mobilePanel, setMobilePanel] = useState<'list' | 'chat' | 'details'>('list');
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [commSummary, setCommSummary] = useState<CommunicationSummary>({
    platformMessages: 0, smsSent: 0, smsDelivered: 0, smsFailed: 0, calls: 0,
  });

  // Filtered timeline
  const filteredTimeline = channelFilter === 'all'
    ? timelineEvents
    : timelineEvents.filter(e => e.channel === channelFilter);

  // Inline "needs-dispatcher" banner — derived from runtime state + timeline.
  // Visible when the AI declined/skipped this thread and the customer is the
  // latest speaker. Slides + fades out via CSS transition once the dispatcher
  // replies (the manual reply becomes the new latest event, flipping derived
  // state to false). `bannerMounted` keeps the element in the DOM during the
  // exit animation.
  const lastEvent = filteredTimeline.length > 0 ? filteredTimeline[filteredTimeline.length - 1] : null;
  const lastInbound = lastEvent?.direction === 'inbound';
  const bannerCopy = getDispatcherBannerCopy(runtimeState, lastInbound);
  const needsDispatcher = bannerCopy !== null;
  const [bannerMounted, setBannerMounted] = useState(false);
  const [bannerVisible, setBannerVisible] = useState(false);
  useEffect(() => {
    if (needsDispatcher) {
      setBannerMounted(true);
      const raf = requestAnimationFrame(() => setBannerVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    if (!needsDispatcher && bannerMounted) {
      setBannerVisible(false);
      const t = setTimeout(() => setBannerMounted(false), 500);
      return () => clearTimeout(t);
    }
  }, [needsDispatcher, bannerMounted]);

  // Update account filter in URL
  const setAccountFilter = (value: string) => {
    if (value === 'all') {
      searchParams.delete('account');
      localStorage.removeItem('lb_last_account_filter');
    } else {
      searchParams.set('account', value);
      localStorage.setItem('lb_last_account_filter', value);
    }
    setSearchParams(searchParams);
  };

  // Update date filter in URL
  const setDateFilter = (value: string) => {
    if (value === 'all') {
      searchParams.delete('date');
    } else {
      searchParams.set('date', value);
    }
    setSearchParams(searchParams);
  };

  // Update status filter in URL. Clears the activity sub-filter whenever the
  // primary status changes, since 'activity' is only meaningful under Active.
  const setStatusFilter = (value: 'all' | StatusGroupId) => {
    if (value === 'all') {
      searchParams.delete('status');
    } else {
      searchParams.set('status', value);
    }
    if (value !== 'active') searchParams.delete('activity');
    setSearchParams(searchParams);
  };

  const setActivityFilter = (value: ActivityFilter) => {
    if (value === 'all') {
      searchParams.delete('activity');
    } else {
      searchParams.set('activity', value);
    }
    setSearchParams(searchParams);
  };

  // Parse date filter to get year and month (format: "YYYY-MM")
  const parseDateFilter = (filter: string): { year: number; month: number } | null => {
    if (filter === 'all') return null;
    const match = filter.match(/^(\d{4})-(\d{2})$/);
    if (!match) return null;
    return {
      year: parseInt(match[1], 10),
      month: parseInt(match[2], 10) - 1, // JS months are 0-indexed
    };
  };

  // Generate all months from oldest lead date to current month
  const getMonthOptionsFromLeads = (leadsList: Lead[]): { value: string; label: string }[] => {
    if (leadsList.length === 0) return [];

    // Find the oldest lead date
    let oldestDate = new Date();
    leadsList.forEach(lead => {
      const date = new Date(lead.createdAt);
      if (date < oldestDate) {
        oldestDate = date;
      }
    });

    // Generate all months from oldest lead to now
    const options: { value: string; label: string }[] = [];
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const startYear = oldestDate.getFullYear();
    const startMonth = oldestDate.getMonth();

    // Loop from current month back to oldest month
    for (let year = currentYear; year >= startYear; year--) {
      const monthStart = year === currentYear ? currentMonth : 11;
      const monthEnd = year === startYear ? startMonth : 0;

      for (let month = monthStart; month >= monthEnd; month--) {
        const value = `${year}-${String(month + 1).padStart(2, '0')}`;
        const date = new Date(year, month, 1);
        const label = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        options.push({ value, label });
      }
    }

    return options;
  };

  // Load templates for single message composer
  const [singleMessageTemplates, setSingleMessageTemplates] = useState<MessageTemplate[]>([]);
  const [showTemplateDropdown, setShowTemplateDropdown] = useState(false);

  useEffect(() => {
    loadLeads();
    loadSavedAccounts();
    loadTemplatesForSingleMessage();

    // Refresh leads when tab becomes visible (background refresh - no loading state)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        loadLeadsBackground();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Connect to SSE for real-time lead updates (more efficient than polling)
    const token = localStorage.getItem('token');
    if (!token) {
      console.warn('[Messages] No auth token, skipping SSE connection');
      return () => {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      };
    }

    // EventSource doesn't support custom headers, so pass token as query parameter.
    // Use absolute URL to bypass Vercel's SPA catch-all rewrite and connect directly to the API server.
    //
    // Account-scope query params match the backend contract introduced in PR #138:
    //   - accountFilter === 'all' → scope=all (unified stream across all the user's accounts)
    //   - otherwise              → businessId=<id> (server filters events for one account)
    // The mount useEffect re-runs when accountFilter changes, which closes this
    // EventSource and reopens it with the new scope.
    const API_BASE = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
    const scopeParam = accountFilter === 'all'
      ? 'scope=all'
      : `businessId=${encodeURIComponent(accountFilter)}`;
    const eventSource = new EventSource(
      `${API_BASE}/v1/leads/events?token=${encodeURIComponent(token)}&${scopeParam}`,
    );

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'lead.created') {
          console.log('[Messages] Lead update via SSE:', data.lead?.id);
          // Invalidate message cache for this lead (new message arrived)
          if (data.lead?.id) delete messageCache.current[data.lead.id];
          // Merge silently: update existing lead in-place, or append new one at top
          // NEVER change the currently selected lead
          const incoming = data.lead as Lead;
          const currentLeads = useAppStore.getState().leads;
          const idx = currentLeads.findIndex(l => l.id === incoming.id);
          if (idx >= 0) {
            const updated = [...currentLeads];
            updated[idx] = { ...updated[idx], ...incoming };
            setLeads(updated);
          } else {
            setLeads([incoming, ...currentLeads]);
          }
        } else if (data.type === 'sms.inbound') {
          console.log('[Messages] Inbound SMS received via SSE:', data);
          // Invalidate cache for this lead so next view is fresh
          if (data.leadId) delete messageCache.current[data.leadId];
          // If viewing this lead, add inbound message to timeline in real-time
          if (selectedLead?.id === data.leadId) {
            const newEvent: TimelineEvent = {
              id: `sms-inbound-${data.message?.id || Date.now()}`,
              channel: 'sms',
              direction: 'inbound',
              content: data.message?.content || '',
              timestamp: new Date(data.message?.sentAt || Date.now()),
              sender: 'customer',
            };
            setTimelineEvents(prev => [...prev, newEvent]);
          }
        } else if (data.type === 'sms.status') {
          // Update delivery status of existing SMS in timeline
          setTimelineEvents(prev => prev.map(e => {
            if (e.id.includes(data.messageId) || e.id.includes(data.logId)) {
              return { ...e, smsStatus: data.status as TimelineEvent['smsStatus'], deliveredAt: data.deliveredAt, smsError: data.error || e.smsError };
            }
            return e;
          }));
        } else if (data.type === 'lead.messages.changed') {
          // Backend invalidated the messages cache for this lead (inbound webhook,
          // outbound send, resync). Drop the in-memory cache and, if the user is
          // currently viewing this lead, refetch with fresh=true so they see the
          // new message immediately instead of waiting for the next click.
          //
          // Use refs (not the closed-over state) — this handler was registered
          // once at mount and never sees later renders' state.
          if (data.leadId) {
            delete messageCache.current[data.leadId];
            const active = selectedLeadRef.current;
            if (active && active.id === data.leadId) {
              loadMessagesForLeadRef.current(active, true);
            }
          }
        }
      } catch (err) {
        console.error('[Messages] Error parsing SSE event:', err);
      }
    };

    eventSource.onerror = () => {
      console.warn('[Messages] SSE connection error — browser will auto-reconnect');

      // Only close + redirect for auth errors. For transient errors (Railway proxy timeout),
      // let the browser's built-in EventSource auto-reconnect handle it.
      const currentToken = localStorage.getItem('token');
      if (!currentToken) {
        eventSource.close();
        console.warn('[Messages] SSE error: No token found, redirecting to login');
        window.location.href = '/login';
      } else {
        try {
          const payload = JSON.parse(atob(currentToken.split('.')[1]));
          const exp = payload.exp * 1000;
          if (Date.now() >= exp) {
            eventSource.close();
            console.warn('[Messages] SSE error: Token expired, redirecting to login');
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            localStorage.removeItem('auth-storage');
            window.location.href = '/login';
          } else {
            // Token valid — Railway proxy dropped connection (60s idle or 15-min max)
            // EventSource auto-reconnects with exponential backoff — don't close it
            console.log('[Messages] SSE will auto-reconnect (Railway proxy timeout)');
          }
        } catch (e) {
          console.error('[Messages] Failed to parse token:', e);
        }
      }
    };

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      eventSource.close();
    };
    // accountFilter is a dep so switching accounts refetches the lead list AND
    // reconnects the SSE under the new scope. Other deps are intentionally
    // omitted (loadLeads/loadSavedAccounts/loadTemplatesForSingleMessage are
    // stable closures over component state and don't need to retrigger this
    // effect on every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountFilter]);

  // Keep the loadMessagesForLead ref in sync — every render produces a fresh
  // closure, and the SSE handler (registered once at mount) needs the latest
  // one to call. Without this, the SSE-triggered refetch would invoke the
  // version captured at mount, which closes over stale state setters.
  useEffect(() => {
    loadMessagesForLeadRef.current = loadMessagesForLead;
  });

  // Refresh current conversation messages when tab becomes visible.
  // forceRefresh=false: rely on cache for instant paint. Server-side lazy sync
  // + SSE will push any updates that arrived while the tab was hidden.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && selectedLead) {
        loadMessagesForLead(selectedLead, false);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [selectedLead]);

  const loadTemplatesForSingleMessage = async () => {
    try {
      const { templates } = await templatesApi.getTemplates();
      setSingleMessageTemplates(templates);
    } catch (err) {
      console.error('[Messages] Failed to load templates:', err);
    }
  };

  const applyTemplateToMessage = (template: MessageTemplate) => {
    if (!selectedLead) return;
    // Personalize the template with lead data
    let personalizedMessage = template.content;
    const firstName = selectedLead.customerName.split(' ')[0];
    personalizedMessage = personalizedMessage.replace(/\{customerName\}/g, selectedLead.customerName);
    personalizedMessage = personalizedMessage.replace(/\{firstName\}/g, firstName);
    personalizedMessage = personalizedMessage.replace(/\{category\}/g, selectedLead.category || 'your project');
    personalizedMessage = personalizedMessage.replace(/\{city\}/g, selectedLead.city || '');
    personalizedMessage = personalizedMessage.replace(/\{state\}/g, selectedLead.state || '');
    setMessageText(personalizedMessage);
    setShowTemplateDropdown(false);
  };

  // When account filter or savedAccounts change, ensure selected lead is valid
  // Auto-select: only when filter/account changes or no lead is selected
  // Do NOT re-run when leads array updates (SSE) — that would steal focus
  useEffect(() => {
    if (leads.length === 0 || savedAccounts.length === 0) return;

    const savedAccountIds = new Set(savedAccounts.map(a => a.businessId));
    const visibleLeads = leads
      .filter(lead => lead.businessId && savedAccountIds.has(lead.businessId))
      .filter(lead => accountFilter === 'all' || lead.businessId === accountFilter);

    if (visibleLeads.length > 0) {
      const currentSelectionVisible = selectedLead && visibleLeads.some(l => l.id === selectedLead.id);
      if (!currentSelectionVisible) {
        setSelectedLead(visibleLeads[0]);
      }
    } else {
      setSelectedLead(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountFilter, savedAccounts]);

  const loadSavedAccounts = async () => {
    try {
      const { accounts } = await thumbtackApi.getSavedAccounts();
      setSavedAccounts(accounts);
    } catch (err) {
      console.error('[Messages] Failed to load saved accounts:', err);
    }
  };

  // Load messages when selected lead changes.
  // forceRefresh=false: paint from the in-memory frontend cache or backend Redis
  // (instant). The lazy Yelp background sync on the server will pick up any
  // missed events asynchronously and push `lead.messages.changed` via SSE — at
  // which point the handler below refetches with forceRefresh=true and the user
  // sees the new messages without clicking Refresh.
  useEffect(() => {
    selectedLeadRef.current = selectedLead;
    if (selectedLead) {
      loadMessagesForLead(selectedLead, false);
    }
  }, [selectedLead]);

  useEffect(() => {
    scrollToBottom();
  }, [timelineEvents]);

  // Check if SMS is enabled for the selected lead's account
  useEffect(() => {
    if (!selectedLead || !selectedLead.businessId) {
      setSmsEnabled(false);
      setSendChannel('platform');
      return;
    }

    const checkSmsCapability = async () => {
      try {
        const account = savedAccounts.find(a => a.businessId === selectedLead.businessId);
        if (!account) {
          setSmsEnabled(false);
          return;
        }
        const { settings } = await notificationsApi.getSettings(account.id);
        const enabled = !!(settings && settings.enabled && settings.sigcoreApiKey);
        setSmsEnabled(enabled);
        if (!enabled) setSendChannel('platform');
      } catch {
        setSmsEnabled(false);
      }
    };

    checkSmsCapability();
  }, [selectedLead, savedAccounts]);

  const loadLeads = async () => {
    if (!_messagesLoaded && leads.length === 0) setLoading(true);
    console.log('[Messages] Loading leads...');
    try {
      // Load all leads (no limit) to support date filtering across full history.
      // Account-scope: accountFilter === 'all' → unified, else → that businessId only.
      const { leads: loadedLeads } = await leadsApi.getLeads(
        accountFilter === 'all' ? { scope: 'all' } : { businessId: accountFilter },
      );
      // Sort leads by lastMessageAt descending (most recent message first)
      // Fall back to createdAt if lastMessageAt is not available
      const sortedLeads = [...loadedLeads].sort((a, b) => {
        const aTime = a.lastMessageAt || a.createdAt;
        const bTime = b.lastMessageAt || b.createdAt;
        return new Date(bTime).getTime() - new Date(aTime).getTime();
      });
      setLeads(sortedLeads);
      _messagesLoaded = true;
      // Auto-select first visible lead if nothing is selected
      if (!selectedLead && sortedLeads.length > 0 && savedAccounts.length > 0) {
        const savedAccountIds = new Set(savedAccounts.map(a => a.businessId));
        const visible = sortedLeads
          .filter(l => l.businessId && savedAccountIds.has(l.businessId))
          .filter(l => accountFilter === 'all' || l.businessId === accountFilter);
        if (visible.length > 0) setSelectedLead(visible[0]);
      }
    } catch (err) {
      console.error('[Messages] Failed to load leads:', err);
    } finally {
      setLoading(false);
    }
  };

  // Background refresh - doesn't show loading state, just updates data silently
  const loadLeadsBackground = async () => {
    try {
      const { leads: loadedLeads } = await leadsApi.getLeads(
        accountFilter === 'all' ? { scope: 'all' } : { businessId: accountFilter },
      );
      const sortedLeads = [...loadedLeads].sort((a, b) => {
        const aTime = a.lastMessageAt || a.createdAt;
        const bTime = b.lastMessageAt || b.createdAt;
        return new Date(bTime).getTime() - new Date(aTime).getTime();
      });
      setLeads(sortedLeads);
    } catch (err) {
      console.error('[Messages] Background refresh failed:', err);
    }
  };

  // Mark a lead as seen (update last seen timestamp to lastMessageAt)
  const markLeadAsSeen = (lead: Lead) => {
    const timestamp = lead.lastMessageAt || lead.createdAt;
    setLastSeenTimestamp(lead.id, timestamp);
    setLastSeenTimestamps(prev => ({ ...prev, [lead.id]: timestamp }));
  };

  const loadMessagesForLead = async (lead: Lead, forceRefresh = false): Promise<void> => {
    // Serve from cache if available and fresh (< 2 min old)
    const cached = messageCache.current[lead.id];
    const CACHE_TTL = 2 * 60 * 1000; // 2 minutes
    if (!forceRefresh && cached && (Date.now() - cached.cachedAt) < CACHE_TTL) {
      setTimelineEvents(cached.timeline);
      setCommSummary(cached.summary);
      setLoadingMessages(false);
      markLeadAsSeen(lead);
      return;
    }

    setLoadingMessages(true);
    setMessages([]);
    setSmsLogs([]);
    setTimelineEvents([]);
    // Clear any prior thread's pending draft so the banner doesn't flash the
    // wrong lead's suggestion while the new payload is in flight.
    setPendingAiSuggestion(null);
    markLeadAsSeen(lead);

    // Initial-request injection — used by both the messages-only first paint and
    // the merged paint after SMS logs land. Closure over `lead` keeps the rule
    // identical between the two passes (single source of truth).
    const injectInitialRequest = (timeline: TimelineEvent[]): TimelineEvent[] => {
      if (!lead.message) return timeline;
      const firstMsgContent = lead.message.trim();
      if (firstMsgContent.length === 0) return timeline;
      const firstMsgWords = firstMsgContent.substring(0, 80);
      const alreadyInTimeline = timeline.some(e =>
        e.direction === 'inbound' && e.content && (
          e.content.includes(firstMsgWords) || firstMsgContent.includes(e.content.trim().substring(0, 80))
        ),
      );
      if (alreadyInTimeline) return timeline;
      const initialEvent: TimelineEvent = {
        id: 'initial-request',
        channel: 'platform',
        direction: 'inbound',
        content: firstMsgContent,
        timestamp: new Date(lead.createdAt),
        sender: 'customer',
      };
      return [initialEvent, ...timeline];
    };

    try {
      // forceRefresh = the caller wants the freshest possible view (e.g. user just
      // clicked the lead, tab regained focus, SSE pushed an update). Pair the
      // frontend cache bypass with backend cache bypass so we don't read a
      // 5-min-stale Redis snapshot of the messages thread.
      const { messages: apiMessages, pendingAiSuggestion: pendingDraft } = await leadsApi.getMessages(lead.id, { fresh: forceRefresh });
      // The draft belongs to the lead we just asked about — if the operator
      // already navigated away by the time the response arrives, the lead-
      // switch effect will have cleared it again before this assignment.
      setPendingAiSuggestion(pendingDraft ?? null);
      setLeadsWithPendingDraft(prev => {
        const next = { ...prev };
        if (pendingDraft) next[lead.id] = true; else delete next[lead.id];
        return next;
      });

      // Fire-and-forget auto-resync when DB is empty. Previously this awaited
      // resyncMessages + a second getMessages before rendering, blocking the
      // first paint by ~1 RTT for the (rare, post-PR #99) empty-DB case. SSE
      // pushes new messages live, but we also re-call loadMessagesForLead on
      // resync completion to handle providers whose resync writes flow only
      // through the API path (not SSE). Force-refresh bypasses the 2-min
      // in-memory cache so the user sees the freshly-synced thread.
      if (apiMessages.length === 0) {
        console.log('[Messages] No messages found, auto-syncing in background...');
        leadsApi.resyncMessages(lead.id)
          .then(() => loadMessagesForLead(lead, true))
          .catch(err => console.warn('[Messages] Background resync failed:', err));
      }

      const convertedMessages: LocalMessage[] = apiMessages.map((msg) => {
        const sender = (msg.sender || '').toLowerCase() as 'pro' | 'customer';
        return {
          id: msg.id || msg.externalMessageId,
          content: msg.content,
          sender,
          senderType: msg.senderType ?? null,
          sentAt: new Date(msg.sentAt),
          externalId: msg.externalMessageId,
          attachments: msg.attachments,
          platform: msg.platform,
          deliveredAt: msg.deliveredAt,
          notificationLogId: msg.notificationLogId,
        };
      });
      setMessages(convertedMessages);

      // Lazy-render: paint a messages-only timeline immediately so the
      // conversation is visible to the user. SMS logs merge in async below.
      const messagesOnlyTimeline = injectInitialRequest(
        mergeTimeline(convertedMessages, [], lead.customerPhone),
      );
      setTimelineEvents(messagesOnlyTimeline);
      setLoadingMessages(false);

      // Auto-detect phone from customer messages and save to lead if missing.
      // Already async-fire-and-forget via `.then()`, kept as-is.
      if (!lead.customerPhone) {
        const phoneRegex = /(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/;
        for (const msg of convertedMessages) {
          if (msg.sender === 'customer' && msg.content) {
            const text = msg.content.replace(/<[^>]+>/g, '');
            const match = text.match(phoneRegex);
            if (match) {
              const digits = match[1].replace(/\D/g, '');
              const normalized = digits.length === 11 && digits.startsWith('1') ? `+${digits}` : digits.length === 10 ? `+1${digits}` : null;
              if (normalized) {
                api.patch(`/v1/leads/${lead.id}`, { customerPhone: normalized }).then(() => {
                  setLeads(leads.map(l => l.id === lead.id ? { ...l, customerPhone: normalized } : l));
                }).catch(() => {});
                break; // Only save first found phone
              }
            }
          }
        }
      }

      // Fetch SMS logs in background, then merge into the timeline + compute
      // summary + cache the final state. On error, keep the messages-only
      // timeline visible and skip caching so the next click retries.
      notificationsApi.getLogsByLead(lead.id)
        .then(({ logs: leadSmsLogs }) => {
          setSmsLogs(leadSmsLogs);

          const mergedTimeline = injectInitialRequest(
            mergeTimeline(convertedMessages, leadSmsLogs, lead.customerPhone),
          );
          setTimelineEvents(mergedTimeline);

          const customerSmslogs = leadSmsLogs.filter(log => {
            if (!lead.customerPhone || !log.toPhone) return false;
            const normalizedCustomerPhone = lead.customerPhone.replace(/\D/g, '');
            const normalizedToPhone = log.toPhone.replace(/\D/g, '');
            return normalizedToPhone === normalizedCustomerPhone;
          });
          const summary = computeSummary(convertedMessages, customerSmslogs);
          setCommSummary(summary);

          // Cache the FINAL merged state — partial states aren't cached so the
          // next click retries the SMS fetch on failure (matches old behavior).
          messageCache.current[lead.id] = { timeline: mergedTimeline, summary, cachedAt: Date.now() };
        })
        .catch(err => {
          console.warn('[Messages] Failed to load SMS logs for lead:', err);
        });
    } catch (err) {
      console.error('[Messages] Failed to load messages:', err);
      setLoadingMessages(false);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleResyncMessages = async () => {
    if (!selectedLead) return;
    setResyncingMessages(true);
    setResyncError(null);
    try {
      await leadsApi.resyncMessages(selectedLead.id);
      // Invalidate cache + reload messages after resync
      delete messageCache.current[selectedLead.id];
      await loadMessagesForLead(selectedLead, true);
    } catch (err: any) {
      console.error('[Messages] Failed to resync messages:', err);
      const errorMessage = err.response?.data?.message || 'Failed to resync messages';
      setResyncError(errorMessage);
    } finally {
      setResyncingMessages(false);
    }
  };

  /**
   * Manual lead status change. Closes the dropdown on success, then pops the
   * conflict modal if the backend flagged a divergence (SF integrated, or
   * platform status disagrees).
   */
  const handleStatusChange = async (newStatus: string) => {
    if (!selectedLead || savingStatus) return;
    setSavingStatus(true);
    try {
      const res = await leadsApi.updateStatus(selectedLead.id, newStatus);
      if (res.success && res.lead) {
        setSelectedLead(res.lead as any);
        setLeads(leads.map(l => (l.id === res.lead!.id ? (res.lead as any) : l)));
      }
      setStatusEditorOpen(false);
      if (res.conflict) {
        setStatusConflict(res.conflict);
        setStatusConflictLeadId(selectedLead.id);
      }
    } catch (err: any) {
      console.error('[Messages] Failed to update status:', err?.response?.data || err);
      alert('Could not update status: ' + (err?.response?.data?.error || err?.message));
    } finally {
      setSavingStatus(false);
    }
  };

  const handleResolveConflict = async (resolveNote: string) => {
    if (!statusConflict || !statusConflictLeadId) return;
    try {
      await leadsApi.resolveStatusConflict(statusConflictLeadId, statusConflict.auditLogId, resolveNote);
    } catch (err) {
      console.error('[Messages] Failed to resolve conflict:', err);
    } finally {
      setStatusConflict(null);
      setStatusConflictLeadId(null);
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!messageText.trim() || !selectedLead) return;

    setSendingMessage(true);
    const text = messageText.trim();
    setMessageText('');

    if (sendChannel === 'sms') {
      // Send SMS via ad-hoc endpoint
      const account = savedAccounts.find(a => a.businessId === selectedLead.businessId);
      if (!account) {
        alert('Account not found for this lead.');
        setSendingMessage(false);
        setMessageText(text);
        return;
      }

      // Optimistically add SMS to timeline
      const optimisticEvent: TimelineEvent = {
        id: `sms-temp-${Date.now()}`,
        channel: 'sms',
        direction: 'outbound',
        content: text,
        timestamp: new Date(),
        sender: 'system',
        smsStatus: 'pending',
        toPhone: selectedLead.customerPhone || '',
        ruleName: 'Manual SMS',
      };
      setTimelineEvents(prev => [...prev, optimisticEvent]);

      try {
        await notificationsApi.sendAdHocSms(account.id, selectedLead.id, text);
        // Invalidate cache + reload to get actual log entry
        delete messageCache.current[selectedLead.id];
        await loadMessagesForLead(selectedLead, true);
      } catch (err) {
        console.error('Failed to send SMS:', err);
        setTimelineEvents(prev => prev.filter(e => e.id !== optimisticEvent.id));
        setMessageText(text);
        alert('Failed to send SMS. Please try again.');
      } finally {
        setSendingMessage(false);
      }
    } else {
      // Platform message (existing logic)
      const optimisticMessage: LocalMessage = {
        id: `temp-${Date.now()}`,
        content: text,
        sender: 'pro',
        sentAt: new Date(),
      };
      setMessages((prev) => [...prev, optimisticMessage]);

      // Also add to timeline
      const optimisticEvent: TimelineEvent = {
        id: `platform-temp-${Date.now()}`,
        channel: 'platform',
        direction: 'outbound',
        content: text,
        timestamp: new Date(),
        sender: 'pro',
      };
      setTimelineEvents(prev => [...prev, optimisticEvent]);

      try {
        await leadsApi.sendMessage(selectedLead.id, text);
        // Invalidate cache — next load will pick up the sent message from DB
        delete messageCache.current[selectedLead.id];
      } catch (err) {
        console.error('Failed to send message:', err);
        setMessages((prev) => prev.filter((m) => m.id !== optimisticMessage.id));
        setTimelineEvents(prev => prev.filter(e => e.id !== optimisticEvent.id));
        setMessageText(text);
        alert('Failed to send message. Please try again.');
      } finally {
        setSendingMessage(false);
      }
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Format time for lead list (compact relative format)
  const formatLeadTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'now';
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const formatPhoneNumber = (phone: string | null) => {
    if (!phone) return 'N/A';
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 10) {
      return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
    }
    return phone;
  };

  /** Render message content with clickable phone numbers and stripped HTML tel tags */
  const renderMessageContent = (content: string) => {
    // Strip HTML tel links: <a href="tel:xxx">yyy</a> → just the visible text
    let text = content.replace(/<a[^>]*href=["']tel:([^"']*)["'][^>]*>(.*?)<\/a>/gi, '$2');
    // Also strip any other HTML tags
    text = text.replace(/<[^>]+>/g, '');

    // Split by phone number pattern and render parts
    const phoneRegex = /(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/g;
    const parts = text.split(phoneRegex);

    if (parts.length === 1) return <span>{text}</span>;

    return (
      <span>
        {parts.map((part, i) => {
          if (phoneRegex.test(part)) {
            phoneRegex.lastIndex = 0; // Reset regex
            const cleaned = part.replace(/\D/g, '');
            const digits = cleaned.length === 11 && cleaned.startsWith('1') ? cleaned.slice(1) : cleaned;
            if (digits.length === 10) {
              return (
                <a
                  key={i}
                  href={`tel:${digits}`}
                  className="underline font-semibold hover:opacity-80"
                >
                  {formatPhoneNumber(part)}
                </a>
              );
            }
          }
          return <span key={i}>{part}</span>;
        })}
      </span>
    );
  };

  const getLeadDetails = (lead: Lead) => {
    // Thumbtack format
    if (lead.raw?.request?.details) {
      return lead.raw.request.details as { question: string; answer: string }[];
    }
    // Yelp format — build from project survey_answers + availability + location
    if (lead.raw?.project || lead.platform === 'yelp') {
      const details: { question: string; answer: string }[] = [];
      const project = lead.raw?.project;
      if (project?.job_names?.length) {
        details.push({ question: 'Service', answer: project.job_names.join(', ') });
      }
      for (const q of project?.survey_answers || []) {
        const answer = Array.isArray(q.answer_text) ? q.answer_text.join(', ') : q.answer_text;
        details.push({ question: q.question_text, answer });
      }
      if (project?.availability?.status) {
        details.push({ question: 'When do you require this service?', answer: project.availability.status === 'ASAP' ? 'As soon as possible' : project.availability.status === 'FLEXIBLE' ? "I'm flexible" : project.availability.status });
      }
      if (project?.location?.postal_code) {
        details.push({ question: 'Location', answer: project.location.postal_code });
      }
      if (project?.additional_info) {
        details.push({ question: 'Additional details', answer: project.additional_info });
      }
      return details;
    }
    return [];
  };

  // Get account name for a lead
  const getAccountNameForLead = (lead: Lead): string | null => {
    if (!lead.businessId) return null;
    const account = savedAccounts.find(a => a.businessId === lead.businessId);
    return account?.businessName || null;
  };

  // Check if the lead belongs to the currently connected account
  const isLeadFromCurrentAccount = (lead: Lead): boolean => {
    if (!lead.businessId || !configuredBusinessId) return true; // Assume accessible if no info
    return lead.businessId === configuredBusinessId;
  };

  // Check if messaging is enabled for the selected lead
  const canSendMessage = selectedLead ? isLeadFromCurrentAccount(selectedLead) : false;

  // Multi-select functions
  const toggleMultiSelect = () => {
    if (multiSelectMode) {
      setSelectedLeadIds(new Set());
    }
    setMultiSelectMode(!multiSelectMode);
  };

  const toggleLeadSelection = (leadId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newSet = new Set(selectedLeadIds);
    if (newSet.has(leadId)) {
      newSet.delete(leadId);
    } else {
      newSet.add(leadId);
    }
    setSelectedLeadIds(newSet);
  };

  const selectAllVisible = () => {
    const allIds = filteredLeads.map(l => l.id);
    setSelectedLeadIds(new Set(allIds));
  };

  const clearSelection = () => {
    setSelectedLeadIds(new Set());
  };

  // Bulk send modal functions
  const openBulkSendModal = async () => {
    setShowBulkSendModal(true);
    setSelectedTemplateId(null);
    setCustomMessage('');
    setBulkPreviews([]);

    // Load templates
    setLoadingTemplates(true);
    try {
      const { templates: loadedTemplates } = await templatesApi.getTemplates();
      setTemplates(loadedTemplates);
      // Auto-select default template if available
      const defaultTemplate = loadedTemplates.find(t => t.isDefault);
      if (defaultTemplate) {
        setSelectedTemplateId(defaultTemplate.id);
        setCustomMessage(defaultTemplate.content);
      }
    } catch (err) {
      console.error('Failed to load templates:', err);
    } finally {
      setLoadingTemplates(false);
    }
  };

  const closeBulkSendModal = () => {
    setShowBulkSendModal(false);
    setSelectedTemplateId(null);
    setCustomMessage('');
    setBulkPreviews([]);
    setBulkSendProgress(null);
  };

  const handleTemplateSelect = (templateId: string) => {
    setSelectedTemplateId(templateId);
    const template = templates.find(t => t.id === templateId);
    if (template) {
      setCustomMessage(template.content);
    }
    setBulkPreviews([]); // Clear previews when template changes
  };

  const loadBulkPreview = async () => {
    if (!customMessage.trim() || selectedLeadIds.size === 0) return;

    setLoadingPreview(true);
    try {
      const { previews } = await bulkMessageApi.preview(
        Array.from(selectedLeadIds),
        customMessage,
      );
      setBulkPreviews(previews);
    } catch (err) {
      console.error('Failed to load preview:', err);
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleBulkSend = async () => {
    if (!customMessage.trim() || selectedLeadIds.size === 0) return;

    setSendingBulk(true);
    setBulkSendProgress({ sent: 0, total: selectedLeadIds.size });

    try {
      const result = await bulkMessageApi.send(
        Array.from(selectedLeadIds),
        customMessage,
        selectedTemplateId || undefined,
      );

      setBulkSendProgress({ sent: result.successful, total: result.total });

      // Show success/partial success
      if (result.failed === 0) {
        alert(`Successfully sent ${result.successful} messages!`);
      } else {
        alert(`Sent ${result.successful} of ${result.total} messages. ${result.failed} failed.`);
      }

      // Close modal and clear selection
      closeBulkSendModal();
      setSelectedLeadIds(new Set());
      setMultiSelectMode(false);
    } catch (err) {
      console.error('Failed to send bulk messages:', err);
      alert('Failed to send messages. Please try again.');
    } finally {
      setSendingBulk(false);
      setBulkSendProgress(null);
    }
  };

  // Get count of leads that can receive messages (have thread)
  const sendableLeadsCount = Array.from(selectedLeadIds).filter(id => {
    const lead = leads.find(l => l.id === id);
    return lead?.threadId;
  }).length;

  // Get saved account businessIds for filtering
  const savedAccountIds = new Set(savedAccounts.map(a => a.businessId));

  // Only show leads from saved accounts
  const leadsFromSavedAccounts = leads.filter(lead =>
    lead.businessId && savedAccountIds.has(lead.businessId)
  );

  // Account selector options. Always source from savedAccounts directly so the
  // dropdown stays stable when an account is selected — pre-PR #142 the inbox
  // loaded leads from every account so this list was implicitly "all", but now
  // the backend scopes the lead list and `leadsFromSavedAccounts` shrinks to a
  // single account when filtered. Sourcing from the currently-loaded leads
  // would collapse the dropdown to one option.
  const accountsInLeads = savedAccounts;

  // Generate month options from actual leads data
  const monthOptions = getMonthOptionsFromLeads(leadsFromSavedAccounts);

  // Filter leads by selected account, date, and search query
  const parsedDateFilter = parseDateFilter(dateFilter);
  const filteredLeads = leadsFromSavedAccounts.filter(lead => {
    // Account filter
    const matchesAccount = accountFilter === 'all' || lead.businessId === accountFilter;
    // Date filter - check if lead was created within the selected month
    let matchesDate = true;
    if (parsedDateFilter) {
      const leadDate = new Date(lead.createdAt);
      // Compare using year and month to avoid timezone issues
      const leadYear = leadDate.getFullYear();
      const leadMonth = leadDate.getMonth();
      matchesDate = leadYear === parsedDateFilter.year && leadMonth === parsedDateFilter.month;
    }
    // Status group filter. 'refunded' + 'refundable' are pseudo-groups
    // — they match Lead.refundedAt / Lead.refundableFlag instead of
    // Lead.status. Refunded/refundable leads keep their real status
    // pill (Lost, Active, etc.) and add a secondary badge.
    const matchesStatus =
      statusFilter === 'all'
        ? true
        : statusFilter === 'refunded'
          ? matchesRefundedFilter(lead)
          : statusFilter === 'refundable'
            ? matchesRefundableFilter(lead)
            : matchesGroupFilter(lead.status, statusFilter);
    // Activity sub-bucket filter — only applies when the primary status
    // group is 'active'. activityBucket is null on terminal leads so this
    // naturally excludes them.
    const matchesActivity =
      statusFilter !== 'active' ||
      activityFilter === 'all' ||
      (lead as any).activityBucket === activityFilter;
    // Name search (case-insensitive)
    const matchesSearch = !searchQuery.trim() ||
      lead.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lead.category?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lead.message?.toLowerCase().includes(searchQuery.toLowerCase());
    // Hide leads where the only outbound activity is AI auto-send. Backend
    // sets isAutoHandled when an AI message exists but no human send and no
    // customer reply do — see leads.service.ts::computeAutoHandledFlags.
    const matchesAutoHandled = !hideAutoHandled || !lead.isAutoHandled;
    return matchesAccount && matchesDate && matchesStatus && matchesActivity && matchesSearch && matchesAutoHandled;
  });
  const autoHandledHiddenCount = hideAutoHandled
    ? leadsFromSavedAccounts.filter((l) => l.isAutoHandled).length
    : 0;

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen">
        <Loader2 className="w-12 h-12 animate-spin text-blue-600" />
        <p className="mt-4 text-slate-500">Loading leads...</p>
      </div>
    );
  }

  if (savedAccounts.length === 0 && useAuthStore.getState().user?.role === 'ADMIN') {
    return (
      <div className="p-6 lg:p-10">
        <div className="flex items-center gap-3 mb-6">
          <MessageSquare className="w-6 h-6 text-blue-600" />
          <h1 className="text-2xl font-bold text-slate-900">Lead Activity</h1>
        </div>
        <AdminNoAccountsState />
      </div>
    );
  }

  return (
    <div
      className="flex h-[100dvh] lg:h-screen w-full max-w-[100vw] lg:max-w-none overflow-hidden"
      style={{ background: 'var(--lb-bg)' }}
    >
      {savedAccounts.length === 0 && useAuthStore.getState().user?.role !== 'ADMIN' && <NoAccountsOverlay />}
      {/* Leads Sidebar */}
      <aside
        className={`w-full md:w-80 flex flex-col ${mobilePanel !== 'list' ? 'hidden md:flex' : 'flex'}`}
        style={{ background: 'var(--lb-surface)', borderRight: '1px solid var(--lb-line)' }}
      >
        <div
          style={{
            padding: '14px 14px 10px',
            borderBottom: '1px solid var(--lb-line-soft)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <button
            onClick={() => navigate('/overview')}
            style={{
              width: 28, height: 28,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: 'transparent', border: 0, cursor: 'pointer',
              color: 'var(--lb-ink-5)', borderRadius: 4,
            }}
            className="md:hidden"
            title="Back"
          >
            <ArrowLeft size={16} />
          </button>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--lb-ink-1)', flex: 1 }}>
            Lead Activity
          </h2>
          <span
            style={{
              fontSize: 11,
              color: 'var(--lb-ink-5)',
              fontFamily: 'var(--lb-font-mono)',
              fontWeight: 500,
            }}
          >
            {filteredLeads.length}
          </span>
          <button
            onClick={toggleMultiSelect}
            title={multiSelectMode ? 'Exit selection mode' : 'Select multiple'}
            style={{
              width: 28, height: 28,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: multiSelectMode ? 'var(--lb-accent-tint)' : 'transparent',
              color: multiSelectMode ? 'var(--lb-accent)' : 'var(--lb-ink-5)',
              border: 0, cursor: 'pointer', borderRadius: 4,
            }}
          >
            <CheckSquare size={15} />
          </button>
          <button
            onClick={loadLeads}
            title="Refresh"
            style={{
              width: 28, height: 28,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: 'transparent', border: 0, cursor: 'pointer',
              color: 'var(--lb-ink-5)', borderRadius: 4,
            }}
          >
            <RefreshCw size={15} />
          </button>
        </div>

        {/* Selection Toolbar */}
        {multiSelectMode && (
          <div className="p-4 bg-blue-50 border-b border-blue-100">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-semibold text-blue-900">
                {selectedLeadIds.size} selected
                {selectedLeadIds.size > 0 && sendableLeadsCount < selectedLeadIds.size && (
                  <span className="text-blue-600"> ({sendableLeadsCount} can send)</span>
                )}
              </span>
            </div>
            <div className="flex gap-2">
              <button className="text-xs font-semibold text-blue-600 hover:text-blue-700" onClick={selectAllVisible}>
                Select All
              </button>
              <button className="text-xs font-semibold text-blue-600 hover:text-blue-700" onClick={clearSelection} disabled={selectedLeadIds.size === 0}>
                Clear
              </button>
              <button
                className="ml-auto px-3 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                onClick={openBulkSendModal}
                disabled={selectedLeadIds.size === 0}
              >
                <Mail size={12} />
                Send Follow-up
              </button>
            </div>
          </div>
        )}

        {/* Search Input */}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--lb-line-soft)' }}>
          <div style={{ position: 'relative' }}>
            <Search
              size={13}
              style={{
                position: 'absolute',
                left: 9,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--lb-ink-6)',
              }}
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search leads, services, places..."
              style={{
                width: '100%',
                padding: '7px 10px 7px 28px',
                fontSize: 12,
                fontFamily: 'inherit',
                background: 'var(--lb-ink-10)',
                border: '1px solid transparent',
                borderRadius: 'var(--lb-radius)',
                color: 'var(--lb-ink-1)',
                outline: 'none',
              }}
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--lb-accent-line)'; e.currentTarget.style.background = 'var(--lb-surface)'; }}
              onBlur={e => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.background = 'var(--lb-ink-10)'; }}
            />
          </div>
        </div>

        {/* Account Filter */}
        {accountsInLeads.length > 0 && (
          <div className="px-4 py-2 border-b border-slate-100">
            <div className="relative">
              <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <select
                value={accountFilter}
                onChange={(e) => setAccountFilter(e.target.value)}
                className="w-full pl-9 pr-8 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                {/* "All Accounts" count is only meaningful when the inbox is currently
                    showing all accounts. When scoped to one account, the count next to
                    "All Accounts" would only reflect that one account's loaded leads,
                    so we hide it. Same logic for individual accounts: counts only show
                    when accountFilter==='all' OR the option matches the active filter. */}
                <option value="all">
                  All Accounts{accountFilter === 'all' ? ` (${leadsFromSavedAccounts.length})` : ''}
                </option>
                {accountsInLeads.map((account) => {
                  const dot = account.platform === 'yelp' ? '\uD83D\uDD34' : '\uD83D\uDD35';
                  const showCount = accountFilter === 'all' || account.businessId === accountFilter;
                  const count = leadsFromSavedAccounts.filter(l => l.businessId === account.businessId).length;
                  return (
                    <option key={account.id} value={account.businessId}>
                      {dot} {account.businessName}{showCount ? ` (${count})` : ''}
                    </option>
                  );
                })}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={16} />
            </div>
          </div>
        )}

        {/* Date Filter */}
        <div className="px-4 py-2 border-b border-slate-100">
          <div className="relative">
            <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <select
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="w-full pl-9 pr-8 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="all">All Time</option>
              {monthOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={16} />
          </div>
        </div>

        {/* Status Filter */}
        <div className="px-4 py-2 border-b border-slate-100">
          <div className="relative">
            <Tag className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | StatusGroupId)}
              className="w-full pl-9 pr-8 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="all">All Statuses</option>
              {STATUS_FILTER_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={16} />
          </div>
        </div>

        {/* Activity sub-bucket filter — shown only when the primary status
            is 'active'. Mirrors Lead.activityBucket which the backend derives
            from ThreadContext.conversationState. */}
        {statusFilter === 'active' && (
          <div className="px-4 py-2 border-b border-slate-100">
            <div className="relative">
              <Tag className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
              <select
                value={activityFilter}
                onChange={(e) => setActivityFilter(e.target.value as ActivityFilter)}
                className="w-full pl-9 pr-8 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-medium appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="all">All Active</option>
                <option value="engagement">Engagement</option>
                <option value="ai_conversation">AI Conversation</option>
                <option value="follow_up">Follow-up</option>
                <option value="human_handoff">Human Handoff ⚠</option>
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={16} />
            </div>
          </div>
        )}

        {/* Hide auto-handled toggle */}
        <label className="px-4 py-2 border-b border-slate-100 flex items-center justify-between gap-3 cursor-pointer select-none">
          <span className="text-sm font-medium text-slate-700">
            Hide auto-handled
            {hideAutoHandled && autoHandledHiddenCount > 0 && (
              <span className="ml-1 text-xs text-slate-400">({autoHandledHiddenCount})</span>
            )}
          </span>
          <input
            type="checkbox"
            checked={hideAutoHandled}
            onChange={(e) => setHideAutoHandled(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
          />
        </label>

        <div className="flex-1 overflow-y-auto">
          {filteredLeads.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <MessageSquare className="w-12 h-12 text-slate-300 mb-3" />
              <p className="text-slate-600 font-medium">No leads yet</p>
              <small className="text-slate-400 mt-1">New leads will appear here</small>
            </div>
          ) : (
            filteredLeads.map((lead) => {
              const accountName = getAccountNameForLead(lead);
              const isCurrentAccount = isLeadFromCurrentAccount(lead);
              const isUpdated = hasNewUpdates(lead, lastSeenTimestamps);
              const isChecked = selectedLeadIds.has(lead.id);
              const isSelected = selectedLead?.id === lead.id;
              const statusKind = displayPillKind(lead.status);
              const statusLabel = displayLabel(lead.status);
              return (
                <div
                  key={lead.id}
                  onClick={() => {
                    if (multiSelectMode) {
                      toggleLeadSelection(lead.id, { stopPropagation: () => {} } as React.MouseEvent);
                    } else if (selectedLead?.id === lead.id) {
                      // Re-clicking the already-selected lead: user is asking
                      // for a refresh — bypass both caches so DB is read fresh.
                      loadMessagesForLead(lead, true);
                      setMobilePanel('chat');
                    } else {
                      console.log('[Messages] Negotiation object:', lead);
                      setSelectedLead(lead);
                      setMobilePanel('chat');
                    }
                  }}
                  style={{
                    padding: '12px 14px',
                    borderBottom: '1px solid var(--lb-line-soft)',
                    display: 'flex',
                    gap: 10,
                    cursor: 'pointer',
                    background: isSelected || isChecked ? 'var(--lb-accent-tint)' : 'var(--lb-surface)',
                    borderLeft: isSelected ? '2px solid var(--lb-accent)' : '2px solid transparent',
                    opacity: !isCurrentAccount ? 0.6 : 1,
                    position: 'relative',
                    transition: 'background 120ms ease',
                  }}
                  onMouseEnter={e => { if (!isSelected && !isChecked) e.currentTarget.style.background = 'var(--lb-ink-10)'; }}
                  onMouseLeave={e => { if (!isSelected && !isChecked) e.currentTarget.style.background = 'var(--lb-surface)'; }}
                >
                  {multiSelectMode && (
                    <div
                      style={{ paddingTop: 4, flexShrink: 0 }}
                      onClick={(e) => toggleLeadSelection(lead.id, e)}
                    >
                      {isChecked
                        ? <CheckSquare size={18} style={{ color: 'var(--lb-accent)' }} />
                        : <Square size={18} style={{ color: 'var(--lb-ink-7)' }} />}
                    </div>
                  )}
                  <div style={{ flexShrink: 0, position: 'relative' }}>
                    <div
                      style={{
                        width: 34, height: 34,
                        borderRadius: 99,
                        background: 'var(--lb-accent-tint)',
                        color: 'var(--lb-accent)',
                        border: '1px solid var(--lb-accent-line)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 12, fontWeight: 700, letterSpacing: 0.03,
                      }}
                    >
                      {(lead.customerName || '?').split(' ').slice(0, 2).map(s => s[0]).join('').toUpperCase()}
                    </div>
                    {isUpdated && (
                      <span
                        style={{
                          position: 'absolute',
                          top: -2,
                          right: -2,
                          width: 10,
                          height: 10,
                          borderRadius: 99,
                          background: 'var(--lb-accent)',
                          border: '2px solid var(--lb-surface)',
                        }}
                      />
                    )}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: isUpdated ? 600 : 500,
                          color: 'var(--lb-ink-1)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {lead.customerName}
                      </span>
                      <PlatformBadge platform={lead.platform} size="sm" />
                      <span
                        style={{
                          marginLeft: 'auto',
                          fontSize: 10,
                          color: 'var(--lb-ink-5)',
                          fontFamily: 'var(--lb-font-mono)',
                          flexShrink: 0,
                        }}
                      >
                        {formatLeadTime(lead.lastMessageAt || lead.createdAt)}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--lb-ink-4)',
                        marginTop: 2,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {lead.category || 'Service Request'}
                      {accountName && <span style={{ color: 'var(--lb-ink-5)' }}> · {accountName}</span>}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--lb-ink-5)',
                        marginTop: 3,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {/* Prefer the latest conversation message (newest customer/pro reply)
                          over the original lead body. Falls back to lead.message for
                          leads with no conversation activity yet. */}
                      {(lead.lastMessage?.content || lead.message)?.slice(0, 80)}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                      <StatusPill status={statusKind} label={statusLabel} />
                      {/* Activity bucket — secondary badge under the main
                          status pill. Derived server-side from
                          ThreadContext.conversationState + Lead.status.
                          Null on terminal Lead.status. Human Handoff is
                          visually urgent (red) because the customer is
                          waiting on a human. */}
                      {(() => {
                        const ab = (lead as any).activityBucket as
                          | 'engagement' | 'ai_conversation' | 'follow_up' | 'human_handoff'
                          | null | undefined;
                        if (!ab) return null;
                        const labels = {
                          engagement:      'Engagement',
                          ai_conversation: 'AI Conv',
                          follow_up:       'Follow-up',
                          human_handoff:   'Handoff',
                        } as const;
                        const tones = {
                          engagement:      { bg: '#eff6ff', fg: '#1e40af' },
                          ai_conversation: { bg: '#f5f3ff', fg: '#6d28d9' },
                          follow_up:       { bg: '#ecfeff', fg: '#0e7490' },
                          human_handoff:   { bg: '#fef2f2', fg: '#991b1b' },
                        } as const;
                        const t = tones[ab];
                        return (
                          <span
                            title={ab === 'human_handoff' ? 'Human Handoff — customer waiting' : labels[ab]}
                            style={{
                              fontSize: 9,
                              fontWeight: ab === 'human_handoff' ? 700 : 600,
                              letterSpacing: 0.04,
                              padding: '1px 5px',
                              borderRadius: 3,
                              background: t.bg,
                              color: t.fg,
                              lineHeight: 1.4,
                            }}
                          >
                            {labels[ab]}{ab === 'human_handoff' ? ' ⚠' : ''}
                          </span>
                        );
                      })()}
                      {/* V2 Review Mode: yellow badge surfacing leads that
                          have an AI draft waiting for operator approval.
                          Populated from the per-thread messages payload as
                          the operator opens leads — so the badge appears on
                          re-renders after the first visit. */}
                      {leadsWithPendingDraft[lead.id] && (
                        <span
                          title="AI drafted a reply for this lead — open to review"
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            letterSpacing: 0.04,
                            padding: '1px 5px',
                            borderRadius: 3,
                            background: '#fef3c7',
                            color: '#92400e',
                            lineHeight: 1.4,
                          }}
                        >
                          🟡 AI Draft
                        </span>
                      )}
                      {/* Refunded badge — surfaces leads where the platform
                          (currently only Thumbtack) reported chargeState='Refunded',
                          which auto-sets Lead.refundedAt + Lead.budgetVoidedAt
                          via the scheduler's 404 handler + the hourly chargeState
                          sweep. The lead row + phone numbers remain queryable;
                          this is informational + drives the analytics cost-void
                          (budgetVoidedAt filters leadPrice AVG/SUM). */}
                      {matchesRefundedFilter(lead) && (
                        <span
                          title={`Refunded by platform${lead.chargeStateRaw ? ` — chargeState=${lead.chargeStateRaw}` : ''}`}
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            letterSpacing: 0.04,
                            padding: '1px 5px',
                            borderRadius: 3,
                            background: '#fef2f2',
                            color: '#991b1b',
                            border: '1px solid #fecaca',
                            lineHeight: 1.4,
                          }}
                        >
                          Refunded
                        </span>
                      )}
                      {/* Refundable badge — surfaces leads matched by the
                          duplicate detector. Refunded wins precedence so we
                          never render both. Click → opens a popover-style
                          modal with the evidence + an "Open in Thumbtack"
                          deep link. Read-only proof; no submit/ignore
                          buttons per operator spec. */}
                      {!matchesRefundedFilter(lead) && lead.refundableFlag && (
                        <button
                          type="button"
                          title="Possibly refundable — click to view evidence"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRefundableProofLead(lead);
                          }}
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            letterSpacing: 0.04,
                            padding: '1px 5px',
                            borderRadius: 3,
                            background: '#fffbeb',
                            color: '#92400e',
                            border: '1px solid #fcd34d',
                            lineHeight: 1.4,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          Refundable
                        </button>
                      )}
                      {/* SF identity tag — keeps the inbox scannable. Priority
                          is structural (`if/else if`) so we never render both:
                          SF Customer (isSfLinked, indigo, primary) takes
                          precedence over SF Lead (sfLeadId only, slate,
                          informational). SF Lead means "SF knows about this
                          lead but no customer/job yet" — LB still owns
                          acquisition, so the lead behaves like any other
                          LB-managed row (status editable, follow-ups continue,
                          AI/classifier unchanged). PR D (2026-06-05). */}
                      {lead.isSfLinked ? (
                        <span
                          title="SF Customer"
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            letterSpacing: 0.04,
                            padding: '1px 5px',
                            borderRadius: 3,
                            background: '#4f46e5',
                            color: '#fff',
                            lineHeight: 1.4,
                          }}
                        >
                          SF
                        </span>
                      ) : lead.sfLeadId ? (
                        <span
                          title={`Exists in ServiceFlow.\nStage at match time: ${lead.sfLeadStageName ?? 'unknown'}`}
                          style={{
                            fontSize: 9,
                            fontWeight: 700,
                            letterSpacing: 0.04,
                            padding: '1px 5px',
                            borderRadius: 3,
                            background: '#f1f5f9',
                            color: '#475569',
                            border: '1px solid #cbd5e1',
                            lineHeight: 1.4,
                          }}
                        >
                          SF Lead
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Chat Area */}
      <main
        className={`flex-1 min-w-0 flex flex-col ${mobilePanel !== 'chat' ? 'hidden md:flex' : 'flex'}`}
        style={{ background: 'var(--lb-bg)' }}
      >
        {selectedLead ? (
          <>
            {/* Lead Info Header — fixed, never scrolls */}
            <div
              className="shrink-0"
              style={{
                padding: '14px 20px',
                background: 'var(--lb-surface)',
                borderBottom: '1px solid var(--lb-line)',
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
                  {/* Mobile back button */}
                  <button
                    className="p-1.5 sm:p-2 text-slate-400 hover:bg-slate-50 hover:text-slate-600 rounded-lg transition-colors md:hidden shrink-0"
                    onClick={() => setMobilePanel('list')}
                  >
                    <ArrowLeft size={20} />
                  </button>
                  <div className="w-10 h-10 sm:w-12 sm:h-12 bg-slate-100 rounded-full flex items-center justify-center text-slate-400 shrink-0">
                    <User size={20} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="font-bold text-slate-900 truncate">{selectedLead.customerName}</h3>
                      <span className={`px-1.5 py-0.5 text-[10px] font-bold rounded text-white ${selectedLead.platform === 'yelp' ? 'bg-[#FF1A1A]' : 'bg-[#41B1E1]'}`}>
                        {selectedLead.platform === 'yelp' ? 'Yelp' : 'TT'}
                      </span>
                      {/* SF identity badge — Customer takes precedence over Lead,
                          structural if/else so we never render both. SF Customer
                          (isSfLinked, indigo, primary) means SF owns the customer/
                          job lifecycle; SF Lead (sfLeadId only, slate, secondary)
                          means SF knows about the lead but LB still owns acquisition
                          (status editable, follow-ups continue, AI/classifier
                          unchanged). Stage name lives in tooltip only — see PR D
                          spec: badge text is just "SF Lead" to avoid stale-stage
                          surface. PR D (2026-06-05). */}
                      {selectedLead.isSfLinked ? (
                        <span
                          className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-indigo-600 text-white"
                          title="Customer is managed in Service Flow"
                        >
                          SF Customer
                        </span>
                      ) : selectedLead.sfLeadId ? (
                        <span
                          className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-slate-100 text-slate-700 border border-slate-300"
                          title={`Exists in ServiceFlow.\nStage at match time: ${selectedLead.sfLeadStageName ?? 'unknown'}`}
                        >
                          SF Lead
                        </span>
                      ) : null}
                      {/* Editable lead status pill — click to open dropdown of LB
                          canonical statuses. Manual writes may surface a conflict
                          modal if SF is integrated or platform status disagrees.
                          Label/tone come from displayLabel/displayPillKind so legacy
                          raw values (Open / Picked / Canceled / Yelp 'active', etc.)
                          fold into their group instead of falling through to
                          thumbtackStatus — which would render the platform-native
                          string twice next to the TT/Yelp pill below.

                          In SF-connected mode the pill renders disabled with a
                          tooltip — SF owns the lifecycle, so a manual write would
                          be rejected by LeadStatusService (sf_managed skipReason)
                          and produce a confusing toast. Pill stays visible so the
                          LB-side funnel value (engaged/quoted from classifier) is
                          still legible for support context. */}
                      <div className="relative">
                        <button
                          type="button"
                          disabled={savingStatus || !!selectedLead.isSfLinked}
                          onClick={() => {
                            if (selectedLead.isSfLinked) return;
                            setStatusEditorOpen(o => !o);
                          }}
                          className={`px-2 py-0.5 text-[10px] font-bold rounded uppercase transition ${
                            STATUS_GROUP_TONE[displayPillKind(selectedLead.status)] || 'bg-slate-100 text-slate-600'
                          } ${
                            selectedLead.isSfLinked
                              ? 'opacity-60 cursor-not-allowed'
                              : 'hover:ring-2 hover:ring-offset-1 hover:ring-blue-400'
                          }`}
                          title={selectedLead.isSfLinked ? 'Managed by ServiceFlow' : 'Click to change status'}
                        >
                          {displayLabel(selectedLead.status)}
                          {savingStatus && '…'}
                        </button>
                        {statusEditorOpen && (
                          <>
                            <button
                              className="fixed inset-0 z-30 bg-transparent cursor-default"
                              onClick={() => setStatusEditorOpen(false)}
                              aria-label="Close status menu"
                            />
                            <div className="absolute z-40 top-full mt-1 left-0 w-44 bg-white rounded-xl border border-slate-200 shadow-xl py-1">
                              {LB_PIPELINE_STATUSES.map(opt => {
                                const isCurrent = (selectedLead.status || '').toLowerCase() === opt.value;
                                return (
                                  <button
                                    key={opt.value}
                                    type="button"
                                    disabled={savingStatus}
                                    onClick={() => handleStatusChange(opt.value)}
                                    className={`w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50 flex items-center justify-between ${isCurrent ? 'font-bold' : ''}`}
                                  >
                                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${opt.tone}`}>{opt.label}</span>
                                    {isCurrent && <span className="text-slate-400">✓</span>}
                                  </button>
                                );
                              })}
                            </div>
                          </>
                        )}
                      </div>
                      {selectedLead.thumbtackStatus && selectedLead.thumbtackStatus.toLowerCase() !== (selectedLead.status || '').toLowerCase() && (
                        <span
                          className="px-2 py-0.5 text-[10px] font-semibold rounded uppercase bg-slate-50 border border-slate-200 text-slate-500"
                          title={`Platform-native status from ${selectedLead.platform}`}
                        >
                          {selectedLead.platform === 'yelp' ? 'Yelp' : 'TT'}: {selectedLead.thumbtackStatus}
                        </span>
                      )}
                      {/* SF job outcome — secondary pill rendered only when the
                          lead is SF-linked AND SF has reported an outcome. The
                          authoritative status for the customer-side lifecycle
                          lives here once SF takes over. */}
                      {selectedLead.isSfLinked && selectedLead.sfJobOutcome && (
                        <span
                          className="px-2 py-0.5 text-[10px] font-semibold rounded uppercase bg-indigo-50 border border-indigo-200 text-indigo-700"
                          title="Service Flow job outcome"
                        >
                          SF: {SF_JOB_OUTCOME_LABEL[selectedLead.sfJobOutcome] ?? selectedLead.sfJobOutcome}
                        </span>
                      )}
                    </div>
                    {/* Lead meta — all on one horizontal line with thin vertical
                        rules between items. Items: category · account · phone ·
                        date · estimate. Pieces with no value are skipped so
                        consecutive rules don't double up. */}
                    {(() => {
                      const accountName = getAccountNameForLead(selectedLead);
                      const items: React.ReactNode[] = [];
                      items.push(
                        <span key="cat" className="text-slate-500 whitespace-nowrap">
                          {selectedLead.category || 'Service Request'}
                        </span>
                      );
                      if (accountName) {
                        items.push(
                          <span key="acct" className="text-slate-400 whitespace-nowrap">{accountName}</span>
                        );
                      }
                      {
                        const realPhone = selectedLead.customerPhone;
                        const subPhone = selectedLead.customerPhoneSubstitute;
                        if (realPhone) {
                          items.push(
                            <a key="phone" href={`tel:${realPhone}`} className="flex items-center gap-1.5 text-slate-600 hover:text-blue-600 whitespace-nowrap">
                              <Phone size={14} />
                              {formatPhoneNumber(realPhone)}
                            </a>
                          );
                          if (subPhone && subPhone !== realPhone) {
                            items.push(
                              <a key="phone-sub" href={`tel:${subPhone}`} className="flex items-center gap-1.5 text-slate-400 hover:text-slate-600 whitespace-nowrap">
                                <Phone size={14} />
                                {formatPhoneNumber(subPhone)}
                                <span className="ml-1 px-1.5 py-px text-[10px] uppercase tracking-wide rounded bg-green-100 text-green-700">Real</span>
                              </a>
                            );
                          }
                        } else if (subPhone) {
                          items.push(
                            <a key="phone" href={`tel:${subPhone}`} className="flex items-center gap-1.5 text-slate-600 hover:text-blue-600 whitespace-nowrap">
                              <Phone size={14} />
                              {formatPhoneNumber(subPhone)}
                              <span className="ml-1 px-1.5 py-px text-[10px] uppercase tracking-wide rounded bg-green-100 text-green-700">Real</span>
                            </a>
                          );
                        } else {
                          items.push(
                            <span key="phone" className="flex items-center gap-1.5 text-slate-400 whitespace-nowrap">
                              <Phone size={14} />
                              No phone
                            </span>
                          );
                        }
                      }
                      items.push(
                        <span key="date" className="hidden md:flex items-center gap-1.5 text-slate-600 whitespace-nowrap">
                          <Calendar size={14} />
                          {formatDate(selectedLead.createdAt)}
                        </span>
                      );
                      if (selectedLead.raw?.estimate?.total) {
                        items.push(
                          <span key="est" className="hidden md:flex items-center gap-1.5 text-slate-600 whitespace-nowrap">
                            <DollarSign size={14} />
                            {selectedLead.raw.estimate.total}
                          </span>
                        );
                      }
                      return (
                        <div className="flex items-center gap-2 text-xs flex-wrap mt-0.5">
                          {items.map((item, i) => (
                            <span key={i} className="flex items-center gap-2">
                              {i > 0 && <span className="w-px h-3 bg-slate-300 shrink-0" aria-hidden />}
                              {item}
                            </span>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                </div>
                <div className="flex items-center gap-1 sm:gap-3 shrink-0">
                  {/* Desktop meta (phone / date / estimate) merged into the
                      single-line meta row above. This wrapper now only holds
                      the action buttons. */}
                  <button
                    className="p-2 text-slate-400 hover:bg-slate-50 hover:text-slate-600 rounded-lg transition-colors disabled:opacity-50"
                    onClick={handleResyncMessages}
                    disabled={resyncingMessages}
                    title="Resync messages"
                  >
                    {resyncingMessages ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
                  </button>
                  {/* Details panel toggle — visible on all viewports below xl (sidebar auto-shows ≥1280px) */}
                  <button
                    className="p-2 text-slate-400 hover:bg-slate-50 hover:text-slate-600 rounded-lg transition-colors xl:hidden"
                    onClick={() => setMobilePanel('details')}
                    title="Lead details"
                  >
                    <ChevronRight size={20} />
                  </button>
                </div>
              </div>
            </div>

            {/* Resync Error Message */}
            {resyncError && (
              <div className="mx-3 sm:mx-4 mt-3 sm:mt-4 p-3 bg-red-50 border border-red-100 rounded-xl flex items-center gap-2 text-red-600 text-xs sm:text-sm shrink-0">
                <AlertCircle size={16} />
                <span className="flex-1">{resyncError}</span>
                <button className="p-1 hover:bg-red-100 rounded transition-colors" onClick={() => setResyncError(null)}>
                  <X size={14} />
                </button>
              </div>
            )}

            {/* Channel Filter Bar */}
            <div
              className="shrink-0"
              style={{
                display: 'flex',
                gap: 6,
                padding: '10px 20px',
                borderBottom: '1px solid var(--lb-line)',
                background: 'var(--lb-surface)',
              }}
            >
              {(['all', 'platform', 'sms'] as const).map((filter) => {
                const active = channelFilter === filter;
                return (
                  <button
                    key={filter}
                    onClick={() => setChannelFilter(filter)}
                    style={{
                      padding: '4px 10px',
                      fontSize: 11,
                      fontWeight: 500,
                      fontFamily: 'inherit',
                      background: active ? 'var(--lb-accent-tint)' : 'transparent',
                      color: active ? 'var(--lb-accent)' : 'var(--lb-ink-5)',
                      border: `1px solid ${active ? 'var(--lb-accent-line)' : 'var(--lb-line)'}`,
                      borderRadius: 999,
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    {filter === 'all' && 'All'}
                    {filter === 'platform' && <><MessageCircle size={12} /> Platform</>}
                    {filter === 'sms' && <><Smartphone size={12} /> SMS</>}
                  </button>
                );
              })}
            </div>

            {/* Activity Timeline */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {loadingMessages ? (
                <div className="flex flex-col items-center justify-center h-full">
                  <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
                  <p className="mt-3 text-slate-500 text-sm">Loading messages...</p>
                </div>
              ) : filteredTimeline.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <MessageSquare className="w-12 h-12 text-slate-300 mb-3" />
                  <p className="text-slate-600 font-medium">No messages yet</p>
                  <small className="text-slate-400 mt-1">Send a message to start the conversation</small>
                </div>
              ) : (
                filteredTimeline.map((event) => {
                  // Check if account is disconnected for SMS messages
                  const account = selectedLead ? savedAccounts.find(a => a.businessId === selectedLead.businessId) : null;
                  const isAccountDisconnected = account && !account.webhookId;
                  const isSmsDisconnected = event.channel === 'sms' && isAccountDisconnected;

                  return (
                    <div
                      key={event.id}
                      className={`flex ${event.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
                    >
                      <div
                        className="max-w-[85%] sm:max-w-md px-4 py-2.5"
                        style={{
                          borderRadius: 10,
                          fontSize: 13,
                          lineHeight: 1.45,
                          border: '1px solid',
                          background:
                            isSmsDisconnected && event.direction === 'outbound'
                              ? 'oklch(0.96 0.05 75)'
                              : event.channel === 'sms' && event.direction === 'inbound'
                              ? 'oklch(0.95 0.04 150)'
                              : event.channel === 'sms'
                              ? 'oklch(0.96 0.05 75)'
                              : event.direction === 'outbound'
                              ? (event.senderType === 'ai' ? 'var(--lb-accent-tint)' : 'var(--lb-ink-1)')
                              : 'var(--lb-surface)',
                          color:
                            event.direction === 'outbound' && event.senderType !== 'ai' && !(event.channel === 'sms')
                              ? 'white'
                              : 'var(--lb-ink-1)',
                          borderColor:
                            isSmsDisconnected && event.direction === 'outbound'
                              ? 'oklch(0.85 0.1 75)'
                              : event.channel === 'sms'
                              ? 'oklch(0.85 0.06 150)'
                              : event.direction === 'outbound'
                              ? (event.senderType === 'ai' ? 'var(--lb-accent-line)' : 'var(--lb-ink-1)')
                              : 'var(--lb-line)',
                        }}
                      >
                      {/* Channel Badge */}
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-[10px] font-bold uppercase ${
                          isSmsDisconnected && event.direction === 'outbound'
                            ? 'text-yellow-700'
                            : event.channel === 'sms' && event.direction === 'inbound'
                            ? 'text-green-700'
                            : event.channel === 'sms'
                            ? 'text-yellow-700'
                            : event.direction === 'outbound'
                            // AI bubble bg is a light tint → use dark-on-light; manual (dark bg) keeps light text.
                            ? (event.senderType === 'ai' ? 'text-blue-700' : 'text-blue-100')
                            : 'text-blue-600'
                        }`}>
                          {event.channel === 'platform' && (
                            event.direction === 'inbound'
                              ? 'Client'
                              : event.senderType === 'ai'
                              ? 'AI'
                              : 'Dispatcher'
                          )}
                          {event.channel === 'sms' && 'SMS'}
                          {event.channel === 'call' && 'Call'}
                          {event.channel === 'automation' && 'Auto'}
                        </span>
                        {event.ruleName && (
                          <span className="text-[10px] text-slate-500">{event.ruleName}</span>
                        )}
                      </div>

                      {/* Message Content */}
                      {event.content && <div className="text-sm leading-relaxed">{renderMessageContent(event.content)}</div>}

                      {/* Attachments (platform only) */}
                      {event.attachments && event.attachments.length > 0 && (
                        <div className="mt-2 space-y-2">
                          {event.attachments.map((attachment, idx) => (
                            attachment.mimeType?.startsWith('image/') ? (
                              <a
                                key={idx}
                                href={attachment.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="block"
                              >
                                <img
                                  src={attachment.url}
                                  alt={attachment.fileName || `Image ${idx + 1}`}
                                  className="max-w-full rounded-lg"
                                />
                              </a>
                            ) : (
                              <a
                                key={idx}
                                href={attachment.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs underline"
                              >
                                {attachment.fileName || 'Download attachment'}
                              </a>
                            )
                          ))}
                        </div>
                      )}

                      {/* Message Footer: time + SMS status */}
                      <div className={`flex items-center gap-2 mt-1 text-[10px] ${
                        isSmsDisconnected && event.direction === 'outbound'
                          ? 'text-yellow-700'
                          : event.channel === 'sms'
                          ? 'text-yellow-700'
                          : event.direction === 'outbound'
                          // AI bubble bg is a light tint → use slate-500 for contrast; manual (dark bg) keeps light text.
                          ? (event.senderType === 'ai' ? 'text-slate-500' : 'text-blue-100')
                          : 'text-slate-500'
                      }`}>
                        <span>
                          {(() => {
                            const now = new Date();
                            const isSameDay =
                              event.timestamp.getFullYear() === now.getFullYear() &&
                              event.timestamp.getMonth() === now.getMonth() &&
                              event.timestamp.getDate() === now.getDate();
                            const time = event.timestamp.toLocaleTimeString('en-US', {
                              hour: '2-digit',
                              minute: '2-digit',
                            });
                            if (isSameDay) return `Today, ${time}`;
                            const datePart = event.timestamp.toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              ...(event.timestamp.getFullYear() !== now.getFullYear() && { year: 'numeric' }),
                            });
                            return `${datePart}, ${time}`;
                          })()}
                        </span>
                        {event.channel === 'sms' && event.smsStatus && (
                          <span
                            className={`font-semibold ${
                              event.smsStatus === 'delivered' ? 'text-green-600' :
                              event.smsStatus === 'failed' ? 'text-red-600' :
                              event.smsStatus === 'unknown' ? 'text-slate-500' :
                              ''
                            }`}
                            title={event.smsStatus === 'unknown' ? 'Sigcore never returned a delivery confirmation. The message was almost certainly delivered.' : undefined}
                          >
                            {event.smsStatus === 'delivered' && '\u2713\u2713 Delivered'}
                            {event.smsStatus === 'sent' && '\u2713 Sent'}
                            {event.smsStatus === 'queued' && '\u231B Queued'}
                            {event.smsStatus === 'pending' && '\u231B Pending'}
                            {event.smsStatus === 'failed' && '\u2717 Failed'}
                            {event.smsStatus === 'unknown' && '\u2713 Sent (delivery not confirmed)'}
                          </span>
                        )}
                        {event.channel === 'sms' && event.smsError && (
                          <span title={event.smsError} className="text-red-500 flex items-center gap-0.5">
                            <AlertCircle size={12} />
                          </span>
                        )}
                      </div>
                      {event.channel === 'sms' && event.smsStatus === 'failed' && event.smsError && (
                        <div className="text-[10px] text-red-500 mt-0.5 leading-tight max-w-[300px] truncate" title={event.smsError}>
                          {event.smsError}
                        </div>
                      )}
                    </div>

                    {/* AI Reply preview — inbound messages only, 4 strategy buttons with % */}
                    {event.direction === 'inbound' && event.content && (
                      <div className="mt-1">
                        {/* Strategy buttons row */}
                        <div className="flex items-center gap-1 flex-wrap">
                          <Sparkles size={10} className="text-violet-400" />
                          {AI_STRATEGIES.map(strategy => {
                            const previewKey = `${event.id}:${strategy.key}`;
                            const preview = aiPreview[previewKey];
                            const isSuggested = strategySuggestion?.suggested === strategy.key;
                            const rawSet = leadFollowUpInfo?.accountStrategy;
                            const isSet = rawSet != null && rawSet !== 'auto' && rawSet === strategy.key;
                            const isBoth = isSet && isSuggested;
                            const score = strategySuggestion?.scores?.[strategy.key];
                            return (
                              <button
                                key={strategy.key}
                                onClick={() => {
                                  setActiveStrategyKey(strategy.key);
                                  // Load context data for right panel if not loaded
                                  if (!threadContextData && selectedLead?.threadId) {
                                    conversationContextApi.getAiContext(selectedLead.threadId).then(res => {
                                      if (res.success && res.context) {
                                        setThreadContextData({ systemContext: res.context.systemContext, threadState: res.context.threadState });
                                      }
                                    }).catch(() => {});
                                  }
                                  if (preview) return; // already loaded, just show details
                                  setAiPreview(prev => ({ ...prev, [previewKey]: { loading: true, reply: null } }));
                                  if (selectedLead?.threadId) {
                                    aiApi.previewWithContext(selectedLead.id, selectedLead.threadId, event.content!, strategy.prompt, aiContextMode)
                                      .then(({ reply, contextMode }) => setAiPreview(prev => ({ ...prev, [previewKey]: { loading: false, reply, contextMode } })))
                                      .catch(() => setAiPreview(prev => ({ ...prev, [previewKey]: { loading: false, reply: 'Failed to generate.' } })));
                                  } else {
                                    const idx = timelineEvents.indexOf(event);
                                    const history = timelineEvents.slice(0, idx)
                                      .filter(e => e.content && (e.direction === 'inbound' || e.direction === 'outbound'))
                                      .map(e => ({ role: (e.direction === 'inbound' ? 'customer' : 'pro') as 'customer' | 'pro', content: e.content! }));
                                    aiApi.previewForLead(selectedLead!.id, event.content!, history, strategy.prompt)
                                      .then(({ reply }) => setAiPreview(prev => ({ ...prev, [previewKey]: { loading: false, reply } })))
                                      .catch(() => setAiPreview(prev => ({ ...prev, [previewKey]: { loading: false, reply: 'Failed to generate.' } })));
                                  }
                                }}
                                className={`text-[10px] px-1.5 py-0.5 rounded-md transition-colors ${
                                  preview?.reply ? 'bg-violet-100 text-violet-700 font-semibold' :
                                  preview?.loading ? 'bg-violet-50 text-violet-400' :
                                  isBoth ? 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100 ring-1 ring-emerald-300 font-semibold' :
                                  isSet ? 'text-blue-700 bg-blue-50 hover:bg-blue-100 ring-1 ring-blue-300 font-semibold' :
                                  isSuggested ? 'text-amber-600 hover:text-amber-700 hover:bg-amber-50 ring-1 ring-amber-200' :
                                  'text-violet-400 hover:text-violet-600 hover:bg-violet-50'
                                }`}
                                title={
                                  isBoth ? `Set on account AND suggested by AI — ${strategySuggestion?.reason || ''}` :
                                  isSet ? `Set on account: this is the strategy follow-ups actually use` :
                                  isSuggested ? `AI suggests: ${strategySuggestion?.reason}` :
                                  undefined
                                }
                              >
                                {preview?.loading ? <Loader2 size={9} className="animate-spin inline" /> : strategy.emoji} {strategy.label}
                                {score !== undefined && <span className="text-[8px] ml-0.5 opacity-70">{Math.round(score * 100)}%</span>}
                              </button>
                            );
                          })}
                        </div>

                        {/* Show loaded previews */}
                        {AI_STRATEGIES.map(strategy => {
                          const previewKey = `${event.id}:${strategy.key}`;
                          const preview = aiPreview[previewKey];
                          if (!preview || preview.loading || !preview.reply) return null;
                          return (
                            <div key={strategy.key} className="bg-violet-50 border border-violet-100 rounded-xl px-3 py-2 max-w-sm mt-1.5">
                              <div className="flex items-center justify-between gap-2 mb-1">
                                <span className="text-[10px] font-bold text-violet-500 uppercase tracking-widest">
                                  {strategy.emoji} {strategy.label}
                                  {preview.contextMode && <span className="ml-1 text-slate-400 normal-case font-normal">({preview.contextMode})</span>}
                                </span>
                                <button onClick={() => setAiPreview(prev => { const n = { ...prev }; delete n[previewKey]; return n; })} className="text-violet-300 hover:text-violet-500">
                                  <X size={11} />
                                </button>
                              </div>
                              <p className="text-xs text-slate-700 leading-relaxed">{preview.reply}</p>
                              <div className="flex items-center gap-2 mt-1.5">
                                <button
                                  onClick={() => {
                                    setMessageText(preview.reply || '');
                                    const input = document.querySelector<HTMLInputElement>('input[placeholder*="message"]');
                                    if (input) { input.focus(); input.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
                                  }}
                                  className="flex items-center gap-1 text-[10px] font-semibold text-violet-600 hover:text-violet-800 bg-violet-100 hover:bg-violet-200 px-2 py-1 rounded-lg transition-colors"
                                >
                                  <ArrowRight size={10} />
                                  Use this reply
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  );
                })
              )}
              {bannerMounted && bannerCopy && (
                <div
                  className="flex justify-center"
                  style={{
                    opacity: bannerVisible ? 1 : 0,
                    maxHeight: bannerVisible ? 200 : 0,
                    transform: bannerVisible ? 'translateY(0)' : 'translateY(-6px)',
                    transition: 'opacity 450ms ease, max-height 450ms ease, transform 450ms ease, margin 450ms ease',
                    overflow: 'hidden',
                    marginTop: bannerVisible ? undefined : 0,
                  }}
                >
                  <div
                    className="flex items-start gap-2 px-3 py-2 rounded-xl border max-w-md"
                    style={{
                      background: 'oklch(0.97 0.04 80)',
                      borderColor: 'oklch(0.85 0.1 80)',
                      color: 'oklch(0.35 0.1 60)',
                    }}
                  >
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    <div className="text-xs leading-snug">
                      <div className="font-semibold">{bannerCopy.title}</div>
                      {bannerCopy.reason && (
                        <div className="mt-0.5 opacity-80">{bannerCopy.reason}</div>
                      )}
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* V2 Review Mode pending AI draft. Shown above the composer
                when the account opted into 'suggest' delivery and a draft
                is parked. Send dispatches via /v1/leads/:id/ai-suggestion/send
                (server uses sendMessage('ai') so the outbound row is
                indistinguishable from auto-send). Discard clears the parked
                blob via /discard. Both actions trigger a force-refresh to
                update the surrounding thread + clear the banner.

                MVP per spec: Send + Discard only. Edit&Send and Regenerate
                are deferred. */}
            {pendingAiSuggestion && selectedLead && (
              <div className="px-3 sm:px-4 pt-3 border-t border-slate-100 bg-amber-50">
                <div className="flex items-start gap-2 mb-2">
                  <span className="text-amber-500" aria-hidden>🟡</span>
                  <div className="text-xs font-bold text-amber-800 uppercase tracking-wider">
                    AI drafted this reply
                  </div>
                </div>
                <p className="text-sm text-slate-700 bg-white border border-amber-200 rounded-lg p-3 leading-relaxed whitespace-pre-wrap">
                  {pendingAiSuggestion.message}
                </p>
                <div className="flex gap-2 mt-3 pb-3">
                  <button
                    className="flex-1 px-3 py-2 bg-blue-600 text-white rounded-lg font-semibold text-sm hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                    disabled={aiSuggestionBusy !== null}
                    onClick={async () => {
                      if (!selectedLead) return;
                      setAiSuggestionBusy('sending');
                      try {
                        await leadsApi.sendAiSuggestion(selectedLead.id);
                        setPendingAiSuggestion(null);
                        setLeadsWithPendingDraft(prev => {
                          const next = { ...prev };
                          delete next[selectedLead.id];
                          return next;
                        });
                        // Refresh the thread so the operator sees the sent
                        // message appear in the timeline.
                        delete messageCache.current[selectedLead.id];
                        await loadMessagesForLead(selectedLead, true);
                      } catch (err: any) {
                        console.error('[AI Suggestion] send failed:', err);
                        // Keep the draft banner visible so the operator can
                        // retry — pendingAiSuggestion is only cleared on
                        // success above. Surface the failure as a toast so
                        // the spinner stopping doesn't look like a no-op.
                        const detail = err?.response?.data?.message || err?.message || '';
                        notify.error(
                          'Failed to send AI draft',
                          detail
                            ? `Please try again. (${detail})`
                            : 'Please try again.',
                        );
                      } finally {
                        setAiSuggestionBusy(null);
                      }
                    }}
                  >
                    {aiSuggestionBusy === 'sending' ? <Loader2 className="animate-spin" size={14} /> : <Send size={14} />}
                    Send
                  </button>
                  <button
                    className="px-3 py-2 border border-slate-300 text-slate-700 rounded-lg font-semibold text-sm hover:bg-slate-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    disabled={aiSuggestionBusy !== null}
                    onClick={async () => {
                      if (!selectedLead) return;
                      setAiSuggestionBusy('discarding');
                      try {
                        await leadsApi.discardAiSuggestion(selectedLead.id);
                        setPendingAiSuggestion(null);
                        setLeadsWithPendingDraft(prev => {
                          const next = { ...prev };
                          delete next[selectedLead.id];
                          return next;
                        });
                      } catch (err: any) {
                        console.error('[AI Suggestion] discard failed:', err);
                        const detail = err?.response?.data?.message || err?.message || '';
                        notify.error(
                          'Failed to discard AI draft',
                          detail
                            ? `Please try again. (${detail})`
                            : 'Please try again.',
                        );
                      } finally {
                        setAiSuggestionBusy(null);
                      }
                    }}
                  >
                    Discard
                  </button>
                </div>
              </div>
            )}

            {/* Message Input */}
            {canSendMessage ? (
              <div className="p-2 sm:p-4 border-t border-slate-100 bg-white">
                <div className="flex gap-1.5 sm:gap-2">
                  {/* Channel + Template Selector */}
                  <select
                    value={sendChannel}
                    onChange={(e) => setSendChannel(e.target.value as 'platform' | 'sms')}
                    className="w-[72px] sm:w-auto px-2 sm:px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs sm:text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500 shrink-0"
                  >
                    <option value="platform">Platform</option>
                    {smsEnabled && selectedLead?.customerPhone && (
                      <option value="sms">SMS</option>
                    )}
                  </select>

                  {/* Template Selector Dropdown */}
                  <div className="relative shrink-0">
                    <button
                      type="button"
                      className="p-2 sm:p-3 text-slate-400 hover:bg-slate-50 hover:text-slate-600 rounded-xl transition-colors flex items-center gap-1"
                      onClick={() => setShowTemplateDropdown(!showTemplateDropdown)}
                      title="Use template"
                    >
                      <FileText size={18} />
                      <ChevronDown size={12} className="hidden sm:block" />
                    </button>
                    {showTemplateDropdown && singleMessageTemplates.length > 0 && (
                      <div className="absolute bottom-full left-0 mb-2 w-[calc(100vw-2rem)] sm:w-80 bg-white rounded-xl border border-slate-200 shadow-lg overflow-hidden z-10">
                        <div className="p-3 border-b border-slate-100 bg-slate-50">
                          <span className="text-xs font-bold text-slate-600 uppercase tracking-wider">Use Template</span>
                        </div>
                        <div className="max-h-60 overflow-y-auto">
                          {singleMessageTemplates.map((template) => (
                            <button
                              key={template.id}
                              className="w-full text-left p-3 hover:bg-slate-50 transition-colors border-b border-slate-100 last:border-b-0"
                              onClick={() => applyTemplateToMessage(template)}
                            >
                              <div className="font-semibold text-sm text-slate-900 mb-1">{template.name}</div>
                              <div className="text-xs text-slate-500 truncate">{template.content.substring(0, 50)}...</div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <form className="flex-1 flex gap-1.5 sm:gap-2 min-w-0" onSubmit={handleSendMessage}>
                    <input
                      type="text"
                      value={messageText}
                      onChange={(e) => setMessageText(e.target.value)}
                      placeholder={sendChannel === 'sms'
                        ? `SMS to ${formatPhoneNumber(selectedLead?.customerPhone || '')}...`
                        : 'Type a message...'}
                      disabled={sendingMessage}
                      className="flex-1 min-w-0 px-3 sm:px-4 py-2 sm:py-3 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
                    />
                    <button
                      type="submit"
                      className="px-3 sm:px-6 py-2 sm:py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center shrink-0"
                      disabled={!messageText.trim() || sendingMessage}
                    >
                      {sendingMessage ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
                    </button>
                  </form>
                </div>
              </div>
            ) : (
              <div className="p-3 sm:p-4 border-t border-slate-100 bg-amber-50 flex items-center justify-center gap-2 text-amber-700">
                <AlertCircle size={16} className="shrink-0" />
                <span className="text-xs sm:text-sm text-center">
                  Switch to <strong>{getAccountNameForLead(selectedLead) || 'this account'}</strong> to send messages
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <MessageSquare className="w-16 h-16 text-slate-300 mb-4" />
            <h3 className="text-xl font-bold text-slate-900 mb-2">Select a lead</h3>
            <p className="text-slate-500">Choose a lead from the list to view details and send messages</p>
          </div>
        )}
      </main>

      {/* Right Details Panel */}
      {selectedLead && (
        <aside className={`w-full md:w-72 bg-white border-l border-slate-100 overflow-y-auto ${mobilePanel === 'details' ? 'flex flex-col' : 'hidden'} xl:block`}>
          <div className="p-4 border-b border-slate-100 flex items-center gap-3">
            {/* Mobile back button */}
            <button
              className="p-2 text-slate-400 hover:bg-slate-50 hover:text-slate-600 rounded-lg transition-colors xl:hidden"
              onClick={() => setMobilePanel('chat')}
            >
              <ArrowLeft size={20} />
            </button>
            <h3 className="font-bold text-slate-900">Lead Details</h3>
          </div>

          {/* Follow-up suggestion card */}
          {fuSuggestions.length > 0 && (
            <div className="p-3 border-b border-slate-100 space-y-2">
              {fuSuggestions.map((s: any) => (
                <div key={s.id} className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <Sparkles size={14} className="text-amber-600" />
                    <span className="text-xs font-bold text-amber-800">Follow-up Suggestion</span>
                    <span className="text-[10px] text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded-full">{s.objective}</span>
                  </div>
                  {fuEditId === s.id ? (
                    <textarea value={fuEditMsg} onChange={e => setFuEditMsg(e.target.value)} rows={3}
                      className="w-full px-2 py-1.5 text-sm border border-amber-300 rounded-lg bg-white resize-none" />
                  ) : (
                    <p className="text-sm text-slate-700 leading-relaxed">{s.generatedMessage}</p>
                  )}
                  <div className="flex gap-1.5">
                    {fuEditId === s.id ? (
                      <button disabled={fuActionLoading} onClick={async () => {
                        setFuActionLoading(true);
                        await followUpApi.editAndApprove(s.id, fuEditMsg);
                        setFuSuggestions(prev => prev.filter(x => x.id !== s.id));
                        setFuEditId(null); setFuActionLoading(false);
                      }} className="px-2 py-1 text-[10px] font-bold bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                        Send Edited
                      </button>
                    ) : (
                      <>
                        <button disabled={fuActionLoading} onClick={async () => {
                          setFuActionLoading(true);
                          await followUpApi.approveSuggestion(s.id);
                          setFuSuggestions(prev => prev.filter(x => x.id !== s.id));
                          setFuActionLoading(false);
                        }} className="px-2 py-1 text-[10px] font-bold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50">
                          Approve & Send
                        </button>
                        <button onClick={() => { setFuEditId(s.id); setFuEditMsg(s.generatedMessage || ''); }}
                          className="px-2 py-1 text-[10px] font-bold bg-white text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
                          Edit
                        </button>
                        <button disabled={fuActionLoading} onClick={async () => {
                          setFuActionLoading(true);
                          await followUpApi.skipSuggestion(s.id);
                          setFuSuggestions(prev => prev.filter(x => x.id !== s.id));
                          setFuActionLoading(false);
                        }} className="px-2 py-1 text-[10px] font-bold text-slate-400 hover:text-red-500">
                          Skip
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Mobile-only: contact info (hidden in chat header on mobile) */}
          <div className="p-4 border-b border-slate-100 space-y-2 xl:hidden">
            {selectedLead.customerPhone && (
              <a href={`tel:${selectedLead.customerPhone}`} className="flex items-center gap-2 text-sm text-slate-700 hover:text-blue-600">
                <Phone size={16} className="text-slate-400" />
                {formatPhoneNumber(selectedLead.customerPhone)}
              </a>
            )}
            {selectedLead.city && (
              <span className="flex items-center gap-2 text-sm text-slate-700">
                <MapPin size={16} className="text-slate-400" />
                {selectedLead.city}, {selectedLead.state}
              </span>
            )}
            <span className="flex items-center gap-2 text-sm text-slate-700">
              <Calendar size={16} className="text-slate-400" />
              {formatDate(selectedLead.createdAt)}
            </span>
            {selectedLead.raw?.estimate?.total && (
              <span className="flex items-center gap-2 text-sm text-slate-700">
                <DollarSign size={16} className="text-slate-400" />
                {selectedLead.raw.estimate.total}
              </span>
            )}
          </div>
          <div className="p-4 space-y-6">
            {/* Lead Activity Timeline — every status transition that touched this lead */}
            <LeadActivityTimeline leadId={selectedLead.id} />

            {/* Lead Cost */}
            {selectedLead.raw?.leadPrice && (
              <div>
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Lead Cost</h4>
                <p className="flex items-center gap-2 text-sm text-slate-900 font-semibold">
                  <Tag size={14} className="text-slate-400" />
                  {selectedLead.raw.leadPrice}
                </p>
              </div>
            )}

            {/* Request Details */}
            {getLeadDetails(selectedLead).length > 0 && (
              <div>
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Request Details</h4>
                <dl className="space-y-3">
                  {getLeadDetails(selectedLead).map((detail, idx) => (
                    <div key={idx}>
                      <dt className="text-xs font-semibold text-slate-600 mb-1">{detail.question}</dt>
                      <dd className="text-sm text-slate-900">{detail.answer}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            {/* Communication Summary — one-line */}
            {(commSummary.platformMessages > 0 || commSummary.smsSent > 0 || commSummary.calls > 0) && (
              <div className="flex items-center gap-3 text-[11px] text-slate-500 bg-slate-50 rounded-lg px-3 py-1.5 flex-wrap">
                <span className="flex items-center gap-1"><MessageCircle size={11} /> {commSummary.platformMessages} msgs</span>
                <span className="flex items-center gap-1"><Smartphone size={11} /> {commSummary.smsSent} sms</span>
                {commSummary.smsFailed > 0 && <span className="text-red-500">{commSummary.smsFailed} failed</span>}
                <span className="flex items-center gap-1"><Phone size={11} /> {commSummary.calls} calls</span>
              </div>
            )}

            {/* AI Strategy Details — shown when a strategy button is clicked */}
            {activeStrategyKey && strategySuggestion && (
              <div className="space-y-3">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Conversation Goal</h4>
                <div className="bg-violet-50 border border-violet-100 rounded-xl p-3 space-y-2">
                  {/* Active strategy header */}
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-800">
                      {AI_STRATEGIES.find(s => s.key === activeStrategyKey)?.emoji}{' '}
                      {AI_STRATEGIES.find(s => s.key === activeStrategyKey)?.label}
                    </span>
                    {strategySuggestion.scores?.[activeStrategyKey] !== undefined && (
                      <span className="text-[9px] bg-violet-100 text-violet-600 px-1.5 py-0.5 rounded-full font-semibold">
                        {Math.round(strategySuggestion.scores[activeStrategyKey] * 100)}%
                      </span>
                    )}
                    {strategySuggestion.suggested === activeStrategyKey && (
                      <span className="text-[9px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-semibold">recommended</span>
                    )}
                  </div>

                  {/* Why this answer */}
                  {strategySuggestion.suggested === activeStrategyKey && (
                    <p className="text-[11px] text-slate-600 leading-relaxed">{strategySuggestion.reason}</p>
                  )}

                  {/* Context — collapsible */}
                  <details>
                    <summary className="text-[10px] text-violet-500 cursor-pointer hover:text-violet-700 font-semibold flex items-center gap-1">
                      <ChevronRight size={9} /> Context
                    </summary>
                    <div className="mt-1.5 space-y-1.5">
                      {threadContextData?.systemContext && (
                        <div>
                          <div className="text-[10px] font-semibold text-slate-500 mb-0.5">Summary:</div>
                          <p className="text-[10px] text-slate-600 italic leading-relaxed">
                            {threadContextData.systemContext.split('\n').find(l => l.startsWith('Conversation summary:'))?.replace('Conversation summary: ', '') || 'No summary yet'}
                          </p>
                        </div>
                      )}
                      <div>
                        <div className="text-[10px] font-semibold text-slate-500 mb-0.5">State:</div>
                        <ul className="text-[10px] text-slate-600 space-y-0.5 list-none">
                          {strategySuggestion.threadState.awaitingCustomerReply !== undefined && (
                            <li>- awaiting reply: {strategySuggestion.threadState.awaitingCustomerReply ? 'yes' : 'no'}</li>
                          )}
                          <li>- price discussed: {strategySuggestion.threadState.priceDiscussed ? (strategySuggestion.threadState.priceRange || 'yes') : 'no'}</li>
                          {strategySuggestion.threadState.missingFields?.length > 0 && (
                            <li>- missing: {strategySuggestion.threadState.missingFields.join(', ')}</li>
                          )}
                          {strategySuggestion.threadState.stage && (
                            <li>- stage: {strategySuggestion.threadState.stage}</li>
                          )}
                          {strategySuggestion.threadState.engagementLevel && strategySuggestion.threadState.engagementLevel !== 'unknown' && (
                            <li>- engagement: {strategySuggestion.threadState.engagementLevel}</li>
                          )}
                        </ul>
                      </div>
                      {threadContextData?.systemContext && (
                        <details className="mt-1">
                          <summary className="text-[9px] text-violet-400 cursor-pointer hover:text-violet-600 font-semibold">View full context</summary>
                          <pre className="mt-1 text-[9px] text-slate-500 whitespace-pre-wrap bg-white rounded-lg p-2 max-h-32 overflow-y-auto border border-slate-100">{threadContextData.systemContext}</pre>
                        </details>
                      )}
                    </div>
                  </details>

                  {/* Prompt — collapsible */}
                  <details>
                    <summary className="text-[10px] text-violet-500 cursor-pointer hover:text-violet-700 font-semibold flex items-center gap-1">
                      <ChevronRight size={9} /> Prompt
                    </summary>
                    <pre className="mt-1 text-[9px] text-slate-500 whitespace-pre-wrap bg-white rounded-lg p-2 max-h-32 overflow-y-auto border border-slate-100">
                      {AI_STRATEGIES.find(s => s.key === activeStrategyKey)?.prompt || ''}
                    </pre>
                  </details>
                </div>
              </div>
            )}

            {/* Follow-up & AI status — rich panel */}
            {leadFollowUpInfo && (
              <div className="space-y-1">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Ongoing Communication</h4>
                <div className="bg-slate-50 rounded-xl p-2.5 space-y-2 text-[11px]">
                  {/* Strategy at-a-glance — Set (account-configured) vs Suggested (per-thread AI) */}
                  {(() => {
                    const rawSet = leadFollowUpInfo.accountStrategy;
                    const setKey = rawSet && rawSet !== 'auto' ? rawSet : null;
                    const setStrategy = setKey ? AI_STRATEGIES.find(s => s.key === setKey) : null;
                    const suggestedKey = strategySuggestion?.suggested;
                    const suggestedStrategy = suggestedKey ? AI_STRATEGIES.find(s => s.key === suggestedKey) : null;
                    const matches = setKey != null && suggestedKey != null && setKey === suggestedKey;
                    return (
                      <div className="grid grid-cols-2 gap-1.5 pb-1.5 border-b border-slate-200/70">
                        {/* SET — blue (account-configured, authoritative) */}
                        <div className="bg-blue-50/60 border border-blue-200 rounded-lg px-2 py-1.5">
                          <div className="flex items-center gap-1 mb-0.5">
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500" aria-hidden />
                            <span className="text-blue-700 font-bold uppercase tracking-wide text-[9px]">Set</span>
                            <span className="text-slate-400 text-[9px]">account</span>
                          </div>
                          {setStrategy ? (
                            <div className="flex items-center gap-1 text-blue-700 font-semibold text-[11px]">
                              <span>{setStrategy.emoji}</span>
                              <span>{setStrategy.label}</span>
                            </div>
                          ) : (
                            <div className="text-slate-500 font-medium text-[11px]">Auto</div>
                          )}
                        </div>
                        {/* SUGGESTED — amber (AI), emerald when matching Set */}
                        <div
                          className={`rounded-lg px-2 py-1.5 border ${
                            matches ? 'bg-emerald-50/60 border-emerald-200' : 'bg-amber-50/60 border-amber-200'
                          }`}
                          title={matches ? 'Matches the account-configured strategy' : (setKey ? 'Differs from the account-configured strategy — Set wins for follow-ups' : 'Account is on Auto — Suggested will be used')}
                        >
                          <div className="flex items-center gap-1 mb-0.5">
                            <span className={`inline-block w-1.5 h-1.5 rounded-full ${matches ? 'bg-emerald-500' : 'bg-amber-500'}`} aria-hidden />
                            <span className={`font-bold uppercase tracking-wide text-[9px] ${matches ? 'text-emerald-700' : 'text-amber-700'}`}>Suggested</span>
                            <span className="text-slate-400 text-[9px]">AI</span>
                          </div>
                          {suggestedStrategy ? (
                            <div className={`flex items-center gap-1 font-semibold text-[11px] ${matches ? 'text-emerald-700' : 'text-amber-700'}`}>
                              <span>{suggestedStrategy.emoji}</span>
                              <span>{suggestedStrategy.label}</span>
                            </div>
                          ) : (
                            <div className="text-slate-400 font-medium text-[11px]">—</div>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                  {/* Follow-up status */}
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">Follow-ups</span>
                    {!leadFollowUpInfo.enrollmentId ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] text-slate-400">
                          {leadFollowUpInfo.followUpStatus === 'stopped'
                            ? `Stopped${leadFollowUpInfo.lastStoppedReason === 'customer_replied' ? ' — replied' : leadFollowUpInfo.lastStoppedReason === 'manual' ? ' — manual' : leadFollowUpInfo.lastStoppedReason ? ` — ${leadFollowUpInfo.lastStoppedReason.replace(/_/g, ' ')}` : ''}`
                            : leadFollowUpInfo.followUpStatus === 'completed' ? 'Completed'
                            : leadFollowUpInfo.mode === 'off' ? 'Disabled'
                            : 'Not enrolled'}
                        </span>
                        {leadFollowUpInfo.mode !== 'off' && (
                          <button
                            className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                            onClick={async () => {
                              if (!selectedLead?.threadId) return;
                              // Optimistic update — show active state immediately
                              const prev = leadFollowUpInfo;
                              setLeadFollowUpInfo({
                                ...leadFollowUpInfo,
                                enrollmentId: 'pending',
                                followUpStatus: 'active',
                                lastStoppedReason: null,
                              });
                              try {
                                const res = await followUpApi.restartFollowUp(selectedLead.threadId);
                                if (res.success) {
                                  const updated = await followUpApi.getEnrollmentInfo(selectedLead.threadId);
                                  if (updated.enrollment) {
                                    setLeadFollowUpInfo({
                                      ...leadFollowUpInfo,
                                      enrollmentId: updated.enrollment.id,
                                      nextFollowUpAt: updated.enrollment.nextStepDueAt || null,
                                      followUpStatus: updated.enrollment.status || null,
                                      currentStepIndex: updated.enrollment.currentStepIndex ?? 0,
                                      totalSteps: updated.enrollment.totalSteps ?? 0,
                                      sentCount: updated.enrollment.sentCount ?? 0,
                                      nextStepObjective: updated.enrollment.nextStepObjective || null,
                                      nextMessagePreview: updated.enrollment.nextMessagePreview || null,
                                      nextMessageMode: updated.enrollment.nextMessageMode || 'ai',
                                      pendingSuggestionId: updated.enrollment.pendingSuggestionId || null,
                                      mode: updated.enrollment.mode || 'auto_send',
                                      lastStoppedReason: null,
                                    });
                                  }
                                } else {
                                  // Rollback
                                  setLeadFollowUpInfo(prev);
                                }
                              } catch {
                                setLeadFollowUpInfo(prev);
                              }
                            }}
                          >
                            Restart
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-600">Active</span>
                        <button
                          className="px-1.5 py-0.5 rounded text-[10px] font-medium border border-red-200 text-red-500 hover:bg-red-50 transition-colors"
                          onClick={async () => {
                            const enrollmentId = leadFollowUpInfo.enrollmentId;
                            if (!enrollmentId || enrollmentId === 'pending') return;
                            const prev = leadFollowUpInfo;
                            setLeadFollowUpInfo({
                              ...leadFollowUpInfo,
                              enrollmentId: '',
                              nextFollowUpAt: null,
                              followUpStatus: 'stopped',
                              currentStepIndex: 0,
                              totalSteps: 0,
                              nextMessagePreview: null,
                              pendingSuggestionId: null,
                              lastStoppedReason: 'manual',
                            });
                            try {
                              await followUpApi.stopEnrollment(enrollmentId, 'manual');
                            } catch {
                              setLeadFollowUpInfo(prev);
                            }
                          }}
                        >
                          Stop
                        </button>
                      </div>
                    )}
                  </div>
                  {/* Next follow-up with relative time + step progress */}
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">Next follow-up</span>
                    <span className="font-semibold text-slate-700">
                      {leadFollowUpInfo.nextFollowUpAt ? (() => {
                        const due = new Date(leadFollowUpInfo.nextFollowUpAt);
                        const now = new Date();
                        const diffMs = due.getTime() - now.getTime();
                        const diffMin = Math.round(diffMs / 60_000);
                        const diffHr = Math.round(diffMs / 3_600_000);
                        const diffDay = Math.round(diffMs / 86_400_000);
                        let relative = '';
                        if (diffMin < 0) relative = 'overdue';
                        else if (diffMin < 60) relative = `in ${diffMin}m`;
                        else if (diffHr < 24) relative = `in ${diffHr}h`;
                        else relative = `in ${diffDay}d`;
                        return relative;
                      })() : <span className="text-slate-400 font-normal">None scheduled</span>}
                    </span>
                  </div>
                  {/* Step progress bar */}
                  {leadFollowUpInfo.totalSteps > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-slate-500">Progress</span>
                        <span className="text-[10px] text-slate-500">
                          Step {leadFollowUpInfo.currentStepIndex + 1} of {leadFollowUpInfo.totalSteps}
                          {leadFollowUpInfo.sentCount > 0 && ` (${leadFollowUpInfo.sentCount} sent)`}
                        </span>
                      </div>
                      <div className="w-full bg-slate-200 rounded-full h-1.5">
                        <div
                          className="bg-blue-500 h-1.5 rounded-full transition-all"
                          style={{ width: `${Math.min(100, ((leadFollowUpInfo.currentStepIndex) / leadFollowUpInfo.totalSteps) * 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {/* Absolute date (smaller) */}
                  {leadFollowUpInfo.nextFollowUpAt && (
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400 text-[10px]">Scheduled</span>
                      <span className="text-[10px] text-slate-400">
                        {new Date(leadFollowUpInfo.nextFollowUpAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </span>
                    </div>
                  )}
                  {/* AI Conversation status + availability */}
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">AI Conversation</span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                      leadFollowUpInfo.aiConversationOn
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-slate-200 text-slate-500'
                    }`}>
                      {leadFollowUpInfo.aiConversationOn ? 'On' : 'Off'}
                    </span>
                  </div>
                  {leadFollowUpInfo.aiConversationOn && (
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400 text-[10px]">Availability</span>
                      <span className="text-[10px] text-slate-500 font-medium">
                        {leadFollowUpInfo.aiAvailability === 'always'
                          ? '24/7'
                          : leadFollowUpInfo.aiActiveHoursStart && leadFollowUpInfo.aiActiveHoursEnd
                            ? `${leadFollowUpInfo.aiActiveHoursStart} – ${leadFollowUpInfo.aiActiveHoursEnd}${leadFollowUpInfo.aiTimezone ? ` ${({ 'America/New_York': 'ET', 'America/Chicago': 'CT', 'America/Denver': 'MT', 'America/Los_Angeles': 'PT' } as Record<string, string>)[leadFollowUpInfo.aiTimezone] || ''}` : ''}`
                            : 'Active hours'}
                      </span>
                    </div>
                  )}
                </div>

                {/* Next message preview */}
                {leadFollowUpInfo.nextFollowUpAt && (
                  <div className="bg-white border border-slate-200 rounded-xl p-2.5 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-bold text-slate-400 uppercase">Next Message</span>
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${
                        leadFollowUpInfo.nextMessageMode === 'template'
                          ? 'bg-slate-100 text-slate-500'
                          : 'bg-violet-50 text-violet-600'
                      }`}>
                        {leadFollowUpInfo.nextMessageMode === 'template' ? 'Template' : 'AI'}
                      </span>
                    </div>

                    {editingPreview ? (
                      <div className="space-y-1.5">
                        <textarea
                          className="w-full text-[11px] text-slate-700 border border-blue-200 rounded-lg p-2 resize-none focus:outline-none focus:ring-1 focus:ring-blue-400"
                          rows={4}
                          value={editedMessage}
                          onChange={(e) => setEditedMessage(e.target.value)}
                        />
                        <div className="flex gap-1">
                          <button
                            className="flex-1 text-[10px] font-medium py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                            onClick={async () => {
                              if (!leadFollowUpInfo.pendingSuggestionId) return;
                              const res = await followUpApi.editAndApprove(leadFollowUpInfo.pendingSuggestionId, editedMessage);
                              if (res.success) {
                                setEditingPreview(false);
                                // Reload enrollment info
                                if (selectedLead?.threadId) {
                                  const updated = await followUpApi.getEnrollmentInfo(selectedLead.threadId);
                                  setLeadFollowUpInfo(updated.enrollment ? { ...leadFollowUpInfo, ...updated.enrollment } : null);
                                }
                              }
                            }}
                          >
                            Send Edited
                          </button>
                          <button
                            className="text-[10px] font-medium py-1 px-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
                            onClick={() => setEditingPreview(false)}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {leadFollowUpInfo.nextMessagePreview ? (
                          <p className="text-[11px] text-slate-600 leading-relaxed bg-slate-50 rounded-lg p-2 max-h-24 overflow-y-auto">
                            {leadFollowUpInfo.nextMessagePreview}
                          </p>
                        ) : leadFollowUpInfo.nextMessageMode === 'ai' ? (
                          <button
                            className="w-full text-[10px] font-medium py-1.5 rounded-lg border border-dashed border-violet-300 text-violet-500 hover:bg-violet-50 flex items-center justify-center gap-1"
                            disabled={previewLoading}
                            onClick={async () => {
                              if (!selectedLead?.threadId) return;
                              setPreviewLoading(true);
                              try {
                                const res = await followUpApi.generatePreview(selectedLead.threadId);
                                if (res.success && res.message) {
                                  setLeadFollowUpInfo(prev => prev ? { ...prev, nextMessagePreview: res.message! } : prev);
                                }
                              } finally {
                                setPreviewLoading(false);
                              }
                            }}
                          >
                            {previewLoading ? <><Loader2 size={10} className="animate-spin" /> Generating...</> : <><Sparkles size={10} /> Generate Preview</>}
                          </button>
                        ) : null}

                        {/* Action buttons */}
                        {leadFollowUpInfo.nextMessagePreview && (
                          <div className="flex gap-1">
                            {leadFollowUpInfo.pendingSuggestionId && (
                              <>
                                <button
                                  className="flex-1 text-[10px] font-medium py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                                  onClick={async () => {
                                    await followUpApi.approveSuggestion(leadFollowUpInfo.pendingSuggestionId!);
                                    if (selectedLead?.threadId) {
                                      const updated = await followUpApi.getEnrollmentInfo(selectedLead.threadId);
                                      setLeadFollowUpInfo(updated.enrollment ? { ...leadFollowUpInfo, ...updated.enrollment } : null);
                                    }
                                  }}
                                >
                                  Send Now
                                </button>
                                <button
                                  className="text-[10px] font-medium py-1 px-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
                                  onClick={() => {
                                    setEditedMessage(leadFollowUpInfo.nextMessagePreview || '');
                                    setEditingPreview(true);
                                  }}
                                >
                                  Edit
                                </button>
                              </>
                            )}
                            <button
                              className="text-[10px] font-medium py-1 px-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
                              onClick={async () => {
                                if (leadFollowUpInfo.pendingSuggestionId) {
                                  await followUpApi.skipSuggestion(leadFollowUpInfo.pendingSuggestionId);
                                }
                                if (selectedLead?.threadId) {
                                  const updated = await followUpApi.getEnrollmentInfo(selectedLead.threadId);
                                  setLeadFollowUpInfo(updated.enrollment ? { ...leadFollowUpInfo, ...updated.enrollment } : null);
                                }
                              }}
                            >
                              Skip
                            </button>
                            <button
                              className="text-[10px] font-medium py-1 px-2 rounded-lg border border-red-200 text-red-400 hover:bg-red-50"
                              onClick={async () => {
                                const enrollmentId = leadFollowUpInfo.enrollmentId;
                                const prev = leadFollowUpInfo;
                                // Optimistic update — show stopped state immediately
                                setLeadFollowUpInfo({
                                  ...leadFollowUpInfo,
                                  enrollmentId: '',
                                  nextFollowUpAt: null,
                                  followUpStatus: 'stopped',
                                  currentStepIndex: 0,
                                  totalSteps: 0,
                                  nextMessagePreview: null,
                                  pendingSuggestionId: null,
                                  lastStoppedReason: 'manual',
                                });
                                try {
                                  await followUpApi.stopEnrollment(enrollmentId, 'manual');
                                } catch {
                                  // Rollback on failure
                                  setLeadFollowUpInfo(prev);
                                }
                              }}
                            >
                              Stop
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Follow-up Status — compact thread status (Set vs Suggested live at top of Ongoing Communication) */}
            {strategySuggestion && (() => {
              const rawSet = leadFollowUpInfo?.accountStrategy;
              const setKey = rawSet && rawSet !== 'auto' ? rawSet : null;
              const setStrategy = setKey ? AI_STRATEGIES.find(s => s.key === setKey) : null;
              const matches = setKey != null && setKey === strategySuggestion.suggested;
              return (
                <div className="space-y-1">
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Follow-up Status</h4>
                  <div className="bg-slate-50 rounded-xl p-2.5 space-y-1 text-[11px] text-slate-600">
                    {/* Explanatory note — which strategy actually controls follow-ups */}
                    {setKey ? (
                      matches ? (
                        <p className="text-[10px] text-emerald-700 leading-snug">
                          <span className="font-semibold">Set</span> matches <span className="font-semibold">Suggested</span> — follow-ups use {setStrategy?.label}.
                        </p>
                      ) : (
                        <p className="text-[10px] text-slate-600 leading-snug">
                          Follow-ups use the <span className="text-blue-700 font-semibold">Set</span> strategy ({setStrategy?.label}). The <span className="text-amber-700 font-semibold">Suggested</span> pill is the AI's per-thread recommendation only.
                        </p>
                      )
                    ) : (
                      <p className="text-[10px] text-slate-600 leading-snug">
                        Account strategy is <span className="font-semibold">Auto</span> — follow-ups will use the <span className="text-amber-700 font-semibold">Suggested</span> strategy.
                      </p>
                    )}
                    {strategySuggestion.threadState.stage && (
                      <div className="flex items-center justify-between pt-1 border-t border-slate-200/70">
                        <span className="text-slate-500">Stage</span>
                        <span className="font-medium capitalize">{strategySuggestion.threadState.stage}</span>
                      </div>
                    )}
                    {strategySuggestion.threadState.awaitingCustomerReply && (
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500">State</span>
                        <span className="text-amber-600 font-medium">Waiting for reply</span>
                      </div>
                    )}
                    <p className="text-[9px] text-slate-400 pt-0.5">{strategySuggestion.reason}</p>
                  </div>
                </div>
              );
            })()}

          </div>
        </aside>
      )}

      {/* Status conflict modal. Two variants, keyed off conflict.kind:
          - sf_push_needed: "this lead is tracked in Service Flow — update there"
          - platform_nudge_needed: "platform status is different — update on platform"
          The LB write has ALREADY been persisted before this modal opens; the
          modal is purely advisory, so the only actions are dismiss (which
          resolves the audit row with a note) or a deep-link to the source. */}
      {statusConflict && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
          onClick={() => handleResolveConflict('dismissed_without_action')}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className={`p-2 rounded-lg ${
                statusConflict.kind === 'sf_push_needed' ? 'bg-amber-100' : 'bg-blue-100'
              }`}>
                <AlertTriangle
                  size={20}
                  className={statusConflict.kind === 'sf_push_needed' ? 'text-amber-600' : 'text-blue-600'}
                />
              </div>
              <div className="flex-1">
                <h3 className="font-bold text-slate-900 text-base">
                  {statusConflict.kind === 'sf_push_needed'
                    ? 'Update Service Flow too?'
                    : `Update ${statusConflict.platform === 'yelp' ? 'Yelp' : 'Thumbtack'} too?`}
                </h3>
                <p className="text-sm text-slate-600 mt-1">
                  {statusConflict.kind === 'sf_push_needed'
                    ? 'Status saved in LeadBridge. Since this lead is tracked in Service Flow, the job there still shows the old status. Update it in Service Flow to keep both in sync.'
                    : `Status saved in LeadBridge. The lead still shows "${statusConflict.platformStatus}" on ${statusConflict.platform === 'yelp' ? 'Yelp' : 'Thumbtack'}. Update it on the platform so customer-facing state matches.`}
                </p>
                {statusConflict.kind === 'sf_push_needed' && statusConflict.sfJobId && (
                  <p className="text-xs text-slate-400 mt-2 font-mono">
                    SF job: {statusConflict.sfJobId}
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => handleResolveConflict('acknowledged')}
                className="flex-1 px-4 py-2 text-sm font-bold bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Got it
              </button>
              <button
                type="button"
                onClick={() => handleResolveConflict('dismissed_without_action')}
                className="px-4 py-2 text-sm font-semibold text-slate-600 hover:text-slate-900"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Send Modal */}
      {showBulkSendModal && (
        <div className="modal-overlay" onClick={closeBulkSendModal}>
          <div className="bulk-send-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Send Follow-up Message</h3>
              <button className="btn-icon" onClick={closeBulkSendModal}>
                <X size={20} />
              </button>
            </div>

            <div className="modal-body">
              <div className="bulk-send-info">
                <Mail size={18} />
                <span>
                  Sending to <strong>{selectedLeadIds.size}</strong> lead{selectedLeadIds.size !== 1 ? 's' : ''}
                  {sendableLeadsCount < selectedLeadIds.size && (
                    <span className="warning"> ({sendableLeadsCount} have active conversations)</span>
                  )}
                </span>
              </div>
              {/* Show active filters */}
              {(accountFilter !== 'all' || dateFilter !== 'all') && (
                <div className="bulk-send-filters">
                  <span className="filter-label">Filtered by:</span>
                  {accountFilter !== 'all' && (
                    <span className="filter-tag">
                      <Building2 size={12} />
                      {savedAccounts.find(a => a.businessId === accountFilter)?.businessName || 'Account'}
                    </span>
                  )}
                  {dateFilter !== 'all' && (
                    <span className="filter-tag">
                      <Calendar size={12} />
                      {monthOptions.find(m => m.value === dateFilter)?.label || dateFilter}
                    </span>
                  )}
                </div>
              )}

              {/* Template Selector */}
              <div className="form-group">
                <label>Template</label>
                {loadingTemplates ? (
                  <div className="loading-templates">
                    <Loader2 className="spinner" size={16} />
                    Loading templates...
                  </div>
                ) : templates.length === 0 ? (
                  <p className="no-templates-hint">
                    No templates yet. <a href="/templates">Create one</a>
                  </p>
                ) : (
                  <select
                    value={selectedTemplateId || ''}
                    onChange={(e) => handleTemplateSelect(e.target.value)}
                    className="template-select"
                  >
                    <option value="">-- Custom message --</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} {t.isDefault && '(Default)'}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Message Content */}
              <div className="form-group">
                <label>Message</label>
                <textarea
                  value={customMessage}
                  onChange={(e) => {
                    setCustomMessage(e.target.value);
                    setBulkPreviews([]); // Clear previews when message changes
                  }}
                  placeholder="Hi {firstName}, thanks for reaching out about {category}..."
                  className="bulk-message-textarea"
                  rows={5}
                />
                <div className="variables-hint">
                  Variables: {'{customerName}'} {'{firstName}'} {'{category}'} {'{city}'} {'{state}'}
                </div>
              </div>

              {/* Preview Section */}
              <div className="preview-section">
                <div className="preview-header">
                  <h4>Preview</h4>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={loadBulkPreview}
                    disabled={loadingPreview || !customMessage.trim()}
                  >
                    {loadingPreview ? <Loader2 className="spinner" size={14} /> : 'Generate Preview'}
                  </button>
                </div>

                {bulkPreviews.length > 0 && (
                  <div className="previews-list">
                    {bulkPreviews.slice(0, 3).map((preview) => (
                      <div
                        key={preview.leadId}
                        className={`preview-item ${preview.canSend ? '' : 'cannot-send'}`}
                      >
                        <div className="preview-name">
                          {preview.customerName}
                          {!preview.canSend && <span className="preview-error">{preview.error}</span>}
                        </div>
                        <div className="preview-message">{preview.personalizedMessage}</div>
                      </div>
                    ))}
                    {bulkPreviews.length > 3 && (
                      <p className="more-previews">...and {bulkPreviews.length - 3} more</p>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="modal-footer">
              {bulkSendProgress && (
                <div className="send-progress">
                  Sending... {bulkSendProgress.sent}/{bulkSendProgress.total}
                </div>
              )}
              <button className="btn btn-secondary" onClick={closeBulkSendModal} disabled={sendingBulk}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleBulkSend}
                disabled={sendingBulk || !customMessage.trim() || selectedLeadIds.size === 0}
              >
                {sendingBulk ? (
                  <>
                    <Loader2 className="spinner" size={16} />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send size={16} />
                    Send to {selectedLeadIds.size} Lead{selectedLeadIds.size !== 1 ? 's' : ''}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Refundable proof modal — read-only evidence + "Open in Thumbtack"
          deep link. No submit/ignore buttons per operator spec; the pro
          decides on TT's side, the existing chargeState sweep confirms
          back. Closes on backdrop click or ESC. */}
      {refundableProofLead && (() => {
        const flag = refundableProofLead.refundableFlag;
        if (!flag) return null;
        let parsed: any = null;
        try { parsed = flag.evidenceJson ? JSON.parse(flag.evidenceJson) : null; } catch { /* keep null */ }
        const ttUrl = refundableProofLead.externalRequestId
          ? `https://www.thumbtack.com/pro/jobs/${refundableProofLead.externalRequestId}`
          : null;
        return (
          <div
            onClick={() => setRefundableProofLead(null)}
            style={{
              position: 'fixed', inset: 0, zIndex: 1000,
              background: 'rgba(15, 23, 42, 0.5)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: '#fff', borderRadius: 12, maxWidth: 480, width: '100%',
                padding: 24, boxShadow: '0 24px 48px -12px rgba(0,0,0,0.25)',
                border: '1px solid var(--lb-line)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <span style={{
                  display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
                  background: '#f59e0b',
                }} />
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--lb-ink-1)' }}>
                  Possibly refundable
                </h3>
              </div>
              <div style={{ fontSize: 12, color: 'var(--lb-ink-5)', marginBottom: 16, lineHeight: 1.5 }}>
                {flag.evidenceSummary}
              </div>
              {parsed && (parsed.leadCost != null || parsed.candidateLeadCost != null) && (
                <div style={{
                  background: '#f8fafc', border: '1px solid var(--lb-line)', borderRadius: 6,
                  padding: '10px 12px', fontSize: 12, marginBottom: 16, color: 'var(--lb-ink-2)',
                }}>
                  {parsed.leadCost != null && <div>This lead cost: <strong>${parsed.leadCost}</strong></div>}
                  {parsed.candidateLeadCost != null && <div>Earlier lead cost: <strong>${parsed.candidateLeadCost}</strong></div>}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => setRefundableProofLead(null)}
                  style={{
                    padding: '8px 16px', borderRadius: 6, border: '1px solid var(--lb-line)',
                    background: 'var(--lb-surface)', color: 'var(--lb-ink-2)',
                    fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  Close
                </button>
                {ttUrl && (
                  <a
                    href={ttUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      padding: '8px 16px', borderRadius: 6, border: '1px solid #1d4ed8',
                      background: '#1d4ed8', color: '#fff',
                      fontSize: 13, fontWeight: 600, textDecoration: 'none',
                      display: 'inline-flex', alignItems: 'center',
                    }}
                  >
                    Open in Thumbtack
                  </a>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
