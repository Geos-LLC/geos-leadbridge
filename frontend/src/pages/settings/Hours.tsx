import { useEffect, useState } from 'react';
import { CalendarClock, Moon, Loader2 } from 'lucide-react';
import {
  SettingCard, FieldRow, BigToggle, Dropdown,
} from '../../components/automation/ui';
import { usersApi } from '../../services/api';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
type Day = (typeof DAYS)[number];
const DAY_TO_API: Record<Day, 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'> = {
  Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun',
};

const START_OPTIONS = ['6:00 AM', '7:00 AM', '8:00 AM', '9:00 AM', '10:00 AM', '11:00 AM'];
const END_OPTIONS = ['12:00 PM', '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM'];

const QUIET_START_OPTIONS = ['8:00 PM', '9:00 PM', '10:00 PM', '11:00 PM'];
const QUIET_END_OPTIONS = ['6:00 AM', '7:00 AM', '8:00 AM', '9:00 AM'];

// "9:00 AM" / "10:30 PM" ⇄ "09:00" / "22:30" (24h HH:MM strings used by the API)
function display24(d: string): string {
  if (/^\d{2}:\d{2}$/.test(d)) return d; // already HH:MM
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(d.trim());
  if (!m) return '09:00';
  let h = parseInt(m[1], 10);
  const min = m[2];
  const isPm = m[3].toUpperCase() === 'PM';
  if (isPm && h !== 12) h += 12;
  if (!isPm && h === 12) h = 0;
  return `${h.toString().padStart(2, '0')}:${min}`;
}
function display12(t: string): string {
  if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(t)) return t;
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  if (!m) return t;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const isPm = h >= 12;
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${min} ${isPm ? 'PM' : 'AM'}`;
}

type DayState = { on: boolean; start: string; end: string };
const DEFAULT_DAY: DayState = { on: false, start: '9:00 AM', end: '6:00 PM' };

export function SettingsHours() {
  const [hours, setHours] = useState<Record<Day, DayState>>({
    Mon: { ...DEFAULT_DAY }, Tue: { ...DEFAULT_DAY }, Wed: { ...DEFAULT_DAY },
    Thu: { ...DEFAULT_DAY }, Fri: { ...DEFAULT_DAY }, Sat: { ...DEFAULT_DAY }, Sun: { ...DEFAULT_DAY },
  });
  const [tz, setTz] = useState('America/New_York');
  const [quietOn, setQuietOn] = useState(true);
  const [quietStart, setQuietStart] = useState('10:00 PM');
  const [quietEnd, setQuietEnd] = useState('8:00 AM');
  const [quietTz, setQuietTz] = useState('America/New_York');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load on mount
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [bh, qh] = await Promise.all([
          usersApi.getBusinessHours(),
          usersApi.getQuietHours(),
        ]);
        if (!alive) return;
        setTz(bh.timezone || 'America/New_York');
        setHours(h => {
          const next = { ...h };
          (DAYS as readonly Day[]).forEach(d => {
            const entry = bh.schedule?.[DAY_TO_API[d]];
            next[d] = entry
              ? { on: true, start: display12(entry.start), end: display12(entry.end) }
              : { ...DEFAULT_DAY };
          });
          return next;
        });
        setQuietOn(!!qh.enabled);
        if (qh.start) setQuietStart(display12(qh.start));
        if (qh.end) setQuietEnd(display12(qh.end));
        if (qh.timezone) setQuietTz(qh.timezone);
      } catch (e: any) {
        if (alive) setError(e?.response?.data?.message || e?.message || 'Failed to load hours');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const setDayField = (d: Day, patch: Partial<DayState>) =>
    setHours(h => ({ ...h, [d]: { ...h[d], ...patch } }));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const schedule: Record<string, { start: string; end: string } | null> = {};
      (DAYS as readonly Day[]).forEach(d => {
        const key = DAY_TO_API[d];
        schedule[key] = hours[d].on
          ? { start: display24(hours[d].start), end: display24(hours[d].end) }
          : null;
      });
      await Promise.all([
        usersApi.updateBusinessHours({ timezone: tz, schedule }),
        usersApi.updateQuietHours({
          enabled: quietOn,
          start: display24(quietStart),
          end: display24(quietEnd),
          timezone: quietTz,
        }),
      ]);
      setSavedAt(Date.now());
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 32, color: 'var(--lb-ink-5)' }}>
        <Loader2 size={16} className="animate-spin" /> Loading hours…
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error && (
        <div style={{
          padding: '10px 14px', borderRadius: 10,
          background: 'var(--lb-danger-tint)', color: 'var(--lb-danger)',
          fontSize: 13, fontWeight: 600,
        }}>{error}</div>
      )}
      {savedAt && !error && (
        <div style={{
          padding: '10px 14px', borderRadius: 10,
          background: 'var(--lb-success-tint)', color: 'var(--lb-success)',
          fontSize: 13, fontWeight: 600,
        }}>Hours saved.</div>
      )}

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
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            marginTop: 12, paddingTop: 12,
            borderTop: '1px solid var(--lb-line-soft)',
          }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--lb-ink-2)' }}>Timezone</div>
            <Dropdown
              value={tz}
              onChange={setTz}
              options={['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix']}
            />
          </div>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Dropdown value={quietStart} onChange={setQuietStart} options={QUIET_START_OPTIONS} />
            <span style={{ fontSize: 12.5, color: 'var(--lb-ink-5)' }}>to</span>
            <Dropdown value={quietEnd} onChange={setQuietEnd} options={QUIET_END_OPTIONS} />
            <Dropdown
              value={quietTz}
              onChange={setQuietTz}
              options={['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix']}
            />
          </div>
        </FieldRow>
      </SettingCard>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '10px 18px', fontSize: 13.5, fontWeight: 600,
            background: 'var(--lb-accent)', color: 'white',
            border: 0, borderRadius: 10,
            cursor: saving ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? 'Saving...' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
