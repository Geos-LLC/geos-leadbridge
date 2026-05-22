import {
  MAppBar, MCard, MIconBtn, MSection, MShell, MStat,
} from '../components';
import { useMobileStats } from '../hooks';
import { MEmpty, MErrorState, MLoading } from '../states';

export default function MInsights() {
  const { data, loading, error } = useMobileStats('all');
  const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const max = data ? Math.max(1, ...data.sparkRevenue) : 1;
  const wins = data ? Math.round(data.week.winRate * 100) : 0;

  return (
    <MShell tab="insights" appBar={<MAppBar large title="Insights" subtitle="Past 7 days" trailing={<MIconBtn icon="calendar" />} />}>
      {loading && <MLoading label="Loading insights…" />}
      {error && <MErrorState message={error} />}
      {!loading && !error && data && (
        <>
          <MSection>
            <MCard style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--ink-5)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Revenue booked</div>
                  <div style={{ fontSize: 36, fontWeight: 700, color: 'var(--ink-1)', letterSpacing: '-0.025em', marginTop: 2 }}>
                    ${data.week.revenue.toLocaleString()}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 100, marginTop: 16 }}>
                {data.sparkRevenue.map((v, i) => {
                  const pct = (v / max) * 100;
                  return (
                    <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                      <div style={{
                        width: '100%', height: `${pct}%`,
                        background: i === 6 ? 'var(--accent)' : 'var(--accent-tint)',
                        border: '1px solid ' + (i === 6 ? 'var(--accent)' : 'var(--accent-line)'),
                        borderRadius: '6px 6px 0 0', minHeight: 4,
                      }} />
                      <div style={{ fontSize: 10.5, color: 'var(--ink-5)', fontFamily: 'var(--font-mono)' }}>{days[i]}</div>
                    </div>
                  );
                })}
              </div>
            </MCard>
          </MSection>

          <MSection title="Key metrics">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <MCard style={{ padding: 14 }}><MStat label="Leads (7d)" value={data.week.leads} /></MCard>
              <MCard style={{ padding: 14 }}>
                <MStat label="Reply rate" value={data.week.leads > 0 ? `${Math.round((data.week.replied / data.week.leads) * 100)}%` : '—'} />
              </MCard>
              <MCard style={{ padding: 14 }}><MStat label="Win rate" value={data.week.leads > 0 ? `${wins}%` : '—'} /></MCard>
              <MCard style={{ padding: 14 }}><MStat label="Avg ticket" value={data.week.avgTicket > 0 ? `$${data.week.avgTicket}` : '—'} /></MCard>
            </div>
          </MSection>

          <MSection title="Funnel">
            <MCard style={{ padding: 14 }}>
              {data.funnel.map((f, i, arr) => {
                const mx = arr[0].value || 1;
                const pct = (f.value / mx) * 100;
                return (
                  <div key={f.label} style={{ marginBottom: i === arr.length - 1 ? 0 : 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 6 }}>
                      <span style={{ color: 'var(--ink-3)', fontWeight: 500 }}>{f.label}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink-5)' }}>{f.value}</span>
                    </div>
                    <div style={{ height: 8, background: 'var(--ink-10)', borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{
                        width: `${pct}%`, height: '100%',
                        background: i === arr.length - 1 ? 'var(--success)' : 'var(--accent)',
                      }} />
                    </div>
                  </div>
                );
              })}
            </MCard>
          </MSection>
        </>
      )}

      {!loading && !error && data && data.week.leads === 0 && (
        <MEmpty
          icon="bar-chart-3"
          title="No data yet"
          body="Insights will populate as leads start coming in."
        />
      )}

      <div style={{ height: 60 }} />
    </MShell>
  );
}
