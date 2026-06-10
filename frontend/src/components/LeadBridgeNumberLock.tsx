import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { notificationsApi, type TenantPhoneNumber } from '../services/api';

// Module-scope cache so all three banner mount sites share a single fetch.
// TTL is small — when the user buys a number from /settings/communication
// we want the banner to disappear without a hard reload. callers can flush
// by importing clearLeadBridgeNumberCache().
let cache: { hasNumber: boolean; checkedAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

export function clearLeadBridgeNumberCache() { cache = null; }

async function checkHasLeadBridgeNumber(): Promise<boolean> {
  if (cache && Date.now() - cache.checkedAt < CACHE_TTL_MS) return cache.hasNumber;
  const r = await notificationsApi
    .listTenantPhones()
    .catch(() => ({ success: false, data: [] as TenantPhoneNumber[] }));
  const hasNumber = Array.isArray(r?.data) && r.data.some(p => p.status === 'ACTIVE');
  cache = { hasNumber, checkedAt: Date.now() };
  return hasNumber;
}

/**
 * Inline warning banner that renders only when the tenant has no active
 * LeadBridge number. Used to gate features that physically need a Twilio
 * sender (Instant Text SMS, Instant Call bridge, SMS business alerts).
 * Other features (Instant Reply, AI Conversation, Follow-ups) go over the
 * platform's native chat API and don't need a number — don't add this
 * banner there.
 *
 * Self-contained (own fetch + cache) so it can be dropped into any card
 * without lifting state.
 */
export function LeadBridgeNumberLock({ feature }: { feature: string }) {
  const navigate = useNavigate();
  const [state, setState] = useState<'loading' | 'has' | 'none'>('loading');

  useEffect(() => {
    let alive = true;
    checkHasLeadBridgeNumber().then(has => {
      if (alive) setState(has ? 'has' : 'none');
    });
    return () => { alive = false; };
  }, []);

  if (state !== 'none') return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        marginBottom: 12,
        background: '#fffbeb',
        border: '1px solid #fde68a',
        borderRadius: 10,
        color: '#92400e',
      }}
    >
      <AlertTriangle size={18} style={{ flexShrink: 0, color: '#b45309' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: '#92400e' }}>
          {feature} needs a LeadBridge number
        </div>
        <div style={{ fontSize: 12.5, color: '#a16207', marginTop: 2 }}>
          This feature is unavailable until you claim a number. Other
          features (AI Conversation, Follow-ups, Instant Reply) work
          over chat and don't need one.
        </div>
      </div>
      <button
        type="button"
        onClick={() => navigate('/settings/communication')}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '7px 12px',
          fontSize: 13,
          fontWeight: 600,
          color: '#fff',
          background: '#b45309',
          border: 0,
          borderRadius: 8,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        Get a number <ArrowRight size={14} />
      </button>
    </div>
  );
}
