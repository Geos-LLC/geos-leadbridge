import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Avatar, MAppBar, MCard, MChip, MIconBtn, MShell, PlatformBadge, StatusPill,
} from '../components';
import { LB_LEADS, type LeadStatus } from '../data';

type Filter = 'all' | LeadStatus;

export default function MLeads() {
  const [filter, setFilter] = useState<Filter>('all');
  const navigate = useNavigate();
  const list = LB_LEADS.filter(l => filter === 'all' || l.status === filter);

  return (
    <MShell
      tab="leads"
      appBar={
        <MAppBar
          large
          title="Leads"
          subtitle={`${LB_LEADS.length} total · ${LB_LEADS.filter(l => l.unread).length} new`}
          trailing={<><MIconBtn icon="search" /><MIconBtn icon="sliders-horizontal" /></>}
        />
      }
    >
      <div style={{ padding: '12px 14px 4px', display: 'flex', gap: 8, overflowX: 'auto' }}>
        <MChip label="All" active={filter === 'all'} count={LB_LEADS.length} onClick={() => setFilter('all')} />
        <MChip label="New" active={filter === 'new'} count={LB_LEADS.filter(l => l.status === 'new').length} onClick={() => setFilter('new')} />
        <MChip label="Replied" active={filter === 'replied'} count={LB_LEADS.filter(l => l.status === 'replied').length} onClick={() => setFilter('replied')} />
        <MChip label="Quoted" active={filter === 'quoted'} count={LB_LEADS.filter(l => l.status === 'quoted').length} onClick={() => setFilter('quoted')} />
        <MChip label="Booked" active={filter === 'won'} count={LB_LEADS.filter(l => l.status === 'won').length} onClick={() => setFilter('won')} />
      </div>

      <div style={{ padding: '6px 14px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {list.map(l => (
          <MCard key={l.id} style={{ padding: 14, position: 'relative', cursor: 'pointer' }} onClick={() => navigate(`/m/leads/${l.id}`)}>
            <div style={{ display: 'flex', gap: 12 }}>
              <Avatar name={l.name} size={40} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink-1)' }}>{l.name}</span>
                  <PlatformBadge platform={l.platform} size="sm" />
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--ink-5)', fontFamily: 'var(--font-mono)' }}>{l.receivedAt}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-4)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {l.service}
                </div>
                <div style={{
                  fontSize: 12.5, color: 'var(--ink-3)', marginTop: 6, lineHeight: 1.4,
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as 'vertical', overflow: 'hidden',
                }}>{l.snippet}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
                  <StatusPill status={l.status} />
                  {l.ai === 'handed-off' && (
                    <span style={{ fontSize: 10, color: 'var(--warn)', fontWeight: 600, fontFamily: 'var(--font-mono)' }}>↳ TO YOU</span>
                  )}
                  {l.amount && (
                    <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--ink-2)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>${l.amount}</span>
                  )}
                </div>
              </div>
            </div>
            {l.unread && (
              <span style={{ position: 'absolute', top: 14, right: 14, width: 8, height: 8, borderRadius: 99, background: 'var(--accent)' }} />
            )}
          </MCard>
        ))}
      </div>

      <div style={{ height: 80 }} />
    </MShell>
  );
}
