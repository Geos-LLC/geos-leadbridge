import { useEffect, useMemo, useState } from 'react';
import { Clock, Moon, Check, Loader2, Copy } from 'lucide-react';
import { usersApi } from '../services/api';

const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type Day = typeof ALL_DAYS[number];

const DAY_LABEL: Record<Day, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};
const DAY_SHORT: Record<Day, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

type DaySchedule = { start: string; end: string } | null;
type Schedule = Record<Day, DaySchedule>;

const DEFAULT_SCHEDULE: Schedule = {
  mon: { start: '09:00', end: '18:00' },
  tue: { start: '09:00', end: '18:00' },
  wed: { start: '09:00', end: '18:00' },
  thu: { start: '09:00', end: '18:00' },
  fri: { start: '09:00', end: '18:00' },
  sat: null,
  sun: null,
};

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
 * Hours card — one card, two sections (Business / Quiet). Always-on settings;
 * per-feature switches on Services decide which features respect them.
 *
 * Business Hours = per-day schedule. Each weekday can have its own start/end
 * (or be closed). Copy button per row applies that day's window to selected
 * other days in one click.
 */
export function HoursCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Business hours (per-day)
  const [schedule, setSchedule] = useState<Schedule>(DEFAULT_SCHEDULE);
  const [bhTz, setBhTz] = useState('America/New_York');
  const [copyFrom, setCopyFrom] = useState<Day | null>(null);
  const [copyTargets, setCopyTargets] = useState<Set<Day>>(new Set());

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
        // Merge with default to make sure all keys exist.
        const next: Schedule = { ...DEFAULT_SCHEDULE };
        for (const k of ALL_DAYS) {
          if (bh.schedule[k] !== undefined) next[k] = bh.schedule[k];
        }
        setSchedule(next);
        setBhTz(bh.timezone);
        setQhStart(qh.start);
        setQhEnd(qh.end);
        setQhTz(qh.timezone);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const toggleDay = (day: Day) => {
    setSchedule((prev) => ({
      ...prev,
      [day]: prev[day] ? null : { start: '09:00', end: '18:00' },
    }));
  };

  const setDayStart = (day: Day, value: string) => {
    setSchedule((prev) => ({
      ...prev,
      [day]: prev[day] ? { ...prev[day]!, start: value } : null,
    }));
  };
  const setDayEnd = (day: Day, value: string) => {
    setSchedule((prev) => ({
      ...prev,
      [day]: prev[day] ? { ...prev[day]!, end: value } : null,
    }));
  };

  const openCopyPicker = (day: Day) => {
    setCopyFrom(day);
    setCopyTargets(new Set());
  };
  const toggleCopyTarget = (day: Day) => {
    setCopyTargets((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day); else next.add(day);
      return next;
    });
  };
  const applyCopy = () => {
    if (!copyFrom) return;
    const src = schedule[copyFrom];
    if (!src) return;
    setSchedule((prev) => {
      const next = { ...prev };
      for (const d of copyTargets) next[d] = { start: src.start, end: src.end };
      return next;
    });
    setCopyFrom(null);
    setCopyTargets(new Set());
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await Promise.all([
        usersApi.updateBusinessHours({ timezone: bhTz, schedule: schedule as any }),
        usersApi.updateQuietHours({ enabled: true, start: qhStart, end: qhEnd, timezone: qhTz }),
      ]);
      setSavedAt(Date.now());
      window.setTimeout(() => setSavedAt(null), 2000);
    } finally {
      setSaving(false);
    }
  };

  const otherDays = useMemo(
    () => (copyFrom ? ALL_DAYS.filter((d) => d !== copyFrom) : []),
    [copyFrom],
  );

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
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Clock size={14} className="text-slate-500" />
            <h4 className="text-sm font-bold text-slate-800">Business Hours</h4>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">Time Zone</span>
            <select
              value={bhTz}
              onChange={(e) => setBhTz(e.target.value)}
              disabled={loading}
              className="px-2 py-1.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 disabled:bg-slate-50"
            >
              {TZ_OPTIONS.map((tz) => (
                <option key={tz} value={tz}>{tz.replace('_', ' ')}</option>
              ))}
            </select>
          </div>
        </div>
        <p className="text-xs text-slate-500">
          Set hours per day. Used by Instant Call, Instant Text (first message), and AI Conversation when set to "Outside of business hours".
        </p>

        <div className="space-y-2">
          {ALL_DAYS.map((day) => {
            const ds = schedule[day];
            const open = !!ds;
            return (
              <div key={day} className="flex items-center gap-3 py-1">
                <label className="inline-flex items-center gap-2 cursor-pointer min-w-[110px]">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={open}
                    onChange={() => toggleDay(day)}
                    disabled={loading}
                  />
                  <span className="w-8 h-4 bg-slate-200 rounded-full peer peer-checked:bg-blue-600 relative transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:w-3 after:h-3 after:rounded-full after:transition-transform peer-checked:after:translate-x-4" />
                  <span className="text-sm font-semibold text-slate-700 w-16">{DAY_LABEL[day]}</span>
                </label>

                {open ? (
                  <>
                    <input
                      type="time"
                      value={ds.start}
                      onChange={(e) => setDayStart(day, e.target.value)}
                      disabled={loading}
                      className="px-2 py-1.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 disabled:bg-slate-50 w-28"
                    />
                    <span className="text-slate-400">–</span>
                    <input
                      type="time"
                      value={ds.end}
                      onChange={(e) => setDayEnd(day, e.target.value)}
                      disabled={loading}
                      className="px-2 py-1.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 disabled:bg-slate-50 w-28"
                    />
                    <button
                      type="button"
                      onClick={() => openCopyPicker(day)}
                      disabled={loading}
                      title={`Copy ${DAY_LABEL[day]}'s hours to other days`}
                      className="ml-2 p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors"
                    >
                      <Copy size={14} />
                    </button>
                  </>
                ) : (
                  <span className="text-xs text-slate-400 italic">Closed</span>
                )}
              </div>
            );
          })}
        </div>

        {copyFrom && schedule[copyFrom] && (
          <div className="bg-blue-50/60 border border-blue-100 rounded-xl p-3 space-y-2">
            <p className="text-xs font-semibold text-blue-900">
              Copy {DAY_LABEL[copyFrom]} ({schedule[copyFrom]!.start}–{schedule[copyFrom]!.end}) to:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {otherDays.map((d) => {
                const on = copyTargets.has(d);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleCopyTarget(d)}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-full border transition-colors ${
                      on ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'
                    }`}
                  >
                    {DAY_SHORT[d]}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={applyCopy}
                disabled={copyTargets.size === 0}
                className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                Apply
              </button>
              <button
                type="button"
                onClick={() => { setCopyFrom(null); setCopyTargets(new Set()); }}
                className="px-3 py-1.5 bg-white text-slate-600 border border-slate-200 rounded-lg text-xs font-semibold hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
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
