/**
 * UpgradeOverlay — paywall pattern that shows locked features.
 *
 * Wraps tier-gated content so it stays VISIBLE (user sees what's there),
 * with a translucent overlay covering it (interactions blocked + a clear
 * "Upgrade to <Tier>" CTA in the center).
 *
 * Distinct from `FeatureGate` which HIDES locked features. UpgradeOverlay
 * keeps the locked controls in the layout — useful when the value prop of
 * a feature is the controls themselves (e.g. "look what AI Conversation
 * could be doing for you").
 *
 * Usage:
 *   <UpgradeOverlay tier="convert">
 *     <SettingCard title="AI Conversation" ... />
 *     ...other cards the user would unlock...
 *   </UpgradeOverlay>
 */

import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { useAuthStore } from '../store/authStore';

type Tier = 'engage' | 'convert';

const TIER_LABEL: Record<Tier, string> = {
  engage:  'Engage',
  convert: 'Convert',
};

const TIER_TAGLINE: Record<Tier, string> = {
  engage:  'Automated follow-ups when leads stop responding.',
  convert: 'Full AI Conversation — replies, handoff, custom Playbook.',
};

/**
 * Pure predicate — does this user have access to a tier-gated feature today?
 * Trial active OR subscription tier meets the bar. Used by callers that need
 * the boolean independently of rendering the overlay.
 */
export function hasTierAccess(
  user: { trialActive?: boolean; subscriptionTier?: 'STARTER' | 'PRO' | 'ENTERPRISE' | null } | null | undefined,
  tier: Tier,
): boolean {
  if (!user) return false;
  if (user.trialActive) return true;
  if (tier === 'engage') return user.subscriptionTier === 'PRO' || user.subscriptionTier === 'ENTERPRISE';
  if (tier === 'convert') return user.subscriptionTier === 'ENTERPRISE';
  return false;
}

export function UpgradeOverlay({
  tier, children, force,
}: {
  tier: Tier;
  children: ReactNode;
  /**
   * Force the overlay on/off regardless of user tier. Defaults to undefined,
   * which means "auto-detect from auth user". Set `false` to never show the
   * overlay (e.g. in storybook/preview); set `true` to force show.
   */
  force?: boolean;
}) {
  const navigate = useNavigate();
  const user = useAuthStore(s => s.user);

  const locked = force !== undefined ? force : !hasTierAccess(user, tier);
  if (!locked) return <>{children}</>;

  const onUpgrade = () => navigate('/pricing');

  return (
    <div style={{ position: 'relative' }}>
      {/* Render the children as-is so the user sees the underlying controls. */}
      <div aria-hidden style={{ pointerEvents: 'none', userSelect: 'none' }}>
        {children}
      </div>

      {/* Translucent overlay — catches all clicks, shows the upgrade CTA. */}
      <button
        type="button"
        onClick={onUpgrade}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%', height: '100%',
          border: 0, padding: 0, margin: 0,
          background: 'rgba(248, 250, 252, 0.62)',
          backdropFilter: 'blur(1.5px)',
          WebkitBackdropFilter: 'blur(1.5px)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          paddingTop: 80,
        }}
        aria-label={`Upgrade to ${TIER_LABEL[tier]} to unlock`}
      >
        <UpgradeCallout tier={tier} />
      </button>
    </div>
  );
}

function UpgradeCallout({ tier }: { tier: Tier }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: 12,
      padding: '20px 28px',
      background: 'white',
      border: '1.5px solid var(--lb-accent)',
      borderRadius: 14,
      boxShadow: '0 8px 30px rgba(15, 23, 42, 0.18)',
      maxWidth: 420,
      textAlign: 'center',
      position: 'sticky',
      top: 80,
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 12,
        background: '#ede9fe', color: '#6d28d9',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Sparkles size={22} />
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--lb-ink-1)' }}>
        Upgrade to {TIER_LABEL[tier]} to unlock
      </div>
      <div style={{ fontSize: 13, color: 'var(--lb-ink-5)', lineHeight: 1.5 }}>
        {TIER_TAGLINE[tier]}
      </div>
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        background: 'var(--lb-accent)', color: 'white',
        padding: '10px 18px', borderRadius: 10,
        fontSize: 13.5, fontWeight: 700,
        marginTop: 4,
      }}>
        See plans &rarr;
      </div>
    </div>
  );
}
