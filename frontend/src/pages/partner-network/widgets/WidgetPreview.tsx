/**
 * Widget template preview — renders the selected widget style inside a mock
 * "partner website" frame so the admin can see how the offer will appear
 * before any widget runtime ships. Pure presentation; no API calls.
 *
 * Three templates ship for the MVP:
 *   - banner: full-width strip at the top of the source business's site
 *   - card:   floating card in the bottom-right corner
 *   - modal:  centered overlay with a dimmed backdrop
 *
 * Lives inside src/pages/partner-network/widgets/ so the whole feature can
 * be extracted with the module later. Self-contained: no design-system or
 * shared-component imports beyond the icon library.
 */

import { ArrowRight, Tag, X } from 'lucide-react';

export type WidgetTemplate = 'banner' | 'card' | 'modal';

export const WIDGET_TEMPLATES: { key: WidgetTemplate; label: string; sublabel: string }[] = [
  { key: 'banner', label: 'Banner',  sublabel: 'Top of page strip' },
  { key: 'card',   label: 'Card',    sublabel: 'Floating bottom-right' },
  { key: 'modal',  label: 'Modal',   sublabel: 'Centered overlay' },
];

interface Props {
  template: WidgetTemplate;
  /** Destination business name — shown in the widget copy. */
  destinationName: string;
  /** Offer copy — the customer-facing sentence. Empty string allowed. */
  offerText: string;
  /** Source business URL — rendered in the mock browser URL bar. */
  sourceWebsite?: string | null;
  /** Source business name — rendered as the mock site's hero copy. */
  sourceName: string;
}

const ACCENT = '#7c3aed';
const ACCENT_DARK = '#5b21b6';

