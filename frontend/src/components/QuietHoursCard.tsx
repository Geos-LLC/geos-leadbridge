import { useEffect, useState } from 'react';
import { Moon, Check, Loader2 } from 'lucide-react';
import { usersApi } from '../services/api';

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
 * Quiet Hours — daily "don't text leads at night" window. Used by Follow-ups
 * when the account opts in via the Apply Quiet Hours toggle on the card.
 * Distinct from Business Hours (Mon-Fri 9-6 for calls/first-msg) and from the
 * dispatcher's owner-alert quietHours (silences notifications to YOU, not to leads).
 */
export function QuietHoursCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [start, setStart] = useState('22:00');
  const [end, setEnd] = useState('08:00');
  const [timezone, setTimezone] = useState('America/New_York');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await usersApi.getQuietHours();
        if (!alive) return;
        setEnabled(cfg.enabled);
        setStart(cfg.start);
        setEnd(cfg.end);
        setTimezone(cfg.timezone);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await usersApi.updateQuietHours({ enabled, start, end, timezone });
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
          <Moon size={14} className="text-slate-400" />
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-1)' }}>Quiet Hours</h3>
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
          Don't send follow-up messages to leads during this nightly window. Applies daily.
          Each account can opt in/out from the Follow-ups card.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Don't send after</p>
            <input
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              disabled={!enabled || loading}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 disabled:bg-slate-50 disabled:text-slate-400"
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Resume at</p>
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
