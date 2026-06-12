import { useEffect, useRef, useState } from 'react';
import { Building, Globe, Info, Loader2, Sparkles } from 'lucide-react';
import {
  SettingCard, FieldRow, Dropdown, FooterBanner,
} from '../../components/automation/ui';
import { useAuthStore } from '../../store/authStore';
import { useAppStore } from '../../store/appStore';
import { usersApi, authApi } from '../../services/api';
import { notify } from '../../store/notificationStore';
import { WebsitePreviewCard } from '../../components/WebsitePreviewCard';
import { ApplyToPlaybookButton } from '../../components/ApplyToPlaybookButton';

export function SettingsGeneral() {
  const user = useAuthStore(s => s.user);
  const token = useAuthStore(s => s.token);
  const setAuth = useAuthStore(s => s.setAuth);
  const savedAccounts = useAppStore(s => s.savedAccounts);

  // First TT / Yelp account ids for the "Pull from..." buttons. Buttons
  // are hidden when the user has no account of that platform connected.
  const ttAccountId = savedAccounts.find(a => a.platform === 'thumbtack')?.id;
  const yelpAccountId = savedAccounts.find(a => a.platform === 'yelp')?.id;
  const [pullingFrom, setPullingFrom] = useState<'thumbtack' | 'yelp' | null>(null);

  const [business, setBusiness] = useState<string>((user as any)?.businessName || user?.name || '');
  const [tz, setTz] = useState<string>('America/New_York');
  const [industry, setIndustry] = useState<string>('Cleaning & home services');
  const [website, setWebsite] = useState<string>(user?.website ?? '');
  const [websiteMetadata, setWebsiteMetadata] = useState<any>((user as any)?.websiteMetadataJson ?? null);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
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

  const pullFromAccount = async (platform: 'thumbtack' | 'yelp', accountId: string) => {
    setPullingFrom(platform);
    try {
      const res = await usersApi.pullBusinessInfoFromAccount(platform, accountId);
      if (!res.success) {
        notify.warning(`No ${platform === 'thumbtack' ? 'Thumbtack' : 'Yelp'} data`, res.warning || 'Nothing new to pull.');
        return;
      }
      const label = platform === 'thumbtack' ? 'Thumbtack' : 'Yelp';
      const parts: string[] = [];
      if (res.fieldsApplied > 0) parts.push(`${res.fieldsApplied} field${res.fieldsApplied === 1 ? '' : 's'} added`);
      if (res.conflictsRaised > 0) parts.push(`${res.conflictsRaised} conflict${res.conflictsRaised === 1 ? '' : 's'} queued for review`);
      notify.success(
        `Pulled from ${label}`,
        parts.length > 0 ? parts.join(', ') + '.' : 'Already up to date.',
        4500,
      );
      // Refresh auth user so the preview card re-renders with the new
      // businessInformation values.
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
    } catch (e: any) {
      notify.error('Pull failed', e?.response?.data?.message || e?.message || 'Try again later.');
    } finally {
      setPullingFrom(null);
    }
  };

  const verifyAndSaveWebsite = async () => {
    setVerifying(true);
    setVerifyError(null);
    try {
      const trimmed = website.trim();
      if (trimmed.length === 0) {
        await usersApi.updateProfile({ website: null, websiteMetadata: null });
        setWebsiteMetadata(null);
        if (token) {
          try {
            const fresh: any = await authApi.getProfile();
            const u = fresh?.user ?? fresh;
            if (u?.id) setAuth(u, token);
          } catch { /* silent */ }
        }
        setSavedAt(Date.now());
        return;
      }
      const outcome = await usersApi.verifyWebsite(trimmed);
      if (!outcome.reachable) {
        setVerifyError(outcome.errorMessage || 'We couldn\'t load that site.');
        return;
      }
      await usersApi.updateProfile({
        website: outcome.normalizedUrl,
        websiteMetadata: outcome.metadata ?? null,
      });
      setWebsite(outcome.normalizedUrl);
      setWebsiteMetadata(outcome.metadata ?? null);
      if (token) {
        try {
          const fresh: any = await authApi.getProfile();
          const u = fresh?.user ?? fresh;
          if (u?.id) setAuth(u, token);
        } catch { /* silent */ }
      }
      setSavedAt(Date.now());
    } catch (e: any) {
      setVerifyError(e?.response?.data?.message || e?.message || 'Failed to verify');
    } finally {
      setVerifying(false);
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
  }, [business, tz, industry]);

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
        <FieldRow label="Industry">
          <Dropdown
            value={industry}
            onChange={setIndustry}
            width="100%"
            options={[
              'Cleaning & home services',
              'Lawn care & landscaping',
              'Handyman & repair',
              'Pest control',
              'Other',
            ]}
          />
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
        title="Business website"
        subtitle="We pull a preview + AI summary so we can seed your FAQ and AI playbook."
        contentPad="8px 24px 24px"
      >
        <FieldRow label="Website URL">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <SettingsInput
                value={website}
                onChange={setWebsite}
                placeholder="myco.com or https://myco.com"
              />
            </div>
            <button
              type="button"
              onClick={() => void verifyAndSaveWebsite()}
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
              {verifying ? 'Checking…' : 'Verify & save'}
            </button>
            {/* Apply-to-Playbook sits on the same row as Verify & save so
                the two-button flow the user expects is one glance. Disabled
                until the verification produces a playbookSeed. */}
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
        {(ttAccountId || yelpAccountId) && (
          <div style={{ padding: '0 24px 12px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {ttAccountId && (
              <PullButton
                label="Pull from Thumbtack"
                busy={pullingFrom === 'thumbtack'}
                onClick={() => void pullFromAccount('thumbtack', ttAccountId)}
              />
            )}
            {yelpAccountId && (
              <PullButton
                label="Pull from Yelp"
                busy={pullingFrom === 'yelp'}
                onClick={() => void pullFromAccount('yelp', yelpAccountId)}
              />
            )}
          </div>
        )}
        {(user?.website || websiteMetadata) && (
          <div style={{ padding: '0 24px 12px' }}>
            <WebsitePreviewCard
              url={user?.website || website || null}
              metadata={websiteMetadata}
              tone="settings"
            />
          </div>
        )}
      </SettingCard>

      <FooterBanner icon={Info} body="Account-level changes apply across all your connected sources." />
    </div>
  );
}

function PullButton({ label, busy, onClick }: { label: string; busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      style={{
        padding: '9px 14px',
        fontSize: 13, fontWeight: 600,
        color: 'var(--lb-ink-2)',
        background: 'white',
        border: '1px solid var(--lb-line)', borderRadius: 8,
        cursor: busy ? 'not-allowed' : 'pointer',
        opacity: busy ? 0.6 : 1,
        display: 'inline-flex', alignItems: 'center', gap: 6,
        whiteSpace: 'nowrap',
      }}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
      {busy ? 'Pulling…' : label}
    </button>
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
