import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
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
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { leadsApi } from '../services/api';
import { useAppStore } from '../store/appStore';
import type { Lead } from '../types';

interface LocalMessage {
  id: string;
  content: string;
  sender: 'pro' | 'customer';
  sentAt: Date;
  externalId?: string;
}

export function Messages() {
  const navigate = useNavigate();
  const { leads, setLeads, selectedLead, setSelectedLead, selectedBusiness } = useAppStore();
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [messageText, setMessageText] = useState('');
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [expandedDetails, setExpandedDetails] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadLeads();
  }, []);

  useEffect(() => {
    if (selectedLead) {
      // Load messages for selected lead (from raw data if available)
      loadMessagesForLead(selectedLead);
    }
  }, [selectedLead]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const loadLeads = async () => {
    setLoading(true);
    try {
      const { leads } = await leadsApi.getLeads(50);
      setLeads(leads);
      if (leads.length > 0 && !selectedLead) {
        setSelectedLead(leads[0]);
      }
    } catch (err) {
      console.error('Failed to load leads:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadMessagesForLead = async (lead: Lead) => {
    setLoadingMessages(true);
    setMessages([]);
    try {
      const { messages: apiMessages } = await leadsApi.getMessages(lead.id);
      const convertedMessages: LocalMessage[] = apiMessages.map((msg) => ({
        id: msg.id || msg.externalMessageId,
        content: msg.content,
        sender: msg.sender,
        sentAt: new Date(msg.sentAt),
        externalId: msg.externalMessageId,
      }));
      setMessages(convertedMessages);
    } catch (err) {
      console.error('Failed to load messages:', err);
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

        {selectedBusiness && (
          <div className="business-badge">
            {selectedBusiness.name}
          </div>
        )}

        <div className="leads-list">
          {leads.length === 0 ? (
            <div className="empty-leads">
              <MessageSquare size={32} />
              <p>No leads yet</p>
              <small>New leads will appear here</small>
            </div>
          ) : (
            leads.map((lead) => (
              <div
                key={lead.id}
                className={`lead-item ${selectedLead?.id === lead.id ? 'selected' : ''}`}
                onClick={() => setSelectedLead(lead)}
              >
                <div className="lead-avatar">
                  <User size={20} />
                </div>
                <div className="lead-preview">
                  <div className="lead-header">
                    <span className="lead-name">{lead.customerName}</span>
                    <span className="lead-time">{formatDate(lead.createdAt)}</span>
                  </div>
                  <div className="lead-meta">
                    <span className="lead-category">{lead.category || 'Service Request'}</span>
                  </div>
                  <p className="lead-snippet">{lead.message?.slice(0, 60)}...</p>
                </div>
              </div>
            ))
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
                  <h3>{selectedLead.customerName}</h3>
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
              </div>
            </div>

            {/* Expandable Lead Details */}
            <div className="lead-details-panel">
              <button
                className="details-toggle"
                onClick={() => setExpandedDetails(!expandedDetails)}
              >
                <span>Lead Details</span>
                {expandedDetails ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
              </button>

              {expandedDetails && (
                <div className="details-content">
                  <div className="details-grid">
                    <div className="detail-item">
                      <Calendar size={16} />
                      <div>
                        <label>Received</label>
                        <span>{formatDate(selectedLead.createdAt)}</span>
                      </div>
                    </div>
                    {selectedLead.raw?.estimate?.total && (
                      <div className="detail-item">
                        <DollarSign size={16} />
                        <div>
                          <label>Estimate</label>
                          <span>{selectedLead.raw.estimate.total}</span>
                        </div>
                      </div>
                    )}
                    {selectedLead.raw?.leadPrice && (
                      <div className="detail-item">
                        <Tag size={16} />
                        <div>
                          <label>Lead Cost</label>
                          <span>{selectedLead.raw.leadPrice}</span>
                        </div>
                      </div>
                    )}
                    <div className="detail-item">
                      <Tag size={16} />
                      <div>
                        <label>Status</label>
                        <span className={`status-badge ${selectedLead.status}`}>
                          {selectedLead.status}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Customer Request Details */}
                  {getLeadDetails(selectedLead).length > 0 && (
                    <div className="request-details">
                      <h4>Request Details</h4>
                      <dl>
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
                    <div className="original-message">
                      <h4>Customer Message</h4>
                      <p>{selectedLead.message}</p>
                    </div>
                  )}
                </div>
              )}
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
                    <div className="message-content">{msg.content}</div>
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
          </>
        ) : (
          <div className="no-lead-selected">
            <MessageSquare size={64} />
            <h3>Select a lead</h3>
            <p>Choose a lead from the list to view details and send messages</p>
          </div>
        )}
      </main>
    </div>
  );
}
