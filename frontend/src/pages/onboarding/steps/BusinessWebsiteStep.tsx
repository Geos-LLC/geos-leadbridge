import { useState } from 'react';
import { Globe, Loader2 } from 'lucide-react';
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

// Business website step. Free-text input — we deliberately don't
// validate URL format here because users legitimately enter values
// like "myco.com", "https://myco.com", or longer prose. The real
// website parser (announced in PR copy) lives behind a feature flag
// and is not built yet; per the spec we ship the input now and add
// the confirmation-card UI later when the parser exists.
export default function BusinessWebsiteStep({ onSaveContinue, onNoWebsite, saving, setSaving }: Props) {
  const user = useAuthStore(s => s.user);
  const setAuth = useAuthStore(s => s.setAuth);
  const meta = getStepMeta('business');

  const [value, setValue] = useState<string>(user?.website ?? '');

  async function persistAndContinue(websiteValue: string | null) {
    if (saving) return;
    try {
      setSaving(true);
      const { user: updated } = await usersApi.updateProfile({ website: websiteValue });
      // Merge the updated field into the persisted auth user so the
      // step shows the saved value if the user navigates back to it.
      if (user) {
        const token = localStorage.getItem('token') || '';
        setAuth({ ...user, website: updated.website ?? null }, token);
      }
      if (websiteValue == null || websiteValue.trim().length === 0) {
        await onNoWebsite();
      } else {
        await onSaveContinue();
      }
    } catch (err: any) {
      notify.error('Could not save', err.response?.data?.message || 'Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && !saving;

  return (
    <div className="pt-2">
      <h1 className="text-2xl md:text-3xl font-extrabold text-slate-900 tracking-tight mb-2">
        {meta.title}
      </h1>
      <p className="text-base text-slate-500 leading-relaxed mb-8 max-w-xl">
        {meta.description}
      </p>

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
            onChange={e => setValue(e.target.value)}
            disabled={saving}
            className="w-full pl-12 pr-4 py-3.5 rounded-2xl border-2 border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all disabled:opacity-60"
            onKeyDown={e => {
              if (e.key === 'Enter' && canSave) {
                e.preventDefault();
                void persistAndContinue(trimmed);
              }
            }}
          />
        </div>
      </label>

      <div className="mt-6 flex flex-col sm:flex-row gap-3">
        <button
          type="button"
          onClick={() => void persistAndContinue(trimmed)}
          disabled={!canSave}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-md shadow-blue-200 transition-all"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {saving ? 'Saving…' : 'Save & Continue'}
        </button>
        <button
          type="button"
          onClick={() => void persistAndContinue(null)}
          disabled={saving}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl transition-all"
        >
          I don't have a website
        </button>
      </div>
    </div>
  );
}
