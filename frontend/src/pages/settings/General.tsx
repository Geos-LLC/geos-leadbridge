import { useEffect, useRef, useState } from 'react';
import { Building, Globe, Info, Loader2, Phone } from 'lucide-react';
import {
  SettingCard, FieldRow, Dropdown, FooterBanner,
} from '../../components/automation/ui';
import { useAuthStore } from '../../store/authStore';
import { useAppStore } from '../../store/appStore';
import { usersApi, authApi } from '../../services/api';
import { notify } from '../../store/notificationStore';
import { WebsitePreviewCard } from '../../components/WebsitePreviewCard';
import { ApplyToPlaybookButton } from '../../components/ApplyToPlaybookButton';
import { ManualBusinessInfoModal } from '../../components/ManualBusinessInfoModal';

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
      if (res.fieldsApplied > 0) {
        notify.success(
          `Pulled from ${platformWord}`,
          `Filled ${res.fieldsApplied} field${res.fieldsApplied === 1 ? '' : 's'}. Review in Settings → AI Playbook.`,
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
                onChange={setWebsite}
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
