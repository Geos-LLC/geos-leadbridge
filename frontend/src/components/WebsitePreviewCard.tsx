import { useState } from 'react';
import { Globe, Image as ImageIcon } from 'lucide-react';

export interface WebsiteMetadata {
  title?: string;
  description?: string;
  phone?: string;
  imageUrl?: string;
  summary?: string;
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
    </div>
  );
}
