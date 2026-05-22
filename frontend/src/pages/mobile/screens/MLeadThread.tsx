import { useState, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Avatar, Icon, MAppBar, MBack, MCard, MIconBtn, MShell, PlatformBadge, StatusPill,
} from '../components';
import { useMobileLead, useMobileMessages } from '../hooks';
import { aiApi, leadsApi } from '../../../services/api';
import { MErrorState, MLoading } from '../states';
import type { MobileMessage } from '../data';

function qaBtn(primary?: boolean, disabled?: boolean): CSSProperties {
  return {
    flex: 1, padding: '8px 10px',
    border: '1px solid ' + (primary ? 'var(--accent)' : 'var(--line)'),
    background: primary ? 'var(--accent)' : 'var(--surface)',
    color: primary ? 'white' : 'var(--ink-2)',
    borderRadius: 8, fontWeight: 600, fontSize: 12,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
  };
}

function MMessage({ m }: { m: MobileMessage }) {
  const isLead = m.from === 'lead';
  const isAi = m.from === 'ai';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: isLead ? 'flex-start' : 'flex-end' }}>
      <div style={{
        maxWidth: '80%', padding: '10px 13px', borderRadius: 16,
        borderBottomLeftRadius: isLead ? 4 : 16,
        borderBottomRightRadius: !isLead ? 4 : 16,
        fontSize: 13.5, lineHeight: 1.45,
        background: isLead ? 'var(--surface)' : isAi ? 'var(--accent-tint)' : 'var(--accent)',
        color: isLead ? 'var(--ink-1)' : isAi ? 'var(--ink-1)' : 'white',
        border: isLead ? '1px solid var(--line)' : isAi ? '1px solid var(--accent-line)' : 'none',
        whiteSpace: 'pre-wrap',
      }}>
        {isAi && (
          <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--accent)', marginBottom: 4, fontWeight: 700, letterSpacing: 0.05 }}>
            ✦ AI REPLY
          </div>
        )}
        {m.text}
      </div>
      <div style={{ fontSize: 10, color: 'var(--ink-5)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
        {m.from === 'you' ? 'You' : m.from === 'ai' ? 'AI' : 'Lead'} · {m.at}
      </div>
    </div>
  );
}

