import { useEffect, useRef, useState } from 'react';
import { Moon, Loader2 } from 'lucide-react';
import {
  SettingCard, FieldRow, Dropdown,
} from '../../components/automation/ui';
import BusinessHoursEditor from '../../components/BusinessHoursEditor';
import { usersApi } from '../../services/api';

const QUIET_START_OPTIONS = ['8:00 PM', '9:00 PM', '10:00 PM', '11:00 PM'];
const QUIET_END_OPTIONS = ['6:00 AM', '7:00 AM', '8:00 AM', '9:00 AM'];

// "9:00 AM" / "10:30 PM" ⇄ "09:00" / "22:30" (24h HH:MM strings used by the API)
function display24(d: string): string {
  if (/^\d{2}:\d{2}$/.test(d)) return d;
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

export function SettingsHours() {
  // Business hours editor handles its own state + auto-save via the
  // shared component (canonical wizard pattern). This page just stitches
  // it together with the Quiet Hours card below.

  const [quietOn, setQuietOn] = useState(true);
  const [quietStart, setQuietStart] = useState('10:00 PM');
  const [quietEnd, setQuietEnd] = useState('8:00 AM');
  const [quietTz, setQuietTz] = useState('America/New_York');
  const [quietLoading, setQuietLoading] = useState(true);
  const [quietDirty, setQuietDirty] = useState(false);
  const [quietSaving, setQuietSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hydratedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    usersApi.getQuietHours()
      .then(qh => {
        if (!alive) return;
        setQuietOn(!!qh.enabled);
        if (qh.start) setQuietStart(display12(qh.start));
        if (qh.end) setQuietEnd(display12(qh.end));
        if (qh.timezone) setQuietTz(qh.timezone);
      })
      .catch((e: any) => {
        if (alive) setError(e?.response?.data?.message || e?.message || 'Failed to load quiet hours');
      })
      .finally(() => {
        if (alive) {
          setQuietLoading(false);
          setTimeout(() => { hydratedRef.current = true; }, 0);
        }
      });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    setQuietDirty(true);
  }, [quietOn, quietStart, quietEnd, quietTz]);

  // Debounced auto-save for quiet hours — matches the canonical
  // wizard pattern (no manual Save button).
  useEffect(() => {
    if (!quietDirty) return;
    const t = setTimeout(async () => {
      try {
        setQuietSaving(true);
        await usersApi.updateQuietHours({
          enabled: quietOn,
          start: display24(quietStart),
          end: display24(quietEnd),
          timezone: quietTz,
        });
        setQuietDirty(false);
        setError(null);
      } catch (e: any) {
        setError(e?.response?.data?.message || e?.message || 'Failed to save quiet hours');
      } finally {
        setQuietSaving(false);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [quietDirty, quietOn, quietStart, quietEnd, quietTz]);

  if (quietLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 32, color: 'var(--lb-ink-5)' }}>
        <Loader2 size={16} className="animate-spin" /> Loading hours…
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {error && (
        <div style={{
          padding: '10px 14px', borderRadius: 10,
          background: 'var(--lb-danger-tint)', color: 'var(--lb-danger)',
          fontSize: 13, fontWeight: 600,
        }}>{error}</div>
      )}

      <BusinessHoursEditor defaultOpen />

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
            {quietSaving && (
              <Loader2 size={13} className="animate-spin" style={{ color: 'var(--lb-ink-5)' }} />
            )}
          </div>
        </FieldRow>
      </SettingCard>
    </div>
  );
}
