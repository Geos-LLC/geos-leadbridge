import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Building, Globe, Info, Loader2, Phone, Layers, Plus, Edit3,
  CheckCircle2, Archive, Settings2, X, ChevronDown, ChevronUp,
} from 'lucide-react';
import {
  SettingCard, FieldRow, Dropdown, FooterBanner,
} from '../../components/automation/ui';
import { useAuthStore } from '../../store/authStore';
import { useAppStore } from '../../store/appStore';
import { usersApi, authApi, serviceProfilesApi, type ServiceProfile } from '../../services/api';
import { notify } from '../../store/notificationStore';
import { WebsitePreviewCard } from '../../components/WebsitePreviewCard';
import { ApplyToPlaybookButton } from '../../components/ApplyToPlaybookButton';
import { ManualBusinessInfoModal } from '../../components/ManualBusinessInfoModal';
import { PresetPickerModal } from './Services';

export function SettingsGeneral() {
  const user = useAuthStore(s => s.user);
  const token = useAuthStore(s => s.token);
  const setAuth = useAuthStore(s => s.setAuth);
  const savedAccounts = useAppStore(s => s.savedAccounts);

  // The "Pull from Thumbtack / Yelp" buttons are removed in the unified
  // URL flow — the Apply button on the URL field does both jobs (save
  // URL + run the seed pipeline) in one click. We keep `pullingFrom`
  // wired only as the busy state for the unified apply.
  const [pullingFrom, setPullingFrom] = useState<'apply' | null>(null);
  void pullingFrom; // referenced via setter in handleApplyBusinessUrl

  // Detected platform from the LAST successful apply — drives the small
  // badge next to the URL field's "Verified" pill. Hydrated on mount
  // from the unified GET endpoint.
  const [detectedPlatform, setDetectedPlatform] = useState<'thumbtack' | 'yelp' | 'website' | null>(null);

  const [business, setBusiness] = useState<string>((user as any)?.businessName || user?.name || '');
  const [tz, setTz] = useState<string>('America/New_York');
  const [website, setWebsite] = useState<string>(user?.website ?? '');
  const [websiteMetadata, setWebsiteMetadata] = useState<any>((user as any)?.websiteMetadataJson ?? null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  // Fallback modal — opens when the URL scrape returns nothing usable
  // (failure or zero-fields), and can also be opened manually via the
  // "paste it instead" link under the URL field. Tracks the URL that
  // failed so the modal can echo it in its header.
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  // In-memory snapshot of the last successful applyBusinessProfileUrl
  // call. TT / Yelp paths don't populate User.website + websiteMetadata,
  // so the existing WebsitePreviewCard never renders for them — leaving
  // the page looking inert after a successful TT fetch. This snapshot
  // backs a small TT/Yelp confirmation card and is invalidated the
  // moment the URL input is edited (so the card never shows stale
  // results from a different URL).
  const [lastApply, setLastApply] = useState<{
    platform: 'thumbtack' | 'yelp' | 'website';
    url: string;
    fieldsApplied: number;
    // Count of fields the scrape returned BEFORE merge. When > 0 but
    // fieldsApplied === 0, it means the page DID yield structured data
    // but everything already matches what's saved — that's a very
    // different message from "page yielded nothing." Without this gap
    // the emerald card was incorrectly telling Spotless Tampa "No
    // structured info was extracted" when the scrape was extracting 7
    // fields every time (just all already saved).
    fieldsExtracted: number;
    /** Actual key/value pairs the scrape returned. Powers the
     *  expandable "Show what we pulled" disclosure under the card. */
    extractedFields?: Record<string, string | string[]>;
    /** GPT-generated prose summary of the scraped page. Shown directly
     *  in the card body for a quick "what does the AI see on this
     *  page?" read — same surface WebsitePreviewCard uses for the
     *  website branch. */
    summary?: string;
    accountsAffected: number;
  } | null>(null);
  // Expand/collapse the "what we pulled" disclosure under the emerald card.
  const [showExtracted, setShowExtracted] = useState(false);
  const [businessPhone, setBusinessPhone] = useState<string>((user as any)?.businessPhone || '');
  const [businessPhoneError, setBusinessPhoneError] = useState<string | null>(null);
  const [savingBusinessPhone, setSavingBusinessPhone] = useState(false);
  const [businessPhoneSavedAt, setBusinessPhoneSavedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  // Preserved for potential busy-state UI later.
  const [_saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(null), 2000);
    return () => clearTimeout(t);
  }, [savedAt]);

  // Pull timezone from business-hours endpoint (single source of truth).
  // Mark hydration done after the initial load so debounced auto-save doesn't
  // fire on the very first state-set.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    usersApi.getBusinessHours()
      .then(bh => { if (alive && bh.timezone) setTz(bh.timezone); })
      .catch(() => { /* non-fatal */ })
      .finally(() => {
        if (alive) {
          setLoading(false);
          // Defer hydration flag until after this render commits so the
          // setTz above doesn't trip auto-save.
          setTimeout(() => { hydratedRef.current = true; }, 0);
        }
      });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!business && ((user as any)?.businessName || user?.name)) {
      setBusiness((user as any)?.businessName || user?.name || '');
    }
  }, [user, business]);

  // Re-hydrate website + metadata when the cached auth user updates (e.g. after
  // an authApi.getProfile() refresh elsewhere). The URL input is user-typed so
  // we only seed it when empty. websiteMetadata is API-derived (verify writes
  // it), so we ALWAYS resync — that lets us pick up the newer playbookSeed
  // shape on cache refresh, which drives the Apply-to-Playbook button enable.
  useEffect(() => {
    if (!website && user?.website) setWebsite(user.website);
    const fresh = (user as any)?.websiteMetadataJson ?? null;
    setWebsiteMetadata(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Hydrate the unified URL field from whichever source has a saved
  // value (TT publicProfileUrl > Yelp publicProfileUrl > User.website).
  // Runs on mount + whenever the cached savedAccounts list changes, so
  // a freshly-connected TT account's saved URL fills the field without
  // a hard reload.
  useEffect(() => {
    let alive = true;
    usersApi.getBusinessProfileUrl()
      .then(res => {
        if (!alive) return;
        if (res.url && !website.trim()) setWebsite(res.url);
        if (res.platform) setDetectedPlatform(res.platform);
      })
      .catch(() => { /* non-fatal */ });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedAccounts.length]);

  // Force-refresh the cached user once on mount. The Apply-to-Playbook button
  // gates on `websiteMetadata.playbookSeed`, which only landed in the verify
  // flow recently; users who verified earlier have a stale auth-store entry
  // without `playbookSeed` and would see the button stuck disabled until
  // their next login. One getProfile call closes that gap.
  useEffect(() => {
    if (!token) return;
    authApi.getProfile().then((fresh: any) => {
      const u = fresh?.user ?? fresh;
      if (u?.id) setAuth(u, token);
    }).catch(() => { /* non-fatal */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Unified Apply handler — backend detects platform from hostname and
  // routes to TT fan-out / Yelp fan-out / generic website. Replaces both
  // the prior `verifyAndSaveWebsite` and the per-platform pull buttons.
  const applyBusinessUrl = async () => {
    const trimmed = website.trim();
    if (trimmed.length === 0) {
      // Empty value — clear User.website (keeps the per-account TT/Yelp
      // URLs intact; clearing those is out of scope for v1 of this flow).
      setVerifying(true);
      setVerifyError(null);
      try {
        await usersApi.updateProfile({ website: null, websiteMetadata: null });
        setWebsiteMetadata(null);
        setDetectedPlatform(null);
        if (token) {
          try {
            const fresh: any = await authApi.getProfile();
            const u = fresh?.user ?? fresh;
            if (u?.id) setAuth(u, token);
          } catch { /* silent */ }
        }
        setSavedAt(Date.now());
      } finally {
        setVerifying(false);
      }
      return;
    }

    setVerifying(true);
    setVerifyError(null);
    setPullingFrom('apply');
    try {
      const res = await usersApi.applyBusinessProfileUrl(trimmed);
      if (!res.success || !res.savedUrl) {
        setVerifyError(res.warning || "We couldn't load that link.");
        // Site couldn't be reached or returned no usable data — surface
        // the fallback modal so the tenant has an immediate next step
        // (try a Thumbtack URL OR paste the info manually) without
        // having to hunt for a workflow.
        setFallbackUrl(trimmed);
        setFallbackOpen(true);
        return;
      }
      setDetectedPlatform(res.platform);
      setWebsite(res.savedUrl);
      // Snapshot for the TT/Yelp confirmation card. Mirrors the wizard
      // pattern — the WebsitePreviewCard below this only renders for
      // platform='website', so without this snapshot a TT/Yelp fetch
      // leaves the page with no visible "we just saved it" evidence.
      setLastApply({
        platform: res.platform,
        url: res.savedUrl,
        fieldsApplied: res.fieldsApplied ?? 0,
        fieldsExtracted: res.fieldsExtracted ?? 0,
        extractedFields: res.extractedFields,
        summary: res.summary,
        accountsAffected: res.accountsAffected ?? 0,
      });
      // Default the disclosure to collapsed on each fresh fetch so the
      // card doesn't visually balloon every Pull click.
      setShowExtracted(false);
      if (res.platform === 'website') {
        // Generic site path also updated User.website + metadata.
        setWebsiteMetadata((res.websiteMetadata as any) ?? null);
      }
      if (token) {
        try {
          const fresh: any = await authApi.getProfile();
          const u = fresh?.user ?? fresh;
          if (u?.id) {
            setAuth(u, token);
            setWebsiteMetadata((u as any).websiteMetadataJson ?? null);
          }
        } catch { /* silent */ }
      }
      const platformWord =
        res.platform === 'thumbtack' ? 'Thumbtack' :
        res.platform === 'yelp' ? 'Yelp' :
        'your website';
      const extracted = res.fieldsExtracted ?? 0;
      if (res.fieldsApplied > 0) {
        notify.success(
          `Pulled from ${platformWord}`,
          `Filled ${res.fieldsApplied} field${res.fieldsApplied === 1 ? '' : 's'}. Review in Settings → AI Playbook.`,
          4500,
        );
      } else if (extracted > 0) {
        // Scrape worked and DID return structured facts, but every one
        // already matches what's in bizInfo (likely a re-run on the same
        // URL). The card below this confirms the connection — no need to
        // open the fallback paste modal in this case.
        notify.success(
          `${platformWord} profile up to date`,
          `${extracted} field${extracted === 1 ? ' was' : 's were'} already saved from earlier — nothing new to add.`,
          4500,
        );
      } else {
        // Scrape technically succeeded (URL was reachable) but nothing
        // structured came back — the BookingKoala-SPA / meta-less-site
        // case. Save the URL silently but also offer the fallback so the
        // tenant isn't stuck wondering why "no fields" happened.
        notify.success(
          `${platformWord} link saved`,
          'No new fields to add — try pasting your business info if you want richer Playbook coverage.',
          4500,
        );
        setFallbackUrl(trimmed);
        setFallbackOpen(true);
      }
      setSavedAt(Date.now());
    } catch (e: any) {
      setVerifyError(e?.response?.data?.message || e?.message || 'Failed to apply');
    } finally {
      setVerifying(false);
      setPullingFrom(null);
    }
  };

  // Pre-fill business phone from the user object (set during registration or
  // by Settings → Communication). Re-runs when the auth store user updates.
  useEffect(() => {
    setBusinessPhone((user as any)?.businessPhone || '');
  }, [(user as any)?.id, (user as any)?.businessPhone]);

  useEffect(() => {
    if (!businessPhoneSavedAt) return;
    const t = setTimeout(() => setBusinessPhoneSavedAt(null), 2200);
    return () => clearTimeout(t);
  }, [businessPhoneSavedAt]);

  const handleSaveBusinessPhone = async () => {
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
      if (token) {
        try {
          const fresh: any = await authApi.getProfile();
          const u = fresh?.user ?? fresh;
          if (u?.id) setAuth(u, token);
        } catch { /* silent */ }
      }
      setBusinessPhoneSavedAt(Date.now());
    } catch (e: any) {
      setBusinessPhoneError(e?.response?.data?.message || e?.message || 'Failed to save');
    } finally {
      setSavingBusinessPhone(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await usersApi.updateProfile({ name: business });
      await usersApi.updateBusinessHours({ timezone: tz });
      // Refresh cached auth user so the rest of the app sees the new name.
      if (token) {
        try {
          const fresh: any = await authApi.getProfile();
          const u = fresh?.user ?? fresh;
          if (u?.id) setAuth(u, token);
        } catch { /* silent */ }
      }
      setSavedAt(Date.now());
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // Auto-save (debounced ~800ms — slightly longer since "business name" is a
  // text field).
  useEffect(() => {
    if (!hydratedRef.current) return;
    const t = setTimeout(() => { handleSave(); }, 800);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business, tz]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error && (
        <div style={{
          padding: '10px 14px', borderRadius: 10,
          background: 'var(--lb-danger-tint)', color: 'var(--lb-danger)',
          fontSize: 13, fontWeight: 600,
        }}>{error}</div>
      )}
      {savedAt && !error && (
        <div style={{
          padding: '10px 14px', borderRadius: 10,
          background: 'var(--lb-success-tint)', color: 'var(--lb-success)',
          fontSize: 13, fontWeight: 600,
        }}>Saved.</div>
      )}

      <SettingCard
        icon={Building}
        iconTone="violet"
        title="Business profile"
        subtitle="How your business shows up in customer replies and notifications."
        contentPad="8px 24px 24px"
      >
        <FieldRow label="Business name">
          <SettingsInput value={business} onChange={setBusiness} />
        </FieldRow>
        <FieldRow label="Timezone" noBorder>
          {loading ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--lb-ink-5)', fontSize: 13 }}>
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : (
            <Dropdown
              value={tz}
              onChange={setTz}
              width="100%"
              options={[
                'America/New_York',
                'America/Chicago',
                'America/Denver',
                'America/Los_Angeles',
                'America/Phoenix',
              ]}
            />
          )}
        </FieldRow>
      </SettingCard>

      <SettingCard
        icon={Globe}
        iconTone="violet"
        title="Business profile or website"
        subtitle="Paste your Thumbtack profile, Yelp business page, or website — we auto-detect the source and pull info into your AI Playbook + FAQ."
        contentPad="8px 24px 24px"
      >
        <FieldRow label="URL">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <SettingsInput
                value={website}
                onChange={(next) => {
                  setWebsite(next);
                  // Edit invalidates the platform badge + the last-apply
                  // confirmation card. Without this the badge says
                  // THUMBTACK while the input shows a bookingkoala URL
                  // (reported 2026-06-17 — stale state from a prior fetch).
                  if (detectedPlatform && next.trim() !== website.trim()) {
                    setDetectedPlatform(null);
                  }
                  if (lastApply && next.trim() !== lastApply.url) {
                    setLastApply(null);
                  }
                  if (verifyError) setVerifyError(null);
                }}
                placeholder="thumbtack.com/… · yelp.com/biz/… · myco.com"
              />
            </div>
            {detectedPlatform && (
              <span style={{
                fontSize: 11, fontWeight: 700,
                padding: '4px 10px', borderRadius: 999,
                background: 'var(--lb-accent-tint, #dbeafe)',
                color: 'var(--lb-accent, #2563eb)',
                textTransform: 'uppercase', letterSpacing: 0.02,
              }}>
                {detectedPlatform === 'thumbtack' ? 'Thumbtack' : detectedPlatform === 'yelp' ? 'Yelp' : 'Website'}
              </span>
            )}
            <button
              type="button"
              onClick={() => void applyBusinessUrl()}
              disabled={verifying}
              style={{
                padding: '9px 16px',
                fontSize: 13, fontWeight: 700,
                color: 'white',
                background: 'var(--lb-accent)',
                border: 0, borderRadius: 8,
                cursor: verifying ? 'not-allowed' : 'pointer',
                opacity: verifying ? 0.6 : 1,
                display: 'inline-flex', alignItems: 'center', gap: 6,
                whiteSpace: 'nowrap',
              }}
            >
              {verifying ? <Loader2 size={13} className="animate-spin" /> : null}
              {verifying ? 'Fetching…' : 'Fetch & save'}
            </button>
            {/* Apply-to-Playbook stays for the website path — only shows
                a usable seed when a generic website was the source. The
                TT/Yelp paths apply automatically during Fetch & save. */}
            <ApplyToPlaybookButton
              hasSeed={!!websiteMetadata?.playbookSeed}
              tone="settings"
            />
          </div>
        </FieldRow>
        {verifyError && (
          <div style={{
            margin: '0 24px 12px', padding: '8px 12px', borderRadius: 8,
            background: 'var(--lb-danger-tint)', color: 'var(--lb-danger)',
            fontSize: 12, fontWeight: 600,
          }}>{verifyError}</div>
        )}
        {/* Persistent fallback link — for tenants whose site can't be
            scraped (Yelp/BookingKoala/Cloudflare) or who'd just rather
            type the info than guess at a URL. The same modal auto-opens
            on a failed apply, but having it surfaced here means a tenant
            who already KNOWS their site won't scrape doesn't have to fail
            once to find this path. */}
        <div style={{ margin: '0 24px 14px', fontSize: 12, color: 'var(--lb-ink-5)' }}>
          Site not scraping?{' '}
          <button
            type="button"
            onClick={() => { setFallbackUrl(website.trim() || null); setFallbackOpen(true); }}
            style={{
              border: 0, background: 'transparent', padding: 0,
              color: 'var(--lb-link, #2563eb)', cursor: 'pointer',
              fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
              textDecoration: 'underline',
            }}
          >
            Paste your business info instead
          </button>
        </div>
        {detectedPlatform === 'website' && (user?.website || websiteMetadata) && (
          <div style={{ padding: '0 24px 12px' }}>
            <WebsitePreviewCard
              url={user?.website || website || null}
              metadata={websiteMetadata}
              tone="settings"
            />
          </div>
        )}

        {/* TT / Yelp confirmation card — mirrors the wizard's emerald
            card. WebsitePreviewCard above is hard-gated on the website
            path because the underlying data only exists for that path.
            Without this card a TT/Yelp fetch shows zero visible
            confirmation (tenant reported 2026-06-17: "no info is showed"
            after a successful TT fetch). */}
        {lastApply && lastApply.platform !== 'website' && lastApply.url.trim() === website.trim() && (
          <div style={{ padding: '0 24px 12px' }}>
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '12px 14px', borderRadius: 12,
              border: '1px solid #a7f3d0',
              background: '#ecfdf5',
              color: '#065f46',
              fontSize: 12.5, lineHeight: 1.5,
            }}>
              <CheckCircle2 size={16} style={{ flexShrink: 0, marginTop: 1, color: '#059669' }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 700, color: '#064e3b' }}>
                  {lastApply.platform === 'thumbtack' ? 'Thumbtack profile' : 'Yelp business page'} connected
                  {lastApply.fieldsApplied > 0
                    ? ` — pulled ${lastApply.fieldsApplied} field${lastApply.fieldsApplied === 1 ? '' : 's'} into your AI Playbook`
                    : lastApply.fieldsExtracted > 0
                      ? ` — ${lastApply.fieldsExtracted} field${lastApply.fieldsExtracted === 1 ? '' : 's'} already saved`
                      : ''}
                </div>
                <div style={{ marginTop: 3, wordBreak: 'break-all' }}>
                  {lastApply.url}
                  {lastApply.accountsAffected > 0 && (
                    <> · Saved on {lastApply.accountsAffected} {lastApply.accountsAffected === 1 ? 'account' : 'accounts'}</>
                  )}
                </div>
                {/* Three cases distinguished by (fieldsApplied, fieldsExtracted):
                    - (>0, *)  : new data merged — primary headline covers it
                    - (0, >0)  : everything on the page already matches saved — quiet "up to date" note
                    - (0, 0)   : scrape worked but yielded no structured facts — point to manual paste */}
                {lastApply.fieldsApplied === 0 && lastApply.fieldsExtracted > 0 && (
                  <div style={{ marginTop: 5, color: '#065f46', fontSize: 11.5 }}>
                    Your AI Playbook already reflects this page's facts. Re-fetch any time you update the listing.
                  </div>
                )}
                {lastApply.fieldsApplied === 0 && lastApply.fieldsExtracted === 0 && (
                  <div style={{ marginTop: 5, color: '#78350f', fontSize: 11.5 }}>
                    No structured info was extracted from that page. Use the "Paste your business info instead" link above
                    to fill the Playbook by hand.
                  </div>
                )}
                {/* GPT prose summary — same content `WebsitePreviewCard`
                    surfaces for the website branch. For TT/Yelp scrapes
                    summarizeWebsite was already producing this (Loki:
                    "extracted summary=738ch") and it was being discarded.
                    Plain serif read so the tenant can scan "what does
                    the AI think this business is about?" without opening
                    the structured-fields disclosure. */}
                {lastApply.summary && (
                  <div style={{
                    marginTop: 8,
                    padding: '8px 10px',
                    background: 'white',
                    border: '1px solid #d1fae5',
                    borderRadius: 8,
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: '#1f2937',
                    fontStyle: 'italic',
                  }}>
                    {lastApply.summary}
                  </div>
                )}
                {/* Expandable "Show what we pulled" — renders the extractedFields
                    blob the backend now returns. Tenants asked for inline
                    visibility of WHICH fields were saved; tells them more
                    than a count and saves a trip to Settings → AI Playbook
                    just to verify the scrape did the right thing. */}
                {lastApply.extractedFields && Object.keys(lastApply.extractedFields).length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      onClick={() => setShowExtracted((v) => !v)}
                      style={{
                        background: 'transparent', border: 0, padding: 0,
                        color: '#065f46', fontSize: 11.5, fontWeight: 600,
                        cursor: 'pointer', fontFamily: 'inherit',
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                      }}
                    >
                      {showExtracted ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      {showExtracted ? 'Hide details' : 'Show what we pulled'}
                    </button>
                    {showExtracted && (
                      <div style={{
                        marginTop: 6,
                        padding: '8px 10px',
                        background: 'white',
                        border: '1px solid #d1fae5',
                        borderRadius: 8,
                        fontSize: 12,
                        color: '#064e3b',
                        display: 'grid',
                        gridTemplateColumns: 'auto 1fr',
                        columnGap: 12,
                        rowGap: 4,
                      }}>
                        {Object.entries(lastApply.extractedFields).map(([key, value]) => {
                          const display = formatExtractedValue(value as any);
                          if (!display) return null;
                          return (
                            <React.Fragment key={key}>
                              <div style={{ fontWeight: 600, color: '#047857', whiteSpace: 'nowrap' }}>
                                {humanizeFieldKey(key)}
                              </div>
                              <div style={{ color: '#1f2937', wordBreak: 'break-word' }}>
                                {display}
                              </div>
                            </React.Fragment>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </SettingCard>

      <SettingCard
        icon={Phone}
        iconTone="blue"
        title="Business phone"
        subtitle="Your primary owner / company number. Used for owner alerts and auto-registered on connected Thumbtack businesses as an associate phone."
        contentPad="8px 24px 24px"
      >
        <FieldRow label="Phone number" noBorder>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              value={businessPhone}
              onChange={e => setBusinessPhone(e.target.value)}
              placeholder="+1 (555) 010-1234"
              style={{
                flex: '1 1 auto', minWidth: 0,
                padding: '9px 12px',
                border: '1px solid var(--lb-line)', borderRadius: 8,
                fontSize: 13, fontFamily: 'inherit',
                background: 'white', color: 'var(--lb-ink-1)',
                outline: 'none',
              }}
            />
            {businessPhoneSavedAt && !businessPhoneError && (
              <span style={{ color: 'var(--lb-success, #059669)', fontSize: 12, fontWeight: 600 }}>Saved</span>
            )}
            <button
              type="button"
              onClick={handleSaveBusinessPhone}
              disabled={savingBusinessPhone || (businessPhone.trim() === ((user as any)?.businessPhone || ''))}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '9px 14px', borderRadius: 8,
                border: 'none',
                background: savingBusinessPhone || (businessPhone.trim() === ((user as any)?.businessPhone || ''))
                  ? 'var(--lb-ink-tint, #e2e8f0)' : '#2563eb',
                color: savingBusinessPhone || (businessPhone.trim() === ((user as any)?.businessPhone || ''))
                  ? 'var(--lb-ink-5, #64748b)' : 'white',
                fontSize: 13, fontWeight: 600,
                cursor: savingBusinessPhone ? 'not-allowed' : 'pointer',
              }}
            >
              {savingBusinessPhone && <Loader2 size={14} className="animate-spin" />}
              {savingBusinessPhone ? 'Saving…' : 'Save'}
            </button>
          </div>
          {businessPhoneError && (
            <div style={{
              marginTop: 8, padding: '8px 12px', borderRadius: 8,
              background: 'var(--lb-danger-tint, #fee2e2)',
              color: 'var(--lb-danger, #dc2626)',
              fontSize: 12, fontWeight: 600,
            }}>
              {businessPhoneError}
            </div>
          )}
        </FieldRow>
      </SettingCard>

      <ServicesOfferedSection />

      <FooterBanner icon={Info} body="Account-level changes apply across all your connected sources." />

      {/* Manual-paste fallback — auto-opens when the URL fetch fails or
          returns zero new fields; also reachable via the "paste it
          instead" link beneath the URL row. */}
      <ManualBusinessInfoModal
        isOpen={fallbackOpen}
        failedUrl={fallbackUrl}
        onClose={() => setFallbackOpen(false)}
        onSuccess={async ({ platform }) => {
          // Same post-success rehydrate as the URL path so the AI Playbook
          // / Business-info card see the freshly-merged seed without a
          // full page reload.
          if (platform) setDetectedPlatform(platform as any);
          if (token) {
            try {
              const fresh: any = await authApi.getProfile();
              const u = fresh?.user ?? fresh;
              if (u?.id) {
                setAuth(u, token);
                setWebsiteMetadata((u as any).websiteMetadataJson ?? null);
              }
            } catch { /* silent */ }
          }
          setSavedAt(Date.now());
          setFallbackOpen(false);
        }}
      />
    </div>
  );
}

// Maps the playbookSeed.businessInformation camelCase keys to the labels
// the user sees in Settings → AI Playbook. Anything not in the map falls
// back to a humanized version of the key. Kept inline rather than
// imported so the seed schema and its display strings don't drift; the
// schema is the source of truth.
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
  // camelCase → "Camel Case"
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

function formatExtractedValue(v: string | string[]): string {
  if (Array.isArray(v)) return v.filter(Boolean).join(', ');
  return String(v);
}

function SettingsInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: '100%', padding: '9px 12px',
        border: '1px solid var(--lb-line)', borderRadius: 8,
        fontSize: 13, fontFamily: 'inherit',
        background: 'white', color: 'var(--lb-ink-1)',
        outline: 'none',
      }}
    />
  );
}

// ─── Services Offered section (PR-D) ─────────────────────────────────────
//
// Services are part of business setup, so they live here in General as a
// section rather than as their own top-level Settings tab. This list shows
// every non-archived ServiceProfile with quick status transitions and a
// "View / Edit playbook" deep link to AI Playbook (the canonical service
// content surface now). "Create from preset" reuses the same modal the old
// /settings?tab=services page used so the create flow stays one-click.
//
// Archived profiles are revealed via a "Show N archived" toggle, mirroring
// the AI Playbook tab strip pattern from PR-B.1.

const SECTION_ANCHOR = 'services-offered';
const HOUSE_CLEANING_INDICATORS = /\b(bedroom|bathroom|sq ?ft|square ?feet|cleaning)\b/i;

function detectHouseCleaning(profile: ServiceProfile): boolean {
  try {
    if (profile.pricingJson) {
      const pricing = JSON.parse(profile.pricingJson);
      if (pricing && pricing.pricingModel === 'bed_bath_grid') return true;
    }
  } catch { /* fall through */ }
  const blob = `${profile.pricingJson ?? ''} ${profile.faqJson ?? ''}`;
  return HOUSE_CLEANING_INDICATORS.test(blob);
}

function displayName(profile: ServiceProfile): string {
  if (profile.isDefault && profile.name === 'Default Service' && detectHouseCleaning(profile)) {
    return 'House Cleaning';
  }
  return profile.name;
}

type SavedAccountAssignment = {
  savedAccountId: string;
  businessName: string;
  platform: string;
  configured: boolean;
  enabledServiceProfileIds: string[];
  defaultServiceProfileId: string | null;
};

function ServicesOfferedSection() {
  const [profiles, setProfiles] = useState<ServiceProfile[] | null>(null);
  const [assignments, setAssignments] = useState<SavedAccountAssignment[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshTok, setRefreshTok] = useState(0);
  const [showPresetModal, setShowPresetModal] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [managingProfileId, setManagingProfileId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    Promise.all([
      serviceProfilesApi.list(),
      serviceProfilesApi.listSavedAccountAssignments().catch((err) => {
        // Assignments endpoint is new in PR-E. If it fails on a tenant
        // hitting an older deploy, we still show the services list.
        // eslint-disable-next-line no-console
        console.warn('listSavedAccountAssignments failed', err);
        return { accounts: [] };
      }),
    ])
      .then(([profileRes, assignRes]) => {
        if (cancelled) return;
        setProfiles(profileRes.profiles);
        setAssignments(assignRes.accounts);
      })
      .catch((err: any) => {
        if (!cancelled) setLoadError(err?.response?.data?.message ?? err?.message ?? 'Failed to load services');
      });
    return () => { cancelled = true; };
  }, [refreshTok]);

  const refresh = () => setRefreshTok((t) => t + 1);

  const { primary, archived } = useMemo(() => {
    if (!profiles) return { primary: [] as ServiceProfile[], archived: [] as ServiceProfile[] };
    const rank = (p: ServiceProfile) =>
      p.status === 'active' ? (p.isDefault ? 0 : 1) : 2;
    const primarySorted = profiles
      .filter((p) => p.status !== 'archived')
      .slice()
      .sort((a, b) => {
        const d = rank(a) - rank(b);
        if (d !== 0) return d;
        return displayName(a).localeCompare(displayName(b));
      });
    const archivedSorted = profiles
      .filter((p) => p.status === 'archived')
      .slice()
      .sort((a, b) => displayName(a).localeCompare(displayName(b)));
    return { primary: primarySorted, archived: archivedSorted };
  }, [profiles]);

  const handleActivate = async (profile: ServiceProfile) => {
    setBusy(`activate-${profile.id}`);
    try {
      await serviceProfilesApi.transitionStatus(profile.id, 'active');
      notify.success('Activated', `${displayName(profile)} is now active. AI replies will use this profile for matched leads.`);
      refresh();
    } catch (err: any) {
      notify.error('Could not activate', err?.response?.data?.message ?? err?.message ?? 'Activation failed');
    } finally {
      setBusy(null);
    }
  };

  // Archived → Active reactivation. Backend transitionStatus requires
  // allowReactivate=true for this jump so a misclick on a draft Archive
  // button can't accidentally promote a long-dormant profile back into
  // the AI flow.
  const handleReactivate = async (profile: ServiceProfile) => {
    if (!confirm(`Reactivate "${displayName(profile)}"? AI replies will resume for leads matched to this service.`)) return;
    setBusy(`reactivate-${profile.id}`);
    try {
      await serviceProfilesApi.transitionStatus(profile.id, 'active', true);
      notify.success('Reactivated', `${displayName(profile)} is active again.`);
      refresh();
    } catch (err: any) {
      notify.error('Could not reactivate', err?.response?.data?.message ?? err?.message ?? 'Reactivation failed');
    } finally {
      setBusy(null);
    }
  };

  const handleArchive = async (profile: ServiceProfile) => {
    if (!confirm(`Archive "${displayName(profile)}"? Matched leads will fall back to the default profile.`)) return;
    setBusy(`archive-${profile.id}`);
    try {
      await serviceProfilesApi.transitionStatus(profile.id, 'archived');
      notify.success('Archived', `${displayName(profile)} is archived.`);
      refresh();
    } catch (err: any) {
      notify.error('Could not archive', err?.response?.data?.message ?? err?.message ?? 'Archive failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div id={SECTION_ANCHOR}>
      <SettingCard
        icon={Layers}
        iconTone="blue"
        title="Services offered"
        subtitle="Each service has its own pricing, FAQ, and qualification questions. AI replies use the profile that matches the lead's category. Edit a service's playbook in AI Playbook → service tab."
        contentPad="8px 24px 24px"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
          <button
            type="button"
            onClick={() => setShowPresetModal(true)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', borderRadius: 8,
              border: '1px solid #bfdbfe',
              background: '#2563eb', color: 'white',
              fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <Plus size={14} /> Create from preset
          </button>
          <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)' }}>
            New profiles start as drafts — AI replies stay paused until you activate.
          </div>
        </div>

        {loadError && (
          <div style={{
            padding: 12, borderRadius: 8, background: '#fef2f2', color: '#b91c1c',
            fontSize: 13, marginBottom: 12,
          }}>{loadError}</div>
        )}
        {!profiles && !loadError && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--lb-ink-5)', fontSize: 13 }}>
            <Loader2 size={14} className="animate-spin" /> Loading services…
          </div>
        )}
        {profiles && profiles.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--lb-ink-5)' }}>
            No services yet. Click "Create from preset" above to get started with curated pricing + FAQ + qualification.
          </div>
        )}
        {profiles && profiles.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {primary.map((p) => (
              <ServiceRow
                key={p.id}
                profile={p}
                busy={busy}
                assignments={assignments}
                onActivate={() => handleActivate(p)}
                onArchive={() => handleArchive(p)}
                onReactivate={() => handleReactivate(p)}
                onManageAvailability={() => setManagingProfileId(p.id)}
              />
            ))}
            {showArchived && archived.map((p) => (
              <ServiceRow
                key={p.id}
                profile={p}
                busy={busy}
                assignments={assignments}
                onActivate={() => handleActivate(p)}
                onArchive={() => handleArchive(p)}
                onReactivate={() => handleReactivate(p)}
                onManageAvailability={() => setManagingProfileId(p.id)}
              />
            ))}
            {archived.length > 0 && (
              <button
                type="button"
                onClick={() => setShowArchived((v) => !v)}
                style={{
                  alignSelf: 'flex-start',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 10px', borderRadius: 8,
                  border: '1px dashed var(--lb-line)',
                  background: 'transparent', color: 'var(--lb-ink-5)',
                  fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                  marginTop: 6,
                }}
              >
                <Archive size={12} />
                {showArchived ? 'Hide archived' : `Show ${archived.length} archived`}
              </button>
            )}
          </div>
        )}

        <div style={{ marginTop: 16, fontSize: 12, color: 'var(--lb-ink-5)' }}>
          Per-account overrides and advanced settings live in{' '}
          <a href="/settings?tab=services" style={{ color: 'var(--lb-accent)', fontWeight: 600 }}>
            advanced services management
          </a>.
        </div>
      </SettingCard>

      {showPresetModal && (
        <PresetPickerModal
          onClose={() => setShowPresetModal(false)}
          onCreated={() => { setShowPresetModal(false); refresh(); }}
        />
      )}

      {managingProfileId && profiles && (
        <ManageAvailabilityModal
          profile={profiles.find((p) => p.id === managingProfileId) ?? null}
          assignments={assignments ?? []}
          onClose={() => setManagingProfileId(null)}
          onSaved={() => { setManagingProfileId(null); refresh(); }}
        />
      )}
    </div>
  );
}

function ServiceRow({
  profile,
  busy,
  assignments,
  onActivate,
  onArchive,
  onReactivate,
  onManageAvailability,
}: {
  profile: ServiceProfile;
  busy: string | null;
  assignments: SavedAccountAssignment[] | null;
  onActivate: () => void;
  onArchive: () => void;
  onReactivate: () => void;
  onManageAvailability: () => void;
}) {
  const name = displayName(profile);
  const isActive = profile.status === 'active';
  const isDraft = profile.status === 'draft';
  const isArchived = profile.status === 'archived';

  // PR-E — derive "Offered by" from per-account assignments.
  // - configured accounts that include this profile → counted as offering it
  // - unconfigured accounts → treated as "not declared" (omitted from
  //   the count so users don't conflate silence with explicit opt-in)
  const accountsOffering = useMemo(() => {
    if (!assignments) return [] as SavedAccountAssignment[];
    return assignments.filter(
      (a) => a.configured && a.enabledServiceProfileIds.includes(profile.id),
    );
  }, [assignments, profile.id]);

  const totalConfigured = useMemo(() => {
    if (!assignments) return 0;
    return assignments.filter((a) => a.configured).length;
  }, [assignments]);

  return (
    <div style={{
      border: '1px solid var(--lb-line)',
      borderRadius: 10,
      padding: 14,
      background: 'white',
      display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap',
    }}>
      <div style={{ flex: 1, minWidth: 240 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--lb-ink-1)' }}>{name}</div>
          <StatusBadge status={profile.status} />
          {profile.isDefault && <DefaultBadge />}
        </div>
        <div style={{ fontSize: 12, color: 'var(--lb-ink-5)' }}>
          {isActive && !isArchived && 'AI replies use this profile for matched leads.'}
          {isDraft && 'AI replies stay paused until you activate.'}
          {isArchived && 'Not used for AI replies. Edits stay saved.'}
        </div>
        {assignments && !isArchived && (
          <div style={{ fontSize: 12, color: 'var(--lb-ink-5)', marginTop: 6 }}>
            {accountsOffering.length === 0 && totalConfigured === 0 && (
              <span>
                <strong>Offered by:</strong>{' '}
                <span style={{ color: 'var(--lb-ink-4)' }}>all connected accounts (no per-account setup)</span>
              </span>
            )}
            {accountsOffering.length === 0 && totalConfigured > 0 && (
              <span style={{ color: '#b45309' }}>
                <strong>Not offered by any account.</strong> Click Manage availability to enable.
              </span>
            )}
            {accountsOffering.length > 0 && (
              <span>
                <strong>Offered by:</strong>{' '}
                {accountsOffering
                  .slice(0, 3)
                  .map((a) => a.businessName || a.platform)
                  .join(', ')}
                {accountsOffering.length > 3 && ` + ${accountsOffering.length - 3} more`}
              </span>
            )}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: 'wrap' }}>
        <a
          href={`/settings?tab=ai-playbook&scope=${encodeURIComponent(profile.id)}`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '7px 12px', borderRadius: 8,
            border: '1px solid var(--lb-line)',
            background: 'white', color: 'var(--lb-ink-2)',
            fontSize: 12.5, fontWeight: 600, textDecoration: 'none',
          }}
        >
          <Edit3 size={13} /> View / edit playbook
        </a>
        {!isArchived && (
          <button
            type="button"
            onClick={onManageAvailability}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '7px 12px', borderRadius: 8,
              border: '1px solid var(--lb-line)',
              background: 'white', color: 'var(--lb-ink-2)',
              fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            <Settings2 size={13} /> Manage availability
          </button>
        )}
        {isDraft && (
          <button
            type="button"
            onClick={onActivate}
            disabled={busy === `activate-${profile.id}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '7px 12px', borderRadius: 8,
              border: '1px solid #bfdbfe',
              background: '#2563eb', color: 'white',
              fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {busy === `activate-${profile.id}` ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
            Activate
          </button>
        )}
        {isActive && (
          <button
            type="button"
            onClick={onArchive}
            disabled={busy === `archive-${profile.id}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '7px 12px', borderRadius: 8,
              border: '1px solid var(--lb-line)',
              background: 'white', color: 'var(--lb-ink-2)',
              fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {busy === `archive-${profile.id}` ? <Loader2 size={13} className="animate-spin" /> : <Archive size={13} />}
            Archive
          </button>
        )}
        {isArchived && (
          <button
            type="button"
            onClick={onReactivate}
            disabled={busy === `reactivate-${profile.id}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '7px 12px', borderRadius: 8,
              border: '1px solid #bfdbfe',
              background: '#2563eb', color: 'white',
              fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {busy === `reactivate-${profile.id}` ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
            Reactivate
          </button>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ServiceProfile['status'] }) {
  const styles: Record<ServiceProfile['status'], { bg: string; fg: string; border: string; label: string }> = {
    draft:    { bg: '#fef3c7', fg: '#b45309', border: '#fde68a', label: 'DRAFT' },
    active:   { bg: '#dcfce7', fg: '#15803d', border: '#bbf7d0', label: 'ACTIVE' },
    archived: { bg: '#f3f4f6', fg: '#6b7280', border: '#e5e7eb', label: 'ARCHIVED' },
  };
  const s = styles[status];
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 4,
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
      fontSize: 10, fontWeight: 700, letterSpacing: 0.06,
    }}>{s.label}</span>
  );
}

function DefaultBadge() {
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 4,
      background: '#dbeafe', color: '#1e40af', border: '1px solid #bfdbfe',
      fontSize: 10, fontWeight: 700, letterSpacing: 0.06,
    }}>DEFAULT</span>
  );
}

// ─── Manage Availability modal (PR-E) ────────────────────────────────────
//
// Lets the operator pick which connected accounts offer this service.
// Save fans out one PUT per touched account (only accounts the user
// actually toggled — untouched configured rows stay configured,
// untouched unconfigured rows stay unconfigured).

function ManageAvailabilityModal({
  profile,
  assignments,
  onClose,
  onSaved,
}: {
  profile: ServiceProfile | null;
  assignments: SavedAccountAssignment[];
  onClose: () => void;
  onSaved: () => void;
}) {
  // Local checkbox state keyed by savedAccountId. true = this account
  // OFFERS the profile. We seed from the assignments snapshot and only
  // diff-PUT on save.
  const initial = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const a of assignments) {
      out[a.savedAccountId] = a.configured && profile
        ? a.enabledServiceProfileIds.includes(profile.id)
        : false;
    }
    return out;
  }, [assignments, profile]);

  const [picks, setPicks] = useState<Record<string, boolean>>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset when modal switches profiles (parent unmounts on close, so
  // this mostly covers programmatic profile switching if we add it).
  useEffect(() => { setPicks(initial); }, [initial]);

  if (!profile) return null;

  const dirty =
    Object.keys(initial).some((id) => initial[id] !== picks[id]) ||
    Object.keys(picks).some((id) => picks[id] !== initial[id]);

  const handleSave = async () => {
    if (!dirty) { onSaved(); return; }
    setSaving(true);
    setError(null);
    try {
      const writes: Promise<unknown>[] = [];
      for (const a of assignments) {
        const wasEnabled = a.configured && a.enabledServiceProfileIds.includes(profile.id);
        const willEnable = picks[a.savedAccountId] === true;
        if (wasEnabled === willEnable && a.configured) continue;
        // Build the new list: existing enabled ± this profile.
        const baseList = a.configured
          ? a.enabledServiceProfileIds.filter((id) => id !== profile.id)
          : [];
        const nextList = willEnable ? [...baseList, profile.id] : baseList;
        writes.push(
          serviceProfilesApi.setSavedAccountAssignments(a.savedAccountId, {
            enabledServiceProfileIds: nextList,
            defaultServiceProfileId: a.defaultServiceProfileId,
          }),
        );
      }
      const results = await Promise.allSettled(writes);
      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        setError(`${failures.length} of ${writes.length} accounts failed to update`);
        notify.error('Could not save availability', `${failures.length} of ${writes.length} updates failed`);
      } else {
        notify.success('Availability saved', `${displayName(profile)} availability updated.`);
        onSaved();
      }
    } catch (err: any) {
      setError(err?.response?.data?.message ?? err?.message ?? 'Save failed');
      notify.error('Could not save availability', err?.response?.data?.message ?? err?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.45)',
        zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white', borderRadius: 16, width: 'min(560px, 100%)',
          maxHeight: '85vh', overflow: 'auto',
          boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)', padding: 24,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--lb-ink-1)', marginBottom: 4 }}>
              Service availability for {displayName(profile)}
            </div>
            <div style={{ fontSize: 13, color: 'var(--lb-ink-5)', lineHeight: 1.45 }}>
              Pick which connected accounts offer this service. Leads from accounts that don't offer it will pause AI replies and flag a setup mismatch.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              padding: 6, background: 'transparent', border: 'none',
              color: 'var(--lb-ink-5)', cursor: 'pointer', borderRadius: 6,
            }}
          >
            <X size={18} />
          </button>
        </div>

        {assignments.length === 0 && (
          <div style={{
            padding: 12, borderRadius: 8, background: '#fef3c7',
            color: '#92400e', fontSize: 13,
          }}>
            No connected accounts yet. Connect Thumbtack / Yelp / Angi first to assign services per location.
          </div>
        )}

        {assignments.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {assignments.map((a) => {
              const checked = picks[a.savedAccountId] === true;
              return (
                <label
                  key={a.savedAccountId}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '10px 12px', borderRadius: 10,
                    border: `1px solid ${checked ? 'var(--lb-accent-line, #bfdbfe)' : 'var(--lb-line)'}`,
                    background: checked ? 'var(--lb-accent-tint, #eff6ff)' : 'white',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => setPicks((prev) => ({ ...prev, [a.savedAccountId]: e.target.checked }))}
                    style={{ width: 16, height: 16, accentColor: '#2563eb' }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--lb-ink-1)' }}>
                      {a.businessName || '(unnamed)'}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--lb-ink-5)', marginTop: 2 }}>
                      {a.platform || 'unknown'}
                      {!a.configured && (
                        <span style={{ marginLeft: 8, color: '#92400e' }}>· no per-account setup yet</span>
                      )}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        )}

        {error && (
          <div style={{
            marginTop: 12, padding: 10, borderRadius: 8,
            background: '#fee2e2', color: '#b91c1c', fontSize: 12.5,
          }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              padding: '8px 14px', borderRadius: 8,
              border: '1px solid var(--lb-line)',
              background: 'white', color: 'var(--lb-ink-2)',
              fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty || assignments.length === 0}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', borderRadius: 8,
              border: 'none',
              background: !dirty || assignments.length === 0 ? '#cbd5e1' : '#2563eb',
              color: 'white',
              fontSize: 13, fontWeight: 600,
              cursor: saving || !dirty || assignments.length === 0 ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
            Save availability
          </button>
        </div>
      </div>
    </div>
  );
}