export default function MLeadThread() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const leadState = useMobileLead(id);
  const messagesState = useMobileMessages(id);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [showBookBanner, setShowBookBanner] = useState(false);

  const lead = leadState.data;
  const messages = messagesState.data || [];

  async function send() {
    if (!id || !draft.trim() || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await leadsApi.sendMessage(id, draft.trim());
      setDraft('');
      window.location.reload();
    } catch (err: any) {
      setSendError(err?.message || 'Send failed');
    } finally {
      setSending(false);
    }
  }

  // Generate an AI draft using the current conversation. Drops the result
  // into the composer so the user can review/edit before sending — never
  // auto-sends. Mirrors what the desktop "Suggest" button does on
  // Messages.tsx (Messages.tsx:2248-2256).
  //
  // Two endpoints, picked by whether we have a real threadId:
  //   - previewWithContext: backend pulls thread state + history from DB.
  //     Requires a valid Conversation.id; passing the lead id by mistake
  //     causes a 500.
  //   - previewForLead: dumb fallback — we pass conversationHistory
  //     inline. Used when the lead has no linked conversation yet (new
  //     lead, no messages, etc.) so the button still works.
  async function generate() {
    if (!id || generating) return;
    if (!lead?.id) {
      setGenError('Lead is still loading.');
      return;
    }
    if (!messages.length) {
      setGenError('Need at least one customer message before generating.');
      return;
    }
    const lastCustomer = [...messages].reverse().find((m) => m.from === 'lead');
    if (!lastCustomer) {
      setGenError('No customer message to respond to yet.');
      return;
    }
    setGenerating(true);
    setGenError(null);
    try {
      let reply: string;
      if (lead.threadId) {
        const out = await aiApi.previewWithContext(id, lead.threadId, lastCustomer.text);
        reply = out.reply;
      } else {
        // Convert MobileMessage history to the {role, content} shape the
        // endpoint expects: customer → 'customer', anyone else → 'pro'.
        const history = messages.map<{ role: 'customer' | 'pro'; content: string }>((m) => ({
          role: m.from === 'lead' ? 'customer' : 'pro',
          content: m.text,
        }));
        const out = await aiApi.previewForLead(id, lastCustomer.text, history);
        reply = out.reply;
      }
      setDraft(reply || '');
    } catch (err: any) {
      // axios attaches the backend's response on err.response.data. Surface
      // its message when present so the user sees the real reason instead
      // of a generic "Request failed with status code 500".
      const backendMsg = err?.response?.data?.message
        || (typeof err?.response?.data === 'string' ? err.response.data : null);
      setGenError(backendMsg || err?.message || 'Could not generate a reply');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <MShell
      tab="leads"
      appBar={
        <MAppBar
          leading={<MBack label="" />}
          title={lead?.name || 'Lead'}
          subtitle={lead ? `${lead.service || 'Lead'} · ${lead.location.split(',')[0] || ''}` : ''}
          trailing={
            <>
              {lead?.phone && (
                <a href={`tel:${lead.phone}`} style={{ display: 'inline-flex' }}>
                  <MIconBtn icon="phone" color="var(--accent)" />
                </a>
              )}
              <MIconBtn icon="more-horizontal" />
            </>
          }
        />
      }
    >
      {leadState.loading && <MLoading label="Loading lead…" />}
      {leadState.error && <MErrorState message={leadState.error} />}

      {lead && (
        <div style={{ padding: '12px 14px 0' }}>
          <MCard style={{ padding: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Avatar name={lead.name} size={44} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <PlatformBadge platform={lead.platform} size="sm" />
                  <StatusPill status={lead.status} />
                </div>
                {lead.phone && (
                  <div style={{ fontSize: 11.5, color: 'var(--ink-5)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
                    {lead.phone}
                  </div>
                )}
              </div>
              {lead.amount != null && (
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--ink-5)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Budget</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--ink-1)', fontFamily: 'var(--font-mono)' }}>${lead.amount}</div>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              {/* Generate: AI-draft an answer into the composer. The user can
                  edit before sending — never auto-sends. */}
              <button
                type="button"
                onClick={() => void generate()}
                disabled={generating}
                style={qaBtn(true, generating)}
              >
                <Icon name="sparkles" size={13} /> {generating ? 'Generating…' : 'Generate'}
              </button>

              {/* Book is a teaser today — actual booking lives on
                  service-flow.pro; show a banner instead of a fake screen. */}
              <button
                type="button"
                onClick={() => setShowBookBanner((v) => !v)}
                style={qaBtn()}
              >
                <Icon name="calendar" size={13} /> Book
              </button>

              {/* Profile opens the full lead detail page (desktop's
                  right-panel content), reached via /m/leads/:id/profile. */}
              <button
                type="button"
                onClick={() => navigate(`/m/leads/${id}/profile`)}
                style={qaBtn()}
              >
                <Icon name="user" size={13} /> Profile
              </button>
            </div>
            {showBookBanner && (
              <div style={{
                marginTop: 10, padding: '10px 12px',
                background: 'var(--accent-tint)', border: '1px solid var(--accent-line)',
                borderRadius: 10, fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5,
                display: 'flex', gap: 10,
              }}>
                <Icon name="info" size={14} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
                <div style={{ flex: 1 }}>
                  <strong style={{ color: 'var(--ink-1)' }}>Connect to ServiceFlow.pro to enable booking.</strong>
                  <div style={{ marginTop: 3 }}>
                    Bookings flow through your ServiceFlow account. Set it up once and
                    "Book" creates a real calendar invite from here.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowBookBanner(false)}
                  style={{
                    background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
                    color: 'var(--ink-5)', display: 'inline-flex', alignItems: 'center',
                  }}
                  aria-label="Dismiss"
                >
                  <Icon name="check" size={14} />
                </button>
              </div>
            )}
          </MCard>
        </div>
      )}

      <div style={{ padding: '14px 14px 8px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messagesState.loading && <MLoading label="Loading messages…" />}
        {messagesState.error && <MErrorState message={messagesState.error} />}
        {!messagesState.loading && !messagesState.error && messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--ink-5)', fontSize: 12.5 }}>
            No messages yet.
          </div>
        )}
        {messages.map((m, i) => <MMessage key={i} m={m} />)}
      </div>

      {genError && (
        <div style={{ padding: '0 14px 8px', fontSize: 12, color: 'var(--danger)' }}>{genError}</div>
      )}
      {sendError && (
        <div style={{ padding: '0 14px 8px', fontSize: 12, color: 'var(--danger)' }}>{sendError}</div>
      )}

      {/* Composer — sticky inside the scrollable region, so it sits at
          the bottom of the scroll area just above the bottom tab bar. */}
      <div style={{
        position: 'sticky', bottom: 0,
        padding: '8px 12px 12px', background: 'var(--surface)',
        borderTop: '1px solid var(--line)', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--ink-10)', borderRadius: 22, padding: '4px 6px 4px 14px' }}>
          <Icon name="sparkles" size={15} style={{ color: 'var(--accent)' }} />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder={lead ? `Message ${lead.name.split(' ')[0]}…` : 'Message…'}
            disabled={sending}
            style={{
              flex: 1, background: 'transparent', border: 0, outline: 'none',
              fontSize: 13.5, color: 'var(--ink-1)', padding: '8px 0', minWidth: 0,
            }}
          />
          <button type="button" onClick={() => void send()} disabled={!draft.trim() || sending} style={{
            width: 34, height: 34, borderRadius: 999, border: 0,
            cursor: !draft.trim() || sending ? 'not-allowed' : 'pointer',
            background: !draft.trim() || sending ? 'var(--ink-8)' : 'var(--accent)',
            color: 'white',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon name="arrow-up" size={16} />
          </button>
        </div>
      </div>
    </MShell>
  );
}
