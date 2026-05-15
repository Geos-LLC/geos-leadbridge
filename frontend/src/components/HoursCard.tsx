import { useEffect, useState } from 'react';
import { Clock, Moon, Check, Loader2 } from 'lucide-react';
import { usersApi } from '../services/api';

const ALL_DAYS: Array<{ key: string; label: string }> = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
];

const TZ_OPTIONS = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
];

/**
 * Hours card — one card, two sections. Always-on settings (no enable toggle).
 * Per-feature gating lives on each card on the Services page; this just
 * defines the windows those gates check.
 *
 * Business Hours — Mon-Fri 9-6 default — used by Instant Call, Instant Text
 *   first-msg, and AI Conversation when "Outside of business hours" is selected.
 * Quiet Hours    — 22:00-08:00 daily default — used by Follow-ups when the
 *   "Apply quiet hours" toggle on the card is on.
 */
export function HoursCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Business hours
  const [bhStart, setBhStart] = useState('09:00');
  const [bhEnd, setBhEnd] = useState('18:00');
  const [bhTz, setBhTz] = useState('America/New_York');
  const [bhDays, setBhDays] = useState<string[]>(['mon', 'tue', 'wed', 'thu', 'fri']);

  // Quiet hours
  const [qhStart, setQhStart] = useState('22:00');
  const [qhEnd, setQhEnd] = useState('08:00');
  const [qhTz, setQhTz] = useState('America/New_York');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [bh, qh] = await Promise.all([usersApi.getBusinessHours(), usersApi.getQuietHours()]);
        if (!alive) return;
        setBhStart(bh.start);
        setBhEnd(bh.end);
        setBhTz(bh.timezone);
        setBhDays(bh.days);
        setQhStart(qh.start);
        setQhEnd(qh.end);
        setQhTz(qh.timezone);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const toggleDay = (key: string) => {
    setBhDays((prev) => (prev.includes(key) ? prev.filter((d) => d !== key) : [...prev, key]));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // `enabled: true` — both windows are now always-on settings. Per-feature
      // switches on Services decide whether to consult the window.
      await Promise.all([
        usersApi.updateBusinessHours({ enabled: true, start: bhStart, end: bhEnd, timezone: bhTz, days: bhDays }),
        usersApi.updateQuietHours({ enabled: true, start: qhStart, end: qhEnd, timezone: qhTz }),
      ]);
      setSavedAt(Date.now());
      window.setTimeout(() => setSavedAt(null), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="overflow-hidden"
      style={{ background: 'var(--lb-surface)', border: '1px solid var(--lb-line)', borderRadius: 'var(--lb-radius-lg)' }}
    >
      <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--lb-line-soft)' }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-1)' }}>Hours</h3>
        <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--lb-ink-5)' }}>
          Defines the windows used by per-feature switches on the Services page. The hours themselves are always on — switches in automation decide which features respect them.
        </p>
      </div>

      {/* Business Hours section */}
      <div className="p-6 space-y-4 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <Clock size={14} className="text-slate-500" />
          <h4 className="text-sm font-bold text-slate-800">Business Hours</h4>
        </div>
        <p className="text-xs text-slate-500 -mt-2">
          Used by Instant Call, Instant Text (first message), and AI Conversation when set to "Outside of business hours".
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Start</p>
            <input
              type="time"
              value={bhStart}
              onChange={(e) => setBhStart(e.target.value)}
              disabled={loading}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 disabled:bg-slate-50"
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">End</p>
            <input
              type="time"
              value={bhEnd}
              onChange={(e) => setBhEnd(e.target.value)}
              disabled={loading}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 disabled:bg-slate-50"
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Time Zone</p>
            <select
              value={bhTz}
              onChange={(e) => setBhTz(e.target.value)}
              disabled={loading}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 disabled:bg-slate-50"
            >
              {TZ_OPTIONS.map((tz) => (
                <option key={tz} value={tz}>{tz.replace('_', ' ')}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Days</p>
          <div className="flex flex-wrap gap-1.5">
            {ALL_DAYS.map((d) => {
              const on = bhDays.includes(d.key);
              return (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => toggleDay(d.key)}
                  disabled={loading}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-full border transition-colors ${
                    on
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'
                  } disabled:opacity-50`}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Quiet Hours section */}
      <div className="p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Moon size={14} className="text-slate-500" />
          <h4 className="text-sm font-bold text-slate-800">Quiet Hours</h4>
        </div>
        <p className="text-xs text-slate-500 -mt-2">
          Daily nighttime window for Follow-ups. Used when "Apply quiet hours" is on for an account.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Don't send after</p>
            <input
              type="time"
              value={qhStart}
              onChange={(e) => setQhStart(e.target.value)}
              disabled={loading}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 disabled:bg-slate-50"
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Resume at</p>
            <input
              type="time"
              value={qhEnd}
              onChange={(e) => setQhEnd(e.target.value)}
              disabled={loading}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 disabled:bg-slate-50"
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Time Zone</p>
            <select
              value={qhTz}
              onChange={(e) => setQhTz(e.target.value)}
              disabled={loading}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 disabled:bg-slate-50"
            >
              {TZ_OPTIONS.map((tz) => (
                <option key={tz} value={tz}>{tz.replace('_', ' ')}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-slate-100 bg-slate-50/50">
        {savedAt && <span className="text-xs text-emerald-600 flex items-center gap-1"><Check size={12} /> Saved</span>}
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || loading}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 transition-colors"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : null}
          Save Hours
        </button>
      </div>
    </div>
  );
}
