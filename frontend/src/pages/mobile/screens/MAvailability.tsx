import {
  Icon, MAppBar, MBack, MCard, MIconBox, MRow, MSection, MShell,
} from '../components';

export default function MAvailability() {
  return (
    <MShell tab="more" appBar={<MAppBar leading={<MBack label="" />} title="Availability" subtitle="Working hours & off-hours" />}>
      <MSection title="Working hours">
        <MCard>
          <div style={{
            padding: '20px 14px', fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.5,
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <Icon name="calendar-clock" size={18} style={{ color: 'var(--accent)' }} />
            <div>
              Working hours editing is in the desktop app — Settings → Hours.
              Mobile read/edit for this section ships in a follow-up.
            </div>
          </div>
        </MCard>
      </MSection>

      <MSection title="Off-hours">
        <MCard>
          <MRow
            leading={<MIconBox icon="moon" color="var(--ink-4)" bg="var(--ink-10)" />}
            title="Quiet hours auto-reply"
            subtitle="Configured per-account on desktop"
            trailing={<Icon name="chevron-right" size={16} style={{ color: 'var(--ink-6)' }} />}
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
