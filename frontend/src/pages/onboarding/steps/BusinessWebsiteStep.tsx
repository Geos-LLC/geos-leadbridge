import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, ChevronRight, DownloadCloud, Globe,
  Loader2, Phone, Sparkles, Users,
} from 'lucide-react';
import { authApi, notificationsApi, usersApi } from '../../../services/api';
import { useAppStore } from '../../../store/appStore';
import { useAuthStore } from '../../../store/authStore';
import { notify } from '../../../store/notificationStore';
import type { TenantPhoneNumber } from '../../../services/api';
import type { SavedAccount } from '../../../types';
import { WebsitePreviewCard } from '../../../components/WebsitePreviewCard';
import { AdditionalAssociatePhonesEditor, type AssociatePhoneEntry } from '../../../components/AdditionalAssociatePhonesEditor';
import { WizardStepActions } from '../WizardStepActions';

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

/**
 * Wizard step 2 — Business contact + website.
 *
 * Order matters here. Per spec the section stack runs:
 *
 *   1. Business phone   — User.businessPhone, the owner's primary number
 *      that alerts forward TO and TT registers as the primary associate.
 *      Pre-populated from signup when provided; per-TT-account associate
 *      numbers expand below it (same editor that Settings → Communication
 *      uses).
 *   2. LeadBridge phone — TenantPhoneNumber, the dedicated outbound number
 *      LeadBridge sends customer texts/calls FROM.
 *   3. Website URL      — User.website + websiteMetadataJson. A dedicated
 *      "Fetch site data" button runs verify + Playbook/FAQ apply WITHOUT
 *      advancing the wizard, so the user can confirm what we pulled
 *      before committing to Continue.
 *   4. Thumbtack profile URLs — one per connected TT account, each with
 *      its own "Fetch from Thumbtack" button that saves the URL + pulls
 *      business info into the Playbook on demand.
 *
 * "Save & Continue" still does the full verify-if-needed + persist + advance
 * flow, so users who just type a URL and hit the bottom CTA also get the
 * old behavior. The Fetch buttons are an upgrade, not a replacement.
 */
