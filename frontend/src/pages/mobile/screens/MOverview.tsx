import { useState } from 'react';
import {
  Avatar, Icon, MAppBar, MCard, MIconBox, MIconBtn, MRow, MSection, MShell, MStat, MToggleRow,
  PlatformBadge, Toggle,
} from '../components';
import type { IconName } from '../components';
import { LB_LEADS, LB_ACCOUNTS, LB_STATS } from '../data';

function MAutomationRow({ title, sub, icon, color, bg, on, last }: {
  title: string; sub: string; icon: IconName; color: string; bg: string; on: boolean; last?: boolean;
}) {
  const [v, setV] = useState(on);
  return (
    <MRow
      leading={<MIconBox icon={icon} color={color} bg={bg} />}
      title={title}
      subtitle={sub}
      trailing={<Toggle on={v} onChange={setV} />}
      last={last}
    />
  );
}

export default function MOverview() {
  const unread = LB_LEADS.filter(l => l.unread).slice(0, 3);
  const attention = LB_ACCOUNTS.filter(a => a.status !== 'connected');
  return (
    <MShell
      tab="overview"
      appBar={
        <MAppBar
          large
          title="Today"
          subtitle="Tue, Apr 23 · GreenField Lawn"
          trailing={<><MIconBtn icon="search" /><MIconBtn icon="bell" badge /></>}
        />
      }
    >
      <div style={{ padding: '14px 14px 0' }}>
        <MCard style={{ padding: 16, background: 'var(--ink-1)', borderColor: 'var(--ink-1)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600 }}>Today so far</span>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', fontFamily: 'var(--font-mono)' }}>9:41 AM</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <div style={{ fontSize: 56, fontWeight: 700, color: 'white', letterSpacing: '-0.04em', lineHeight: 1 }}>5</div>
            <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 14, fontWeight: 500 }}>new leads</div>
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.12)' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>AI replied</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'white', marginTop: 2 }}>4 <span style={{ fontSize: 11, color: '#86efac', fontFamily: 'var(--font-mono)' }}>80%</span></div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Booked</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'white', marginTop: 2 }}>1 <span style={{ fontSize: 11, color: '#86efac', fontFamily: 'var(--font-mono)' }}>$480</span></div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Median reply</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'white', marginTop: 2 }}>38<span style={{ fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.6)' }}>s</span></div>
            </div>
          </div>
        </MCard>
      </div>

      <MSection title="Needs your attention" action={<a style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600, cursor: 'pointer' }}>See all</a>}>
        <MCard>
          {attention.map((a, i) => (
            <MRow
              key={a.id}
              leading={<PlatformBadge platform={a.platform} size="md" />}
              title={a.shortName}
              subtitle={a.issue}
              trailing={<button type="button" style={{ background: 'var(--warn-tint)', color: '#92400e', border: 0, padding: '6px 12px', borderRadius: 999, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Fix</button>}
              last={i === attention.length - 1 && unread.length === 0}
            />
          ))}
          {unread.map((l, i) => (
            <MRow
              key={l.id}
              leading={<Avatar name={l.name} size={36} />}
              title={<>
                <span>{l.name}</span>
                <span style={{ fontSize: 11, color: 'var(--ink-5)', fontFamily: 'var(--font-mono)', fontWeight: 400, marginLeft: 4 }}>· {l.receivedAt}</span>
              </>}
              subtitle={l.snippet}
              trailing={<span style={{ width: 8, height: 8, borderRadius: 99, background: 'var(--accent)', flexShrink: 0 }} />}
              last={i === unread.length - 1}
            />
          ))}
        </MCard>
      </MSection>

      <MSection title="Automation">
        <MCard>
          <MAutomationRow title="Instant Reply" sub="AI mode · ~30s response" icon="zap" color="var(--accent)" bg="var(--accent-tint)" on />
          <MAutomationRow title="Follow-ups" sub="4 steps · stops on reply" icon="repeat" color="#6d28d9" bg="#ede9fe" on />
          <MAutomationRow title="AI Conversation" sub="Strategy: auto" icon="sparkles" color="var(--accent)" bg="var(--accent-tint)" on />
          <MAutomationRow title="Instant Call" sub="Agent-first · working hours" icon="phone" color="var(--success)" bg="var(--success-tint)" on last />
        </MCard>
      </MSection>

      <MSection title="This week">
        <MCard style={{ padding: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16, rowGap: 14 }}>
            <MStat label="Leads in" value={LB_STATS.week.leads} delta="+14%" />
            <MStat label="Booked" value={LB_STATS.week.booked} delta="33% rate" />
            <MStat label="Revenue" value={`$${LB_STATS.week.revenue.toLocaleString()}`} delta="+$640" />
            <MStat label="Avg ticket" value={`$${LB_STATS.week.avgTicket}`} delta="+$40" />
          </div>
        </MCard>
      </MSection>

      <div style={{ marginTop: 18, padding: '0 14px' }}>
        <div style={{
          padding: 14, borderRadius: 14,
          background: 'var(--accent-tint)', border: '1px solid var(--accent-line)',
          display: 'flex', gap: 12,
        }}>
          <MIconBox icon="lightbulb" />
          <div style={{ flex: 1, fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5 }}>
            <strong style={{ color: 'var(--ink-1)' }}>You're replying in 38s.</strong> Leads are 3× more likely to book under 60s. Consider turning on Instant Call for sod jobs.
          </div>
        </div>
      </div>

      <div style={{ height: 80 }} />
    </MShell>
  );
}
// MToggleRow imported for type completeness even though only the inline
// version above is used by this screen.
void MToggleRow;
void Icon;
