import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Globe, Loader2, Phone } from 'lucide-react';
import { usersApi } from '../../../services/api';
import { useAuthStore } from '../../../store/authStore';
import { notify } from '../../../store/notificationStore';
import { getStepMeta } from '../wizardConfig';

interface Props {
  // Both callbacks ultimately funnel through the WizardShell action
  // bar — onSaveContinue marks the step as "done", onNoWebsite as
  // "skipped". The container handles the actual wizard advance.
  onSaveContinue: () => Promise<void> | void;
  onNoWebsite: () => Promise<void> | void;
  saving: boolean;
  setSaving: (v: boolean) => void;
}

interface VerifyOutcome {
  reachable: boolean;
  normalizedUrl: string;
  metadata?: { title?: string; description?: string; phone?: string };
  errorCode?: 'invalid_url' | 'private_host' | 'dns_not_found' | 'connection_refused' | 'timeout' | 'http_error' | 'unreachable';
  errorMessage?: string;
}

// Business website step. Now runs the URL through the backend's
// verifyWebsite endpoint before accepting it:
//   - Empty input + "I don't have a website" → skipped path (no check)
//   - Non-empty + reachable → show "We found your site" briefly, save
//     URL + metadata, advance
//   - Non-empty + unreachable → inline error with the specific reason,
//     user can edit and retry, or pick "I don't have a website"
// The parsed metadata (title / description / phone) is persisted on
// User.websiteMetadataJson so later wizard steps can pre-fill answers.
export default function BusinessWebsiteStep({ onSaveContinue, onNoWebsite, saving, setSaving }: Props) {
  const user = useAuthStore(s => s.user);
  const setAuth = useAuthStore(s => s.setAuth);
  const meta = getStepMeta('business');

  const [value, setValue] = useState<string>(user?.website ?? '');
  // Business phone — same field we capture at registration. Kept on
  // User.businessPhone (single source of truth) and surfaced here so
  // the user can confirm / edit it during onboarding rather than
  // hunting through Settings.
  const [phone, setPhone] = useState<string>(user?.businessPhone ?? '');
  const [verifyState, setVerifyState] = useState<
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'invalid'; outcome: VerifyOutcome }
    | { kind: 'valid'; outcome: VerifyOutcome }
  >({ kind: 'idle' });

  async function verifyAndContinue() {
    if (saving) return;
    const url = value.trim();
    if (url.length === 0) return;
    setSaving(true);
    setVerifyState({ kind: 'checking' });
    try {
      const outcome = await usersApi.verifyWebsite(url);
      if (!outcome.reachable) {
        setVerifyState({ kind: 'invalid', outcome });
        return;
      }
      // Persist normalized URL + parsed metadata + (optionally) the
      // phone the user typed. The backend's updateProfile normalizes
      // the phone to E.164 itself; we just hand it the trimmed value.
      const trimmedPhone = phone.trim();
      const { user: updated } = await usersApi.updateProfile({
        website: outcome.normalizedUrl,
        websiteMetadata: outcome.metadata ?? null,
        ...(trimmedPhone.length > 0 ? { businessPhone: trimmedPhone } : {}),
      });
      if (user) {
        const token = localStorage.getItem('token') || '';
        setAuth(
          {
            ...user,
            website: updated.website ?? null,
            websiteMetadataJson: updated.websiteMetadataJson ?? null,
            businessPhone: updated.businessPhone ?? user.businessPhone ?? null,
          },
          token,
        );
      }
      setVerifyState({ kind: 'valid', outcome });
      await onSaveContinue();
    } catch (err: any) {
      notify.error('Could not save', err.response?.data?.message || 'Please try again.');
      setVerifyState({ kind: 'idle' });
    } finally {
      setSaving(false);
    }
  }

  async function skipNoWebsite() {
    if (saving) return;
    setSaving(true);
    try {
      // Clear any previously-saved URL so it can't haunt later steps.
      const { user: updated } = await usersApi.updateProfile({
        website: null,
        websiteMetadata: null,
      });
      if (user) {
        const token = localStorage.getItem('token') || '';
        setAuth(
          {
            ...user,
            website: updated.website ?? null,
            websiteMetadataJson: updated.websiteMetadataJson ?? null,
          },
          token,
        );
      }
      await onNoWebsite();
    } catch (err: any) {
      notify.error('Could not save', err.response?.data?.message || 'Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const trimmed = value.trim();
  const isChecking = verifyState.kind === 'checking' || saving;
  const canSave = trimmed.length > 0 && !isChecking;

  return (
    <div className="pt-2">
      <h1 className="text-2xl md:text-3xl font-extrabold text-slate-900 tracking-tight mb-2">
        {meta.title}
      </h1>
      <p className="text-base text-slate-500 leading-relaxed mb-8 max-w-xl">
        {meta.description}
      </p>

      <div className="space-y-4">
        <label className="block">
          <span className="block text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-2">
            Website URL
          </span>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
              <Globe className="w-5 h-5" />
            </span>
            <input
              type="text"
              inputMode="url"
              autoComplete="url"
              placeholder="myco.com or https://myco.com"
              value={value}
              onChange={e => {
                setValue(e.target.value);
                // Any edit clears the previous result so the user sees a
                // fresh state on the next submit attempt.
                if (verifyState.kind !== 'idle' && verifyState.kind !== 'checking') {
                  setVerifyState({ kind: 'idle' });
                }
              }}
              disabled={isChecking}
              className="w-full pl-12 pr-4 py-3.5 rounded-2xl border-2 border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all disabled:opacity-60"
              onKeyDown={e => {
                if (e.key === 'Enter' && canSave) {
                  e.preventDefault();
                  void verifyAndContinue();
                }
              }}
            />
          </div>
        </label>

        <label className="block">
          <span className="block text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-2">
            Business phone <span className="text-slate-300 font-medium">(optional)</span>
          </span>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
              <Phone className="w-5 h-5" />
            </span>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="(555) 123-4567"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              disabled={isChecking}
              className="w-full pl-12 pr-4 py-3.5 rounded-2xl border-2 border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all disabled:opacity-60"
            />
          </div>
          <p className="mt-1.5 text-xs text-slate-400">
            Notifications and customer replies will be forwarded here.
          </p>
        </label>
      </div>

      {/* Verify result panel — replaces the inline help text once the
          user has submitted at least once. */}
      {verifyState.kind === 'invalid' && (
        <div
          className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 flex items-start gap-3"
          role="alert"
        >
          <AlertTriangle className="w-5 h-5 text-rose-500 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-rose-900">
              {verifyState.outcome.errorMessage || "We couldn't load that site."}
            </div>
            <div className="text-xs text-rose-700 mt-0.5">
              Double-check the URL, or use <span className="font-semibold">I don't have a website</span> below.
            </div>
          </div>
        </div>
      )}

      {verifyState.kind === 'valid' && verifyState.outcome.metadata?.title && (
        <div
          className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 flex items-start gap-3"
        >
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-emerald-900 truncate">
              Found: {verifyState.outcome.metadata.title}
            </div>
            {verifyState.outcome.metadata.description && (
              <div className="text-xs text-emerald-800 mt-0.5 line-clamp-2">
                {verifyState.outcome.metadata.description}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mt-6 flex flex-col sm:flex-row gap-3">
        <button
          type="button"
          onClick={() => void verifyAndContinue()}
          disabled={!canSave}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-md shadow-blue-200 transition-all"
        >
          {isChecking ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {verifyState.kind === 'checking' ? 'Checking your site…' : (saving ? 'Saving…' : 'Save & Continue')}
        </button>
        <button
          type="button"
          onClick={() => void skipNoWebsite()}
          disabled={isChecking}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl transition-all"
        >
          I don't have a website
        </button>
      </div>
    </div>
  );
}
