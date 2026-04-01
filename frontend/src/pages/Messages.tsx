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
} from 'lucide-react';
import { leadsApi, thumbtackApi, templatesApi, bulkMessageApi, notificationsApi, aiApi, conversationContextApi, followUpApi, type MessageAttachment } from '../services/api';
import { useAppStore } from '../store/appStore';
import { useAuthStore } from '../store/authStore';
import AdminNoAccountsState from '../components/AdminNoAccountsState';
import NoAccountsOverlay from '../components/NoAccountsOverlay';
import type { Lead, MessageTemplate, BulkMessagePreview, NotificationLog, TimelineEvent, TimelineChannel, CommunicationSummary } from '../types';

interface LocalMessage {
  id: string;
  content: string;
  sender: 'pro' | 'customer';
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
  const AI_STRATEGIES = [
    { key: 'hybrid', label: 'Hybrid', emoji: '⚖️', prompt: 'STRATEGY: HYBRID\n\nUse when:\n- You have enough information to estimate price\n- But still need one key detail OR want to move toward scheduling\n\nYou MUST:\n- Provide a price range based on pricing settings\n- Ask EXACTLY ONE question\n\nThe question MUST:\n- Move toward booking (timing or confirmation)\n- Be simple and direct\n\nDO NOT:\n- Ask more than one question\n- Ask vague questions (e.g. "does that work?")\n\nGoal: Reduce uncertainty and move the lead forward.\nExample style: Price + scheduling-oriented question' },
    { key: 'price', label: 'Price', emoji: '💰', prompt: 'STRATEGY: PRICE ANCHOR\n\nUse when:\n- Customer asks about price directly\n- Or pricing is the main concern\n\nYou MUST:\n- Lead with a price range based on pricing settings\n- Briefly explain what is included\n\nDO NOT:\n- Ask questions\n- Be vague or hesitant\n\nTone:\n- Confident and clear\n\nGoal: Give the customer a number to react to.\nExample style: "For a 1-bedroom home, pricing typically runs around $120-150 depending on condition. This includes kitchen, bathroom, and full surface cleaning."' },
    { key: 'qualify', label: 'Qualify', emoji: '🧠', prompt: 'STRATEGY: QUALIFICATION\n\nUse when:\n- Critical details are missing (home size, timing, condition)\n\nYou MUST:\n- Ask 2-3 specific questions\n- Briefly explain why you need the info\n\nDO NOT:\n- Give pricing\n- Use if enough info is already provided\n\nGoal: Collect only the minimum info needed to move to pricing or booking.\nExample style: "To give you an accurate quote, I just need a couple quick details — how many bedrooms and bathrooms, and what condition is the home in?"' },
    { key: 'convert', label: 'Convert', emoji: '📞', prompt: 'STRATEGY: CONVERSION\n\nUse when:\n- You have enough information\n- Lead shows intent or urgency\n- Ready to move to booking\n\nYou MUST:\n- Include pricing based on settings\n- Offer a SPECIFIC time or 2 options\n- Push toward scheduling\n\nDO NOT:\n- Ask open-ended questions\n- Delay with unnecessary details\n\nGoal: Get the lead to commit to a time.\nExample style: "For your 1-bedroom home, pricing is typically around $120-150. I have availability tomorrow at 2pm or Thursday morning — which works better?"' },
    { key: 'phone', label: 'Phone', emoji: '📱', prompt: 'STRATEGY: PHONE / ESCALATION\n\nUse when:\n- Job is complex\n- Customer asks for exact quote\n- You need confirmation\n- High-intent lead\n\nFlow:\nStep 1 — explain why call is needed:\n- "Every home is a bit different..."\n- "We\'ll prepare an accurate estimate..."\n\nStep 2 — ask for phone naturally:\n- "What\'s the best number to reach you?"\n\nIf hesitation:\n- Offer texting option\n\nStep 3 — confirm next step:\n- "We\'ll call you shortly"\n- OR send booking link if requested\n\nDO NOT:\n- Push phone too early\n- Sound forceful\n\nTone:\n- Helpful, process-driven, professional\n\nExample style: "Every home is a little different — size and condition affect pricing. We can prepare an accurate estimate for you. What\'s the best number to reach you?"\n\nIf they resist: "No problem, we can text — just need your number to send the estimate and coordinate everything."\n\nIf they want booking: "Absolutely — you can book online here: [link]. We\'ll follow up to confirm details."' },
  ];
  const [resyncingMessages, setResyncingMessages] = useState(false);
  const [resyncError, setResyncError] = useState<string | null>(null);
  const [messageText, setMessageText] = useState('');
  const [, setMessages] = useState<LocalMessage[]>([]);
  const [lastSeenTimestamps, setLastSeenTimestamps] = useState<Record<string, string>>(() => getLastSeenTimestamps());
  const [searchQuery, setSearchQuery] = useState('');
  // Get account filter from URL params, default to 'all'
  const accountFilter = searchParams.get('account') || localStorage.getItem('lb_last_account_filter') || 'all';
  // Get date filter from URL params, default to 'all' (no filter)
  const dateFilter = searchParams.get('date') || 'all';
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Message cache: stores loaded timeline + summary per lead ID to avoid re-fetching
  const messageCache = useRef<Record<string, { timeline: TimelineEvent[]; summary: CommunicationSummary; cachedAt: number }>>({});

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
  const [fuActionLoading, setFuActionLoading] = useState(false);

