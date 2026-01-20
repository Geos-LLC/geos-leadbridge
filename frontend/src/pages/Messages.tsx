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
} from 'lucide-react';
import { leadsApi, thumbtackApi, type MessageAttachment } from '../services/api';
import { useAppStore } from '../store/appStore';
import type { Lead } from '../types';
import { Search } from 'lucide-react';

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

export function Messages() {
  console.log('[Messages] Component rendering');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { leads, setLeads, selectedLead, setSelectedLead, configuredBusinessId, savedAccounts, setSavedAccounts } = useAppStore();
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [resyncingMessages, setResyncingMessages] = useState(false);
  const [resyncError, setResyncError] = useState<string | null>(null);
  const [messageText, setMessageText] = useState('');
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [lastSeenTimestamps, setLastSeenTimestamps] = useState<Record<string, string>>(() => getLastSeenTimestamps());
  const [searchQuery, setSearchQuery] = useState('');
  // Get account filter from URL params, default to 'all'
  const accountFilter = searchParams.get('account') || 'all';
  // Get date filter from URL params, default to 'all' (no filter)
  const dateFilter = searchParams.get('date') || 'all';
  const messagesEndRef = useRef<HTMLDivElement>(null);

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

  // Calculate date range based on filter (format: "YYYY-MM" for specific month)
  const getDateRange = (filter: string): { start: Date; end: Date } | null => {
    if (filter === 'all') return null;
    // Parse YYYY-MM format
    const match = filter.match(/^(\d{4})-(\d{2})$/);
    if (!match) return null;
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1; // JS months are 0-indexed
    const start = new Date(year, month, 1);
    const end = new Date(year, month + 1, 0, 23, 59, 59, 999); // Last day of month
    return { start, end };
  };

  // Generate month options for the last 24 months
  const getMonthOptions = (): { value: string; label: string }[] => {
    const options: { value: string; label: string }[] = [];
    const now = new Date();
    for (let i = 0; i < 24; i++) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      const label = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      options.push({ value, label });
    }
    return options;
  };

  useEffect(() => {
    loadLeads();
    loadSavedAccounts();
  }, []);

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
        console.log('[Messages] Selection invalid, selecting first visible lead:', visibleLeads[0]);
        setSelectedLead(visibleLeads[0]);
      }
    } else {
      console.log('[Messages] No visible leads, clearing selection');
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

  useEffect(() => {
    if (selectedLead) {
      loadMessagesForLead(selectedLead);
    }
  }, [selectedLead]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const loadLeads = async () => {
    setLoading(true);
    console.log('[Messages] Loading leads...');
    try {
      const { leads: loadedLeads } = await leadsApi.getLeads(50);
      console.log('[Messages] Loaded leads:', loadedLeads.length, loadedLeads);
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

  // Mark a lead as seen (update last seen timestamp to lastMessageAt)
  const markLeadAsSeen = (lead: Lead) => {
    const timestamp = lead.lastMessageAt || lead.createdAt;
    setLastSeenTimestamp(lead.id, timestamp);
    setLastSeenTimestamps(prev => ({ ...prev, [lead.id]: timestamp }));
  };

  const loadMessagesForLead = async (lead: Lead) => {
    setLoadingMessages(true);
    setMessages([]);
    console.log('[Messages] Loading messages for lead:', lead.id, lead.externalRequestId);
    // Mark this lead as seen when we load its messages
    markLeadAsSeen(lead);
    try {
      // Messages come from local database (stored via webhooks)
      // No API sync needed - webhooks deliver all updates
      const { messages: apiMessages } = await leadsApi.getMessages(lead.id);
      console.log('[Messages] API returned messages:', apiMessages);
      const convertedMessages: LocalMessage[] = apiMessages.map((msg) => {
        // Normalize sender to lowercase for consistent comparison
        const sender = (msg.sender || '').toLowerCase() as 'pro' | 'customer';
        console.log('[Messages] Message sender raw:', msg.sender, '-> normalized:', sender);
        return {
          id: msg.id || msg.externalMessageId,
          content: msg.content,
          sender,
          sentAt: new Date(msg.sentAt),
          externalId: msg.externalMessageId,
          attachments: msg.attachments,
        };
      });
      console.log('[Messages] Converted messages:', convertedMessages);
      setMessages(convertedMessages);
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
    console.log('[Messages] Resync button clicked for lead:', selectedLead.id, selectedLead.customerName);
    setResyncingMessages(true);
    setResyncError(null);
    try {
      console.log('[Messages] Calling leadsApi.resyncMessages...');
      const result = await leadsApi.resyncMessages(selectedLead.id);
      console.log('[Messages] Resync result:', result);
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

    // Optimistically add message to UI
    const optimisticMessage: LocalMessage = {
      id: `temp-${Date.now()}`,
      content: text,
      sender: 'pro',
      sentAt: new Date(),
    };
    setMessages((prev) => [...prev, optimisticMessage]);

    try {
      await leadsApi.sendMessage(selectedLead.id, text);
    } catch (err) {
      console.error('Failed to send message:', err);
      // Remove optimistic message on failure
      setMessages((prev) => prev.filter((m) => m.id !== optimisticMessage.id));
      setMessageText(text); // Restore text
      alert('Failed to send message. Please try again.');
    } finally {
      setSendingMessage(false);
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

  // Filter leads by selected account, date, and search query
  const dateRange = getDateRange(dateFilter);
  const monthOptions = getMonthOptions();
  const filteredLeads = leadsFromSavedAccounts.filter(lead => {
    // Account filter
    const matchesAccount = accountFilter === 'all' || lead.businessId === accountFilter;
    // Date filter - check if lead was created within the selected month
    const leadDate = new Date(lead.createdAt);
    const matchesDate = !dateRange || (leadDate >= dateRange.start && leadDate <= dateRange.end);
    // Name search (case-insensitive)
    const matchesSearch = !searchQuery.trim() ||
      lead.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lead.category?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lead.message?.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesAccount && matchesDate && matchesSearch;
  });

  if (loading) {
    return (
      <div className="loading-container">
        <Loader2 className="spinner" size={48} />
        <p>Loading leads...</p>
      </div>
    );
  }

  return (
    <div className="messages-page">
      {/* Leads Sidebar */}
      <aside className="leads-sidebar">
        <div className="sidebar-header">
          <button className="btn-icon" onClick={() => navigate('/dashboard')}>
            <ArrowLeft size={20} />
          </button>
          <h2>Leads</h2>
          <button className="btn-icon" onClick={loadLeads} title="Refresh">
            <RefreshCw size={20} />
          </button>
        </div>

        {/* Search Input */}
        <div className="leads-search">
          <Search size={16} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by name..."
            className="leads-search-input"
          />
        </div>

        {/* Account Filter */}
        {accountsInLeads.length > 0 && (
          <div className="account-filter">
            <Building2 size={16} />
            <select
              value={accountFilter}
              onChange={(e) => setAccountFilter(e.target.value)}
              className="account-filter-select"
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
          </div>
        )}

        {/* Date Filter */}
        <div className="account-filter">
          <Calendar size={16} />
          <select
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="account-filter-select"
          >
            <option value="all">All Time</option>
            {monthOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="leads-list">
          {filteredLeads.length === 0 ? (
            <div className="empty-leads">
              <MessageSquare size={32} />
              <p>No leads yet</p>
              <small>New leads will appear here</small>
            </div>
          ) : (
            filteredLeads.map((lead) => {
              const accountName = getAccountNameForLead(lead);
              const isCurrentAccount = isLeadFromCurrentAccount(lead);
              const isUpdated = hasNewUpdates(lead, lastSeenTimestamps);
              return (
                <div
                  key={lead.id}
                  className={`lead-item ${selectedLead?.id === lead.id ? 'selected' : ''} ${!isCurrentAccount ? 'other-account' : ''} ${isUpdated ? 'has-updates' : ''}`}
                  onClick={() => setSelectedLead(lead)}
                >
                  <div className="lead-avatar">
                    <User size={20} />
                    {isUpdated && <span className="update-indicator" />}
                  </div>
                  <div className="lead-preview">
                    <div className="lead-header">
                      <span className="lead-name">{lead.customerName}</span>
                      <span className="lead-time">{formatLeadTime(lead.lastMessageAt || lead.createdAt)}</span>
                    </div>
                    <div className="lead-meta">
                      <span className="lead-category">{lead.category || 'Service Request'}</span>
                      <span className={`lead-status-badge status-${lead.status?.toLowerCase()}`}>
                        {lead.status}
                      </span>
                    </div>
                    {accountName && (
                      <span className={`lead-account-badge ${isCurrentAccount ? 'current' : 'other'}`}>
                        <Building2 size={12} />
                        {accountName}
                      </span>
                    )}
                    <p className="lead-snippet">{lead.message?.slice(0, 60)}...</p>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Chat Area */}
      <main className="chat-area">
        {selectedLead ? (
          <>
            {/* Lead Info Header */}
            <div className="chat-header">
              <div className="lead-info-header">
                <div className="lead-avatar large">
                  <User size={24} />
                </div>
                <div>
                  <div className="lead-name-row">
                    <h3>{selectedLead.customerName}</h3>
                    <span className={`status-badge status-${selectedLead.status?.toLowerCase()}`}>
                      {selectedLead.status}
                    </span>
                  </div>
                  <p>{selectedLead.category || 'Service Request'}</p>
                </div>
              </div>
              <div className="lead-quick-info">
                {selectedLead.customerPhone && (
                  <a href={`tel:${selectedLead.customerPhone}`} className="quick-info-item">
                    <Phone size={16} />
                    {formatPhoneNumber(selectedLead.customerPhone)}
                  </a>
                )}
                {selectedLead.city && (
                  <span className="quick-info-item">
                    <MapPin size={16} />
                    {selectedLead.city}, {selectedLead.state} {selectedLead.postcode}
                  </span>
                )}
                <span className="quick-info-item">
                  <Calendar size={16} />
                  {formatDate(selectedLead.createdAt)}
                </span>
                {selectedLead.raw?.estimate?.total && (
                  <span className="quick-info-item">
                    <DollarSign size={16} />
                    {selectedLead.raw.estimate.total}
                  </span>
                )}
                <button
                  className="btn-icon resync-btn"
                  onClick={handleResyncMessages}
                  disabled={resyncingMessages}
                  title="Resync messages from Thumbtack"
                >
                  {resyncingMessages ? <Loader2 className="spinner" size={16} /> : <RefreshCw size={16} />}
                </button>
              </div>
            </div>

            {/* Resync Error Message */}
            {resyncError && (
              <div className="resync-error">
                <AlertCircle size={16} />
                <span>{resyncError}</span>
                <button className="dismiss-btn" onClick={() => setResyncError(null)}>
                  <X size={14} />
                </button>
              </div>
            )}

            {/* Messages Area */}
            <div className="messages-container">
              {loadingMessages ? (
                <div className="no-messages">
                  <Loader2 className="spinner" size={32} />
                  <p>Loading messages...</p>
                </div>
              ) : messages.length === 0 ? (
                <div className="no-messages">
                  <MessageSquare size={32} />
                  <p>No messages yet</p>
                  <small>Send a message to start the conversation</small>
                </div>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`message ${msg.sender === 'pro' ? 'sent' : 'received'}`}
                  >
                    {msg.content && <div className="message-content">{msg.content}</div>}
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="message-attachments">
                        {msg.attachments.map((attachment, idx) => (
                          attachment.mimeType?.startsWith('image/') ? (
                            <a
                              key={idx}
                              href={attachment.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="attachment-image-link"
                            >
                              <img
                                src={attachment.url}
                                alt={attachment.fileName || `Image ${idx + 1}`}
                                className="attachment-image"
                              />
                            </a>
                          ) : (
                            <a
                              key={idx}
                              href={attachment.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="attachment-link"
                            >
                              {attachment.fileName || 'Download attachment'}
                            </a>
                          )
                        ))}
                      </div>
                    )}
                    <div className="message-time">
                      {msg.sentAt.toLocaleTimeString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </div>
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Message Input */}
            {canSendMessage ? (
              <form className="message-input-form" onSubmit={handleSendMessage}>
                <input
                  type="text"
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  placeholder="Type a message..."
                  disabled={sendingMessage}
                />
                <button
                  type="submit"
                  className="btn btn-primary send-btn"
                  disabled={!messageText.trim() || sendingMessage}
                >
                  {sendingMessage ? <Loader2 className="spinner" size={20} /> : <Send size={20} />}
                </button>
              </form>
            ) : (
              <div className="message-input-disabled">
                <AlertCircle size={18} />
                <span>
                  Switch to <strong>{getAccountNameForLead(selectedLead) || 'this account'}</strong> to send messages
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="no-lead-selected">
            <MessageSquare size={64} />
            <h3>Select a lead</h3>
            <p>Choose a lead from the list to view details and send messages</p>
          </div>
        )}
      </main>

      {/* Right Details Panel */}
      {selectedLead && (
        <aside className="lead-details-sidebar">
          <div className="details-sidebar-header">
            <h3>Lead Details</h3>
          </div>
          <div className="details-sidebar-content">
            {/* Lead Cost */}
            {selectedLead.raw?.leadPrice && (
              <div className="details-section">
                <h4>Lead Cost</h4>
                <p className="detail-value">
                  <Tag size={14} />
                  {selectedLead.raw.leadPrice}
                </p>
              </div>
            )}

            {/* Request Details */}
            {getLeadDetails(selectedLead).length > 0 && (
              <div className="details-section">
                <h4>Request Details</h4>
                <dl className="request-details-list">
                  {getLeadDetails(selectedLead).map((detail, idx) => (
                    <div key={idx} className="detail-row">
                      <dt>{detail.question}</dt>
                      <dd>{detail.answer}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            {/* Original Message */}
            {selectedLead.message && (
              <div className="details-section">
                <h4>Customer Message</h4>
                <p className="customer-message">{selectedLead.message}</p>
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