export function WidgetPreview({
  template,
  destinationName,
  offerText,
  sourceWebsite,
  sourceName,
}: Props) {
  // Strip protocol for the URL bar — it reads more like a real browser when
  // it shows just the hostname.
  const hostname = (() => {
    if (!sourceWebsite) return 'partner-site.example';
    try {
      return new URL(sourceWebsite).hostname;
    } catch {
      return sourceWebsite.replace(/^https?:\/\//i, '').split('/')[0];
    }
  })();
  const displayOffer = offerText.trim() || `Special partner offer from ${destinationName}`;
  const displayDest = destinationName.trim() || 'Partner business';

  return (
    <div style={{
      border: '1px solid var(--lb-line)',
      borderRadius: 12,
      overflow: 'hidden',
      background: '#fff',
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
    }}>
      {/* Mock browser chrome */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 12px',
        background: '#f3f4f6',
        borderBottom: '1px solid var(--lb-line)',
      }}>
        <span style={{ display: 'flex', gap: 4 }}>
          <i style={dot('#ef4444')} />
          <i style={dot('#f59e0b')} />
          <i style={dot('#10b981')} />
        </span>
        <span style={{
          flex: 1, padding: '3px 10px', borderRadius: 6,
          background: '#fff', border: '1px solid #e5e7eb',
          fontSize: 11, color: '#6b7280', fontFamily: 'var(--lb-font-mono, ui-monospace)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {hostname}
        </span>
      </div>

      {/* Fake site body. Each template overlays the same backdrop so the
          differences in placement are obvious. Height is fixed so the
          three templates can be compared at a glance. */}
      <div style={{
        position: 'relative',
        minHeight: 260,
        background: 'linear-gradient(180deg, #fafafa 0%, #f3f4f6 100%)',
        padding: template === 'banner' ? '40px 24px 24px' : '24px',
      }}>
        {/* Mocked site content: hero + 3 placeholder cards. Just enough to
            make the page feel real without distracting from the widget. */}
        <div style={{ fontSize: 18, fontWeight: 700, color: '#111827', marginBottom: 4 }}>
          {sourceName || 'Your partner site'}
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>
          Welcome — book your service today.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          <Placeholder />
          <Placeholder />
          <Placeholder />
        </div>

        {template === 'banner' && (
          <div style={{
            position: 'absolute',
            top: 0, left: 0, right: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 10, padding: '8px 14px',
            background: ACCENT, color: '#fff',
            fontSize: 12, fontWeight: 500,
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <Tag size={14} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <strong>{displayDest}:</strong> {displayOffer}
              </span>
            </span>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '3px 10px', borderRadius: 6,
              background: '#fff', color: ACCENT_DARK,
              fontWeight: 700, fontSize: 11, flexShrink: 0,
            }}>
              Claim <ArrowRight size={12} />
            </span>
          </div>
        )}

        {template === 'card' && (
          <div style={{
            position: 'absolute',
            right: 16, bottom: 16,
            width: 240,
            padding: 12,
            background: '#fff',
            border: `2px solid ${ACCENT}`,
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(124,58,237,0.18)',
            display: 'flex', flexDirection: 'column', gap: 6,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '2px 6px', borderRadius: 4,
                background: '#ede9fe', color: ACCENT_DARK,
                fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.05,
              }}>
                <Tag size={9} /> Offer
              </span>
              <X size={12} style={{ color: '#9ca3af', cursor: 'pointer' }} />
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: '#111827' }}>
              {displayDest}
            </div>
            <div style={{ fontSize: 11.5, color: '#374151', lineHeight: 1.35 }}>
              {displayOffer}
            </div>
            <button style={{
              marginTop: 4, padding: '6px 10px',
              background: ACCENT, color: '#fff', border: 0,
              borderRadius: 6, fontSize: 11, fontWeight: 600,
              cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
              justifyContent: 'center', gap: 4,
            }}>
              Claim offer <ArrowRight size={11} />
            </button>
          </div>
        )}

        {template === 'modal' && (
          <>
            <div style={{
              position: 'absolute', inset: 0,
              background: 'rgba(15,23,42,0.45)',
              backdropFilter: 'blur(1px)',
            }} />
            <div style={{
              position: 'absolute',
              top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
              width: 'min(280px, 80%)',
              padding: 16,
              background: '#fff',
              borderRadius: 12,
              boxShadow: '0 20px 50px rgba(0,0,0,0.25)',
              display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '2px 6px', borderRadius: 4,
                  background: '#ede9fe', color: ACCENT_DARK,
                  fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.05,
                }}>
                  <Tag size={9} /> Partner offer
                </span>
                <X size={14} style={{ color: '#9ca3af', cursor: 'pointer' }} />
              </div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', lineHeight: 1.25 }}>
                Special offer from {displayDest}
              </div>
              <div style={{ fontSize: 12, color: '#374151', lineHeight: 1.4 }}>
                {displayOffer}
              </div>
              <button style={{
                marginTop: 4, padding: '8px 12px',
                background: ACCENT, color: '#fff', border: 0,
                borderRadius: 8, fontSize: 12, fontWeight: 600,
                cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
                justifyContent: 'center', gap: 4,
              }}>
                Get this offer <ArrowRight size={12} />
              </button>
              <button style={{
                padding: '4px 6px',
                background: 'transparent', color: '#6b7280', border: 0,
                fontSize: 10.5, cursor: 'pointer',
              }}>
                No thanks
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function dot(color: string): React.CSSProperties {
  return { width: 9, height: 9, borderRadius: 999, background: color, display: 'inline-block' };
}

function Placeholder() {
  return (
    <div style={{
      height: 90,
      background: '#fff',
      border: '1px solid #e5e7eb',
      borderRadius: 6,
    }} />
  );
}

/**
 * Suggested offer-copy starters the admin can click to populate
 * defaultOfferText with one tap. Keeps the AI suggester for the
 * "site-grounded" version; these are the always-available fallbacks.
 */
export const OFFER_TEMPLATES: { label: string; text: (destinationName: string) => string }[] = [
  {
    label: '$25 off first service',
    text: (d) => `Get $25 off your first booking with ${d}.`,
  },
  {
    label: '20% off first booking',
    text: (d) => `20% off your first ${d} booking — referred customers only.`,
  },
  {
    label: 'Free consultation',
    text: (d) => `Book a free consultation with ${d} — quick estimate, no commitment.`,
  },
  {
    label: 'Priority scheduling',
    text: (d) => `Priority scheduling at ${d} — skip the wait when you mention this offer.`,
  },
];