  // Load follow-up suggestions when selected lead changes
  useEffect(() => {
    if (!selectedLead) { setFuSuggestions([]); return; }
    followUpApi.getSuggestions().then(res => {
      setFuSuggestions((res.suggestions || []).filter(
        (s: any) => s.enrollment?.conversationId === selectedLead.threadId
      ));
    }).catch(() => setFuSuggestions([]));
  }, [selectedLead?.id]);

  // Load strategy suggestion when selected lead changes
  useEffect(() => {
    setStrategySuggestion(null);
    setThreadContextData(null);
    setActiveStrategyKey(null);
    if (!selectedLead?.threadId) return;
    setStrategySuggestionLoading(true);
    conversationContextApi.suggestStrategy(selectedLead.threadId)
      .then(res => {
        if (res.success) setStrategySuggestion({ suggested: res.suggested, reason: res.reason, confidence: res.confidence, scores: res.scores || {}, threadState: res.threadState });
      })
      .catch(() => {})
      .finally(() => setStrategySuggestionLoading(false));
  }, [selectedLead?.id]);

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

    // EventSource doesn't support custom headers, so pass token as query parameter
    // Use absolute URL to bypass Vercel's SPA catch-all rewrite and connect directly to the API server
    const API_BASE = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');
    const eventSource = new EventSource(`${API_BASE}/v1/leads/events?token=${encodeURIComponent(token)}`);

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
  }, []);

  // Refresh current conversation messages when tab becomes visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && selectedLead) {
        loadMessagesForLead(selectedLead);
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

  // Load messages when selected lead changes
  useEffect(() => {
    if (selectedLead) {
      loadMessagesForLead(selectedLead);
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
      // Load all leads (no limit) to support date filtering across full history
      const { leads: loadedLeads } = await leadsApi.getLeads();
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
      const { leads: loadedLeads } = await leadsApi.getLeads();
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

  const loadMessagesForLead = async (lead: Lead, forceRefresh = false) => {
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
    markLeadAsSeen(lead);
    try {
      let { messages: apiMessages } = await leadsApi.getMessages(lead.id);

      if (apiMessages.length === 0) {
        console.log('[Messages] No messages found, auto-syncing from Thumbtack...');
        await leadsApi.resyncMessages(lead.id);
        const result = await leadsApi.getMessages(lead.id);
        apiMessages = result.messages;
      }

      const convertedMessages: LocalMessage[] = apiMessages.map((msg) => {
        const sender = (msg.sender || '').toLowerCase() as 'pro' | 'customer';
        return {
          id: msg.id || msg.externalMessageId,
          content: msg.content,
          sender,
          sentAt: new Date(msg.sentAt),
          externalId: msg.externalMessageId,
          attachments: msg.attachments,
          platform: msg.platform,
          deliveredAt: msg.deliveredAt,
          notificationLogId: msg.notificationLogId,
        };
      });
      setMessages(convertedMessages);

      let leadSmsLogs: NotificationLog[] = [];
      try {
        const { logs } = await notificationsApi.getLogsByLead(lead.id);
        leadSmsLogs = logs;
        setSmsLogs(logs);
      } catch (err) {
        console.warn('[Messages] Failed to load SMS logs for lead:', err);
      }

      let timeline = mergeTimeline(convertedMessages, leadSmsLogs, lead.customerPhone);

      // Inject lead's initial request as the first message if not already in the timeline.
      // Use overlap check: if any existing inbound message contains the lead message
      // content (or vice versa), skip — Yelp raw messages include boilerplate that
      // gets stripped from lead.message, so exact match fails.
      if (lead.message) {
        const firstMsgContent = lead.message.trim();
        if (firstMsgContent.length > 0) {
          const firstMsgWords = firstMsgContent.substring(0, 80);
          const alreadyInTimeline = timeline.some(e =>
            e.direction === 'inbound' && e.content && (
              e.content.includes(firstMsgWords) || firstMsgContent.includes(e.content.trim().substring(0, 80))
            ),
          );
          if (!alreadyInTimeline) {
            const initialEvent: TimelineEvent = {
              id: 'initial-request',
              channel: 'platform',
              direction: 'inbound',
              content: firstMsgContent,
              timestamp: new Date(lead.createdAt),
              sender: 'customer',
            };
            timeline = [initialEvent, ...timeline];
          }
        }
      }
      setTimelineEvents(timeline);

      const customerSmslogs = leadSmsLogs.filter(log => {
        if (!lead.customerPhone || !log.toPhone) return false;
        const normalizedCustomerPhone = lead.customerPhone.replace(/\D/g, '');
        const normalizedToPhone = log.toPhone.replace(/\D/g, '');
        return normalizedToPhone === normalizedCustomerPhone;
      });
      const summary = computeSummary(convertedMessages, customerSmslogs);
      setCommSummary(summary);

      // Store in cache
      messageCache.current[lead.id] = { timeline, summary, cachedAt: Date.now() };
    } catch (err) {
      console.error('[Messages] Failed to load messages:', err);
    } finally {
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

  // Get unique accounts from leads for filter dropdown
  const accountsInLeads = savedAccounts.filter(account =>
    leadsFromSavedAccounts.some(lead => lead.businessId === account.businessId)
  );

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
    // Name search (case-insensitive)
    const matchesSearch = !searchQuery.trim() ||
      lead.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lead.category?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lead.message?.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesAccount && matchesDate && matchesSearch;
  });

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
    <div className="flex h-[100dvh] lg:h-screen w-full max-w-[100vw] lg:max-w-none bg-slate-50 overflow-hidden">
      {savedAccounts.length === 0 && useAuthStore.getState().user?.role !== 'ADMIN' && <NoAccountsOverlay />}
      {/* Leads Sidebar */}
      <aside className={`w-full md:w-80 bg-white border-r border-slate-100 flex flex-col ${mobilePanel !== 'list' ? 'hidden md:flex' : 'flex'}`}>
        <div className="p-4 border-b border-slate-100 flex items-center gap-3">
          <button className="p-2 text-slate-400 hover:bg-slate-50 hover:text-slate-600 rounded-lg transition-colors" onClick={() => navigate('/dashboard')}>
            <ArrowLeft size={20} />
          </button>
          <h2 className="text-lg font-bold text-slate-900 flex-1">Leads</h2>
          <button
            className={`p-2 rounded-lg transition-colors ${multiSelectMode ? 'bg-blue-50 text-blue-600' : 'text-slate-400 hover:bg-slate-50 hover:text-slate-600'}`}
            onClick={toggleMultiSelect}
            title={multiSelectMode ? 'Exit selection mode' : 'Select multiple'}
          >
            <CheckSquare size={18} />
          </button>
          <button className="p-2 text-slate-400 hover:bg-slate-50 hover:text-slate-600 rounded-lg transition-colors" onClick={loadLeads} title="Refresh">
            <RefreshCw size={18} />
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
        <div className="p-4 border-b border-slate-100">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name..."
              className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
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
                <option value="all">All Accounts ({leadsFromSavedAccounts.length})</option>
                {accountsInLeads.map((account) => {
                  const count = leadsFromSavedAccounts.filter(l => l.businessId === account.businessId).length;
                  const dot = account.platform === 'yelp' ? '\uD83D\uDD34' : '\uD83D\uDD35';
                  return (
                    <option key={account.id} value={account.businessId}>
                      {dot} {account.businessName} ({count})
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
              return (
                <div
                  key={lead.id}
                  className={`p-4 border-b border-slate-100 cursor-pointer transition-colors flex gap-3 ${
                    isSelected ? 'bg-blue-50 border-l-4 border-l-blue-600' : 'hover:bg-slate-50'
                  } ${!isCurrentAccount ? 'opacity-60' : ''} ${isChecked ? 'bg-blue-50' : ''}`}
                  onClick={() => {
                    if (multiSelectMode) {
                      toggleLeadSelection(lead.id, { stopPropagation: () => {} } as React.MouseEvent);
                    } else if (selectedLead?.id === lead.id) {
                      loadMessagesForLead(lead);
                      setMobilePanel('chat');
                    } else {
                      console.log('[Messages] Negotiation object:', lead);
                      setSelectedLead(lead);
                      setMobilePanel('chat');
                    }
                  }}
                >
                  {multiSelectMode && (
                    <div
                      className="flex-shrink-0 pt-1"
                      onClick={(e) => toggleLeadSelection(lead.id, e)}
                    >
                      {isChecked ? <CheckSquare size={20} className="text-blue-600" /> : <Square size={20} className="text-slate-300" />}
                    </div>
                  )}
                  <div className="flex-shrink-0 relative">
                    <div className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center text-slate-400">
                      <User size={20} />
                    </div>
                    {isUpdated && <span className="absolute -top-1 -right-1 w-3 h-3 bg-blue-600 rounded-full border-2 border-white" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <span className="font-semibold text-slate-900 text-sm truncate">{lead.customerName}</span>
                      <span className="text-xs text-slate-400 flex-shrink-0">{formatLeadTime(lead.lastMessageAt || lead.createdAt)}</span>
                    </div>
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={`px-1.5 py-0.5 text-[10px] font-bold rounded text-white ${lead.platform === 'yelp' ? 'bg-[#FF1A1A]' : 'bg-[#41B1E1]'}`}>
                        {lead.platform === 'yelp' ? 'Yelp' : 'TT'}
                      </span>
                      <span className="text-xs text-slate-600 truncate">{lead.category || 'Service Request'}</span>
                      <span className={`px-1.5 py-0.5 text-[10px] font-bold rounded uppercase ${
                        lead.status?.toLowerCase() === 'new' ? 'bg-blue-100 text-blue-700' :
                        lead.status?.toLowerCase() === 'contacted' ? 'bg-green-100 text-green-700' :
                        'bg-slate-100 text-slate-600'
                      }`}>
                        {lead.status}
                      </span>
                    </div>
                    {accountName && (
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded mb-1 ${
                        isCurrentAccount ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                      }`}>
                        <Building2 size={10} />
                        {accountName}
                      </span>
                    )}
                    <p className="text-xs text-slate-500 truncate">{lead.message?.slice(0, 60)}...</p>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Chat Area */}
      <main className={`flex-1 min-w-0 flex flex-col bg-white ${mobilePanel !== 'chat' ? 'hidden md:flex' : 'flex'}`}>
        {selectedLead ? (
          <>
            {/* Lead Info Header — fixed, never scrolls */}
            <div className="p-3 sm:p-4 border-b border-slate-100 bg-white shrink-0">
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
                      <span className={`px-2 py-0.5 text-[10px] font-bold rounded uppercase ${
                        selectedLead.status?.toLowerCase() === 'new' ? 'bg-blue-100 text-blue-700' :
                        selectedLead.status?.toLowerCase() === 'contacted' ? 'bg-green-100 text-green-700' :
                        'bg-slate-100 text-slate-600'
                      }`}>
                        {selectedLead.status}
                      </span>
                    </div>
                    <p className="text-sm text-slate-500 truncate">{selectedLead.category || 'Service Request'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1 sm:gap-3 shrink-0">
                  {/* Desktop-only meta details — same format for TT and Yelp */}
                  <div className="hidden md:flex items-center gap-3 flex-wrap">
                    {selectedLead.customerPhone ? (
                      <a href={`tel:${selectedLead.customerPhone}`} className="flex items-center gap-1.5 text-xs text-slate-600 hover:text-blue-600">
                        <Phone size={14} />
                        {formatPhoneNumber(selectedLead.customerPhone)}
                      </a>
                    ) : (
                      <span className="flex items-center gap-1.5 text-xs text-slate-400">
                        <Phone size={14} />
                        No phone available
                      </span>
                    )}
                    <span className="flex items-center gap-1.5 text-xs text-slate-600">
                      <Calendar size={14} />
                      {formatDate(selectedLead.createdAt)}
                    </span>
                    {selectedLead.raw?.estimate?.total && (
                      <span className="flex items-center gap-1.5 text-xs text-slate-600">
                        <DollarSign size={14} />
                        {selectedLead.raw.estimate.total}
                      </span>
                    )}
                  </div>
                  <button
                    className="p-2 text-slate-400 hover:bg-slate-50 hover:text-slate-600 rounded-lg transition-colors disabled:opacity-50"
                    onClick={handleResyncMessages}
                    disabled={resyncingMessages}
                    title="Resync messages"
                  >
                    {resyncingMessages ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
                  </button>
                  {/* Mobile details arrow */}
                  <button
                    className="p-2 text-slate-400 hover:bg-slate-50 hover:text-slate-600 rounded-lg transition-colors md:hidden"
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
            <div className="flex gap-2 p-3 sm:p-4 border-b border-slate-100 shrink-0">
              {(['all', 'platform', 'sms'] as const).map((filter) => (
                <button
                  key={filter}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 ${
                    channelFilter === filter
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                  }`}
                  onClick={() => setChannelFilter(filter)}
                >
                  {filter === 'all' && 'All'}
                  {filter === 'platform' && <><MessageCircle size={14} /> Platform</>}
                  {filter === 'sms' && <><Smartphone size={14} /> SMS</>}
                </button>
              ))}
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
                      <div className={`max-w-[85%] sm:max-w-md ${
                        isSmsDisconnected && event.direction === 'outbound'
                          ? 'bg-yellow-50 text-slate-900 border-2 border-yellow-200'
                          : event.channel === 'sms' && event.direction === 'inbound'
                          ? 'bg-green-50 text-slate-900'
                          : event.channel === 'sms'
                          ? 'bg-yellow-50 text-slate-900'
                          : event.direction === 'outbound'
                          ? 'bg-blue-600 text-white'
                          : 'bg-slate-100 text-slate-900'
                      } rounded-2xl px-4 py-2.5`}>
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
                            ? 'text-blue-100'
                            : 'text-blue-600'
                        }`}>
                          {event.channel === 'platform' && 'Platform'}
                          {event.channel === 'sms' && 'SMS'}
                          {event.channel === 'call' && 'Call'}
                          {event.channel === 'automation' && 'Auto'}
                        </span>
                        {event.ruleName && (
                          <span className="text-[10px] text-slate-500">{event.ruleName}</span>
                        )}
                      </div>

                      {/* Message Content */}
                      {event.content && <div className="text-sm leading-relaxed">{event.content}</div>}

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
                          ? 'text-blue-100'
                          : 'text-slate-500'
                      }`}>
                        <span>
                          {event.timestamp.toLocaleTimeString('en-US', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                        {event.channel === 'sms' && event.smsStatus && (
                          <span className={`font-semibold ${
                            event.smsStatus === 'delivered' ? 'text-green-600' :
                            event.smsStatus === 'failed' ? 'text-red-600' :
                            ''
                          }`}>
                            {event.smsStatus === 'delivered' && '\u2713\u2713 Delivered'}
                            {event.smsStatus === 'sent' && '\u2713 Sent'}
                            {event.smsStatus === 'queued' && '\u231B Queued'}
                            {event.smsStatus === 'pending' && '\u231B Pending'}
                            {event.smsStatus === 'failed' && '\u2717 Failed'}
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
                                  isSuggested ? 'text-amber-600 hover:text-amber-700 hover:bg-amber-50 ring-1 ring-amber-200' :
                                  'text-violet-400 hover:text-violet-600 hover:bg-violet-50'
                                }`}
                                title={isSuggested ? `AI suggests: ${strategySuggestion?.reason}` : undefined}
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
              <div ref={messagesEndRef} />
            </div>

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
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">AI Strategy</h4>
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

            {/* Follow-up Status — compact thread status */}
            {strategySuggestion && (
              <div className="space-y-1">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Follow-up Status</h4>
                <div className="bg-slate-50 rounded-xl p-2.5 space-y-1 text-[11px] text-slate-600">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">Suggested</span>
                    <span className="font-semibold">
                      {AI_STRATEGIES.find(s => s.key === strategySuggestion.suggested)?.emoji}{' '}
                      {AI_STRATEGIES.find(s => s.key === strategySuggestion.suggested)?.label}
                    </span>
                  </div>
                  {strategySuggestion.threadState.stage && (
                    <div className="flex items-center justify-between">
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
            )}

          </div>
        </aside>
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
                    No templates yet. <a href="/message-settings">Create one</a>
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
    </div>
  );
}
