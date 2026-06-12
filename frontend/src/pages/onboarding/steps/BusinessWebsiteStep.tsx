import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Globe, Loader2, Phone, Sparkles } from 'lucide-react';
import { notificationsApi, usersApi } from '../../../services/api';
import { useAppStore } from '../../../store/appStore';
import { useAuthStore } from '../../../store/authStore';
import { notify } from '../../../store/notificationStore';
import type { TenantPhoneNumber } from '../../../services/api';
import { getStepMeta } from '../wizardConfig';
import { WebsitePreviewCard } from '../../../components/WebsitePreviewCard';

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
  metadata?: { title?: string; description?: string; phone?: string; imageUrl?: string; summary?: string };
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
  const [verifyState, setVerifyState] = useState<
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'applying' }
    | { kind: 'invalid'; outcome: VerifyOutcome }
    | { kind: 'valid'; outcome: VerifyOutcome }
  >({ kind: 'idle' });

  // LeadBridge phone — the dedicated number purchased from Twilio via
  // Sigcore that LeadBridge uses to text/call customers on the user's
  // behalf. Stored on TenantPhoneNumber, NOT User.businessPhone.
  // (User.businessPhone is the agent's own phone where alerts forward
  //  TO; the tenant phone is what alerts/messages get sent FROM.)
  const savedAccounts = useAppStore(s => s.savedAccounts);
  const [tenantPhones, setTenantPhones] = useState<TenantPhoneNumber[]>([]);
  const [phonesLoading, setPhonesLoading] = useState(true);
  const [areaCode, setAreaCode] = useState('');
  const [city, setCity] = useState('');
  const [phoneSkipped, setPhoneSkipped] = useState(false);
  const [available, setAvailable] = useState<{ phoneNumber: string; locality?: string; region?: string }[]>([]);
  const [searchingPhone, setSearchingPhone] = useState(false);
  const [purchasingPhone, setPurchasingPhone] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    notificationsApi.listTenantPhones()
      .then(res => {
        if (cancelled) return;
        const active = (res.data || []).filter(p => p.status === 'ACTIVE' || p.status === 'GRACE_PERIOD');
        setTenantPhones(active);
      })
      .catch(() => { /* non-fatal — assume no phones and let user provision */ })
      .finally(() => { if (!cancelled) setPhonesLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function searchPhones() {
    // Need at least one SavedAccount to attach the phone to. If the
    // user got to this step without connecting an account, gently
    // explain — they can still save the website + come back to phone
    // setup in Settings.
    if (savedAccounts.length === 0) {
      setPhoneError('Connect an account in the previous step first — phone numbers attach to a specific account.');
      return;
    }
    setSearchingPhone(true);
    setPhoneError(null);
    setPhoneSkipped(false);
    try {
      const res = await notificationsApi.searchAvailableNumbers(
        savedAccounts[0].id,
        'US',
        areaCode.trim() || undefined,
        city.trim() || undefined,
      );
      setAvailable(res.success ? res.data : []);
      if (res.success && res.data.length === 0) {
        setPhoneError('No numbers available for that area. Try a different area code or city.');
      }
    } catch (err: any) {
      setPhoneError(err.response?.data?.message || 'Could not search numbers.');
    } finally {
      setSearchingPhone(false);
    }
  }

  async function buyPhone(phoneNumber: string) {
    if (savedAccounts.length === 0) return;
    setPurchasingPhone(phoneNumber);
    setPhoneError(null);
    try {
      const res = await notificationsApi.purchaseTenantPhone(savedAccounts[0].id, phoneNumber);
      if (res.success && res.tenantPhone) {
        setTenantPhones(prev => [...prev, res.tenantPhone!]);
        setAvailable([]);
        setAreaCode('');
      } else {
        setPhoneError(res.error || 'Could not provision number.');
      }
    } catch (err: any) {
      setPhoneError(err.response?.data?.message || 'Could not provision number.');
    } finally {
      setPurchasingPhone(null);
    }
  }

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
      // Persist normalized URL + parsed metadata.
      const { user: updated } = await usersApi.updateProfile({
        website: outcome.normalizedUrl,
        websiteMetadata: outcome.metadata ?? null,
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

      // Auto-apply to AI Playbook + FAQ inside the wizard. Both are
      // best-effort: the data is already saved on the user, so a failure
      // here doesn't block the wizard. The two applies are independent —
      // either succeeding is useful — so we run them in parallel and
      // report a combined toast.
      if (outcome.metadata?.playbookSeed) {
        setVerifyState({ kind: 'applying' });
        const [playbookRes, faqRes] = await Promise.all([
          usersApi.applyPlaybookSeed('fill_empty').catch((e: any) => {
            console.warn('[BusinessWebsiteStep] playbook apply failed:', e?.message || e);
            return null;
          }),
          usersApi.applyFaqFromWebsiteSeed().catch((e: any) => {
            console.warn('[BusinessWebsiteStep] faq apply failed:', e?.message || e);
            return null;
          }),
        ]);
        const playbookFilled = playbookRes?.success ? playbookRes.filled : 0;
        const faqFilled = faqRes?.success ? faqRes.filled : 0;
        if (playbookFilled > 0 || faqFilled > 0) {
          const parts: string[] = [];
          if (playbookFilled > 0) parts.push(`${playbookFilled} AI Playbook section${playbookFilled === 1 ? '' : 's'}`);
          if (faqFilled > 0) parts.push(`${faqFilled} FAQ field${faqFilled === 1 ? '' : 's'}`);
          notify.success(
            'Applied from your website',
            `Filled ${parts.join(' and ')}. Review on the next step or in Settings → AI Playbook.`,
            5000,
          );
        }
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
  const isApplying = verifyState.kind === 'applying';
  const isBusy = isChecking || isApplying;
  const canSave = trimmed.length > 0 && !isBusy;
  // Persistent "verified" indicator: the URL in the input matches
  // what we saved AND we have metadata (which only gets written if
  // the verify endpoint actually loaded the site). Survives wizard
  // navigation so revisiting the step doesn't make the user re-prove.
  const savedMetadata = user?.websiteMetadataJson ?? null;
  const savedAndVerified =
    !!user?.website &&
    !!savedMetadata &&
    user.website.trim() === trimmed &&
    trimmed.length > 0;

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
          <span className="flex items-center justify-between text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-2">
            <span>Website URL</span>
            {/* Persistent "verified" badge when the user's saved
                website matches the value in the input AND we have
                metadata (proves the site actually loaded for us at
                some point). Survives navigation back to the step. */}
            {savedAndVerified && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold normal-case tracking-normal">
                <CheckCircle2 className="w-3 h-3" />
                Verified
              </span>
            )}
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
              className={`w-full pl-12 pr-4 py-3.5 rounded-2xl border-2 bg-white text-slate-900 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all disabled:opacity-60 ${
                savedAndVerified ? 'border-emerald-300' : 'border-slate-200'
              }`}
              onKeyDown={e => {
                if (e.key === 'Enter' && canSave) {
                  e.preventDefault();
                  void verifyAndContinue();
                }
              }}
            />
          </div>
          {/* Prominent inline spinner shown while we're talking to the
              backend. The verify endpoint can take 5-15 seconds (HTML
              fetch + Microlink screenshot + gpt-4o-mini summary) so a
              tiny button-label spinner doesn't communicate well — this
              card sets expectation that work is happening. */}
          {isBusy && (
            <div className="mt-3 flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <Loader2 className="w-5 h-5 text-slate-500 animate-spin shrink-0 mt-0.5" />
              <div className="text-sm">
                <div className="font-bold text-slate-900">
                  {isApplying ? 'Applying website info to your AI Playbook…' : 'Pulling info from your site…'}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {isApplying
                    ? 'Filling empty Playbook sections so your AI starts with real context.'
                    : 'We fetch the page, render a preview, and generate an AI summary. Takes a few seconds.'}
                </div>
              </div>
            </div>
          )}
          {/* If the user has a previously-verified site (came back to
              this step, or refreshed the page) show what we found so
              they have visible proof the URL really loaded. The Apply
              button is gone from this surface — auto-apply runs inline
              when Save & continue is clicked, so the user never has to
              think about it during the wizard. */}
          {savedAndVerified && savedMetadata && !isBusy && (
            <div className="mt-2">
              <WebsitePreviewCard url={user?.website || null} metadata={savedMetadata as any} tone="wizard" />
            </div>
          )}
        </label>

      </div>

      {/* LeadBridge phone number — the dedicated outbound number purchased
          from Twilio via Sigcore. Lives on TenantPhoneNumber, not on
          User.businessPhone. Surfaced here because it's the second
          essential piece of "what does AI use to contact customers"
          info — the website tells it WHAT to talk about, the number
          tells customers WHERE the text came from. */}
      <section className="mt-6 rounded-2xl border border-slate-100 bg-slate-50/50 p-5">
        <div className="flex items-center gap-2 mb-1">
          <Phone className="w-4 h-4 text-slate-500" />
          <h2 className="text-sm font-extrabold text-slate-900">LeadBridge phone number</h2>
        </div>
        <p className="text-xs text-slate-500 leading-relaxed mb-4">
          The phone number LeadBridge uses to text and call your customers.
          Assigned from Twilio. You can also assign or release numbers from Settings.
        </p>

        {phonesLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Checking…
          </div>
        ) : tenantPhones.length > 0 ? (
          <div className="space-y-2">
            {tenantPhones.map(p => (
              <div
                key={p.id}
                className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-emerald-200 bg-emerald-50/60"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                <span className="font-mono text-sm font-semibold text-emerald-900">{p.phoneNumber}</span>
                {p.friendlyName && p.friendlyName !== p.phoneNumber && (
                  <span className="text-xs text-emerald-700">— {p.friendlyName}</span>
                )}
                {p.status === 'GRACE_PERIOD' && (
                  <span className="ml-auto text-[10px] font-bold uppercase tracking-widest text-amber-600">
                    Releasing
                  </span>
                )}
              </div>
            ))}
            <p className="text-[11px] text-slate-400 mt-2">
              Manage assignment, area code, or release from Settings later.
            </p>
          </div>
        ) : phoneSkipped ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-white px-3 py-3 flex items-center justify-between gap-3">
            <div className="text-xs text-slate-500">
              Skipped — you can grab a number later from <span className="font-semibold text-slate-700">Settings → Phone numbers</span>.
            </div>
            <button
              type="button"
              onClick={() => setPhoneSkipped(false)}
              className="text-xs font-semibold text-blue-600 hover:text-blue-700"
            >
              Pick now
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <input
                type="text"
                inputMode="numeric"
                placeholder="Area code (e.g. 415)"
                value={areaCode}
                onChange={e => setAreaCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
                disabled={searchingPhone || purchasingPhone !== null}
                className="w-32 px-3 py-2.5 text-sm rounded-xl border-2 border-slate-200 bg-white focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 font-mono tracking-widest"
                onKeyDown={e => {
                  if (e.key === 'Enter' && !searchingPhone) {
                    e.preventDefault();
                    void searchPhones();
                  }
                }}
              />
              <input
                type="text"
                placeholder="City (e.g. San Francisco)"
                value={city}
                onChange={e => setCity(e.target.value)}
                disabled={searchingPhone || purchasingPhone !== null}
                className="flex-1 min-w-[160px] px-3 py-2.5 text-sm rounded-xl border-2 border-slate-200 bg-white focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                onKeyDown={e => {
                  if (e.key === 'Enter' && !searchingPhone) {
                    e.preventDefault();
                    void searchPhones();
                  }
                }}
              />
              <button
                type="button"
                onClick={() => void searchPhones()}
                disabled={searchingPhone || purchasingPhone !== null || savedAccounts.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-xl hover:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {searchingPhone ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {searchingPhone ? 'Searching…' : (available.length > 0 ? 'Search again' : 'Find numbers')}
              </button>
            </div>

            {phoneError && (
              <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">
                {phoneError}
              </div>
            )}

            {available.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto">
                {available.map(num => (
                  <button
                    key={num.phoneNumber}
                    type="button"
                    onClick={() => void buyPhone(num.phoneNumber)}
                    disabled={purchasingPhone !== null}
                    className="flex flex-col gap-0.5 px-3 py-2.5 rounded-xl border-2 border-slate-200 bg-white text-left hover:border-blue-300 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                  >
                    <div className="font-mono text-sm font-semibold text-slate-900 flex items-center gap-2">
                      {num.phoneNumber}
                      {purchasingPhone === num.phoneNumber && <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-600" />}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {[num.locality, num.region].filter(Boolean).join(', ') || 'US'}
                    </div>
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
              <p className="text-[11px] text-slate-400">
                Pick a number now, or skip and grab one later from Settings.
              </p>
              <button
                type="button"
                onClick={() => {
                  setPhoneSkipped(true);
                  setAvailable([]);
                  setPhoneError(null);
                }}
                disabled={searchingPhone || purchasingPhone !== null}
                className="text-xs font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-40 shrink-0"
              >
                Skip — set up later
              </button>
            </div>
          </div>
        )}
      </section>

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
          {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {verifyState.kind === 'checking'
            ? 'Checking your site…'
            : verifyState.kind === 'applying'
              ? 'Applying to Playbook…'
              : (saving ? 'Saving…' : 'Save & Continue')}
        </button>
        <button
          type="button"
          onClick={() => void skipNoWebsite()}
          disabled={isBusy}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed rounded-xl transition-all"
        >
          I don't have a website
        </button>
      </div>
    </div>
  );
}
