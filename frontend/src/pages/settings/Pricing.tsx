import { useState } from 'react';
import { DollarSign, Info } from 'lucide-react';
import { SettingCard, FooterBanner } from '../../components/automation/ui';
import { useAppStore } from '../../store/appStore';
import ServicePricingForm from '../../components/ServicePricingForm';

export function SettingsPricing() {
  const accounts = useAppStore(s => s.savedAccounts);
  const [sharedPricing, setSharedPricing] = useState(true);

  if (accounts.length === 0) {
    return (
      <FooterBanner
        icon={Info}
        body="Connect a Thumbtack, Yelp or Angi account first — pricing is configured per connected business."
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SettingCard
        icon={DollarSign}
        iconTone="green"
        title="Service pricing"
        subtitle="Your pricing table — the AI uses this to quote accurate prices in conversations and follow-ups."
      >
        {accounts.length > 1 && (
          <label style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            marginBottom: 16, cursor: 'pointer', userSelect: 'none',
          }}>
            <input
              type="checkbox"
              checked={sharedPricing}
              onChange={e => setSharedPricing(e.target.checked)}
              style={{ width: 14, height: 14, accentColor: 'var(--lb-accent)' }}
            />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-2)' }}>
              Same pricing for all businesses
            </span>
          </label>
        )}

        {accounts.length === 1 || sharedPricing ? (
          <ServicePricingForm
            accountId={sharedPricing ? accounts.map(a => a.id).join(',') : accounts[0].id}
            accountName={sharedPricing && accounts.length > 1 ? 'All Businesses' : accounts[0].businessName}
            saveToAll={sharedPricing && accounts.length > 1 ? accounts.map(a => a.id) : undefined}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {accounts.map(acc => (
              <details key={acc.id} style={{
                border: '1px solid var(--lb-line)', borderRadius: 10, overflow: 'hidden',
              }}>
                <summary style={{
                  padding: '10px 14px', background: 'var(--lb-surface-soft, #f8fafc)',
                  cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-2)',
                }}>
                  {acc.businessName}{' '}
                  <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--lb-ink-6)', marginLeft: 4 }}>
                    ({acc.platform})
                  </span>
                </summary>
                <div style={{ padding: 14 }}>
                  <ServicePricingForm accountId={acc.id} accountName={acc.businessName} />
                </div>
              </details>
            ))}
          </div>
        )}
      </SettingCard>

      <FooterBanner
        icon={Info}
        body="Per-service overrides still live inside each service editor on the Services page."
      />
    </div>
  );
}
