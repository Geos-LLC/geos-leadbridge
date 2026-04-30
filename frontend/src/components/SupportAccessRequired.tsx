import { useState } from 'react';
import { ShieldCheck, X, Loader2 } from 'lucide-react';
import { supportGrantsApi } from '../services/api';
import { notify } from '../store/notificationStore';

type Props = {
  scope: string;
  tenantId?: string;
  sectionLabel: string;
  onGranted: () => void;
};

const DURATION_OPTIONS = [
  { label: '15 minutes', value: 15 },
  { label: '1 hour', value: 60 },
  { label: '4 hours', value: 240 },
  { label: '24 hours', value: 1440 },
];

export function SupportAccessRequired({ scope, tenantId, sectionLabel, onGranted }: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState(60);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    const trimmed = reason.trim();
    if (!trimmed) {
      notify.error('Reason required', 'Provide a reason for the access grant.');
      return;
    }
    try {
      setSubmitting(true);
      await supportGrantsApi.createSelf({
        tenantId: tenantId ?? '__platform__',
        scopes: [scope],
        reason: trimmed,
        durationMinutes: duration,
      });
      notify.success('Access granted', `Support grant issued for ${scope} (${duration} min).`);
      setOpen(false);
      setReason('');
      onGranted();
    } catch (err: any) {
      const raw = err?.response?.data?.message;
      const msg = Array.isArray(raw) ? raw.join('; ') : (raw || 'Failed to issue grant');
      notify.error('Error', msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="border border-amber-200 bg-amber-50 rounded-2xl p-6 md:p-8 flex flex-col items-center text-center">
        <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center mb-3">
          <ShieldCheck size={22} />
        </div>
        <h3 className="text-base md:text-lg font-bold text-amber-900">Support access required</h3>
        <p className="text-sm text-amber-800 mt-1 max-w-md">
          Viewing {sectionLabel} requires an active SupportGrant for the{' '}
          <code className="font-mono text-xs bg-amber-100 px-1.5 py-0.5 rounded">{scope}</code>{' '}
          scope. Issuing a grant is audit-logged.
        </p>
        <button
          onClick={() => setOpen(true)}
          className="mt-4 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-xl text-sm transition-colors"
        >
          Request access
        </button>
      </div>

      {open && (
        <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Request support grant</h3>
                <p className="text-xs text-slate-500 mt-1">
                  Scope: <span className="font-mono">{scope}</span>
                  {tenantId && tenantId !== '__platform__' ? (
                    <> · Tenant: <span className="font-mono">{tenantId}</span></>
                  ) : (
                    <> · Platform-wide</>
                  )}
                </p>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="text-slate-400 hover:text-slate-600"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>

            <label className="block text-sm font-semibold text-slate-700 mb-1">Reason</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this access needed? (audit-logged)"
              rows={3}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
            />

            <label className="block text-sm font-semibold text-slate-700 mb-1 mt-4">Duration</label>
            <select
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
            >
              {DURATION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>

            <div className="flex gap-2 mt-6">
              <button
                onClick={() => setOpen(false)}
                disabled={submitting}
                className="flex-1 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-xl text-sm disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting || !reason.trim()}
                className="flex-1 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-xl text-sm disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {submitting && <Loader2 size={14} className="animate-spin" />}
                Issue grant
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
