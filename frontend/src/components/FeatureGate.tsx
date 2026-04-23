import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

type Feature = 'CUSTOM_REPLIES' | 'PHONE_CALLS' | 'AI_FOLLOWUPS' | 'OWN_NUMBER';

interface FeatureGateProps {
  feature: Feature;
  children: ReactNode;
  fallback?: ReactNode;
}

const featureRequirements: Record<Feature, { tier: string[]; addon?: boolean }> = {
  CUSTOM_REPLIES: { tier: ['STARTER', 'PRO', 'ENTERPRISE'] },
  PHONE_CALLS: { tier: ['PRO', 'ENTERPRISE'] },
  AI_FOLLOWUPS: { tier: ['ENTERPRISE'] },
  OWN_NUMBER: { tier: ['STARTER', 'PRO', 'ENTERPRISE'], addon: true },
};

const featureNames: Record<Feature, string> = {
  CUSTOM_REPLIES: 'Custom Reply Templates',
  PHONE_CALLS: 'Phone Call Capability',
  AI_FOLLOWUPS: 'AI-Powered Follow-ups',
  OWN_NUMBER: 'Own Business Number',
};

const featureUpgradePlan: Record<Feature, string> = {
  CUSTOM_REPLIES: 'Respond',
  PHONE_CALLS: 'Engage',
  AI_FOLLOWUPS: 'Convert',
  OWN_NUMBER: 'Any plan with Own Number add-on',
};

function hasAccess(
  tier: string | undefined,
  status: string | undefined,
  hasOwnNumber: boolean | undefined,
  feature: Feature
): boolean {
  // No subscription = no access
  if (!tier || !status) return false;

  // Inactive subscription = no access
  if (status !== 'ACTIVE' && status !== 'TRIALING') return false;

  const requirements = featureRequirements[feature];

  // Check tier requirement
  if (!requirements.tier.includes(tier)) return false;

  // Check addon requirement
  if (requirements.addon && !hasOwnNumber) return false;

  return true;
}

function UpgradePrompt({ feature }: { feature: Feature }) {
  return (
    <div className="feature-gate-prompt">
      <div className="feature-gate-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <rect x="5" y="11" width="14" height="10" rx="2" strokeWidth="2" />
          <circle cx="12" cy="16" r="1" fill="currentColor" />
          <path d="M12 7v4" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
      <h3>Upgrade Required</h3>
      <p>
        <strong>{featureNames[feature]}</strong> is available on the {featureUpgradePlan[feature]} plan
      </p>
      <div className="feature-gate-actions">
        <Link to="/pricing" className="btn-primary">
          View Plans
        </Link>
        <Link to="/billing" className="btn-secondary">
          Manage Subscription
        </Link>
      </div>
    </div>
  );
}

export default function FeatureGate({ feature, children, fallback }: FeatureGateProps) {
  const user = useAuthStore((state) => state.user);

  const hasFeatureAccess = hasAccess(
    user?.subscriptionTier,
    user?.subscriptionStatus,
    user?.hasOwnNumber,
    feature
  );

  if (!hasFeatureAccess) {
    return <>{fallback || <UpgradePrompt feature={feature} />}</>;
  }

  return <>{children}</>;
}
