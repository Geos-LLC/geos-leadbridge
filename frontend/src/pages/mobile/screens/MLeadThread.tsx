import { useState, type CSSProperties } from 'react';
import { useParams } from 'react-router-dom';
import {
  Avatar, Icon, MAppBar, MBack, MCard, MIconBtn, MShell, PlatformBadge, StatusPill,
} from '../components';
import { useMobileLead, useMobileMessages } from '../hooks';
import { leadsApi } from '../../../services/api';
import { MErrorState, MLoading } from '../states';
import type { MobileMessage } from '../data';

function qaBtn(primary?: boolean): CSSProperties {
  return {
    flex: 1, padding: '8px 10px',
    border: '1px solid ' + (primary ? 'var(--accent)' : 'var(--line)'),
    background: primary ? 'var(--accent)' : 'var(--surface)',
    color: primary ? 'white' : 'var(--ink-2)',
    borderRadius: 8, fontWeight: 600, fontSize: 12,
    cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
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
  const leadState = useMobileLead(id);
  const messagesState = useMobileMessages(id);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const lead = leadState.data;
  const messages = messagesState.data || [];

  async function send() {
    if (!id || !draft.trim() || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await leadsApi.sendMessage(id, draft.trim());
      setDraft('');
      // Reload messages — bounce the state by triggering a re-fetch in the
      // hook. Simpler: full reload from the URL.
      window.location.reload();
    } catch (err: any) {
      setSendError(err?.message || 'Send failed');
    } finally {
      setSending(false);
    }
  }

  return (
    <MShell
      tab="leads"
      hideTabBar
      appBar={
        <MAppBar
          leading={<MBack label="" />}
          title={lead?.name || 'Lead'}
          subtitle={lead ? `${lead.service || 'Lead'} · ${lead.location.split(',')[0] || ''}` : ''}
          trailing={<><MIconBtn icon="phone" color="var(--accent)" /><MIconBtn icon="more-horizontal" /></>}
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
              <button type="button" style={qaBtn(true)}><Icon name="file-text" size={13} /> Send quote</button>
              <button type="button" style={qaBtn()}><Icon name="calendar" size={13} /> Book</button>
              <button type="button" style={qaBtn()}><Icon name="user" size={13} /> Profile</button>
            </div>
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

      {sendError && (
        <div style={{ padding: '0 14px 8px', fontSize: 12, color: 'var(--danger)' }}>{sendError}</div>
      )}

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
