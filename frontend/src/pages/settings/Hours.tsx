import { useState } from 'react';
import { CalendarClock, Moon } from 'lucide-react';
import {
  SettingCard, FieldRow, BigToggle, Dropdown,
} from '../../components/automation/ui';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
type Day = (typeof DAYS)[number];

const START_OPTIONS = ['6:00 AM', '7:00 AM', '8:00 AM', '9:00 AM', '10:00 AM', '11:00 AM'];
const END_OPTIONS = ['12:00 PM', '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM'];

export function SettingsHours() {
  const [hours, setHours] = useState<Record<Day, { on: boolean; start: string; end: string }>>({
    Mon: { on: true,  start: '9:00 AM', end: '6:00 PM' },
    Tue: { on: true,  start: '9:00 AM', end: '6:00 PM' },
    Wed: { on: true,  start: '9:00 AM', end: '6:00 PM' },
    Thu: { on: true,  start: '9:00 AM', end: '6:00 PM' },
    Fri: { on: true,  start: '9:00 AM', end: '6:00 PM' },
    Sat: { on: false, start: '9:00 AM', end: '2:00 PM' },
    Sun: { on: false, start: '9:00 AM', end: '2:00 PM' },
  });
  const [quietOn, setQuietOn] = useState(true);
  const [quietStart, setQuietStart] = useState('10:00 PM');
  const [quietEnd, setQuietEnd] = useState('8:00 AM');

  const setDayField = (d: Day, patch: Partial<{ on: boolean; start: string; end: string }>) =>
    setHours(h => ({ ...h, [d]: { ...h[d], ...patch } }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SettingCard
        icon={CalendarClock}
        iconTone="violet"
        title="Business hours"
        subtitle="Used by automation, follow-ups, and instant call."
        contentPad="8px 24px 24px"
      >
        <div style={{ paddingTop: 4 }}>
          {DAYS.map((d, i) => (
            <div key={d} style={{
              display: 'flex', alignItems: 'center', gap: 14,
              padding: '12px 0',
              borderBottom: i === DAYS.length - 1 ? 'none' : '1px solid var(--lb-line-soft)',
            }}>
              <div style={{ width: 50, fontSize: 13, fontWeight: 700, color: 'var(--lb-ink-1)' }}>{d}</div>
              <BigToggle on={hours[d].on} onChange={(v) => setDayField(d, { on: v })} />
              <span style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', minWidth: 46 }}>
                {hours[d].on ? 'Open' : 'Closed'}
              </span>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto',
                opacity: hours[d].on ? 1 : 0.4,
                pointerEvents: hours[d].on ? 'auto' : 'none',
              }}>
                <Dropdown value={hours[d].start} onChange={(v) => setDayField(d, { start: v })} options={START_OPTIONS} />
                <span style={{ fontSize: 12.5, color: 'var(--lb-ink-5)' }}>to</span>
                <Dropdown value={hours[d].end} onChange={(v) => setDayField(d, { end: v })} options={END_OPTIONS} />
              </div>
            </div>
          ))}
        </div>
      </SettingCard>

      <SettingCard
        icon={Moon}
        iconTone="purple"
        title="Quiet hours"
        subtitle="Don't text or call leads overnight, even if automation would otherwise fire."
        enabled={quietOn}
        onToggle={setQuietOn}
        contentPad="8px 24px 24px"
      >
        <FieldRow icon={Moon} iconTone="purple" label="Quiet window" noBorder>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Dropdown value={quietStart} onChange={setQuietStart} options={['8:00 PM', '9:00 PM', '10:00 PM', '11:00 PM']} />
            <span style={{ fontSize: 12.5, color: 'var(--lb-ink-5)' }}>to</span>
            <Dropdown value={quietEnd} onChange={setQuietEnd} options={['6:00 AM', '7:00 AM', '8:00 AM', '9:00 AM']} />
            <span style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginLeft: 8 }}>America/New_York</span>
          </div>
        </FieldRow>
      </SettingCard>
    </div>
  );
}
