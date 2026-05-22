import { useState } from 'react';
import {
  Icon, MAppBar, MBack, MCard, MIconBox, MScopeBar, MSection, MSegmented, MShell, MStat,
  MToggleRow,
} from '../components';
import { LB_AUTOMATION } from '../data';

export default function MAutomationFollowups() {
  const [enabled, setEnabled] = useState(true);
  const [accountId, setAccountId] = useState('all');
  const [tone, setTone] = useState<'gentle' | 'friendly' | 'direct'>('friendly');
  return (
    <MShell tab="auto" appBar={<MAppBar leading={<MBack label="" />} title="Follow-ups" subtitle="Engage" />}>
      <MScopeBar accountId={accountId} setAccountId={setAccountId} />
      <MSection title="Status">
        <MCard>
          <MToggleRow
            leading={<MIconBox icon="repeat" color="#6d28d9" bg="#ede9fe" />}
            title="Auto follow-up"
            sub="Stops when the lead replies"
            on={enabled} onChange={setEnabled}
            last
          />
        </MCard>
      </MSection>

      <MSection
        title="Schedule"
        action={<a style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600, cursor: 'pointer' }}>Edit</a>}
      >
        <MCard>
          {LB_AUTOMATION.followUps.schedule.map((s, i, arr) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '14px',
              borderBottom: i === arr.length - 1 ? 'none' : '1px solid var(--line-soft)',
            }}>
              <div style={{
                width: 32, height: 32, borderRadius: 99,
                background: '#ede9fe', color: '#6d28d9',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)', flexShrink: 0,
              }}>{i + 1}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ink-1)' }}>{s.label}</div>
                <div style={{ fontSize: 11.5, color: 'var(--ink-5)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                  Send after {s.offset}
                </div>
              </div>
              <Icon name="chevron-right" size={16} style={{ color: 'var(--ink-6)' }} />
            </div>
          ))}
        </MCard>
      </MSection>

      <MSection title="Tone">
        <MSegmented<'gentle' | 'friendly' | 'direct'>
          value={tone} onChange={setTone}
          options={[
            { value: 'gentle', label: 'Gentle' },
            { value: 'friendly', label: 'Friendly' },
            { value: 'direct', label: 'Direct' },
          ]}
        />
      </MSection>

      <MSection title="This week">
        <MCard style={{ padding: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            <MStat label="Sent" value="12" />
            <MStat label="Replies" value="5" delta="42%" />
            <MStat label="Booked" value="3" delta="25%" />
          </div>
        </MCard>
      </MSection>

      <div style={{ height: 60 }} />
    </MShell>
  );
}
