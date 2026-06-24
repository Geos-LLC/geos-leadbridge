import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Info, Loader2, Moon } from 'lucide-react';
import { usersApi } from '../services/api';
import { notify } from '../store/notificationStore';

/**
 * Quiet Hours editor — matches the BusinessHoursEditor chrome exactly:
 * collapsible card with a 38×38 purple Moon icon tile + title + summary
 * subtitle + chevron, header-right master toggle, and a single inline
 * time-range row (start–end) when expanded. 600ms debounced auto-save
 * through `usersApi.updateQuietHours` keeps it consistent with the
 * canonical no-Save-button pattern.
 *
 * Used by Settings → Hours alongside BusinessHoursEditor so both rows
 * share the same visual rhythm.
 */
interface Props {
  /** Start expanded. Defaults to false. */
  defaultOpen?: boolean;
}

const DEFAULT_QUIET = { start: '22:00', end: '08:00' };

export default function QuietHoursEditor({ defaultOpen = false }: Props) {
  const [enabled, setEnabled] = useState(true);
  const [start, setStart] = useState(DEFAULT_QUIET.start);
  const [end, setEnd] = useState(DEFAULT_QUIET.end);
  const [open, setOpen] = useState(defaultOpen);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Hydrate.
  useEffect(() => {
    let alive = true;
    usersApi.getQuietHours()
      .then(qh => {
        if (!alive) return;
        setEnabled(!!qh.enabled);
        if (qh.start) setStart(to24(qh.start));
        if (qh.end) setEnd(to24(qh.end));
        setDirty(false);
      })
      .catch(() => { /* keep defaults */ });
    return () => { alive = false; };
  }, []);

  // Debounced auto-save.
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(async () => {
      try {
        setSaving(true);
        await usersApi.updateQuietHours({ enabled, start, end });
        setDirty(false);
      } catch (err: any) {
        notify.error('Could not save quiet hours', err?.response?.data?.message || 'Please try again.');
      } finally {
        setSaving(false);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [dirty, enabled, start, end]);

  const setEnabledDirty = (v: boolean) => { setEnabled(v); setDirty(true); };
  const setStartDirty = (v: string) => { setStart(v); setDirty(true); };
  const setEndDirty = (v: string) => { setEnd(v); setDirty(true); };

  const summary = useMemo(() => {
    if (!enabled) return 'Off · AI can text overnight';
    return `${fmt12(start)} – ${fmt12(end)} · No customer messages overnight`;
  }, [enabled, start, end]);

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
          background: '#ede9fe', color: '#7c3aed',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Moon size={18} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{
            display: 'block', fontSize: 15, fontWeight: 700,
            color: 'var(--lb-ink-1)', letterSpacing: '-0.01em',
          }}>
            Quiet hours
          </span>
          <span style={{
            display: 'block', fontSize: 12, color: 'var(--lb-ink-5)',
            marginTop: 2, lineHeight: 1.4,
          }}>
            {summary}
          </span>
        </span>
        {/* Master toggle on the header — stops the click from also
            toggling the chevron. */}
        <span
          onClick={(e) => { e.stopPropagation(); setEnabledDirty(!enabled); }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEnabledDirty(!enabled); }
          }}
          aria-pressed={enabled}
          style={{
            width: 38, height: 22, borderRadius: 999,
            background: enabled ? 'var(--lb-accent)' : 'var(--lb-ink-8)',
            position: 'relative', flexShrink: 0, marginRight: 6,
            cursor: 'pointer',
            transition: 'background 120ms',
          }}
        >
          <span style={{
            position: 'absolute', top: 2, left: enabled ? 18 : 2,
            width: 18, height: 18, borderRadius: 99,
            background: '#fff',
            boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
            transition: 'left 120ms',
          }} />
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
        <div style={{ padding: '6px 18px 16px', borderTop: '1px solid var(--lb-line-soft)' }}>
          {/* Single quiet-window row, mirroring the per-day rows on the
              Business Hours editor: day label, time inputs, no toggle
              (master toggle lives on the card header). */}
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '11px 0',
            }}
          >
            <span style={{
              width: 38, flexShrink: 0,
              fontSize: 12.5, fontWeight: 700,
              color: 'var(--lb-ink-2)',
              fontFamily: 'var(--lb-font-mono)',
            }}>
              ALL
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              {enabled ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <input
                    type="time"
                    value={start}
                    onChange={(e) => setStartDirty(e.target.value)}
                    style={timeInputStyle}
                  />
                  <span style={{ fontSize: 12, color: 'var(--lb-ink-6)', flexShrink: 0 }}>–</span>
                  <input
                    type="time"
                    value={end}
                    onChange={(e) => setEndDirty(e.target.value)}
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
                  Off
                </span>
              )}
            </span>
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            margin: '12px 0 0', padding: '11px 13px',
            background: '#f8fafc',
            border: '1px solid var(--lb-line-soft)',
            borderRadius: 10,
            fontSize: 12.5, color: 'var(--lb-ink-4)', lineHeight: 1.5,
          }}>
            <Info size={15} style={{ flexShrink: 0, color: 'var(--lb-ink-5)' }} />
            <div>
              Overnight, AI won't text or call customers — owner alerts still go through. Defaults to <strong style={{ color: 'var(--lb-ink-2)' }}>10:00 PM – 8:00 AM</strong>.
            </div>
          </div>
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

// 12h "10:00 PM" ⇄ 24h "22:00" helpers — accept either input form so
// callers don't have to normalise themselves.
function to24(t: string): string {
  if (/^\d{2}:\d{2}$/.test(t)) return t;
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(t.trim());
  if (!m) return t;
  let h = parseInt(m[1], 10);
  const mins = m[2];
  const isPm = m[3].toUpperCase() === 'PM';
  if (isPm && h !== 12) h += 12;
  if (!isPm && h === 12) h = 0;
  return `${h.toString().padStart(2, '0')}:${mins}`;
}
function fmt12(t: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return t;
  const h = parseInt(m[1], 10);
  const mins = m[2];
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${mins} ${ampm}`;
}
