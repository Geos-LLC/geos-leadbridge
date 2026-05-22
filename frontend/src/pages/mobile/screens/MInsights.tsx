import {
  MAppBar, MCard, MIconBtn, MSection, MShell, MStat, PlatformBadge,
} from '../components';
import { LB_PLATFORM_META, LB_STATS, type Platform } from '../data';

const PLATFORM_ROWS: Array<{ p: Platform; count: number; revenue: number; pct: number }> = [
  { p: 'thumbtack', count: 14, revenue: 2200, pct: 100 },
  { p: 'yelp', count: 9, revenue: 1520, pct: 64 },
  { p: 'angi', count: 4, revenue: 600, pct: 28 },
];

export default function MInsights() {
  const wins = Math.round(LB_STATS.week.winRate * 100);
  const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const max = Math.max(...LB_STATS.sparkRevenue);

  return (
    <MShell tab="insights" appBar={<MAppBar large title="Insights" subtitle="Past 7 days" trailing={<MIconBtn icon="calendar" />} />}>
      <MSection>
        <MCard style={{ padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--ink-5)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Revenue booked</div>
              <div style={{ fontSize: 36, fontWeight: 700, color: 'var(--ink-1)', letterSpacing: '-0.025em', marginTop: 2 }}>${LB_STATS.week.revenue.toLocaleString()}</div>
            </div>
            <div style={{ fontSize: 13, color: 'var(--success)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>↑ 18%</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 100, marginTop: 16 }}>
            {LB_STATS.sparkRevenue.map((v, i) => {
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
          <MCard style={{ padding: 14 }}><MStat label="Leads (7d)" value={LB_STATS.week.leads} delta="+14%" /></MCard>
          <MCard style={{ padding: 14 }}><MStat label="Reply rate" value="96%" delta="+2 pts" /></MCard>
          <MCard style={{ padding: 14 }}><MStat label="Win rate" value={`${wins}%`} delta="-1 pt" deltaDir="down" /></MCard>
          <MCard style={{ padding: 14 }}><MStat label="Avg ticket" value={`$${LB_STATS.week.avgTicket}`} delta="+$40" /></MCard>
        </div>
      </MSection>

      <MSection title="Funnel">
        <MCard style={{ padding: 14 }}>
          {LB_STATS.funnel.map((f, i, arr) => {
            const mx = arr[0].value;
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

      <MSection title="By platform">
        <MCard>
          {PLATFORM_ROWS.map((r, i, arr) => (
            <div key={r.p} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '12px 14px',
              borderBottom: i === arr.length - 1 ? 'none' : '1px solid var(--line-soft)',
            }}>
              <PlatformBadge platform={r.p} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500 }}>{LB_PLATFORM_META[r.p].label}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-5)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                  {r.count} leads · ${r.revenue}
                </div>
              </div>
              <div style={{ width: 72, height: 6, background: 'var(--ink-10)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: `${r.pct}%`, height: '100%', background: LB_PLATFORM_META[r.p].color }} />
              </div>
            </div>
          ))}
        </MCard>
      </MSection>

      <div style={{ height: 60 }} />
    </MShell>
  );
}
