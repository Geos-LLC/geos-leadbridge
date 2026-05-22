import { useState } from 'react';
import {
  Avatar, Icon, MAppBar, MBack, MCard, MIconBox, MRow, MScopeBar, MSection, MSegmented, MShell,
  MToggleRow,
} from '../components';
import { LB_AUTOMATION } from '../data';

export default function MAutomationRespond() {
  const [mode, setMode] = useState<'template' | 'ai'>('ai');
  const [enabled, setEnabled] = useState(true);
  const [accountId, setAccountId] = useState('all');
  return (
    <MShell
      tab="auto"
      appBar={<MAppBar leading={<MBack label="" />} title="When a Lead Arrives" subtitle="Respond" />}
    >
      <MScopeBar accountId={accountId} setAccountId={setAccountId} />

      <MSection title="Status">
        <MCard>
          <MToggleRow
            leading={<MIconBox icon="zap" color="var(--success)" bg="var(--success-tint)" />}
            title="Instant Reply"
            sub={enabled ? 'Active — replying within 30s' : 'Paused — no auto reply'}
            on={enabled} onChange={setEnabled}
            last
          />
        </MCard>
      </MSection>

      <MSection title="Reply mode">
        <MSegmented<'template' | 'ai'>
          value={mode}
          onChange={setMode}
          options={[
            { value: 'template', label: 'Template' },
            { value: 'ai', label: 'AI Draft' },
          ]}
        />
        {mode === 'ai' && (
          <MCard style={{ marginTop: 12, padding: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon name="sparkles" size={12} /> AI Prompt
            </div>
            <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55, padding: '10px 12px', background: 'var(--ink-10)', borderRadius: 10, border: '1px solid var(--line)' }}>
              {LB_AUTOMATION.instantReply.prompt}
            </div>
            <button type="button" style={{ marginTop: 10, fontSize: 12, fontWeight: 600, color: 'var(--accent)', background: 'transparent', border: 0, padding: 0, cursor: 'pointer' }}>
              Edit prompt →
            </button>
          </MCard>
        )}
      </MSection>

      <MSection title="Availability">
        <MCard>
          <MRow
            leading={<MIconBox icon="clock" color="var(--accent)" bg="var(--accent-tint)" />}
            title="Always on" subtitle="24/7 — replies any time"
            trailing={<Icon name="check" size={16} style={{ color: 'var(--accent)' }} />}
          />
          <MRow
            leading={<MIconBox icon="calendar-clock" color="var(--ink-4)" bg="var(--ink-10)" />}
            title="During working hours only" subtitle="Mon–Sat 7am–6pm"
            trailing={<Icon name="chevron-right" size={16} style={{ color: 'var(--ink-6)' }} />}
            last
          />
        </MCard>
      </MSection>

      <MSection title="Recent first replies">
        <MCard>
          <MRow
            leading={<Avatar name="Priya D" size={32} />}
            title="Priya Desai" subtitle="Replied 42s · Weekly mow ballpark"
            trailing={<span style={{ fontSize: 11, color: 'var(--success)', fontFamily: 'var(--font-mono)' }}>SENT</span>}
          />
          <MRow
            leading={<Avatar name="Derek M" size={32} />}
            title="Derek Mulligan" subtitle="Replied 38s · Sod $1.2–1.6k"
            trailing={<span style={{ fontSize: 11, color: 'var(--success)', fontFamily: 'var(--font-mono)' }}>SENT</span>}
            last
          />
        </MCard>
      </MSection>

      <div style={{ height: 60 }} />
    </MShell>
  );
}
