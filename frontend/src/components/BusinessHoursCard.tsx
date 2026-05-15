import { useEffect, useState } from 'react';
import { Clock, Check, Loader2 } from 'lucide-react';
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
 * Business Hours card — master window in Settings → General.
 * Gates Instant Call, Instant Text first-msg, and AI Conversation when enabled.
 * Per-card switches live on each account's settings (Services page).
 */
export function BusinessHoursCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('18:00');
  const [timezone, setTimezone] = useState('America/New_York');
  const [days, setDays] = useState<string[]>(['mon', 'tue', 'wed', 'thu', 'fri']);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await usersApi.getBusinessHours();
        if (!alive) return;
        setEnabled(cfg.enabled);
        setStart(cfg.start);
        setEnd(cfg.end);
        setTimezone(cfg.timezone);
        setDays(cfg.days);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const toggleDay = (key: string) => {
    setDays((prev) => (prev.includes(key) ? prev.filter((d) => d !== key) : [...prev, key]));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await usersApi.updateBusinessHours({ enabled, start, end, timezone, days });
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
      <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--lb-line-soft)' }} className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Clock size={14} className="text-slate-400" />
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-1)' }}>Business Hours</h3>
        </div>
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <span className="text-xs text-slate-500">{enabled ? 'On' : 'Off'}</span>
          <input
            type="checkbox"
            className="sr-only peer"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={loading}
          />
          <span className="w-9 h-5 bg-slate-200 rounded-full peer peer-checked:bg-blue-600 relative transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:w-4 after:h-4 after:rounded-full after:transition-transform peer-checked:after:translate-x-4" />
        </label>
      </div>

      <div className="p-6 space-y-5">
        <p className="text-xs text-slate-500 -mt-1">
          When enabled, Instant Call and the first SMS to a new lead are limited to this window.
          AI Conversation respects this window per its mode. Each account can override below.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Start</p>
            <input
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              disabled={!enabled || loading}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 disabled:bg-slate-50 disabled:text-slate-400"
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">End</p>
            <input
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              disabled={!enabled || loading}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 disabled:bg-slate-50 disabled:text-slate-400"
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Time Zone</p>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              disabled={!enabled || loading}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 disabled:bg-slate-50 disabled:text-slate-400"
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
              const on = days.includes(d.key);
              return (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => toggleDay(d.key)}
                  disabled={!enabled || loading}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-full border transition-colors ${
                    on
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-white text-slate-500 border-slate-200 hover:border-slate-300'
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
          {savedAt && <span className="text-xs text-emerald-600 flex items-center gap-1"><Check size={12} /> Saved</span>}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loading}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 transition-colors"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
