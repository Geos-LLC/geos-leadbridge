import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building, Globe, Info, Loader2, Phone, Layers, Plus, Edit3,
  CheckCircle2, Archive,
  Trash2, AlertTriangle, Link2,
} from 'lucide-react';
import {
  SettingCard, FieldRow, Dropdown, FooterBanner,
} from '../../components/automation/ui';
import { useAuthStore } from '../../store/authStore';
import { useAppStore } from '../../store/appStore';
import { usersApi, authApi, serviceProfilesApi, type ServiceProfile } from '../../services/api';
import { notify } from '../../store/notificationStore';
import { ManualBusinessInfoModal } from '../../components/ManualBusinessInfoModal';
import { AddServiceModal } from './Services';

export function SettingsGeneral() {
  const user = useAuthStore(s => s.user);
  const token = useAuthStore(s => s.token);
  const setAuth = useAuthStore(s => s.setAuth);
  const logout = useAuthStore(s => s.logout);
  const savedAccounts = useAppStore(s => s.savedAccounts);
  const navigate = useNavigate();

  // Danger Zone — tenant self-delete. Hidden for ADMIN role (admins
  // already have the admin-side delete affordance and shouldn't be one
  // typo away from nuking their own account). Confirmation requires
  // re-typing the user's email — same gate the legacy SettingsPage
  // shipped in commit 94a635f0 (since deleted in 8fdc00f6).
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState('');
  const [deletingAccount, setDeletingAccount] = useState(false);
  const handleDeleteAccount = async () => {
    setDeletingAccount(true);
    try {
      await usersApi.deleteOwnAccount();
      logout();
      navigate('/');
    } catch (err: any) {
      notify.error('Error', err?.message || 'Failed to delete account');
    } finally {
      setDeletingAccount(false);
    }
  };

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
  // Default to empty — the URL field is hydrated authoritatively by the
  // getBusinessProfileUrl effect below (TT > Yelp > User.website server-
  // side resolution). Seeding from user.website here races the API call:
  // on reload, the bookingkoala value would land before the TT URL,
  // and the effect's !website.trim() guard then bailed (reported
  // 2026-06-17 after the effect-level fix in 07cd20ae).
  const [website, setWebsite] = useState<string>('');
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

  // Re-sync websiteMetadata when the cached auth user updates (e.g. after
  // an authApi.getProfile() refresh elsewhere). NOTE: we deliberately do
  // NOT seed `website` from `user.website` here — `getBusinessProfileUrl`
  // (below) is the single source of truth for that field and runs the
  // canonical TT > Yelp > User.website resolution server-side. Doing both
  // races the API and produces stale-pairing bugs like "URL says
  // bookingkoala while the badge says THUMBTACK" (reported 2026-06-17).
  useEffect(() => {
    const fresh = (user as any)?.websiteMetadataJson ?? null;
    setWebsiteMetadata(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Hydrate the unified URL field from whichever source has a saved
  // value (TT publicProfileUrl > Yelp publicProfileUrl > User.website).
  // Runs on mount + whenever the cached savedAccounts list changes, so
  // a freshly-connected TT account's saved URL fills the field without
  // a hard reload. The `!website.trim()` guard prevents this from
  // clobbering the user's own typing on the re-run (e.g. after
  // savedAccounts populates from cache).
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

  // Rehydrate the TT/Yelp confirmation card from the persisted snapshot
  // on user.websiteMetadataJson.lastBusinessApply. Without this the
  // emerald card vanished on every reload even though the URL + fields
  // were saved server-side (reported 2026-06-17: "the fetched info
  // should stay among with url after reloading"). fieldsApplied is
  // saved as 0 (delta is meaningless across sessions) and
  // fieldsExtracted = patch size, so the existing card-body logic
  // reads as "N fields already saved" on restore — accurate.
  useEffect(() => {
    if (lastApply) return; // a fresh apply in this session wins over the snapshot
    const snap = (user as any)?.websiteMetadataJson?.lastBusinessApply;
    if (!snap || !snap.url || !snap.platform) return;
    if (snap.platform === 'website') return; // website has its own WebsitePreviewCard
    const extracted = snap.extractedFields && Object.keys(snap.extractedFields).length || 0;
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
        infoText="Your business name appears in every AI-generated reply, owner SMS alert, and lead notification. Timezone controls when business hours / quiet hours boundaries are interpreted (so 6 PM means 6 PM in your time, not server time)."
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

      {(() => {
        // Wizard-style "Business info" card chrome (2026-06-23). Two states:
        //   savedAndVerified → URL display tile + Re-scan + summary +
        //     Read more, with a Verified pill in the header.
        //   unsaved/edited → full-width input + Fetch & save button.
        // The wizard's BusinessWebsiteStep carries the same pattern;
        // both UIs now read as a single card with a single content block.
        const savedMetadata = (user as any)?.websiteMetadataJson ?? null;
        const trimmedSite = website.trim();
        const savedAndVerified =
          (!!user?.website && !!savedMetadata && user.website.trim() === trimmedSite && trimmedSite.length > 0)
          || (!!lastApply && lastApply.url.trim() === trimmedSite && trimmedSite.length > 0);
        const displayUrl = lastApply?.url || user?.website || website || '';
        const summary = lastApply?.summary || (websiteMetadata as any)?.summary || null;
        const verifiedPill = savedAndVerified ? (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 10, fontWeight: 700,
            fontFamily: 'var(--lb-font-mono)',
            textTransform: 'uppercase', letterSpacing: '.04em',
            padding: '4px 9px', borderRadius: 99,
            background: '#dcfce7', color: '#15803d',
            flexShrink: 0,
          }}>
            <CheckCircle2 size={11} />
            Verified
          </span>
        ) : undefined;
        return (
        <SettingCard
          icon={Globe}
          iconTone="violet"
          title="Business info"
          infoText="Paste your Thumbtack profile, Yelp business page, or website — we auto-detect the source, scrape it once on save, and pull structured facts (services, hours, service area, ratings, owner name, summary) into your AI Playbook + FAQ. Re-fetch any time you update the listing."
          headerRight={verifiedPill}
          contentPad="8px 24px 24px"
        >
        {savedAndVerified ? (
          <>
            {/* URL display tile + Re-scan / Change — saved & verified state. */}
            <div style={{
              marginTop: 8,
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '12px 14px',
              border: '1px solid var(--lb-accent-line, #c3d4ff)', borderRadius: 10,
              background: '#fff',
            }}>
              <Link2 size={15} style={{ flexShrink: 0, color: 'var(--lb-ink-5)' }} />
              <span style={{
                flex: 1, minWidth: 0,
                fontSize: 13, color: 'var(--lb-ink-2)',
                fontFamily: 'var(--lb-font-mono)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>
                {displayUrl}
              </span>
              <button
                type="button"
                onClick={() => void applyBusinessUrl()}
                disabled={verifying}
                style={{
                  flexShrink: 0,
                  background: 'transparent', border: 0, padding: 0,
                  fontSize: 11.5, fontWeight: 700,
                  color: 'var(--lb-accent)', cursor: verifying ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                  opacity: verifying ? 0.5 : 1,
                }}
              >
                {verifying ? 'Scanning…' : 'Re-scan'}
              </button>
              <button
                type="button"
                onClick={() => {
                  // Clear lastApply + reset the input so the editable
                  // state surfaces — gives the user a way to swap to a
                  // different URL without leaving this card.
                  setLastApply(null);
                  setWebsite('');
                  setDetectedPlatform(null);
                }}
                style={{
                  flexShrink: 0,
                  background: 'transparent', border: 0, padding: 0,
                  fontSize: 11.5, fontWeight: 600,
                  color: 'var(--lb-ink-5)', cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Change
              </button>
            </div>

            {/* Summary — full-width body text, clamped to 4 lines with
                a Read more / Read less toggle. Same chrome the wizard
                uses; no thumbnail, no field-level disclosure. */}
            {summary && (
              <>
                <div style={{
                  marginTop: 13,
                  fontSize: 13, color: 'var(--lb-ink-3)', lineHeight: 1.55,
                  ...(showExtracted ? {} : {
                    display: '-webkit-box',
                    WebkitLineClamp: 4,
                    WebkitBoxOrient: 'vertical' as const,
                    overflow: 'hidden',
                  }),
                }}>
                  {summary}
                </div>
                <button
                  type="button"
                  onClick={() => setShowExtracted(v => !v)}
                  style={{
                    marginTop: 9,
                    background: 'transparent', border: 0, padding: 0,
                    fontFamily: 'inherit',
                    fontSize: 12.5, fontWeight: 600,
                    color: 'var(--lb-accent)', cursor: 'pointer',
                  }}
                >
                  {showExtracted ? 'Read less' : 'Read more'}
                </button>
              </>
            )}
          </>
        ) : (
          <>
            {/* Editable input + Fetch & save — empty / unsaved state.
                URL field spans the full card width (no FieldRow label
                column), matching the wizard's Business info layout. */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%', flexWrap: 'wrap', paddingTop: 8 }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <SettingsInput
                  value={website}
                  onChange={(next) => {
                    setWebsite(next);
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
                disabled={verifying || !website.trim()}
                style={{
                  padding: '9px 16px',
                  fontSize: 13, fontWeight: 700,
                  color: 'white',
                  background: 'var(--lb-accent)',
                  border: 0, borderRadius: 8,
                  cursor: (verifying || !website.trim()) ? 'not-allowed' : 'pointer',
                  opacity: (verifying || !website.trim()) ? 0.6 : 1,
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  whiteSpace: 'nowrap',
                }}
              >
                {verifying ? <Loader2 size={13} className="animate-spin" /> : null}
                {verifying ? 'Fetching…' : 'Fetch & save'}
              </button>
            </div>
            {verifyError && (
              <div style={{
                marginTop: 12, padding: '8px 12px', borderRadius: 8,
                background: 'var(--lb-danger-tint)', color: 'var(--lb-danger)',
                fontSize: 12, fontWeight: 600,
              }}>{verifyError}</div>
            )}
            {/* Persistent fallback link — for tenants whose site can't be
                scraped or who'd rather type the info than guess at a URL. */}
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--lb-ink-5)' }}>
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
          </>
        )}
        </SettingCard>
        );
      })()}

      <SettingCard
        icon={Phone}
        iconTone="blue"
        title="Business phone"
        subtitle="Your primary owner / company number. Used for owner alerts and auto-registered on connected Thumbtack businesses as an associate phone."
        infoText="Owner SMS alerts (new lead, customer reply, handoff) get sent here. Thumbtack also receives this as your business's associate phone so they can call you directly. This is NOT the number customers see — that's your dedicated LeadBridge number, set up under Settings → Communication."
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

      {/* Danger Zone — tenant self-delete. Hidden for ADMIN. */}
      {(user as any)?.role !== 'ADMIN' && (
        <div style={{
          marginTop: 8,
          background: '#fff',
          borderRadius: 18,
          border: '1px solid #fecaca',
          padding: 24,
        }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#dc2626', marginBottom: 4 }}>
            Danger Zone
          </div>
          <div style={{ fontSize: 13, color: 'var(--lb-ink-5)', marginBottom: 16 }}>
            Permanently delete your account and all associated data. This cannot be undone.
          </div>
          {!showDeleteConfirm ? (
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '10px 16px', borderRadius: 10,
                background: '#fef2f2', color: '#dc2626',
                border: '1px solid #fecaca',
                fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              <Trash2 size={14} />
              Delete Account
            </button>
          ) : (
            <div style={{
              padding: 16,
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: 12,
              display: 'flex', flexDirection: 'column', gap: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <AlertTriangle size={16} style={{ color: '#dc2626', flexShrink: 0, marginTop: 2 }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#7f1d1d' }}>
                    This will permanently delete:
                  </div>
                  <ul style={{ fontSize: 13, color: '#991b1b', margin: '4px 0 0 20px', padding: 0, lineHeight: 1.6 }}>
                    <li>Your account and profile</li>
                    <li>All connected business accounts</li>
                    <li>All leads, messages, and automation rules</li>
                    <li>Phone numbers and notification settings</li>
                    <li>Active subscriptions will be cancelled</li>
                  </ul>
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: '#7f1d1d', marginBottom: 6 }}>
                  Type your email <span style={{ fontWeight: 700 }}>{user?.email}</span> to confirm
                </label>
                <input
                  type="text"
                  value={deleteConfirmEmail}
                  onChange={(e) => setDeleteConfirmEmail(e.target.value)}
                  placeholder={user?.email || ''}
                  autoComplete="off"
                  style={{
                    width: '100%', padding: '10px 12px', borderRadius: 10,
                    border: '1px solid #fecaca', background: '#fff',
                    fontSize: 13, color: 'var(--lb-ink-1)', fontFamily: 'inherit',
                    outline: 'none',
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  onClick={handleDeleteAccount}
                  disabled={deleteConfirmEmail !== user?.email || deletingAccount}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 8,
                    padding: '10px 16px', borderRadius: 10,
                    background: '#dc2626', color: '#fff', border: 0,
                    fontSize: 13, fontWeight: 600,
                    cursor: (deleteConfirmEmail !== user?.email || deletingAccount) ? 'not-allowed' : 'pointer',
                    opacity: (deleteConfirmEmail !== user?.email || deletingAccount) ? 0.4 : 1,
                    fontFamily: 'inherit',
                  }}
                >
                  {deletingAccount ? (
                    <><Loader2 size={14} className="animate-spin" /> Deleting…</>
                  ) : (
                    'Permanently Delete Account'
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmEmail(''); }}
                  style={{
                    padding: '10px 16px', borderRadius: 10,
                    background: '#fff', color: 'var(--lb-ink-3)',
                    border: '1px solid var(--lb-line)',
                    fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
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

function ServicesOfferedSection() {
  const [profiles, setProfiles] = useState<ServiceProfile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshTok, setRefreshTok] = useState(0);
  const [showPresetModal, setShowPresetModal] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    serviceProfilesApi.list()
      .then((profileRes) => {
        if (cancelled) return;
        setProfiles(profileRes.profiles);
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
            <Plus size={14} /> Add service
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
                onActivate={() => handleActivate(p)}
                onArchive={() => handleArchive(p)}
                onReactivate={() => handleReactivate(p)}
              />
            ))}
            {showArchived && archived.map((p) => (
              <ServiceRow
                key={p.id}
                profile={p}
                busy={busy}
                onActivate={() => handleActivate(p)}
                onArchive={() => handleArchive(p)}
                onReactivate={() => handleReactivate(p)}
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
        <AddServiceModal
          onClose={() => setShowPresetModal(false)}
          onCreated={() => { setShowPresetModal(false); refresh(); }}
        />
      )}
    </div>
  );
}

function ServiceRow({
  profile,
  busy,
  onActivate,
  onArchive,
  onReactivate,
}: {
  profile: ServiceProfile;
  busy: string | null;
  onActivate: () => void;
  onArchive: () => void;
  onReactivate: () => void;
}) {
  const name = displayName(profile);
  const isActive = profile.status === 'active';
  const isDraft = profile.status === 'draft';
  const isArchived = profile.status === 'archived';

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
