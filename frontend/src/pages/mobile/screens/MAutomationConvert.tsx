import { useState } from 'react';
import {
  Icon, MAppBar, MBack, MCard, MIconBox, MRow, MScopeBar, MSection, MShell, MToggleRow,
} from '../components';
import type { IconName } from '../components';

type Strategy = 'auto' | 'qualify' | 'price' | 'phone';

const STRATEGY_OPTS: Array<{ v: Strategy; label: string; sub: string; icon: IconName }> = [
  { v: 'auto', label: 'Auto', sub: 'AI picks based on lead intent', icon: 'sparkles' },
  { v: 'qualify', label: 'Qualify first', sub: 'Ask 2 questions before pricing', icon: 'help-circle' },
  { v: 'price', label: 'Lead with price', sub: 'Share ballpark in first reply', icon: 'dollar-sign' },
  { v: 'phone', label: 'Push to call', sub: 'Get them on a quick call', icon: 'phone' },
];

export default function MAutomationConvert() {
  const [strategy, setStrategy] = useState<Strategy>('auto');
  const [accountId, setAccountId] = useState('all');
  const [consult, setConsult] = useState(true);
  const [bigJobs, setBigJobs] = useState(true);
  const [tough, setTough] = useState(true);

  return (
    <MShell tab="auto" appBar={<MAppBar leading={<MBack label="" />} title="AI Conversation" subtitle="Convert" />}>
      <MScopeBar accountId={accountId} setAccountId={setAccountId} />

      <MSection title="Strategy">
        <MCard>
          {STRATEGY_OPTS.map((o, i) => (
            <MRow
              key={o.v}
              onClick={() => setStrategy(o.v)}
              leading={<MIconBox icon={o.icon} color="var(--accent)" bg="var(--accent-tint)" />}
              title={o.label}
              subtitle={o.sub}
              trailing={
                <span style={{
                  width: 20, height: 20, borderRadius: 99,
                  border: '2px solid ' + (strategy === o.v ? 'var(--accent)' : 'var(--ink-8)'),
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  background: strategy === o.v ? 'var(--accent)' : 'transparent',
                }}>
                  {strategy === o.v && <Icon name="check" size={11} style={{ color: 'white' }} />}
                </span>
              }
              last={i === STRATEGY_OPTS.length - 1}
            />
          ))}
        </MCard>
      </MSection>

      <MSection title="Hand-off rules">
        <MCard>
          <MToggleRow
            leading={<MIconBox icon="user" color="var(--warn)" bg="var(--warn-tint)" />}
            title="Hand off on consult requests" sub="Big jobs route to you"
            on={consult} onChange={setConsult}
          />
          <MToggleRow
            leading={<MIconBox icon="dollar-sign" color="var(--warn)" bg="var(--warn-tint)" />}
            title="Hand off above $1,500" sub="High-ticket flagged for review"
            on={bigJobs} onChange={setBigJobs}
          />
          <MToggleRow
            leading={<MIconBox icon="alert-triangle" color="var(--warn)" bg="var(--warn-tint)" />}
            title="Hand off on tough questions" sub="Anything off-script"
            on={tough} onChange={setTough}
            last
          />
        </MCard>
      </MSection>

      <MSection title="Try the prompt">
        <MCard style={{ padding: 14, background: 'var(--ink-1)', borderColor: 'var(--ink-1)' }}>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 700, marginBottom: 8 }}>
            Simulated lead
          </div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.92)', lineHeight: 1.5, padding: '8px 12px', background: 'rgba(255,255,255,0.07)', borderRadius: 10 }}>
            "Hey — looking for someone to redo my whole front lawn. Budget around $4k. When can you come look?"
          </div>
          <button type="button" style={{
            marginTop: 12, padding: '10px 14px', borderRadius: 999, border: 0, cursor: 'pointer',
            background: 'var(--accent)', color: 'white', fontWeight: 600, fontSize: 13,
            display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%', justifyContent: 'center',
          }}>
            <Icon name="play" size={13} /> Run simulation
          </button>
        </MCard>
      </MSection>

      <div style={{ height: 60 }} />
    </MShell>
  );
}
