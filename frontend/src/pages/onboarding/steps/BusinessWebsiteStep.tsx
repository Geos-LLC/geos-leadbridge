import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, CalendarClock, ChevronRight as ChevronRightIcon,
  CheckCircle2, ChevronDown, ChevronRight, ChevronUp, DownloadCloud, Globe,
  Info, Loader2, Phone, PhoneCall, Sparkles, Users,
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
export default function BusinessWebsiteStep({ onSaveContinue, saving, setSaving }: Props) {
  const navigate = useNavigate();
  const user = useAuthStore(s => s.user);
  const setAuth = useAuthStore(s => s.setAuth);
  // Title + description live in WizardShell header (2026-06-13 redesign).

  // ── Website state ──────────────────────────────────────────────────
  // Intentionally NOT seeded from user.website. For TT/Yelp tenants the
  // canonical URL lives on SavedAccount.publicProfileUrl, not User.website,
  // and the cached user.website can be a stale value from before the
  // unified field landed. getBusinessProfileUrl (below) runs the
  // canonical TT > Yelp > User.website resolution server-side; with a
  // stale local seed the `!value.trim()` guard would block it from
  // overwriting, leaving the wrong URL visible. Mirrors the same fix
  // Settings → General got (2026-06-17).
  const [value, setValue] = useState<string>('');
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
  // The TT / Yelp paths never write to User.website + websiteMetadataJson
  // (those columns are website-only), so the existing WebsitePreviewCard
  // path can't confirm their success. We track the most recent
  // applyBusinessProfileUrl outcome here and render a small platform-aware
  // confirmation card off it. Without this the wizard looks broken after
  // a successful TT fetch — toast disappears, no on-page evidence remains.
  const [lastApply, setLastApply] = useState<{
    platform: 'thumbtack' | 'yelp' | 'website';
    url: string;
    fieldsApplied: number;
    // Count of fields the scrape returned BEFORE merge. fieldsApplied
    // counts only net-new keys; on a re-fetch of an already-populated
    // bizInfo it's 0 even when the scrape found 7 facts. Use the gap
    // to differentiate "page yielded nothing" from "already saved."
    fieldsExtracted: number;
    /** Actual key/value pairs the scrape returned. Powers the
     *  expandable "Show what we pulled" disclosure under the card. */
    extractedFields?: Record<string, string | string[]>;
    /** GPT-generated prose summary of the scraped page. Shown directly
     *  in the card body for a quick "what does the AI see on this
     *  page?" read — same surface Settings → General uses. */
    summary?: string;
    accountsAffected: number;
  } | null>(null);
  // Disclosure for the "Show what we pulled" panel under the card.
  const [showExtracted, setShowExtracted] = useState(false);

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
  // Per-card info-circle popovers. Canonical FinalDesign uses a small
  // info-circle button next to each card title that toggles a short
  // explanation inline — keeps the card header clean while preserving
  // the helper copy. One open at a time per card.
  const [infoPhoneOpen, setInfoPhoneOpen] = useState(false);
  const [infoLbnumOpen, setInfoLbnumOpen] = useState(false);
  const [infoWebsiteOpen, setInfoWebsiteOpen] = useState(false);
  // LeadBridge phone — collapse the full area-code/city search behind
  // a "Get a number" CTA when no number is assigned yet. Matches the
  // canonical's empty-state pattern (dashed tile + Get a number
  // button → reveal the picker).
  const [showLbnumPicker, setShowLbnumPicker] = useState(false);

  // ── Business hours editor (inline on the wizard) ─────────────────
  // Replaces the prior deep-link-to-Settings card. We load the
  // user-level businessHours blob and let the operator toggle each
  // day on/off plus tweak start/end times right here. Save fires on
  // every change (debounced via the auto-save effect below) so the
  // user doesn't need a separate Save button — matches the canonical
  // pattern.
  const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
  type DayKey = typeof DAY_KEYS[number];
  const DAY_LABEL: Record<DayKey, string> = {
    mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
  };
  const DEFAULT_DAY = { start: '09:00', end: '18:00' };
  const [businessHours, setBusinessHours] = useState<Record<DayKey, { start: string; end: string } | null>>({
    mon: DEFAULT_DAY, tue: DEFAULT_DAY, wed: DEFAULT_DAY, thu: DEFAULT_DAY, fri: DEFAULT_DAY,
    sat: null, sun: null,
  });
  const [hoursOpen, setHoursOpen] = useState(false);
  const [hoursSaving, setHoursSaving] = useState(false);
  const [hoursDirty, setHoursDirty] = useState(false);
  const setDayOpen = (day: DayKey, open: boolean) => {
    setBusinessHours(prev => ({ ...prev, [day]: open ? (prev[day] ?? DEFAULT_DAY) : null }));
    setHoursDirty(true);
  };
  const setDayTime = (day: DayKey, field: 'start' | 'end', value: string) => {
    setBusinessHours(prev => {
      const cur = prev[day] ?? DEFAULT_DAY;
      return { ...prev, [day]: { ...cur, [field]: value } };
    });
    setHoursDirty(true);
  };
  const copyMondayToWeekdays = () => {
    setBusinessHours(prev => {
      const mon = prev.mon ?? DEFAULT_DAY;
      return { ...prev, tue: mon, wed: mon, thu: mon, fri: mon };
    });
    setHoursDirty(true);
  };

  // Compact subtitle for the collapsed Hours card.
  const hoursSummary = useMemo(() => {
    const fmt = (t: string) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(t);
      if (!m) return t;
      const h = parseInt(m[1], 10);
      const mins = m[2];
      const ampm = h >= 12 ? 'PM' : 'AM';
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return `${h12}:${mins} ${ampm}`;
    };
    const weekdays = (['mon', 'tue', 'wed', 'thu', 'fri'] as DayKey[]).map(d => businessHours[d]);
    const allSame = weekdays.every(d => d && d.start === weekdays[0]?.start && d.end === weekdays[0]?.end);
    const sat = businessHours.sat;
    const sun = businessHours.sun;
    const parts: string[] = [];
    if (allSame && weekdays[0]) {
      parts.push(`Mon–Fri ${fmt(weekdays[0].start)} – ${fmt(weekdays[0].end)}`);
    } else {
      const openDays = (['mon', 'tue', 'wed', 'thu', 'fri'] as DayKey[]).filter(d => businessHours[d]);
      if (openDays.length === 0) parts.push('Weekdays closed');
      else parts.push(`${openDays.length} weekday${openDays.length === 1 ? '' : 's'} configured`);
    }
    if (sat) parts.push(`Sat ${fmt(sat.start)} – ${fmt(sat.end)}`);
    else parts.push('Sat closed');
    if (sun) parts.push(`Sun ${fmt(sun.start)} – ${fmt(sun.end)}`);
    else parts.push('Sun closed');
    return parts.join(' · ');
  }, [businessHours]);

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

  // Rehydrate the TT/Yelp confirmation card from the persisted snapshot
  // on user.websiteMetadataJson.lastBusinessApply. Without this the
  // wizard's Business step looked empty after a reload, even though
  // Settings → General was happily rendering the same data. Mirrors
  // the General.tsx rehydration block (2026-06-17 fix).
  //
  // fieldsApplied is saved as 0 (delta is meaningless across sessions)
  // and fieldsExtracted = patch size, so the card-body logic reads as
  // "N fields already saved" on restore — accurate.
  useEffect(() => {
    if (lastApply) return; // a fresh apply in this session wins over the snapshot
    const snap = (user as any)?.websiteMetadataJson?.lastBusinessApply;
    if (!snap || !snap.url || !snap.platform) return;
    if (snap.platform === 'website') return; // website branch has WebsitePreviewCard
    const extracted = (snap.extractedFields && Object.keys(snap.extractedFields).length) || 0;
    setLastApply({
      platform: snap.platform,
      url: snap.url,
      fieldsApplied: 0,
      fieldsExtracted: extracted,
      extractedFields: snap.extractedFields,
      summary: snap.summary,
      accountsAffected: snap.accountsAffected ?? 0,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

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

  // Load business hours on mount — the inline editor below hydrates
  // from the user-level master schedule (User.businessHours*). Falls
  // back to the Mon-Fri 9-6 default rendered by useState above.
  useEffect(() => {
    let alive = true;
    usersApi.getBusinessHours()
      .then(res => {
        if (!alive || !res?.schedule) return;
        setBusinessHours(prev => ({ ...prev, ...res.schedule }));
        setHoursDirty(false);
      })
      .catch(() => { /* keep defaults */ });
    return () => { alive = false; };
  }, []);

  // Debounced auto-save for the inline business hours editor — 600ms
  // after the last toggle/time change. No explicit Save button per the
  // canonical's design; the operator just edits and moves on.
  useEffect(() => {
    if (!hoursDirty) return;
    const t = setTimeout(async () => {
      try {
        setHoursSaving(true);
        await usersApi.updateBusinessHours({ schedule: businessHours });
        setHoursDirty(false);
      } catch (err: any) {
        notify.error('Could not save business hours', err?.response?.data?.message || 'Please try again.');
      } finally {
        setHoursSaving(false);
      }
    }, 600);
    return () => clearTimeout(t);
  }, [hoursDirty, businessHours]);

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
      const extracted = res.fieldsExtracted ?? 0;
      if (res.fieldsApplied > 0) {
        notify.success(
          `Pulled from ${platformWord}`,
          `Filled ${res.fieldsApplied} field${res.fieldsApplied === 1 ? '' : 's'}. Review on the next step or in Settings → AI Playbook.`,
          5000,
        );
        setLowYieldScrape(false);
      } else if (extracted > 0) {
        // fieldsApplied=0 but fieldsExtracted>0 — the scrape DID find
        // structured info, it just all matches what's already in the
        // Playbook (typical when re-running on the same URL). NOT a
        // low-yield case; don't trip the amber warning.
        setLowYieldScrape(false);
      } else {
        // Scrape was reachable but extracted no usable fields — the
        // BookingKoala SPA / meta-less site / Yelp-403 cases. Flag for
        // the in-step warning banner; the banner offers the fallback
        // modal (Try a TT URL OR paste business info manually).
        setLowYieldScrape(true);
      }
      // Snapshot the apply outcome so the in-step confirmation card can
      // render even for TT / Yelp paths (which don't populate the
      // User.website-driven WebsitePreviewCard). Includes the GPT
      // summary + extractedFields so the wizard mirrors Settings →
      // General — same "Show what we pulled" disclosure.
      setLastApply({
        platform: res.platform,
        url: res.savedUrl,
        fieldsApplied: res.fieldsApplied ?? 0,
        fieldsExtracted: extracted,
        extractedFields: res.extractedFields,
        summary: res.summary,
        accountsAffected: res.accountsAffected ?? 0,
      });
      // Default the disclosure to collapsed on each fresh fetch so the
      // card doesn't visually balloon every Pull click.
      setShowExtracted(false);
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

  // ── Derived ───────────────────────────────────────────────────────
  const trimmed = value.trim();
  const isChecking = verifyState.kind === 'checking' || saving;
  const isApplying = verifyState.kind === 'applying';
  const isBusy = isChecking || isApplying;
  const canSave = trimmed.length > 0 && !isBusy;
  const savedMetadata = user?.websiteMetadataJson ?? null;
  const savedAndVerified =
    // Website path — User.website + metadata is the cached source of truth.
    (!!user?.website && !!savedMetadata && user.website.trim() === trimmed && trimmed.length > 0)
    // TT / Yelp paths — the apply we just ran for the same URL succeeded.
    // We can't read it from User.website (those columns are website-only),
    // so we rely on the in-memory `lastApply` snapshot from runVerifyAndApply.
    || (
      !!lastApply &&
      lastApply.platform !== 'website' &&
      lastApply.url.trim() === trimmed &&
      trimmed.length > 0
    );

  return (
    <div className="pt-2">
      {/* Sticky top action row — Save & Continue stays in view while
          the user works through the verify + phone provisioning flow. */}
      <WizardStepActions>
        <button
          type="button"
          onClick={() => void verifyAndContinue()}
          disabled={!canSave}
          style={{
            padding: '10px 22px', borderRadius: 10,
            border: 0, background: 'var(--lb-accent)', color: '#fff',
            fontSize: 13, fontWeight: 700,
            cursor: !canSave ? 'not-allowed' : 'pointer',
            opacity: !canSave ? 0.5 : 1,
            fontFamily: 'inherit',
          }}
        >
          {verifyState.kind === 'checking'
            ? 'Checking your site…'
            : verifyState.kind === 'applying'
              ? 'Applying to Playbook…'
              : (saving ? 'Saving…' : 'Continue')}
        </button>
      </WizardStepActions>

      {/* Title + description moved to WizardShell header (2026-06-13 redesign). */}

      {/* ─── 1. Your phone number (User.businessPhone) ──────────────
          Canonical "Business Step (standalone)" chrome:
            - 38x38 dbeafe-bg icon tile + title + info-circle popover
            - bordered tile + greyed Save button
            - collapsible "Add associate numbers" row at bottom with
              border-top divider */}
      <section style={{
        marginTop: 8,
        background: '#fff',
        border: '1px solid var(--lb-line)',
        borderRadius: 12,
        padding: 18,
      }} className="lb-wiz-card">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <span style={{
            width: 38, height: 38, borderRadius: 10,
            background: '#dbeafe', color: '#2563eb',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Phone size={18} />
          </span>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
              Your phone number
            </span>
            <button
              type="button"
              onClick={() => setInfoPhoneOpen(v => !v)}
              aria-label="More info"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 20, height: 20, border: 0, background: 'transparent',
                cursor: 'pointer', padding: 0, flexShrink: 0,
                color: 'var(--lb-accent)',
              }}
            >
              <Info size={15} />
            </button>
          </div>
        </div>
        {infoPhoneOpen && (
          <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 9, lineHeight: 1.45 }}>
            Used for lead alerts and auto-registered as the primary associate phone on
            connected Thumbtack businesses.
          </div>
        )}
        <div className="lb-wiz-inline-save" style={{ marginTop: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={businessPhone}
            onChange={e => setBusinessPhone(e.target.value)}
            placeholder="+1 (555) 010-1234"
            style={{
              flex: 1, minWidth: 0,
              padding: '12px 14px',
              border: '1px solid var(--lb-line)',
              borderRadius: 10,
              fontSize: 14,
              fontFamily: 'var(--lb-font-mono)',
              color: 'var(--lb-ink-2)',
              outline: 'none',
              background: '#fff',
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleSaveBusinessPhone();
              }
            }}
          />
          <button
            type="button"
            onClick={() => void handleSaveBusinessPhone()}
            disabled={savingBusinessPhone || (businessPhone.trim() === ((user as any)?.businessPhone || ''))}
            style={{
              flexShrink: 0,
              padding: '12px 20px',
              borderRadius: 9,
              border: 0,
              background: (savingBusinessPhone || (businessPhone.trim() === ((user as any)?.businessPhone || '')))
                ? 'var(--lb-ink-10)'
                : 'var(--lb-accent)',
              color: (savingBusinessPhone || (businessPhone.trim() === ((user as any)?.businessPhone || '')))
                ? 'var(--lb-ink-6)'
                : '#fff',
              fontSize: 13,
              fontWeight: 600,
              cursor: savingBusinessPhone ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            {savingBusinessPhone ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {savingBusinessPhone ? 'Saving…' : (businessPhoneSavedAt && !businessPhoneError) ? 'Saved' : 'Save'}
          </button>
        </div>
        {businessPhoneError && (
          <div className="mt-2 text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
            {businessPhoneError}
          </div>
        )}

        {/* Additional associate numbers — collapsible, TT-only. */}
        {ttAccounts.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setShowAssociates(v => !v)}
              style={{
                marginTop: 14, paddingTop: 14,
                display: 'flex', alignItems: 'center', gap: 11,
                width: '100%',
                border: 0, borderTop: '1px solid var(--lb-line-soft)',
                background: 'transparent', cursor: 'pointer',
                fontFamily: 'inherit', textAlign: 'left',
              }}
            >
              {showAssociates ? (
                <ChevronDown className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--lb-ink-5)' }} />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--lb-ink-5)' }} />
              )}
              <Users size={16} style={{ flexShrink: 0, color: 'var(--lb-ink-5)' }} />
              <span style={{
                flex: 1, minWidth: 0,
                fontSize: 13.5, fontWeight: 600,
                color: 'var(--lb-ink-1)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                Add associate numbers
              </span>
              <span style={{ flexShrink: 0, fontSize: 11.5, color: 'var(--lb-ink-6)' }}>Optional</span>
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
          </>
        )}
      </section>

      {/* ─── 2. LeadBridge phone (TenantPhoneNumber) ─────────────── */}
      <section style={{
        marginTop: 12,
        background: '#fff',
        border: '1px solid var(--lb-line)',
        borderRadius: 12,
        padding: 18,
      }} className="lb-wiz-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <PhoneCall size={17} style={{ color: 'var(--lb-ink-3)' }} />
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
            LeadBridge phone number
          </span>
          <button
            type="button"
            onClick={() => setInfoLbnumOpen(v => !v)}
            aria-label="More info"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 20, height: 20, border: 0, background: 'transparent',
              cursor: 'pointer', padding: 0, flexShrink: 0, marginLeft: 1,
              color: 'var(--lb-accent)',
            }}
          >
            <Info size={15} />
          </button>
        </div>
        {infoLbnumOpen && (
          <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 7, lineHeight: 1.5 }}>
            The phone number LeadBridge uses to text and call your customers. Assigned from Twilio.
            You can also assign or release numbers from Settings.
          </div>
        )}

        <div style={{ marginTop: 13 }} />
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
        ) : !showLbnumPicker ? (
          /* Canonical empty state — dashed-bordered tile + info icon +
              "No number assigned yet" + Get a number CTA. Tapping
              expands the full area-code/city picker below. */
          <>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '11px 12px 11px 14px',
              border: '1px dashed var(--lb-line)',
              borderRadius: 10,
              background: '#fff',
            }}>
              <Info size={16} style={{ flexShrink: 0, color: 'var(--lb-ink-5)' }} />
              <span style={{
                flex: 1, minWidth: 0,
                fontSize: 13, fontWeight: 600,
                color: 'var(--lb-ink-3)',
              }}>
                No number assigned yet
              </span>
              <button
                type="button"
                onClick={() => setShowLbnumPicker(true)}
                style={{
                  flexShrink: 0,
                  padding: '8px 14px',
                  borderRadius: 9,
                  border: 0,
                  background: 'var(--lb-accent)',
                  color: '#fff',
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Get a number
              </button>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--lb-ink-6)', marginTop: 9, lineHeight: 1.5 }}>
              A LeadBridge number is also assigned automatically when you connect a lead source.
            </div>
          </>
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
      <section style={{
        marginTop: 12,
        background: '#fff',
        border: '1px solid var(--lb-line)',
        borderRadius: 12,
        padding: 18,
      }} className="lb-wiz-card">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
          <Globe size={18} style={{ flexShrink: 0, marginTop: 2, color: 'var(--lb-ink-3)' }} />
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
            Business info
          </span>
          <button
            type="button"
            onClick={() => setInfoWebsiteOpen(v => !v)}
            aria-label="More info"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 20, height: 20, border: 0, background: 'transparent',
              cursor: 'pointer', padding: 0, flexShrink: 0, margin: '0 2px 0 3px',
              color: 'var(--lb-accent)',
            }}
          >
            <Info size={15} />
          </button>
          <span style={{ flex: 1, minWidth: 0 }} />
          <span style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {detectedPlatform && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                fontSize: 9.5, fontWeight: 700,
                fontFamily: 'var(--lb-font-mono)',
                textTransform: 'uppercase', letterSpacing: '.04em',
                padding: '3px 8px', borderRadius: 99,
                background: '#dbeafe', color: '#1d4ed8',
              }}>
                {platformLabel(detectedPlatform)}
              </span>
            )}
            {savedAndVerified && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                fontSize: 9.5, fontWeight: 700,
                fontFamily: 'var(--lb-font-mono)',
                textTransform: 'uppercase', letterSpacing: '.04em',
                padding: '3px 8px', borderRadius: 99,
                background: '#dcfce7', color: '#15803d',
              }}>
                <CheckCircle2 size={10} />
                Verified
              </span>
            )}
          </span>
        </div>
        {infoWebsiteOpen && (
          <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 9, lineHeight: 1.55 }}>
            Paste your <strong style={{ color: 'var(--lb-ink-2)' }}>business profile</strong>,{' '}
            <strong style={{ color: 'var(--lb-ink-2)' }}>Yelp page</strong>, or{' '}
            <strong style={{ color: 'var(--lb-ink-2)' }}>website</strong> — whichever has the most
            info about your business. We auto-detect the source and pull services, location,
            insurance, pricing, and more into your AI Playbook + FAQ.
          </div>
        )}
        <div style={{ marginTop: 13 }} />

        <div className="flex items-center gap-2 lb-wiz-inline-save">
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
                // Clear the stale apply card the moment the user edits
                // the URL — otherwise the card claims "pulled X fields"
                // from the OLD URL while the input shows the new one.
                if (lastApply && e.target.value.trim() !== lastApply.url) setLastApply(null);
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

        {/* TT / Yelp confirmation card. Renders for any populated
            lastApply (fresh fetch in this session OR persisted snapshot
            on user.websiteMetadataJson.lastBusinessApply) — Settings →
            General does the same. The previous `verifyState=valid`
            gate hid the card on reload, leaving the wizard looking
            inert even when info was actually saved server-side. */}
        {lastApply && lastApply.platform !== 'website' && !isBusy && (
          <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 flex items-start gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div className="min-w-0 text-xs flex-1">
              <div className="font-bold text-emerald-900">
                {platformLabel(lastApply.platform)} connected
                {lastApply.fieldsApplied > 0
                  ? ` — pulled ${lastApply.fieldsApplied} field${lastApply.fieldsApplied === 1 ? '' : 's'} into your Playbook`
                  : lastApply.fieldsExtracted > 0
                    ? ` — ${lastApply.fieldsExtracted} field${lastApply.fieldsExtracted === 1 ? '' : 's'} already saved`
                    : ''}
              </div>
              <div className="text-emerald-800 mt-0.5 leading-snug break-all">
                {lastApply.url}
                {lastApply.accountsAffected > 0 && (
                  <>
                    {' · '}
                    Saved on {lastApply.accountsAffected} {lastApply.accountsAffected === 1 ? 'account' : 'accounts'}
                  </>
                )}
              </div>
              {lastApply.fieldsApplied > 0 && (
                <div className="text-[11px] text-emerald-700 mt-1.5">
                  Review on the next steps or in Settings → AI Playbook after setup.
                </div>
              )}
              {lastApply.fieldsApplied === 0 && lastApply.fieldsExtracted > 0 && (
                <div className="text-[11px] text-emerald-700 mt-1.5">
                  Your AI Playbook already reflects this page's facts.
                </div>
              )}

              {/* GPT prose summary — same content WebsitePreviewCard
                  shows for the website branch. Lets the tenant scan
                  "what does the AI think this business is about?"
                  without opening the structured-fields disclosure. */}
              {lastApply.summary && (
                <div
                  className="mt-2 px-2.5 py-2 rounded-lg border border-emerald-200 bg-white text-[12px] text-slate-700 italic leading-snug"
                >
                  {lastApply.summary}
                </div>
              )}

              {/* Expandable "Show what we pulled" — renders the
                  extractedFields blob the backend now returns. Tells
                  the tenant which specific fields were saved (instead
                  of just a count) and saves a trip to Settings → AI
                  Playbook just to verify the scrape did the right
                  thing. */}
              {lastApply.extractedFields && Object.keys(lastApply.extractedFields).length > 0 && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => setShowExtracted(v => !v)}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 hover:text-emerald-900"
                  >
                    {showExtracted ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    {showExtracted ? 'Hide details' : 'Show what we pulled'}
                  </button>
                  {showExtracted && (
                    <div
                      className="mt-1.5 px-2.5 py-2 rounded-lg border border-emerald-200 bg-white text-[12px] grid"
                      style={{ gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 4 }}
                    >
                      {Object.entries(lastApply.extractedFields).map(([key, value]) => {
                        const display = formatExtractedValue(value);
                        if (!display) return null;
                        return (
                          <Fragment key={key}>
                            <div className="font-semibold text-emerald-700 whitespace-nowrap">
                              {humanizeFieldKey(key)}
                            </div>
                            <div className="text-slate-700 break-words">
                              {display}
                            </div>
                          </Fragment>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
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

      {/* ─── 4. Business hours — INLINE 7-day editor ──────────────
          Canonical FinalDesign: collapsible card with 38x38 calendar
          icon tile + title + summary subtitle + chevron. When open,
          shows 7-day grid (3-letter day code + from/to time pickers
          + per-day toggle) and a "Copy Monday to all weekdays"
          shortcut. Auto-saves debounced via the effect above —
          no separate Save button. */}
      <section
        data-wiz-anchor="schedule"
        style={{
          marginTop: 12,
          background: '#fff',
          border: '1px solid var(--lb-line)',
          borderRadius: 12,
          overflow: 'hidden',
        }}
        className="lb-wiz-card"
      >
        <button
          type="button"
          onClick={() => setHoursOpen(v => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: 13,
            width: '100%', padding: 18,
            background: '#fff', border: 0, cursor: 'pointer',
            fontFamily: 'inherit', textAlign: 'left',
          }}
        >
          <span style={{
            width: 38, height: 38, borderRadius: 10,
            background: '#dbeafe', color: '#2563eb',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <CalendarClock size={18} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{
              display: 'block', fontSize: 15, fontWeight: 700,
              color: 'var(--lb-ink-1)', letterSpacing: '-0.01em',
            }}>
              Business hours
            </span>
            <span style={{
              display: 'block', fontSize: 12, color: 'var(--lb-ink-5)',
              marginTop: 2, lineHeight: 1.4,
            }}>
              {hoursSummary}
            </span>
          </span>
          {hoursSaving ? (
            <Loader2 className="w-4 h-4 animate-spin shrink-0" style={{ color: 'var(--lb-ink-5)' }} />
          ) : hoursOpen ? (
            <ChevronUp className="shrink-0" size={17} style={{ color: 'var(--lb-ink-5)' }} />
          ) : (
            <ChevronDown className="shrink-0" size={17} style={{ color: 'var(--lb-ink-5)' }} />
          )}
        </button>
        {hoursOpen && (
          <div style={{ padding: '6px 18px 4px', borderTop: '1px solid var(--lb-line-soft)' }}>
            {DAY_KEYS.map((d, idx) => {
              const cur = businessHours[d];
              const open = !!cur;
              return (
                <div
                  key={d}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '11px 0',
                    borderBottom: idx === DAY_KEYS.length - 1 ? 'none' : '1px solid var(--lb-line-soft)',
                  }}
                >
                  <span style={{
                    width: 38, flexShrink: 0,
                    fontSize: 12.5, fontWeight: 700,
                    color: 'var(--lb-ink-2)',
                    fontFamily: 'var(--lb-font-mono)',
                  }}>
                    {DAY_LABEL[d]}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {open ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <input
                          type="time"
                          value={cur!.start}
                          onChange={(e) => setDayTime(d, 'start', e.target.value)}
                          style={{
                            display: 'inline-flex', alignItems: 'center',
                            padding: '5px 9px',
                            border: '1px solid var(--lb-line)', borderRadius: 8,
                            background: '#fff',
                            fontSize: 12, fontWeight: 600,
                            color: 'var(--lb-ink-2)',
                            fontFamily: 'var(--lb-font-mono)',
                            outline: 'none',
                          }}
                        />
                        <span style={{ fontSize: 12, color: 'var(--lb-ink-6)', flexShrink: 0 }}>–</span>
                        <input
                          type="time"
                          value={cur!.end}
                          onChange={(e) => setDayTime(d, 'end', e.target.value)}
                          style={{
                            display: 'inline-flex', alignItems: 'center',
                            padding: '5px 9px',
                            border: '1px solid var(--lb-line)', borderRadius: 8,
                            background: '#fff',
                            fontSize: 12, fontWeight: 600,
                            color: 'var(--lb-ink-2)',
                            fontFamily: 'var(--lb-font-mono)',
                            outline: 'none',
                          }}
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
                        Closed
                      </span>
                    )}
                  </span>
                  {/* Per-day on/off toggle */}
                  <button
                    type="button"
                    onClick={() => setDayOpen(d, !open)}
                    aria-pressed={open}
                    style={{
                      width: 38, height: 22, borderRadius: 999,
                      background: open ? 'var(--lb-accent)' : 'var(--lb-ink-8)',
                      border: 0, padding: 0, cursor: 'pointer',
                      position: 'relative', flexShrink: 0,
                      transition: 'background 120ms',
                    }}
                  >
                    <span style={{
                      position: 'absolute', top: 2, left: open ? 18 : 2,
                      width: 18, height: 18, borderRadius: 99,
                      background: '#fff',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
                      transition: 'left 120ms',
                    }} />
                  </button>
                </div>
              );
            })}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              margin: '12px 0', padding: '11px 13px',
              background: '#f8fafc',
              border: '1px solid var(--lb-line-soft)',
              borderRadius: 10,
              fontSize: 12.5, color: 'var(--lb-ink-4)', lineHeight: 1.5,
            }}>
              <Info size={15} style={{ flexShrink: 0, color: 'var(--lb-ink-5)' }} />
              <div>
                Outside these hours, AI can still reply instantly — set that under{' '}
                <strong style={{ color: 'var(--lb-ink-2)' }}>AI Response Mode</strong> in the next step.
              </div>
            </div>
            <button
              type="button"
              onClick={copyMondayToWeekdays}
              style={{
                marginBottom: 16,
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '8px 13px',
                border: '1px solid var(--lb-line)', borderRadius: 9,
                background: '#fff', color: 'var(--lb-ink-3)',
                fontSize: 12.5, fontWeight: 600,
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              <ChevronRight size={13} />
              Copy Monday to all weekdays
            </button>
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

// Friendly labels for the extracted-fields disclosure. Mirrors the
// EXTRACTED_FIELD_LABELS map in Settings → General; kept inline here
// because the seed schema isn't yet a shared module. If you add a new
// key in either place, add it in both.
const EXTRACTED_FIELD_LABELS: Record<string, string> = {
  serviceArea: 'Service area',
  teamSize: 'Team size',
  yearsInBusiness: 'Years in business',
  ownerName: 'Owner / founder',
  suppliesPolicy: 'Supplies policy',
  petsPolicy: 'Pets policy',
  paymentMethods: 'Payment methods',
  officeLocations: 'Office locations',
  insurance: 'Insurance',
  bonding: 'Bonding',
  licensing: 'Licensing',
  guarantees: 'Guarantees',
  ecoFriendly: 'Eco-friendly',
};

function humanizeFieldKey(key: string): string {
  if (EXTRACTED_FIELD_LABELS[key]) return EXTRACTED_FIELD_LABELS[key];
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase());
}

function formatExtractedValue(v: string | string[] | undefined): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.filter(Boolean).join(', ');
  return String(v);
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
