import { Award, CreditCard, Receipt, FileText } from 'lucide-react';
import { SettingCard, SectionCard, FieldRow, IconTile, ActionLink } from '../../components/automation/ui';

export function SettingsBilling() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SectionCard padding="22px 24px">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <IconTile icon={Award} tone="violet" size="lg" />
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)' }}>Engage plan</div>
              <span style={{
                padding: '3px 9px', borderRadius: 999,
                background: '#dbeafe', color: '#2563eb',
                fontSize: 11, fontWeight: 700,
              }}>Active</span>
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)' }}>
              View your plan details and renewal date on the Pricing page.
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
              {['Instant Reply', 'Follow-ups', 'Re-engagement', 'Instant call', 'SMS', 'Advanced analytics'].map(f => (
                <span key={f} style={{
                  padding: '3px 9px', borderRadius: 999,
                  background: 'var(--lb-ink-10)', color: 'var(--lb-ink-3)',
                  fontSize: 11, fontWeight: 500, border: '1px solid var(--lb-line)',
                }}>{f}</span>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <a
              href="/pricing"
              style={{
                padding: '8px 14px', fontSize: 13, fontWeight: 600,
                background: 'var(--lb-accent)', color: 'white',
                border: 0, borderRadius: 8, cursor: 'pointer',
                fontFamily: 'inherit', textDecoration: 'none',
                textAlign: 'center',
              }}
            >Upgrade to Convert</a>
            <a
              href="/pricing"
              style={{
                padding: '8px 14px', fontSize: 13, fontWeight: 600,
                background: 'white', color: 'var(--lb-ink-2)',
                border: '1px solid var(--lb-line)', borderRadius: 8, cursor: 'pointer',
                fontFamily: 'inherit', textDecoration: 'none',
                textAlign: 'center',
              }}
            >Change plan</a>
          </div>
        </div>
      </SectionCard>

      <SettingCard
        icon={CreditCard}
        iconTone="violet"
        title="Payment method"
        subtitle="The card we charge for your monthly subscription."
        contentPad="8px 24px 24px"
      >
        <FieldRow icon={CreditCard} iconTone="violet" label="Primary card" noBorder>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '12px 14px',
            background: '#f8fafc',
            border: '1px solid var(--lb-line-soft)',
            borderRadius: 10,
          }}>
            <div style={{
              width: 40, height: 28, borderRadius: 5,
              background: 'linear-gradient(135deg, #1a1f36 0%, #2c3454 100%)',
              color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 9, fontWeight: 700, letterSpacing: 0.08,
            }}>CARD</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--lb-ink-1)', fontFamily: 'var(--lb-font-mono)' }}>•••• •••• •••• ····</div>
              <div style={{ fontSize: 12, color: 'var(--lb-ink-5)', marginTop: 2 }}>Manage your card in Pricing</div>
            </div>
            <ActionLink>Replace</ActionLink>
          </div>
        </FieldRow>
      </SettingCard>

      <SettingCard
        icon={Receipt}
        iconTone="green"
        title="Invoices"
        subtitle="Recent receipts. Full history available in your Stripe portal."
        contentPad="8px 24px 24px"
      >
        <div style={{ paddingTop: 4, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 14,
            padding: '12px 14px',
            background: '#f8fafc',
            border: '1px solid var(--lb-line-soft)',
            borderRadius: 10,
            fontSize: 13, color: 'var(--lb-ink-5)',
          }}>
            <FileText size={15} style={{ color: 'var(--lb-ink-5)' }} />
            <div style={{ flex: 1 }}>No invoices to show yet. Once your subscription starts, receipts will appear here.</div>
          </div>
        </div>
      </SettingCard>
    </div>
  );
}
