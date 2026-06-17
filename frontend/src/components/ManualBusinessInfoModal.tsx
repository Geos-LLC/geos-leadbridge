import { useEffect, useState } from 'react';
import { X, Loader2, RefreshCw, ClipboardPaste, Link as LinkIcon } from 'lucide-react';
import { usersApi } from '../services/api';
import { notify } from '../store/notificationStore';

interface ManualBusinessInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Optional context — the URL the tenant tried that didn't yield data.
   *  Surfaced in the modal header so they don't lose the thread. */
  failedUrl?: string | null;
  /** Fires after a successful seed (either URL retry or text paste) so
   *  the caller can refresh the cached user + close the modal. */
  onSuccess: (info: { fieldsApplied: number; platform?: string }) => void;
}

/**
 * Fallback affordance when the URL scrape on Settings → General either
 * fails outright (Cloudflare 403, unreachable host) or scrapes
 * successfully but extracts no usable fields (BookingKoala SPA shell,
 * meta-less generic site).
 *
 * Two paths inside one modal:
 *   1. "Try a Thumbtack profile URL" — small URL input. TT pages render
 *      server-side so they actually scrape; this is the smoothest fix
 *      for tenants whose primary listing is on TT anyway.
 *   2. "Paste business info manually" — textarea. Goes to the new
 *      seedBusinessInfoFromText endpoint, which GPT-4o-mini-extracts
 *      the same playbookSeed shape and applies it to Custom Instructions.
 *
 * Each path has its own submit button; we don't try to auto-detect which
 * the tenant filled, because they might fill both and we'd guess wrong.
 */
export function ManualBusinessInfoModal({
  isOpen, onClose, failedUrl, onSuccess,
}: ManualBusinessInfoModalProps) {
  const [ttUrl, setTtUrl] = useState('');
  const [pasted, setPasted] = useState('');
  const [submitting, setSubmitting] = useState<'tt' | 'text' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setTtUrl('');
      setPasted('');
      setSubmitting(null);
      setError(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleTryThumbtack = async () => {
    const url = ttUrl.trim();
    if (!url) {
      setError('Paste a Thumbtack profile URL first.');
      return;
    }
    if (!/thumbtack\.com\//i.test(url)) {
      setError('That doesn\'t look like a Thumbtack URL. Look for one that starts with thumbtack.com/.');
      return;
    }
    setError(null);
    setSubmitting('tt');
    try {
      const res = await usersApi.applyBusinessProfileUrl(url);
      if (!res.success) {
        setError(res.warning || 'Couldn\'t pull from that Thumbtack URL.');
        return;
      }
      if (res.fieldsApplied > 0) {
        notify.success('Pulled from Thumbtack', `Filled ${res.fieldsApplied} field${res.fieldsApplied === 1 ? '' : 's'}. Review in Settings → AI Playbook.`, 4500);
      } else {
        notify.success('Thumbtack link saved', 'No new fields to add — everything looked up-to-date.', 3500);
      }
      onSuccess({ fieldsApplied: res.fieldsApplied, platform: res.platform });
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Failed to apply.');
    } finally {
      setSubmitting(null);
    }
  };

  const handlePasteSubmit = async () => {
    const text = pasted.trim();
    if (text.length < 30) {
      setError('Paste at least a sentence or two of business info.');
      return;
    }
    setError(null);
    setSubmitting('text');
    try {
      const res = await usersApi.seedBusinessInfoFromText(text);
      if (!res.success) {
        setError(res.warning || 'Couldn\'t extract anything structured from that text.');
        return;
      }
      if (res.fieldsApplied > 0) {
        notify.success('Saved from your text', `Filled ${res.fieldsApplied} field${res.fieldsApplied === 1 ? '' : 's'}. Review in Settings → AI Playbook.`, 4500);
      } else {
        notify.success('Saved', 'No new fields to add — everything looked up-to-date.', 3500);
      }
      onSuccess({ fieldsApplied: res.fieldsApplied });
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Failed to apply.');
    } finally {
      setSubmitting(null);
    }
  };

  const busy = submitting !== null;

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-3xl p-7 max-w-xl w-full shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-5">
          <div>
            <h2 className="text-lg font-bold text-slate-900 mb-1">Add business info another way</h2>
            <p className="text-sm text-slate-600 leading-snug">
              {failedUrl
                ? <>We couldn't pull useful info from <span className="font-medium text-slate-700 break-all">{failedUrl}</span>. Try one of these instead.</>
                : 'Try a Thumbtack profile URL or paste your business info directly.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-100 rounded-xl text-sm text-red-700 flex items-start gap-2">
            <span>⚠</span><span>{error}</span>
          </div>
        )}

        {/* Path 1 — TT URL */}
        <div className="mb-5 p-4 bg-slate-50 rounded-2xl border border-slate-100">
          <div className="flex items-center gap-2 mb-2 text-sm font-semibold text-slate-900">
            <LinkIcon size={14} className="text-blue-600" /> Try a Thumbtack profile URL
          </div>
          <p className="text-xs text-slate-600 mb-3">
            Thumbtack profile pages scrape reliably. Paste the public URL of your TT business listing.
          </p>
          <div className="flex gap-2">
            <input
              type="url"
              value={ttUrl}
              onChange={(e) => { setTtUrl(e.target.value); setError(null); }}
              placeholder="https://www.thumbtack.com/..."
              disabled={busy}
              className="flex-1 px-3 py-2 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400 text-sm disabled:opacity-50"
              onKeyDown={(e) => { if (e.key === 'Enter') handleTryThumbtack(); }}
            />
            <button
              type="button"
              onClick={handleTryThumbtack}
              disabled={busy || !ttUrl.trim()}
              className="px-4 py-2 bg-blue-600 text-white rounded-xl font-semibold text-sm hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {submitting === 'tt' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Pull
            </button>
          </div>
        </div>

        {/* Path 2 — paste text */}
        <div className="mb-1 p-4 bg-slate-50 rounded-2xl border border-slate-100">
          <div className="flex items-center gap-2 mb-2 text-sm font-semibold text-slate-900">
            <ClipboardPaste size={14} className="text-emerald-600" /> Or paste business info manually
          </div>
          <p className="text-xs text-slate-600 mb-3">
            Copy text from your own website, a Google listing, a brochure — anything. We'll extract services,
            pricing, hours, and other facts using AI.
          </p>
          <textarea
            value={pasted}
            onChange={(e) => { setPasted(e.target.value); setError(null); }}
            placeholder={`Example:

We offer standard cleaning, deep cleaning, and move-in/move-out service across San Diego. Eco-friendly products, fully insured. Starting at $129. 15% off for recurring weekly clients. Hours: Mon-Fri 8am-6pm. Call (555) 123-4567.`}
            disabled={busy}
            rows={8}
            className="w-full px-3 py-2 rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-200 focus:border-emerald-400 text-sm font-mono resize-y min-h-[140px] disabled:opacity-50"
          />
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-slate-500">{pasted.trim().length} characters</span>
            <button
              type="button"
              onClick={handlePasteSubmit}
              disabled={busy || pasted.trim().length < 30}
              className="px-4 py-2 bg-emerald-600 text-white rounded-xl font-semibold text-sm hover:bg-emerald-700 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {submitting === 'text' ? <Loader2 size={14} className="animate-spin" /> : <ClipboardPaste size={14} />}
              Extract & save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
