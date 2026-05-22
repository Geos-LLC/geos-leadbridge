import { useNavigate } from 'react-router-dom';
import {
  Avatar, MAppBar, MCard, MIconBox, MIconBtn, MRow, MSection, MShell, MStat,
  PlatformBadge,
} from '../components';
import { useMobileAccounts, useMobileLeads, useMobileStats, useMobileUser } from '../hooks';
import { MEmpty, MLoading } from '../states';

export default function MOverview() {
  const user = useMobileUser();
  const accountsState = useMobileAccounts();
  const leadsState = useMobileLeads('all');
  const statsState = useMobileStats('all');
  const navigate = useNavigate();

  const todayHeader = (() => {
    const now = new Date();
    return now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  })();

  const todaysLeads = (leadsState.data || []).filter(l => l.sort < 24 * 60);
  const newToday = todaysLeads.filter(l => l.status === 'new').length;
  const attention = (accountsState.data || []).filter(a => a.status !== 'connected');
  const unread = (leadsState.data || []).filter(l => l.unread).slice(0, 3);
  const week = statsState.data?.week;

  return (
    <MShell
      tab="overview"
      appBar={
        <MAppBar
          large
          title="Today"
          subtitle={user ? `${todayHeader} · ${user.business}` : todayHeader}
          trailing={
            <>
              <MIconBtn icon="search" onClick={() => navigate('/m/leads')} />
              <MIconBtn icon="bell" badge={unread.length > 0} />
            </>
          }
        />
      }
    >
      <div style={{ padding: '14px 14px 0' }}>
        <MCard style={{ padding: 16, background: 'var(--ink-1)', borderColor: 'var(--ink-1)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 600 }}>Today so far</span>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', fontFamily: 'var(--font-mono)' }}>
              {new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <div style={{ fontSize: 56, fontWeight: 700, color: 'white', letterSpacing: '-0.04em', lineHeight: 1 }}>
              {leadsState.loading ? '—' : newToday}
            </div>
            <div style={{ color: 'rgba(255,255,255,0.85)', fontSize: 14, fontWeight: 500 }}>new leads</div>
          </div>
          <div style={{ display: 'flex', gap: 14, marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.12)' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Today</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'white', marginTop: 2 }}>{todaysLeads.length}</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Booked (7d)</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'white', marginTop: 2 }}>{week?.booked ?? '—'}</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Unread</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'white', marginTop: 2 }}>{(leadsState.data || []).filter(l => l.unread).length}</div>
            </div>
          </div>
        </MCard>
      </div>

      {(attention.length > 0 || unread.length > 0) && (
        <MSection title="Needs your attention" action={
          <a style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600, cursor: 'pointer' }} onClick={() => navigate('/m/leads')}>See all</a>
        }>
          <MCard>
            {attention.map((a, i) => (
              <MRow
                key={a.id}
                leading={<PlatformBadge platform={a.platform} size="md" />}
                title={a.shortName}
                subtitle={a.issue}
                trailing={
                  <button type="button" style={{ background: 'var(--warn-tint)', color: '#92400e', border: 0, padding: '6px 12px', borderRadius: 999, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Fix</button>
                }
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
                onClick={() => navigate(`/m/leads/${l.id}`)}
              />
            ))}
          </MCard>
        </MSection>
      )}

      <MSection title="Automation">
        <MCard onClick={() => navigate('/m/automation')} style={{ cursor: 'pointer' }}>
          <MRow
            leading={<MIconBox icon="workflow" color="var(--accent)" bg="var(--accent-tint)" size={38} />}
            title="Open Automation"
            subtitle="Reply rules, follow-ups, AI Conversation"
            trailing={<MIconBtn icon="chevron-right" />}
            last
          />
        </MCard>
      </MSection>

      <MSection title="Past 7 days">
        {statsState.loading && <MLoading label="Loading stats…" />}
        {!statsState.loading && week && (
          <MCard style={{ padding: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16, rowGap: 14 }}>
              <MStat label="Leads in" value={week.leads} />
              <MStat label="Booked" value={week.booked} />
              <MStat label="Revenue" value={`$${week.revenue.toLocaleString()}`} />
              <MStat label="Avg ticket" value={week.avgTicket ? `$${week.avgTicket}` : '—'} />
            </div>
          </MCard>
        )}
      </MSection>

      {leadsState.loading && <MLoading label="Loading your leads…" />}
      {!leadsState.loading && (leadsState.data?.length ?? 0) === 0 && (
        <MEmpty
          icon="inbox"
          title="No leads yet"
          body="Connect a source from More → Connected accounts to start pulling in leads."
        />
      )}

      <div style={{ height: 80 }} />
    </MShell>
  );
}
