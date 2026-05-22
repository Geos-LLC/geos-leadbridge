/**
 * Settings → Partner Network (Beta) wrapper.
 *
 * Hosts the Partner Network admin UI inside the Settings page so the feature
 * stays tucked away while in Beta. Internal sub-tabs switch between the five
 * partner-network views (Dashboard, Businesses, Relationships, Referral codes,
 * Leads); the underlying page components live under
 * `frontend/src/pages/partner-network/` and stay reusable from the top-level
 * `/partner-network/*` routes for direct deep-links.
 *
 * URL convention: `?tab=partner-network&pn=<sub>` so a sub-view survives a
 * reload or share-link.
 */

import { useSearchParams } from 'react-router-dom';
import { BarChart3, Building2, Link as LinkIcon, QrCode, ListChecks } from 'lucide-react';
import PartnerNetworkDashboard from '../partner-network/PartnerNetworkDashboard';
import PartnerNetworkBusinesses from '../partner-network/PartnerNetworkBusinesses';
import PartnerNetworkRelationships from '../partner-network/PartnerNetworkRelationships';
import PartnerNetworkReferralCodes from '../partner-network/PartnerNetworkReferralCodes';
import PartnerNetworkLeads from '../partner-network/PartnerNetworkLeads';

type SubTab = 'dashboard' | 'businesses' | 'relationships' | 'referral-codes' | 'leads';

const SUB_TABS: { key: SubTab; label: string; icon: typeof BarChart3 }[] = [
  { key: 'dashboard',      label: 'Dashboard',      icon: BarChart3 },
  { key: 'businesses',     label: 'Businesses',     icon: Building2 },
  { key: 'relationships',  label: 'Relationships',  icon: LinkIcon },
  { key: 'referral-codes', label: 'Referral codes', icon: QrCode },
  { key: 'leads',          label: 'Leads',          icon: ListChecks },
];

export function SettingsPartnerNetwork() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = (searchParams.get('pn') as SubTab | null) ?? 'dashboard';
  const sub: SubTab = SUB_TABS.some(t => t.key === raw) ? raw : 'dashboard';
  const setSub = (next: SubTab) => {
    const sp = new URLSearchParams(searchParams);
    sp.set('pn', next);
    setSearchParams(sp, { replace: true });
  };

  return (
    <div>
      {/* Sub-nav for the five partner-network views. Mirrors the visual
          weight of the parent Settings tabs but sits one level deeper so the
          two strips read as a hierarchy, not as competing nav bars. */}
      <div style={{
        display: 'flex', gap: 4, marginBottom: 18,
        padding: 4, borderRadius: 10,
        background: 'var(--lb-ink-12, #f5f5f7)',
        border: '1px solid var(--lb-line-soft)',
        overflowX: 'auto',
      }}>
        {SUB_TABS.map(t => {
          const active = sub === t.key;
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setSub(t.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '7px 12px',
                background: active ? 'var(--lb-surface)' : 'transparent',
                border: active ? '1px solid var(--lb-line)' : '1px solid transparent',
                borderRadius: 8,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 12.5,
                fontWeight: active ? 600 : 500,
                color: active ? 'var(--lb-ink-1)' : 'var(--lb-ink-4)',
                whiteSpace: 'nowrap',
                boxShadow: active ? '0 1px 2px rgba(0,0,0,0.04)' : 'none',
                transition: 'background 120ms, color 120ms, border-color 120ms',
              }}
            >
              <Icon size={13} />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Render the matching partner-network page. Each child supplies its
          own padding + cards, so we don't add an extra wrapper here. */}
      {sub === 'dashboard' && <PartnerNetworkDashboard />}
      {sub === 'businesses' && <PartnerNetworkBusinesses />}
      {sub === 'relationships' && <PartnerNetworkRelationships />}
      {sub === 'referral-codes' && <PartnerNetworkReferralCodes />}
      {sub === 'leads' && <PartnerNetworkLeads />}
    </div>
  );
}
