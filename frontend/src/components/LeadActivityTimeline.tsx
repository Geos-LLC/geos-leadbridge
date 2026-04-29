/**
 * Lead Activity Timeline.
 *
 * Renders the chronological list of status transitions for a lead. Reads
 * GET /v1/leads/:id/activity. Empty state is "No activity yet."
 */

import { useEffect, useState } from 'react';
import { Clock, AlertCircle, Loader2 } from 'lucide-react';
import { leadsApi, type LeadActivityEntry } from '../services/api';
import { displayLabel } from '../lib/leadStatus';

interface LeadActivityTimelineProps {
  leadId: string | null | undefined;
  /** Optional cap. Server hard-caps at 200. */
  limit?: number;
  /** Optional refresh trigger; bumping this number re-fetches. */
  refreshKey?: number;
}

const SOURCE_LABEL: Record<string, string> = {
  service_flow: 'Service Flow',
  platform_sync: 'Platform sync',
  manual: 'Manual',
  lb_automation: 'Auto',
};

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Mar 12, 2:34 PM
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function LeadActivityTimeline({ leadId, limit, refreshKey }: LeadActivityTimelineProps) {
  const [rows, setRows] = useState<LeadActivityEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!leadId) {
      setRows(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    leadsApi
      .getActivity(leadId, limit)
      .then((res) => {
        if (cancelled) return;
        if (!res.success) {
          setError(res.error || 'Could not load activity');
          setRows([]);
          return;
        }
        setRows(res.activity);
      })
      .catch((err: any) => {
        if (cancelled) return;
        setError(err?.message || 'Could not load activity');
        setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [leadId, limit, refreshKey]);

  if (!leadId) return null;

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 flex items-center gap-2">
        <Clock size={14} /> Lead Activity
      </h3>

      {loading && rows === null && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {rows && rows.length === 0 && !error && (
        <div className="text-xs text-slate-400 italic">No activity yet.</div>
      )}

      {rows && rows.length > 0 && (
        <ol className="space-y-2 border-l border-slate-200 pl-4">
          {rows.map((row) => (
            <li key={row.id} className="relative">
              <span
                className="absolute -left-[18px] top-[6px] block w-2 h-2 rounded-full bg-slate-300"
                style={{ borderRadius: 99 }}
                aria-hidden
              />
              <div className="text-[11px] text-slate-400 font-mono">
                {formatTimestamp(row.occurredAt || row.createdAt)}
              </div>
              <div className="text-sm text-slate-700 leading-snug">
                <span className="text-slate-400">Status</span>{' '}
                <span className="font-medium text-slate-500">
                  {row.fromStatus ? displayLabel(row.fromStatus) : '—'}
                </span>{' '}
                <span className="text-slate-400">→</span>{' '}
                <span className="font-semibold text-slate-800">
                  {displayLabel(row.toStatus)}
                </span>
              </div>
              <div className="text-[11px] text-slate-400">
                {SOURCE_LABEL[row.source] ?? row.source}
                {row.reason ? ` · ${row.reason.replace(/_/g, ' ')}` : ''}
                {row.actorName ? ` · ${row.actorName}` : ''}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