export default function BusinessWebsiteStep({ onSaveContinue, onNoWebsite, saving, setSaving }: Props) {
  const user = useAuthStore(s => s.user);
  const setAuth = useAuthStore(s => s.setAuth);
  // Title + description live in WizardShell header (2026-06-13 redesign).

  // ── Website state ──────────────────────────────────────────────────
  const [value, setValue] = useState<string>(user?.website ?? '');
  const [verifyState, setVerifyState] = useState<
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'applying' }
    | { kind: 'invalid'; outcome: VerifyOutcome }
    | { kind: 'valid'; outcome: VerifyOutcome }
  >({ kind: 'idle' });

  // ── LeadBridge phone state (TenantPhoneNumber) ─────────────────────
  const savedAccounts = useAppStore(s => s.savedAccounts);
  const setSavedAccounts = useAppStore(s => s.setSavedAccounts);
  const [tenantPhones, setTenantPhones] = useState<TenantPhoneNumber[]>([]);
  const [phonesLoading, setPhonesLoading] = useState(true);
  const [areaCode, setAreaCode] = useState('');
  const [city, setCity] = useState('');
  const [phoneSkipped, setPhoneSkipped] = useState(false);
  const [available, setAvailable] = useState<{ phoneNumber: string; locality?: string; region?: string }[]>([]);
  const [searchingPhone, setSearchingPhone] = useState(false);
  const [purchasingPhone, setPurchasingPhone] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  // ── Business phone state (User.businessPhone) ──────────────────────
  // Pre-populated from signup. Saved via explicit button — same UX as
  // Settings → General so users see a consistent affordance.
  const [businessPhone, setBusinessPhone] = useState<string>((user as any)?.businessPhone ?? '');
  const [businessPhoneError, setBusinessPhoneError] = useState<string | null>(null);
  const [savingBusinessPhone, setSavingBusinessPhone] = useState(false);
  const [businessPhoneSavedAt, setBusinessPhoneSavedAt] = useState<number | null>(null);
  // Per-TT-account associate phones expander. Off by default — the
  // primary business number is usually enough; teams add additional
  // crew numbers only when needed.
  const [showAssociates, setShowAssociates] = useState(false);

  // ── Per-account TT profile URL state ───────────────────────────────
  const [ttUrls, setTtUrls] = useState<Record<string, string>>({});
  const ttUrlsInitialRef = useRef<Record<string, string>>({});
  // accountId currently running the explicit "Fetch from Thumbtack" pull.
  const [pullingTtId, setPullingTtId] = useState<string | null>(null);

  const ttAccounts = useMemo(
    () => savedAccounts.filter(a => a.platform === 'thumbtack'),
    [savedAccounts],
  );

  // ── Effects: hydrate everything we render ─────────────────────────
  useEffect(() => {
    if (ttAccounts.length === 0) return;
    let cancelled = false;
    Promise.all(
      ttAccounts.map(a => usersApi.getThumbtackProfileUrl(a.id)
        .then(res => ({ id: a.id, url: res.url ?? '' }))
        .catch(() => ({ id: a.id, url: '' })),
      ),
    ).then(results => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const r of results) next[r.id] = r.url;
      setTtUrls(prev => ({ ...next, ...prev })); // preserve in-flight edits
      ttUrlsInitialRef.current = { ...next };
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttAccounts.map(a => a.id).join(',')]);

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

  // Keep the input in sync when the auth store refreshes (e.g. after a
  // background /auth/profile fetch fills in a signup-time businessPhone).
  useEffect(() => {
    setBusinessPhone((user as any)?.businessPhone ?? '');
  }, [(user as any)?.id, (user as any)?.businessPhone]);

  // Auto-clear the "Saved" indicator after the standard 2.2s.
  useEffect(() => {
    if (!businessPhoneSavedAt) return;
    const t = setTimeout(() => setBusinessPhoneSavedAt(null), 2200);
    return () => clearTimeout(t);
  }, [businessPhoneSavedAt]);

  // ── TT profile URL save (on blur) ─────────────────────────────────
  const saveTtUrl = async (accountId: string) => {
    const next = (ttUrls[accountId] || '').trim();
    if (next === (ttUrlsInitialRef.current[accountId] || '').trim()) return;
    try {
      const res = await usersApi.saveThumbtackProfileUrl(accountId, next || null);
      if (!res.success) {
        notify.warning('Could not save URL', res.warning || 'Try again.');
        return;
      }
      ttUrlsInitialRef.current = { ...ttUrlsInitialRef.current, [accountId]: next };
      notify.success('Saved', 'AI will use this when pulling business info.', 2500);
    } catch (e: any) {
      notify.error('Save failed', e?.response?.data?.message || e?.message || 'Could not save URL.');
    }
  };

  // ── LeadBridge phone provisioning ─────────────────────────────────
  async function searchPhones() {
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

  // ── Business phone save ───────────────────────────────────────────
  async function handleSaveBusinessPhone() {
    setBusinessPhoneError(null);
    const trimmed = businessPhone.trim();
    if (trimmed) {
      const digits = trimmed.replace(/\D/g, '');
      const valid = digits.length === 10 || (digits.length === 11 && digits.startsWith('1')) || digits.length > 10;
      if (!valid) {
        setBusinessPhoneError('Enter a valid phone number');
        return;
      }
    }
    setSavingBusinessPhone(true);
    try {
      await usersApi.updateProfile({ businessPhone: trimmed || undefined });
      // Refresh the auth cache so the rest of the app reads the new
      // value without a hard reload.
      try {
        const token = localStorage.getItem('token') || '';
        const fresh: any = await authApi.getProfile();
        const u = fresh?.user ?? fresh;
        if (u?.id) setAuth(u, token);
      } catch { /* silent — the input still shows the new value locally */ }
      setBusinessPhoneSavedAt(Date.now());
    } catch (e: any) {
      setBusinessPhoneError(e?.response?.data?.message || e?.message || 'Failed to save');
    } finally {
      setSavingBusinessPhone(false);
    }
  }

  // ── Website verify + apply ────────────────────────────────────────
  // Shared core used by both the explicit "Fetch site data" button and
  // the bottom "Save & Continue" button. Returns the verify outcome so
  // callers can decide what to do next (stay vs. advance).
  async function runVerifyAndApply(): Promise<VerifyOutcome | null> {
    const url = value.trim();
    if (!url) return null;
    setVerifyState({ kind: 'checking' });
    try {
      const outcome = await usersApi.verifyWebsite(url);
      if (!outcome.reachable) {
        setVerifyState({ kind: 'invalid', outcome });
        return outcome;
      }
      // Persist normalized URL + parsed metadata immediately so a refresh
      // (or the bottom Save & Continue) doesn't need to re-verify.
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
      // Best-effort apply to AI Playbook + FAQ. Failures here are
      // non-fatal — the URL + metadata are saved, the user can still
      // continue.
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
      return outcome;
    } catch (err: any) {
      notify.error('Could not fetch', err.response?.data?.message || 'Please try again.');
      setVerifyState({ kind: 'idle' });
      return null;
    }
  }

  // Explicit "Fetch site data" — verify + apply, NO advance. Lets the
  // user preview what we pulled before committing.
  async function fetchSiteData() {
    if (saving || isBusy) return;
    setSaving(true);
    try {
      await runVerifyAndApply();
    } finally {
      setSaving(false);
    }
  }

  async function verifyAndContinue() {
    if (saving) return;
    const url = value.trim();
    if (url.length === 0) return;
    setSaving(true);
    try {
      // If the URL hasn't been verified yet (user typed it but didn't
      // click Fetch), do the full flow inline. If it's already saved +
      // verified, skip the re-verify and just advance.
      if (!savedAndVerified) {
        const outcome = await runVerifyAndApply();
        if (!outcome || !outcome.reachable) return;
      }
      await onSaveContinue();
    } finally {
      setSaving(false);
    }
  }

  async function skipNoWebsite() {
    if (saving) return;
    setSaving(true);
    try {
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

  // ── Thumbtack profile pull ────────────────────────────────────────
  // Saves the URL (if dirty) then asks the backend to pull business info
  // off the Thumbtack profile and merge it into the Playbook. Same
  // endpoint Settings → AI Playbook uses; just surfaced per-URL here so
  // the user sees a 1:1 button for what they just typed.
  async function fetchFromThumbtack(accountId: string) {
    const next = (ttUrls[accountId] || '').trim();
    if (!next) {
      notify.warning('Paste a URL first', 'Add your public Thumbtack profile URL, then Fetch.');
      return;
    }
    setPullingTtId(accountId);
    try {
      // Persist the URL first so the backend has it to read off the
      // SavedAccount. saveThumbtackProfileUrl is idempotent — a second
      // call with the same value is a no-op.
      if (next !== (ttUrlsInitialRef.current[accountId] || '').trim()) {
        const saveRes = await usersApi.saveThumbtackProfileUrl(accountId, next);
        if (!saveRes.success) {
          notify.warning('Could not save URL', saveRes.warning || 'Try again.');
          return;
        }
        ttUrlsInitialRef.current = { ...ttUrlsInitialRef.current, [accountId]: next };
      }
      const pull = await usersApi.pullBusinessInfoFromAccount('thumbtack', accountId);
      if (pull.success) {
        const parts: string[] = [];
        if (pull.fieldsApplied > 0) parts.push(`${pull.fieldsApplied} field${pull.fieldsApplied === 1 ? '' : 's'}`);
        if (pull.conflictsRaised > 0) parts.push(`${pull.conflictsRaised} conflict${pull.conflictsRaised === 1 ? '' : 's'} to review`);
        notify.success(
          'Pulled from Thumbtack',
          parts.length > 0
            ? `Applied ${parts.join(' · ')}. Review on the next step or in Settings → AI Playbook.`
            : 'No new info to apply — Playbook already had values for what we found.',
          5000,
        );
      } else if (pull.warning) {
        notify.warning('Pull finished with a warning', pull.warning);
      }
    } catch (e: any) {
      notify.error('Could not fetch', e?.response?.data?.message || e?.message || 'Thumbtack pull failed.');
    } finally {
      setPullingTtId(null);
    }
  }

  // ── Derived ───────────────────────────────────────────────────────
  const trimmed = value.trim();
  const isChecking = verifyState.kind === 'checking' || saving;
  const isApplying = verifyState.kind === 'applying';
  const isBusy = isChecking || isApplying;
  const canSave = trimmed.length > 0 && !isBusy;
  const savedMetadata = user?.websiteMetadataJson ?? null;
  const savedAndVerified =
    !!user?.website &&
    !!savedMetadata &&
    user.website.trim() === trimmed &&
    trimmed.length > 0;

  return (
    <div className="pt-2">
      {/* Sticky top action row — Save & Continue stays in view while
          the user works through the verify + phone provisioning flow. */}
      <WizardStepActions>
        <button
          type="button"
          onClick={() => void verifyAndContinue()}
          disabled={!canSave}
          className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-md shadow-blue-200 transition-all"
        >
          {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {verifyState.kind === 'checking'
            ? 'Checking your site…'
            : verifyState.kind === 'applying'
              ? 'Applying to Playbook…'
              : (saving ? 'Saving…' : 'Save & Continue')}
          {!isBusy && <ArrowRight className="w-4 h-4" />}
        </button>
        <button
          type="button"
          onClick={() => void skipNoWebsite()}
          disabled={isBusy}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-all"
        >
          I don't have a website
        </button>
      </WizardStepActions>

      {/* Title + description moved to WizardShell header (2026-06-13 redesign). */}

      {/* ─── 1. Business phone (User.businessPhone) ──────────────── */}
      <section className="mt-2 rounded-2xl border border-slate-100 bg-slate-50/50 p-5">
        <div className="flex items-center gap-2 mb-1">
          <Phone className="w-4 h-4 text-slate-500" />
          <h2 className="text-sm font-extrabold text-slate-900">Business phone</h2>
        </div>
        <p className="text-xs text-slate-500 leading-relaxed mb-3">
          Your primary owner/company number. Used for owner alerts and auto-registered
          as the primary associate phone on connected Thumbtack businesses.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={businessPhone}
            onChange={e => setBusinessPhone(e.target.value)}
            placeholder="+1 (555) 010-1234"
            className="flex-1 min-w-0 px-3 py-2.5 text-sm rounded-xl border-2 border-slate-200 bg-white focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleSaveBusinessPhone();
              }
            }}
          />
          {businessPhoneSavedAt && !businessPhoneError && (
            <span className="text-xs font-semibold text-emerald-700">Saved</span>
          )}
          <button
            type="button"
            onClick={() => void handleSaveBusinessPhone()}
            disabled={savingBusinessPhone || (businessPhone.trim() === ((user as any)?.businessPhone || ''))}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-500 disabled:cursor-not-allowed rounded-xl transition-all shrink-0"
          >
            {savingBusinessPhone ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {savingBusinessPhone ? 'Saving…' : 'Save'}
          </button>
        </div>
        {businessPhoneError && (
          <div className="mt-2 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
            {businessPhoneError}
          </div>
        )}

        {/* Additional associate numbers — collapsible, TT-only. Same
            editor Settings → Communication exposes; each entry registers
            on the matching Thumbtack business's profile. */}
        {ttAccounts.length > 0 && (
          <div className="mt-4 pt-4 border-t border-slate-200">
            <button
              type="button"
              onClick={() => setShowAssociates(v => !v)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900"
            >
              {showAssociates ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              <Users className="w-3.5 h-3.5" />
              Add associate numbers (Thumbtack)
              <span className="text-slate-400 font-normal">— optional, per business</span>
            </button>
            {showAssociates && (
              <div className="mt-3 space-y-4">
                {ttAccounts.map(acct => {
                  const initial = parseAdditionalPhones(acct.followUpSettingsJson);
                  return (
                    <div key={acct.id}>
                      <div className="text-[11px] font-bold uppercase tracking-widest text-slate-500 mb-2">
                        {acct.businessName || 'Thumbtack business'}
                      </div>
                      <AdditionalAssociatePhonesEditor
                        savedAccountId={acct.id}
                        initialValue={initial}
                        onSaved={(next) => {
                          // Mirror Communication.tsx — write the new list back
                          // into the cached account's followUpSettingsJson so
                          // a re-render shows the saved state without a refetch.
                          setSavedAccounts(
                            savedAccounts.map((a: SavedAccount) => {
                              if (a.id !== acct.id) return a;
                              let parsed: Record<string, any> = {};
                              try {
                                parsed = a.followUpSettingsJson ? JSON.parse(a.followUpSettingsJson) : {};
                              } catch { parsed = {}; }
                              parsed.additionalAssociatePhones = next;
                              return { ...a, followUpSettingsJson: JSON.stringify(parsed) };
                            }),
                          );
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>

      {/* ─── 2. LeadBridge phone (TenantPhoneNumber) ─────────────── */}
      <section className="mt-4 rounded-2xl border border-slate-100 bg-slate-50/50 p-5">
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

      {/* ─── 3. Website URL ──────────────────────────────────────── */}
      <section className="mt-4 rounded-2xl border border-slate-100 bg-slate-50/50 p-5">
        <div className="flex items-center gap-2 mb-1">
          <Globe className="w-4 h-4 text-slate-500" />
          <h2 className="text-sm font-extrabold text-slate-900">Website URL</h2>
          {savedAndVerified && (
            <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold uppercase tracking-widest">
              <CheckCircle2 className="w-3 h-3" />
              Verified
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500 leading-relaxed mb-3">
          We'll pull title, description, and structured business info from your homepage
          to pre-fill your AI Playbook and FAQ.
        </p>

        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
              <Globe className="w-4 h-4" />
            </span>
            <input
              type="text"
              inputMode="url"
              autoComplete="url"
              placeholder="myco.com or https://myco.com"
              value={value}
              onChange={e => {
                setValue(e.target.value);
                if (verifyState.kind !== 'idle' && verifyState.kind !== 'checking') {
                  setVerifyState({ kind: 'idle' });
                }
              }}
              disabled={isChecking}
              className={`w-full pl-9 pr-3 py-2.5 text-sm rounded-xl border-2 bg-white focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 transition-all disabled:opacity-60 ${
                savedAndVerified ? 'border-emerald-300' : 'border-slate-200'
              }`}
              onKeyDown={e => {
                if (e.key === 'Enter' && canSave) {
                  e.preventDefault();
                  void fetchSiteData();
                }
              }}
            />
          </div>
          <button
            type="button"
            onClick={() => void fetchSiteData()}
            disabled={!canSave}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-xl hover:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed transition-all shrink-0"
          >
            {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <DownloadCloud className="w-4 h-4" />}
            {isApplying ? 'Applying…' : isChecking ? 'Fetching…' : 'Fetch site data'}
          </button>
        </div>

        {isBusy && (
          <div className="mt-3 flex items-start gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5">
            <Loader2 className="w-4 h-4 text-slate-500 animate-spin shrink-0 mt-0.5" />
            <div className="text-xs">
              <div className="font-bold text-slate-900">
                {isApplying ? 'Applying website info to your AI Playbook…' : 'Pulling info from your site…'}
              </div>
              <div className="text-slate-500 mt-0.5">
                {isApplying
                  ? 'Filling empty Playbook sections so your AI starts with real context.'
                  : 'We fetch the page, render a preview, and generate an AI summary. Takes a few seconds.'}
              </div>
            </div>
          </div>
        )}

        {verifyState.kind === 'invalid' && (
          <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 flex items-start gap-2" role="alert">
            <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
            <div className="min-w-0 text-xs">
              <div className="font-bold text-rose-900">
                {verifyState.outcome.errorMessage || "We couldn't load that site."}
              </div>
              <div className="text-rose-700 mt-0.5">
                Double-check the URL, or use <span className="font-semibold">I don't have a website</span> below.
              </div>
            </div>
          </div>
        )}

        {savedAndVerified && savedMetadata && !isBusy && (
          <div className="mt-3">
            <WebsitePreviewCard url={user?.website || null} metadata={savedMetadata as any} tone="wizard" />
          </div>
        )}
      </section>

      {/* ─── 4. Thumbtack profile URLs ───────────────────────────── */}
      {ttAccounts.length > 0 && (
        <section className="mt-4 rounded-2xl border border-slate-100 bg-slate-50/50 p-5">
          <div className="flex items-center gap-2 mb-1">
            <Globe className="w-4 h-4 text-slate-500" />
            <h2 className="text-sm font-extrabold text-slate-900">Thumbtack profile URL</h2>
            <span className="text-xs font-normal text-slate-400">(optional)</span>
          </div>
          <p className="text-xs text-slate-500 leading-relaxed mb-3">
            Paste your public Thumbtack profile so AI can pull services, address, insurance,
            and pricing. Click <span className="font-semibold">Fetch from Thumbtack</span> to
            apply the info to your Playbook.
          </p>
          <ul className="space-y-3">
            {ttAccounts.map(acct => {
              const pulling = pullingTtId === acct.id;
              const hasUrl = (ttUrls[acct.id] || '').trim().length > 0;
              return (
                <li key={acct.id}>
                  <label className="text-[11px] font-semibold text-slate-500 mb-1 block">
                    {acct.businessName || 'Thumbtack business'}
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="url"
                      value={ttUrls[acct.id] ?? ''}
                      onChange={e => setTtUrls(prev => ({ ...prev, [acct.id]: e.target.value }))}
                      onBlur={() => void saveTtUrl(acct.id)}
                      placeholder="https://www.thumbtack.com/fl/jacksonville/house-cleaning/your-business/service/..."
                      className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                    />
                    <button
                      type="button"
                      onClick={() => void fetchFromThumbtack(acct.id)}
                      disabled={!hasUrl || pulling || pullingTtId !== null}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-50 disabled:cursor-not-allowed transition-all shrink-0"
                    >
                      {pulling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <DownloadCloud className="w-3.5 h-3.5" />}
                      {pulling ? 'Fetching…' : 'Fetch'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

    </div>
  );
}

// Parse the additionalAssociatePhones list out of a SavedAccount's
// followUpSettingsJson. Returns [] for any of: null, malformed JSON,
// missing key, or a non-array value — the editor treats [] as "no
// rows" and lets the user add new ones.
function parseAdditionalPhones(json: string | null | undefined): AssociatePhoneEntry[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    const arr = parsed?.additionalAssociatePhones;
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
