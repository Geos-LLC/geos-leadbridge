import { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
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
} from 'lucide-react';
import { leadsApi, thumbtackApi, templatesApi, bulkMessageApi, notificationsApi, type MessageAttachment } from '../services/api';
import { useAppStore } from '../store/appStore';
import type { Lead, MessageTemplate, BulkMessagePreview, NotificationLog, TimelineEvent, TimelineChannel, CommunicationSummary } from '../types';

interface LocalMessage {
  id: string;
  content: string;
  sender: 'pro' | 'customer';
  sentAt: Date;
  externalId?: string;
  attachments?: MessageAttachment[];
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

  for (const msg of platformMessages) {
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
  for (const log of smsLogs) {
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
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [resyncingMessages, setResyncingMessages] = useState(false);
  const [resyncError, setResyncError] = useState<string | null>(null);
  const [messageText, setMessageText] = useState('');
  const [, setMessages] = useState<LocalMessage[]>([]);
  const [lastSeenTimestamps, setLastSeenTimestamps] = useState<Record<string, string>>(() => getLastSeenTimestamps());
  const [searchQuery, setSearchQuery] = useState('');
  // Get account filter from URL params, default to 'all'
  const accountFilter = searchParams.get('account') || 'all';
  // Get date filter from URL params, default to 'all' (no filter)
  const dateFilter = searchParams.get('date') || 'all';
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
    } else {
      searchParams.set('account', value);
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
          console.log('[Messages] New lead received via SSE:', data.lead);
          // Add the new lead to the beginning of the list
          setLeads([data.lead as Lead, ...leads]);
        }
      } catch (err) {
        console.error('[Messages] Error parsing SSE event:', err);
      }
    };

    eventSource.onerror = () => {
      console.error('[Messages] SSE connection error');
      eventSource.close();

      // Check if this is an authentication error
      // EventSource doesn't expose HTTP status, but we can check if the token is still valid
      const currentToken = localStorage.getItem('token');
      if (!currentToken) {
        // Token was removed (probably by 401 handler elsewhere), redirect to login
        console.warn('[Messages] SSE error: No token found, redirecting to login');
        window.location.href = '/login';
      } else {
        // Try to verify token expiration
        try {
          const payload = JSON.parse(atob(currentToken.split('.')[1]));
          const exp = payload.exp * 1000; // Convert to milliseconds
          if (Date.now() >= exp) {
            // Token is expired
            console.warn('[Messages] SSE error: Token expired, redirecting to login');
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            localStorage.removeItem('auth-storage');
            window.location.href = '/login';
          } else {
            // Token not expired but SSE still failed - likely JWT_SECRET mismatch or server issue
            // Don't spam reconnects, just log it once
            console.warn('[Messages] SSE error: Token valid but connection failed. Real-time updates disabled.');
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
  useEffect(() => {
    if (leads.length === 0 || savedAccounts.length === 0) return;

    // Get saved account businessIds for filtering
    const savedAccountIds = new Set(savedAccounts.map(a => a.businessId));

    // Only consider leads from saved accounts
    const leadsFromSavedAccounts = leads.filter(lead =>
      lead.businessId && savedAccountIds.has(lead.businessId)
    );

    // Apply account filter
    const visibleLeads = leadsFromSavedAccounts.filter(lead =>
      accountFilter === 'all' || lead.businessId === accountFilter
    );

    if (visibleLeads.length > 0) {
      const currentSelectionVisible = selectedLead && visibleLeads.some(l => l.id === selectedLead.id);
      if (!currentSelectionVisible) {
        setSelectedLead(visibleLeads[0]);
      }
    } else {
      setSelectedLead(null);
    }
  }, [accountFilter, savedAccounts, leads]);

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
    setLoading(true);
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
      // Selection will be handled by the savedAccounts effect
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

  const loadMessagesForLead = async (lead: Lead) => {
    setLoadingMessages(true);
    setMessages([]);
    setSmsLogs([]);
    setTimelineEvents([]);
    // Mark this lead as seen when we load its messages
    markLeadAsSeen(lead);
    try {
      // Messages come from local database (stored via webhooks)
      let { messages: apiMessages } = await leadsApi.getMessages(lead.id);

      // Auto-sync if no messages found in database
      if (apiMessages.length === 0) {
        console.log('[Messages] No messages found, auto-syncing from Thumbtack...');
        await leadsApi.resyncMessages(lead.id);
        const result = await leadsApi.getMessages(lead.id);
        apiMessages = result.messages;
      }

      const convertedMessages: LocalMessage[] = apiMessages.map((msg) => {
        // Normalize sender to lowercase for consistent comparison
        const sender = (msg.sender || '').toLowerCase() as 'pro' | 'customer';
        return {
          id: msg.id || msg.externalMessageId,
          content: msg.content,
          sender,
          sentAt: new Date(msg.sentAt),
          externalId: msg.externalMessageId,
          attachments: msg.attachments,
        };
      });
      setMessages(convertedMessages);

      // Load SMS logs for this lead
      let leadSmsLogs: NotificationLog[] = [];
      try {
        const { logs } = await notificationsApi.getLogsByLead(lead.id);
        leadSmsLogs = logs;
        setSmsLogs(logs);
      } catch (err) {
        console.warn('[Messages] Failed to load SMS logs for lead:', err);
      }

      // Merge into unified timeline (filter SMS to only show customer-facing messages)
      const timeline = mergeTimeline(convertedMessages, leadSmsLogs, lead.customerPhone);
      setTimelineEvents(timeline);

      // Compute summary with filtered SMS logs (only customer-facing)
      const customerSmslogs = leadSmsLogs.filter(log => {
        if (!lead.customerPhone || !log.toPhone) return false;
        const normalizedCustomerPhone = lead.customerPhone.replace(/\D/g, '');
        const normalizedToPhone = log.toPhone.replace(/\D/g, '');
        return normalizedToPhone === normalizedCustomerPhone;
      });
      setCommSummary(computeSummary(convertedMessages, customerSmslogs));
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
      // Reload messages after resync
      await loadMessagesForLead(selectedLead);
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
        // Reload to get actual log entry
        await loadMessagesForLead(selectedLead);
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
    const details: { question: string; answer: string }[] = lead.raw?.request?.details || [];
    return details;
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

  return (
    <div className="flex h-[100dvh] lg:h-screen w-full max-w-[100vw] lg:max-w-none bg-slate-50 overflow-hidden">
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
                  return (
                    <option key={account.businessId} value={account.businessId}>
                      {account.businessName} ({count})
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
            {/* Lead Info Header */}
            <div className="p-3 sm:p-4 border-b border-slate-100 bg-white">
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
                  {/* Desktop-only meta details */}
                  <div className="hidden md:flex items-center gap-3 flex-wrap">
                    {selectedLead.customerPhone && (
                      <a href={`tel:${selectedLead.customerPhone}`} className="flex items-center gap-1.5 text-xs text-slate-600 hover:text-blue-600">
                        <Phone size={14} />
                        {formatPhoneNumber(selectedLead.customerPhone)}
                      </a>
                    )}
                    {selectedLead.city && (
                      <span className="flex items-center gap-1.5 text-xs text-slate-600">
                        <MapPin size={14} />
                        {selectedLead.city}, {selectedLead.state}
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
                    title="Resync messages from Thumbtack"
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
              <div className="mx-3 sm:mx-4 mt-3 sm:mt-4 p-3 bg-red-50 border border-red-100 rounded-xl flex items-center gap-2 text-red-600 text-xs sm:text-sm">
                <AlertCircle size={16} />
                <span className="flex-1">{resyncError}</span>
                <button className="p-1 hover:bg-red-100 rounded transition-colors" onClick={() => setResyncError(null)}>
                  <X size={14} />
                </button>
              </div>
            )}

            {/* Channel Filter Bar */}
            <div className="flex gap-2 p-3 sm:p-4 border-b border-slate-100">
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
                          <span title={event.smsError}>
                            <AlertCircle size={12} />
                          </span>
                        )}
                      </div>
                    </div>
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
            {/* Communication Summary */}
            {(commSummary.platformMessages > 0 || commSummary.smsSent > 0) && (
              <div>
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Communication Summary</h4>
                <div className="space-y-2">
                  <div className="flex justify-between items-center p-2 bg-slate-50 rounded-lg">
                    <span className="text-xs text-slate-600 flex items-center gap-1.5">
                      <MessageCircle size={14} /> Platform Messages
                    </span>
                    <span className="text-xs font-bold text-slate-900">{commSummary.platformMessages}</span>
                  </div>
                  <div className="flex justify-between items-center p-2 bg-slate-50 rounded-lg">
                    <span className="text-xs text-slate-600 flex items-center gap-1.5">
                      <Smartphone size={14} /> SMS Sent
                    </span>
                    <span className="text-xs font-bold text-slate-900">{commSummary.smsSent}</span>
                  </div>
                  {commSummary.smsDelivered > 0 && (
                    <div className="flex justify-between items-center p-2 bg-green-50 rounded-lg">
                      <span className="text-xs text-green-700 flex items-center gap-1.5">
                        {'\u2713\u2713'} SMS Delivered
                      </span>
                      <span className="text-xs font-bold text-green-900">{commSummary.smsDelivered}</span>
                    </div>
                  )}
                  {commSummary.smsFailed > 0 && (
                    <div className="flex justify-between items-center p-2 bg-red-50 rounded-lg">
                      <span className="text-xs text-red-700 flex items-center gap-1.5">
                        {'\u2717'} SMS Failed
                      </span>
                      <span className="text-xs font-bold text-red-900">{commSummary.smsFailed}</span>
                    </div>
                  )}
                  <div className="flex justify-between items-center p-2 bg-slate-50 rounded-lg">
                    <span className="text-xs text-slate-600 flex items-center gap-1.5">
                      <Phone size={14} /> Calls
                    </span>
                    <span className="text-xs font-bold text-slate-400">{commSummary.calls}</span>
                  </div>
                </div>
              </div>
            )}

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

            {/* Original Message */}
            {selectedLead.message && (
              <div>
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Customer Message</h4>
                <p className="text-sm text-slate-700 leading-relaxed bg-slate-50 p-3 rounded-xl">{selectedLead.message}</p>
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
