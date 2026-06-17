import { useEffect, useMemo, useState } from 'react';
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
import { ManualBusinessInfoModal } from '../../../components/ManualBusinessInfoModal';
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
  // True when the URL fetched fine but the scrape produced no usable
  // Playbook seed (BookingKoala SPA, meta-less site, etc.). Drives the
  // "not enough info" banner that surfaces the fallback modal — the
  // green VERIFIED card on its own is misleading when only the page
  // title was extracted.
  const [lowYieldScrape, setLowYieldScrape] = useState(false);
  const [fallbackOpen, setFallbackOpen] = useState(false);

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

  // ── Unified profile URL state ──────────────────────────────────────
  // Detected platform from the LAST successful apply — drives the badge
  // next to the section header. Null when the user hasn't yet applied
  // anything (or when the URL was cleared).
  const [detectedPlatform, setDetectedPlatform] = useState<'thumbtack' | 'yelp' | 'website' | null>(
    user?.website ? 'website' : null,
  );

  const ttAccounts = useMemo(
    () => savedAccounts.filter(a => a.platform === 'thumbtack'),
    [savedAccounts],
  );

  // Hydrate the unified field from whichever source has a saved value
  // (TT/Yelp publicProfileUrl > User.website). The hook also re-applies
  // when accounts change so a freshly-connected TT account immediately
  // populates the field if its URL was saved out-of-band.
  useEffect(() => {
    let cancelled = false;
    usersApi.getBusinessProfileUrl()
      .then(res => {
        if (cancelled) return;
        if (res.url && !value.trim()) setValue(res.url);
        if (res.platform) setDetectedPlatform(res.platform);
      })
      .catch(() => { /* non-fatal — leave empty and let the user type */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedAccounts.length]);

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

  // ── Unified verify + apply ────────────────────────────────────────
  // Backend detects platform from hostname and routes to the right
  // pipeline (TT fan-out + scrape / Yelp fan-out + scrape / generic
  // verifyWebsite + Playbook + FAQ). Returns a VerifyOutcome-shaped
  // result so the existing "saved & verified" UI stays.
  async function runVerifyAndApply(): Promise<VerifyOutcome | null> {
    const url = value.trim();
    if (!url) return null;
    setVerifyState({ kind: 'checking' });
    try {
      const res = await usersApi.applyBusinessProfileUrl(url);
      if (!res.success || !res.savedUrl) {
        const outcome: VerifyOutcome = {
          reachable: false,
          normalizedUrl: url,
          errorMessage: res.warning || "We couldn't load that link.",
        };
        setVerifyState({ kind: 'invalid', outcome });
        return outcome;
      }
      setDetectedPlatform(res.platform);
      // Generic website path also updates the cached User.website so the
      // preview card renders. TT / Yelp paths store on SavedAccount.
      if (res.platform === 'website' && user) {
        const token = localStorage.getItem('token') || '';
        setAuth(
          {
            ...user,
            website: res.savedUrl,
            websiteMetadataJson: (res.websiteMetadata as any) ?? null,
          },
          token,
        );
      }
      // Notify on apply outcome — same UX as the prior split flow.
      const platformWord =
        res.platform === 'thumbtack' ? 'Thumbtack' :
        res.platform === 'yelp' ? 'Yelp' :
        'your website';
      if (res.fieldsApplied > 0) {
        notify.success(
          `Pulled from ${platformWord}`,
          `Filled ${res.fieldsApplied} field${res.fieldsApplied === 1 ? '' : 's'}. Review on the next step or in Settings → AI Playbook.`,
          5000,
        );
        setLowYieldScrape(false);
      } else {
        // Scrape was reachable but extracted no usable fields — the
        // BookingKoala SPA / meta-less site / Yelp-403 cases. Flag for
        // the in-step warning banner; the banner offers the fallback
        // modal (Try a TT URL OR paste business info manually).
        setLowYieldScrape(true);
      }
      const outcome: VerifyOutcome = {
        reachable: true,
        normalizedUrl: res.savedUrl,
        metadata: res.websiteMetadata as any,
      };
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
          I don't have one
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

      {/* ─── 3. Business profile or website URL (unified) ────────
          One field, three behaviors. Backend detects platform from
          hostname:
            - thumbtack.com → fan out to every connected TT account,
              save as publicProfileUrl, run TT scrape.
            - yelp.com → same for Yelp accounts.
            - any other host → save as User.website + verify + apply
              Playbook + FAQ.
          Replaces the two prior sections (Website URL + Thumbtack
          profile URLs). */}
      <section className="mt-4 rounded-2xl border border-slate-100 bg-slate-50/50 p-5">
        <div className="flex items-center gap-2 mb-1">
          <Globe className="w-4 h-4 text-slate-500" />
          <h2 className="text-sm font-extrabold text-slate-900">Business profile or website</h2>
          {detectedPlatform && (
            <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold uppercase tracking-widest">
              {platformLabel(detectedPlatform)}
            </span>
          )}
          {savedAndVerified && (
            <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold uppercase tracking-widest">
              <CheckCircle2 className="w-3 h-3" />
              Verified
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500 leading-relaxed mb-3">
          Paste your <span className="font-semibold">Thumbtack profile</span>,{' '}
          <span className="font-semibold">Yelp business page</span>, or{' '}
          <span className="font-semibold">your website</span> — whichever has the most
          info about your business. We auto-detect the source and pull services,
          location, insurance, pricing, and more into your AI Playbook + FAQ.
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
              placeholder="thumbtack.com/… · yelp.com/biz/… · myco.com"
              value={value}
              onChange={e => {
                setValue(e.target.value);
                if (verifyState.kind !== 'idle' && verifyState.kind !== 'checking') {
                  setVerifyState({ kind: 'idle' });
                }
                if (lowYieldScrape) setLowYieldScrape(false);
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
            {isApplying ? 'Applying…' : isChecking ? 'Fetching…' : 'Fetch'}
          </button>
        </div>

        {isBusy && (
          <div className="mt-3 flex items-start gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5">
            <Loader2 className="w-4 h-4 text-slate-500 animate-spin shrink-0 mt-0.5" />
            <div className="text-xs">
              <div className="font-bold text-slate-900">
                {isApplying ? 'Applying to your AI Playbook…' : 'Pulling info…'}
              </div>
              <div className="text-slate-500 mt-0.5">
                {isApplying
                  ? 'Filling empty Playbook + FAQ sections so your AI starts with real context.'
                  : 'We fetch the page, generate an AI summary, and pre-fill what we can. Takes a few seconds.'}
              </div>
            </div>
          </div>
        )}

        {verifyState.kind === 'invalid' && (
          <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 flex items-start gap-2" role="alert">
            <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
            <div className="min-w-0 text-xs">
              <div className="font-bold text-rose-900">
                {verifyState.outcome.errorMessage || "We couldn't load that link."}
              </div>
              <div className="text-rose-700 mt-0.5">
                Double-check the URL, or use <span className="font-semibold">I don't have one</span> below.
              </div>
            </div>
          </div>
        )}

        {savedAndVerified && savedMetadata && !isBusy && detectedPlatform === 'website' && (
          <div className="mt-3">
            <WebsitePreviewCard url={user?.website || null} metadata={savedMetadata as any} tone="wizard" />
          </div>
        )}

        {/* Low-yield warning — fires when the URL was reachable but the
            scrape returned no Playbook seed (BookingKoala SPA, meta-less
            site, Cloudflare-protected page). The green VERIFIED card
            alone is misleading; this banner tells the user what didn't
            happen and offers a fallback (TT URL OR paste manually). */}
        {lowYieldScrape && verifyState.kind === 'valid' && !isBusy && (
          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 flex items-start gap-2.5" role="alert">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="min-w-0 text-xs flex-1">
              <div className="font-bold text-amber-900">
                Site loaded — but we couldn't pull much detail.
              </div>
              <div className="text-amber-800 mt-0.5 leading-snug">
                That page is light on structured info (services, pricing, hours). Your AI Playbook will be
                close to empty unless you give us another source.
              </div>
              <div className="mt-2 flex items-center gap-3 flex-wrap">
                <button
                  type="button"
                  onClick={() => setFallbackOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-amber-600 rounded-lg hover:bg-amber-700 transition"
                >
                  Try another source
                </button>
                <span className="text-[11px] text-amber-700">
                  Use a Thumbtack URL or paste your business info as text.
                </span>
              </div>
            </div>
          </div>
        )}
      </section>

      <ManualBusinessInfoModal
        isOpen={fallbackOpen}
        failedUrl={value.trim() || null}
        onClose={() => setFallbackOpen(false)}
        onSuccess={async ({ platform }) => {
          // Refresh the cached user so the next wizard step (FAQ, Pricing)
          // sees the freshly-applied Playbook seed without a hard reload.
          try {
            const fresh: any = await authApi.getProfile();
            const u = fresh?.user ?? fresh;
            if (u?.id && user) {
              const token = localStorage.getItem('token') || '';
              setAuth(u, token);
            }
          } catch { /* non-fatal */ }
          if (platform === 'thumbtack' || platform === 'yelp' || platform === 'website') {
            setDetectedPlatform(platform);
          }
          // Modal succeeded → the low-yield warning no longer applies
          // (we just landed real data through the fallback).
          setLowYieldScrape(false);
          setFallbackOpen(false);
        }}
      />

    </div>
  );
}

// Friendly badge label for the detected platform. Lives at the bottom
// alongside the other small helpers so the JSX section stays tight.
function platformLabel(p: 'thumbtack' | 'yelp' | 'website'): string {
  if (p === 'thumbtack') return 'Thumbtack profile';
  if (p === 'yelp') return 'Yelp business page';
  return 'Website';
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
