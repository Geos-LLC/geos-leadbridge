import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, ChevronDown, ChevronRight, ChevronUp, Info, Loader2 } from 'lucide-react';
import { usersApi } from '../services/api';
import { notify } from '../store/notificationStore';

/**
 * Collapsible 7-day business hours editor — extracted from the
 * BusinessWebsiteStep wizard so Settings → Hours and any future
 * surface can render the same per-day card without re-implementing
 * the state + auto-save effect.
 *
 * Header is a 38×38 dbeafe calendar tile + title + summary subtitle +
 * chevron (or spinner while a save is in flight). When open, each
 * day gets a Mon row with a from-input — to-input pair + a per-day
 * on/off toggle. A "Copy Monday to all weekdays" button at the
 * bottom is the canonical shortcut.
 *
 * Auto-save fires 600ms after the last edit through
 * `usersApi.updateBusinessHours({ schedule })` — no separate Save
 * button per the FinalDesign canonical.
 */
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type DayKey = typeof DAY_KEYS[number];
const DAY_LABEL: Record<DayKey, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};
const DEFAULT_DAY = { start: '09:00', end: '18:00' };

interface Props {
  /** Start the editor expanded. Defaults to false (collapsed). */
  defaultOpen?: boolean;
  /** Hide the "After-hours AI can still reply" info banner — used on the wizard where the next step exposes that toggle. */
  hideAiNote?: boolean;
}

