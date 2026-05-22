import { useState } from 'react';
import {
  Icon, MAppBar, MBack, MCard, MIconBox, MRow, MSection, MShell, MToggleRow, Toggle,
} from '../components';
import { LB_AVAILABILITY } from '../data';

const DAYS = [
  { k: 'mon', label: 'Mon' }, { k: 'tue', label: 'Tue' }, { k: 'wed', label: 'Wed' },
  { k: 'thu', label: 'Thu' }, { k: 'fri', label: 'Fri' }, { k: 'sat', label: 'Sat' },
  { k: 'sun', label: 'Sun' },
];

export default function MAvailability() {
  const [hours, setHours] = useState(LB_AVAILABILITY.weekdays);
  const [offHours, setOffHours] = useState(true);

  return (
    <MShell tab="more" appBar={<MAppBar leading={<MBack label="" />} title="Availability" subtitle={`Timezone: ${LB_AVAILABILITY.timezone}`} />}>
      <MSection title="Working hours">
        <MCard>
          {DAYS.map((d, i) => {
            const h = hours[d.k];
            return (
              <div key={d.k} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '13px 14px',
                borderBottom: i === DAYS.length - 1 ? 'none' : '1px solid var(--line-soft)',
              }}>
                <div style={{ width: 36, fontSize: 13, fontWeight: 600, color: h.on ? 'var(--ink-1)' : 'var(--ink-5)' }}>{d.label}</div>
                <div style={{ flex: 1 }}>
                  {h.on ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                      <span style={{ padding: '4px 9px', background: 'var(--ink-10)', borderRadius: 6 }}>{h.start}</span>
                      <span style={{ color: 'var(--ink-5)' }}>–</span>
                      <span style={{ padding: '4px 9px', background: 'var(--ink-10)', borderRadius: 6 }}>{h.end}</span>
                    </div>
                  ) : (
                    <span style={{ fontSize: 12, color: 'var(--ink-5)' }}>Closed</span>
                  )}
                </div>
                <Toggle on={h.on} onChange={(v) => setHours({ ...hours, [d.k]: { ...h, on: v } })} />
              </div>
            );
          })}
        </MCard>
      </MSection>

      <MSection title="Off-hours">
        <MCard>
          <MToggleRow
            leading={<MIconBox icon="moon" color="var(--ink-4)" bg="var(--ink-10)" />}
            title="Auto-reply outside hours"
            sub="Let leads know when they'll hear back"
            on={offHours} onChange={setOffHours}
            last
          />
        </MCard>
      </MSection>

      <MSection title="Time off">
        <MCard>
          <MRow
            leading={<MIconBox icon="plus" color="var(--accent)" bg="var(--accent-tint)" />}
            title="Schedule time off"
            subtitle="Block dates · pause new leads"
            trailing={<Icon name="chevron-right" size={16} style={{ color: 'var(--ink-6)' }} />}
            last
          />
        </MCard>
      </MSection>

      <div style={{ height: 60 }} />
    </MShell>
  );
}
