import { useState } from 'react';
import { Globe, Image as ImageIcon } from 'lucide-react';
import type { PlaybookSeed } from '../services/api';

export interface WebsiteMetadata {
  title?: string;
  description?: string;
  phone?: string;
  imageUrl?: string;
  summary?: string;
  playbookSeed?: PlaybookSeed;
}

interface Props {
  url: string | null | undefined;
  metadata: WebsiteMetadata | null | undefined;
  /** "wizard" = inset emerald style for the Business step; "settings" = neutral border card. */
  tone?: 'wizard' | 'settings';
}

/**
 * Renders the homepage preview (og:image) + AI summary for a verified
 * website. Shared between the onboarding Business step and Settings →
 * General so both surfaces show the same proof + summary the AI used.
 *
 * Summary is collapsed to 3 lines by default with an inline "Show more"
 * toggle. Hidden completely when metadata is empty / website is unset.
 */
export function WebsitePreviewCard({ url, metadata, tone = 'wizard' }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const m = metadata || {};
  const hasAny = !!(url || m.title || m.description || m.summary || m.imageUrl);
  if (!hasAny) return null;

  const wrap =
    tone === 'wizard'
      ? 'rounded-xl bg-emerald-50/60 border border-emerald-100'
      : 'rounded-xl border border-slate-200 bg-white';
  const accent = tone === 'wizard' ? 'text-emerald-900' : 'text-slate-900';
  const muted = tone === 'wizard' ? 'text-emerald-700' : 'text-slate-600';
  const subtle = tone === 'wizard' ? 'text-emerald-600' : 'text-slate-500';

  return (
    <div className={`${wrap} overflow-hidden`}>
      <div className="flex">
        {/* Thumbnail — a real homepage screenshot (Microlink) when available,
            falling back to og:image, falling back to a placeholder. The
            wider 11rem × 7rem (176×112) box gives a 3:2 viewport-style crop
            and shows the top of the page so the hero is visible. */}
        <div className="w-44 h-28 shrink-0 bg-slate-100 flex items-center justify-center overflow-hidden">
          {m.imageUrl && !imgFailed ? (
            <img
              src={m.imageUrl}
              alt={m.title || 'Site preview'}
              loading="lazy"
              // og:image + Microlink screenshot hosts often 403 hotlinks
              // when they see a referer for a domain they don't allow.
              // Strip the referer so the request looks like a direct
              // visit — restores the thumbnail across most CDNs.
              referrerPolicy="no-referrer"
              onError={() => setImgFailed(true)}
              className="w-full h-full object-cover object-top"
            />
          ) : (
            <ImageIcon className="w-7 h-7 text-slate-300" />
          )}
        </div>

        <div className="flex-1 min-w-0 px-3 py-2.5 text-xs">
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className={`inline-flex items-center gap-1 ${subtle} hover:underline font-mono text-[11px] truncate max-w-full`}
            >
              <Globe className="w-3 h-3 shrink-0" />
              <span className="truncate">{url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>
            </a>
          )}
          {m.title && (
            <div className={`font-bold ${accent} truncate mt-0.5`}>{m.title}</div>
          )}
          {m.description && !m.summary && (
            <div className={`${muted} mt-0.5 line-clamp-2`}>{m.description}</div>
          )}
          {m.phone && (
            <div className={`${subtle} mt-1 font-mono text-[11px]`}>
              Phone on site: {m.phone}
            </div>
          )}
        </div>
      </div>

      {/* Summary block — collapsible. Hidden until AI-summary is present. */}
      {m.summary && (
        <div className="border-t border-current/10 px-3 py-2.5">
          <div className={`text-[11px] uppercase tracking-wider font-bold ${subtle} mb-1`}>
            Site summary
          </div>
          <div className={`text-xs ${muted} ${expanded ? '' : 'line-clamp-3'}`}>
            {m.summary}
          </div>
          {m.summary.length > 180 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className={`mt-1 text-[11px] font-semibold ${accent} hover:underline`}
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}

      {/* Structured facts — one row per Playbook section. These feed the
          AI Playbook + FAQ auto-fill later; surfacing them here lets the
          user verify what the AI actually pulled before they trust it. */}
      {m.playbookSeed && (
        <PlaybookSeedDetails seed={m.playbookSeed} accent={accent} muted={muted} subtle={subtle} />
      )}
    </div>
  );
}

function PlaybookSeedDetails({
  seed, accent, muted, subtle,
}: {
  seed: NonNullable<WebsiteMetadata['playbookSeed']>;
  accent: string; muted: string; subtle: string;
}) {
  const [open, setOpen] = useState(false);
  const sections = buildSeedRows(seed);
  if (sections.length === 0) return null;

  return (
    <div className="border-t border-current/10 px-3 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center justify-between w-full text-[11px] uppercase tracking-wider font-bold ${subtle} hover:opacity-80`}
      >
        <span>
          {open ? '▾' : '▸'} Site facts extracted ({sections.length} section{sections.length === 1 ? '' : 's'})
        </span>
        <span className={`normal-case tracking-normal font-semibold ${accent}`}>
          {open ? 'Hide' : 'Show'}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-3">
          {sections.map(([label, rows]) => (
            <div key={label}>
              <div className={`text-[11px] font-bold ${accent} mb-1`}>{label}</div>
              <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-xs">
                {rows.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className={`${subtle} font-mono text-[11px]`}>{k}</dt>
                    <dd className={muted}>{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Flatten the PlaybookSeed object into [sectionLabel, [[key, value], ...]] rows
 * for tabular rendering. Values that are arrays get joined with bullets;
 * structured priceList becomes "Standard cleaning — from $129" lines.
 */
function buildSeedRows(seed: PlaybookSeed): Array<[string, Array<[string, string]>]> {
  const out: Array<[string, Array<[string, string]>]> = [];

  const joinArr = (a?: string[]) => (a && a.length ? a.join(', ') : undefined);
  const pushSection = (label: string, rows: Array<[string, string | undefined]>) => {
    const filtered = rows.filter(([, v]) => v && v.length > 0) as Array<[string, string]>;
    if (filtered.length > 0) out.push([label, filtered]);
  };

  if (seed.businessInformation) {
    const b = seed.businessInformation;
    pushSection('Business Information', [
      ['Service area', b.serviceArea],
      ['Years', b.yearsInBusiness],
      ['Team', b.teamSize],
      ['Owner', b.ownerName],
      ['Insurance', b.insurance],
      ['Bonding', b.bonding],
      ['Licensing', b.licensing],
      ['Guarantees', b.guarantees],
      ['Eco / products', b.ecoFriendly],
      ['Supplies', b.suppliesPolicy],
      ['Pets', b.petsPolicy],
      ['Payment', joinArr(b.paymentMethods)],
      ['Offices', joinArr(b.officeLocations)],
    ]);
  }
  if (seed.pricingGuidance) {
    const p = seed.pricingGuidance;
    const prices = (p.startingPrices || [])
      .map((sp) => `${sp.service} — ${sp.price}`)
      .join('; ');
    pushSection('Pricing', [
      ['Model', p.pricingModel],
      ['Starting', prices || undefined],
      ['Includes', p.whatsIncluded],
      ['Discounts', p.discounts],
    ]);
  }
  if (seed.bookingGuidance) {
    const k = seed.bookingGuidance;
    pushSection('Booking', [
      ['Channels', joinArr(k.bookingChannels)],
      ['Lead time', k.leadTime],
      ['Notes', k.schedulingNotes],
    ]);
  }
  if (seed.objectionHandling) {
    pushSection('Trust signals', [
      ['Signals', joinArr(seed.objectionHandling.trustSignals)],
    ]);
  }
  if (seed.humanHandoffGuidance) {
    const h = seed.humanHandoffGuidance;
    pushSection('Contact', [
      ['Phones', joinArr(h.phones)],
      ['Emails', joinArr(h.emails)],
      ['Address', joinArr(h.addresses)],
    ]);
  }
  if (seed.personalityBrandVoice) {
    pushSection('Brand voice', [
      ['Tone notes', seed.personalityBrandVoice.toneNotes],
    ]);
  }
  return out;
}