export default function BusinessHoursEditor({ defaultOpen = false, hideAiNote = false }: Props) {
  const [businessHours, setBusinessHours] = useState<Record<DayKey, { start: string; end: string } | null>>({
    mon: DEFAULT_DAY, tue: DEFAULT_DAY, wed: DEFAULT_DAY, thu: DEFAULT_DAY, fri: DEFAULT_DAY,
    sat: null, sun: null,
  });
  const [open, setOpen] = useState(defaultOpen);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const setDayOpen = (day: DayKey, dayOpen: boolean) => {
    setBusinessHours(prev => ({ ...prev, [day]: dayOpen ? (prev[day] ?? DEFAULT_DAY) : null }));
    setDirty(true);
  };
  const setDayTime = (day: DayKey, field: 'start' | 'end', value: string) => {
    setBusinessHours(prev => {
      const cur = prev[day] ?? DEFAULT_DAY;
      return { ...prev, [day]: { ...cur, [field]: value } };
    });
    setDirty(true);
  };
  const copyMondayToWeekdays = () => {
    setBusinessHours(prev => {
      const mon = prev.mon ?? DEFAULT_DAY;
      return { ...prev, tue: mon, wed: mon, thu: mon, fri: mon };
    });
    setDirty(true);
  };

  // Hydrate from the user-level master schedule.
  useEffect(() => {
    let alive = true;
    usersApi.getBusinessHours()
      .then(res => {
        if (!alive || !res?.schedule) return;
        setBusinessHours(prev => ({ ...prev, ...res.schedule }));
        setDirty(false);
      })
      .catch(() => { /* keep defaults */ });
    return () => { alive = false; };
  }, []);

  // Debounced auto-save — 600ms after the last toggle/time change.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(async () => {
      try {
        setSaving(true);
        await usersApi.updateBusinessHours({ schedule: businessHours });
        setDirty(false);
      } catch (err: any) {
        notify.error('Could not save business hours', err?.response?.data?.message || 'Please try again.');
      } finally {
        setSaving(false);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [dirty, businessHours]);

  const summary = useMemo(() => {
    const fmt = (t: string) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(t);
      if (!m) return t;
      const h = parseInt(m[1], 10);
      const mins = m[2];
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return `${h12}:${mins} ${ampm}`;
    };
    const weekdays = (['mon', 'tue', 'wed', 'thu', 'fri'] as DayKey[]).map(d => businessHours[d]);
    const allSame = weekdays.every(d => d && d.start === weekdays[0]?.start && d.end === weekdays[0]?.end);
    const sat = businessHours.sat;
    const sun = businessHours.sun;
    const parts: string[] = [];
    if (allSame && weekdays[0]) {
      parts.push(`Mon–Fri ${fmt(weekdays[0].start)} – ${fmt(weekdays[0].end)}`);
    } else {
      const openDays = (['mon', 'tue', 'wed', 'thu', 'fri'] as DayKey[]).filter(d => businessHours[d]);
      if (openDays.length === 0) parts.push('Weekdays closed');
      else parts.push(`${openDays.length} weekday${openDays.length === 1 ? '' : 's'} configured`);
    }
    if (sat) parts.push(`Sat ${fmt(sat.start)} – ${fmt(sat.end)}`);
    else parts.push('Sat closed');
    if (sun) parts.push(`Sun ${fmt(sun.start)} – ${fmt(sun.end)}`);
    else parts.push('Sun closed');
    return parts.join(' · ');
  }, [businessHours]);

  return (
    <section
      style={{
        background: '#fff',
        border: '1px solid var(--lb-line)',
        borderRadius: 12,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 13,
          width: '100%', padding: 18,
          background: '#fff', border: 0, cursor: 'pointer',
          fontFamily: 'inherit', textAlign: 'left',
        }}
      >
        <span style={{
          width: 38, height: 38, borderRadius: 10,
          background: '#dbeafe', color: '#2563eb',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <CalendarClock size={18} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{
            display: 'block', fontSize: 15, fontWeight: 700,
            color: 'var(--lb-ink-1)', letterSpacing: '-0.01em',
          }}>
            Business hours
          </span>
          <span style={{
            display: 'block', fontSize: 12, color: 'var(--lb-ink-5)',
            marginTop: 2, lineHeight: 1.4,
          }}>
            {summary}
          </span>
        </span>
        {saving ? (
          <Loader2 className="w-4 h-4 animate-spin shrink-0" style={{ color: 'var(--lb-ink-5)' }} />
        ) : open ? (
          <ChevronUp className="shrink-0" size={17} style={{ color: 'var(--lb-ink-5)' }} />
        ) : (
          <ChevronDown className="shrink-0" size={17} style={{ color: 'var(--lb-ink-5)' }} />
        )}
      </button>
      {open && (
        <div style={{ padding: '6px 18px 4px', borderTop: '1px solid var(--lb-line-soft)' }}>
          {DAY_KEYS.map((d, idx) => {
            const cur = businessHours[d];
            const dayOpen = !!cur;
            return (
              <div
                key={d}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '11px 0',
                  borderBottom: idx === DAY_KEYS.length - 1 ? 'none' : '1px solid var(--lb-line-soft)',
                }}
              >
                <span style={{
                  width: 38, flexShrink: 0,
                  fontSize: 12.5, fontWeight: 700,
                  color: 'var(--lb-ink-2)',
                  fontFamily: 'var(--lb-font-mono)',
                }}>
                  {DAY_LABEL[d]}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  {dayOpen ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <input
                        type="time"
                        value={cur!.start}
                        onChange={(e) => setDayTime(d, 'start', e.target.value)}
                        style={timeInputStyle}
                      />
                      <span style={{ fontSize: 12, color: 'var(--lb-ink-6)', flexShrink: 0 }}>–</span>
                      <input
                        type="time"
                        value={cur!.end}
                        onChange={(e) => setDayTime(d, 'end', e.target.value)}
                        style={timeInputStyle}
                      />
                    </span>
                  ) : (
                    <span style={{
                      fontSize: 12.5, fontWeight: 600,
                      color: 'var(--lb-ink-6)',
                      fontFamily: 'var(--lb-font-mono)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}>
                      Closed
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => setDayOpen(d, !dayOpen)}
                  aria-pressed={dayOpen}
                  style={{
                    width: 38, height: 22, borderRadius: 999,
                    background: dayOpen ? 'var(--lb-accent)' : 'var(--lb-ink-8)',
                    border: 0, padding: 0, cursor: 'pointer',
                    position: 'relative', flexShrink: 0,
                    transition: 'background 120ms',
                  }}
                >
                  <span style={{
                    position: 'absolute', top: 2, left: dayOpen ? 18 : 2,
                    width: 18, height: 18, borderRadius: 99,
                    background: '#fff',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
                    transition: 'left 120ms',
                  }} />
                </button>
              </div>
            );
          })}
          {!hideAiNote && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              margin: '12px 0', padding: '11px 13px',
              background: '#f8fafc',
              border: '1px solid var(--lb-line-soft)',
              borderRadius: 10,
              fontSize: 12.5, color: 'var(--lb-ink-4)', lineHeight: 1.5,
            }}>
              <Info size={15} style={{ flexShrink: 0, color: 'var(--lb-ink-5)' }} />
              <div>
                Outside these hours, AI can still reply instantly — toggle that on{' '}
                <strong style={{ color: 'var(--lb-ink-2)' }}>Automation → Conversation</strong>.
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={copyMondayToWeekdays}
            style={{
              marginBottom: 16,
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 13px',
              border: '1px solid var(--lb-line)', borderRadius: 9,
              background: '#fff', color: 'var(--lb-ink-3)',
              fontSize: 12.5, fontWeight: 600,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <ChevronRight size={13} />
            Copy Monday to all weekdays
          </button>
        </div>
      )}
    </section>
  );
}

const timeInputStyle = {
  display: 'inline-flex' as const,
  alignItems: 'center' as const,
  padding: '5px 9px',
  border: '1px solid var(--lb-line)',
  borderRadius: 8,
  background: '#fff',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--lb-ink-2)',
  fontFamily: 'var(--lb-font-mono)',
  outline: 'none',
};
