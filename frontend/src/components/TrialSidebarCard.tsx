import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, AlertCircle } from 'lucide-react';
import { billingApi } from '../services/api';
import type { SubscriptionDetails } from '../types';

type Trial = SubscriptionDetails['trial'];

/**
 * Compact trial / upgrade card rendered at the bottom of the left
 * sidebar (Layout.tsx), above Settings + the user pill. Replaces the
 * fixed top TrialBanner for active trials per the LeadBridgeDesignUpdated
 * sidebar reference — a navy gradient card with the trial status,
 * one-line value prop, and a full-width accent Upgrade plan button.
 *
 * Hidden when the tenant has a paid subscription, no trial, or the
 * trial has ended (the hard-block ended-trial banner stays at the top
 * so it can't be missed).
 */
export default function TrialSidebarCard() {
  const [trial, setTrial] = useState<Trial | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sub = await billingApi.getSubscription();
        if (cancelled) return;
        const hasPaid = sub.tier && ['ACTIVE', 'PAST_DUE'].includes(sub.status || '');
        if (hasPaid) return;
        setTrial(sub.trial ?? null);
      } catch (err) {
        console.error('[TrialSidebarCard] API error:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return null;
  if (!trial || !trial.type) return null;
  // Trial-ended hard block stays at the top via <TrialBanner>; don't
  // double-render the upsell in the sidebar.
  if (trial.isEnded) return null;

  // Headline — adapt copy to trial type.
  const headline =
    trial.type === 'TIME_BASED' || trial.type === 'HYBRID'
      ? trial.daysRemaining === 1
        ? 'Trial · 1 day left'
        : `Trial · ${trial.daysRemaining ?? 0} days left`
      : `Trial · ${trial.leadsRemaining ?? 0} leads left`;

  const urgent =
    (trial.type === 'TIME_BASED' || trial.type === 'HYBRID') &&
    trial.daysRemaining !== null &&
    trial.daysRemaining <= 2;

  return (
    <div
      style={{
        margin: '12px 8px 6px',
        padding: '14px 14px 12px',
        borderRadius: 12,
        background: 'linear-gradient(180deg, #0a1530 0%, #1b2a52 100%)',
        boxShadow: 'var(--lb-shadow-sm)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span
          style={{
            width: 22, height: 22, borderRadius: 6,
            background: 'rgba(255,255,255,0.12)',
            color: '#fff',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {urgent ? <AlertCircle size={12} /> : <CalendarClock size={12} />}
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: '#fff' }}>
          {headline}
        </span>
      </div>
      <div style={{
        fontSize: 11.5,
        color: '#aeb9d6',
        lineHeight: 1.4,
        marginBottom: 10,
      }}>
        Unlock AI Conversation and unlimited follow-ups.
      </div>
      <Link
        to="/pricing"
        style={{
          display: 'block',
          textAlign: 'center',
          padding: '8px 12px',
          borderRadius: 8,
          background: 'var(--lb-accent)',
          color: '#fff',
          fontSize: 12.5,
          fontWeight: 700,
          textDecoration: 'none',
        }}
      >
        Upgrade plan
      </Link>
    </div>
  );
}
