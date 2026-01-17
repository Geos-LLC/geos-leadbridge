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
  if (!lastSeen) return true; // Never seen = new
  return new Date(lead.updatedAt) > new Date(lastSeen);
}

export function Messages() {
  console.log('[Messages] Component rendering');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { leads, setLeads, selectedLead, setSelectedLead, updateLead, configuredBusinessId, savedAccounts, setSavedAccounts } = useAppStore();
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [messageText, setMessageText] = useState('');
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [lastSeenTimestamps, setLastSeenTimestamps] = useState<Record<string, string>>(() => getLastSeenTimestamps());
  const [searchQuery, setSearchQuery] = useState('');
  // Get account filter from URL params, default to 'all'
  const accountFilter = searchParams.get('account') || 'all';
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

  useEffect(() => {
    loadLeads();
    loadSavedAccounts();
  }, []);

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
      const { leads } = await leadsApi.getLeads(50);
      console.log('[Messages] Loaded leads:', leads.length, leads);
      // Sort leads by updatedAt descending (most recently updated first)
      const sortedLeads = [...leads].sort((a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
      setLeads(sortedLeads);
      if (sortedLeads.length > 0 && !selectedLead) {
        console.log('[Messages] Auto-selecting most recently updated lead:', sortedLeads[0]);
        setSelectedLead(sortedLeads[0]);
      }
    } catch (err) {
      console.error('[Messages] Failed to load leads:', err);
    } finally {
      setLoading(false);
    }
  };

  // Mark a lead as seen (update last seen timestamp)
  const markLeadAsSeen = (lead: Lead) => {
    setLastSeenTimestamp(lead.id, lead.updatedAt);
    setLastSeenTimestamps(prev => ({ ...prev, [lead.id]: lead.updatedAt }));
  };

  const loadMessagesForLead = async (lead: Lead) => {
    setLoadingMessages(true);
    setMessages([]);
    console.log('[Messages] Loading messages for lead:', lead.id, lead.externalRequestId);
    // Mark this lead as seen when we load its messages
    markLeadAsSeen(lead);
    try {
      // Sync lead status from Thumbtack (if connected to correct account)
      // This runs in parallel with message loading
      leadsApi.syncLead(lead.id).then(({ lead: syncedLead }) => {
        if (syncedLead && syncedLead.status !== lead.status) {
          console.log('[Messages] Lead status synced:', lead.status, '->', syncedLead.status);
          updateLead(syncedLead);
          // If this is the selected lead, update it too
          if (selectedLead?.id === syncedLead.id) {
            setSelectedLead(syncedLead);
          }
        }
      }).catch((err) => {
        console.log('[Messages] Could not sync lead status (might be different account):', err.message);
      });

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

  // Get unique accounts from leads for filter dropdown
  const accountsInLeads = savedAccounts.filter(account =>
    leads.some(lead => lead.businessId === account.businessId)
  );

  // Filter leads by selected account and search query
  const filteredLeads = leads.filter(lead => {
    // Account filter
    const matchesAccount = accountFilter === 'all' || lead.businessId === accountFilter;
    // Name search (case-insensitive)
    const matchesSearch = !searchQuery.trim() ||
      lead.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lead.category?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lead.message?.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesAccount && matchesSearch;
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
              <option value="all">All Accounts ({leads.length})</option>
              {accountsInLeads.map((account) => {
                const count = leads.filter(l => l.businessId === account.businessId).length;
                return (
                  <option key={account.businessId} value={account.businessId}>
                    {account.businessName} ({count})
                  </option>
                );
              })}
            </select>
          </div>
        )}

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
                      <span className={`lead-status-badge status-${lead.status?.toLowerCase()}`}>
                        {lead.status}
                      </span>
                    </div>
                    <div className="lead-meta">
                      <span className="lead-category">{lead.category || 'Service Request'}</span>
                      {accountName && (
                        <span className={`lead-account-badge ${isCurrentAccount ? 'current' : 'other'}`}>
                          <Building2 size={12} />
                          {accountName}
                        </span>
                      )}
                    </div>
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
              </div>
            </div>

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
