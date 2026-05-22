// Full lead profile — mirrors what the desktop right-panel shows on the
// Messages page. Reached from the thread screen's "Profile" button.

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Avatar, Icon, MAppBar, MBack, MCard, MIconBtn, MSection, MShell,
  PlatformBadge, StatusPill,
} from '../components';
import { leadsApi } from '../../../services/api';
import type { Lead } from '../../../types';
import { mapLead, mapPlatform, mapLeadStatus, formatRelative } from '../adapters';
import { MErrorState, MLoading } from '../states';

interface DetailRow { question: string; answer: string }

// Same parsing the desktop right panel uses. Thumbtack puts the
// answers in `raw.request.details[]`; Yelp scatters them across
// `raw.project.survey_answers`, `availability`, `location`,
// `additional_info`.
function parseLeadDetails(raw: any): DetailRow[] {
  if (!raw) return [];
  if (Array.isArray(raw?.request?.details)) {
    return raw.request.details
      .filter((d: any) => d?.question && d?.answer)
      .map((d: any) => ({ question: String(d.question), answer: String(d.answer) }));
  }
  if (raw?.project) {
    const out: DetailRow[] = [];
    const p = raw.project;
    if (Array.isArray(p.job_names) && p.job_names.length) {
      out.push({ question: 'Service', answer: p.job_names.join(', ') });
    }
    for (const q of (p.survey_answers || [])) {
      if (!q?.question_text) continue;
      const answer = Array.isArray(q.answer_text) ? q.answer_text.join(', ') : (q.answer_text ?? '');
      out.push({ question: String(q.question_text), answer: String(answer) });
    }
    if (p.availability?.status) {
      const v = p.availability.status;
      out.push({
        question: 'When do you require this service?',
        answer: v === 'ASAP' ? 'As soon as possible' : v === 'FLEXIBLE' ? "I'm flexible" : v,
      });
    }
    if (p.location?.postal_code) out.push({ question: 'Location', answer: p.location.postal_code });
    if (p.additional_info) out.push({ question: 'Additional details', answer: p.additional_info });
    return out;
  }
  return [];
}

function leadPrice(raw: any): string | null {
  if (!raw) return null;
  if (typeof raw.leadPrice === 'string') return raw.leadPrice;
  if (raw.leadPrice?.total) return String(raw.leadPrice.total);
  return null;
}

export default function MLeadProfile() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [lead, setLead] = useState<Lead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) { setError('Missing lead id'); setLoading(false); return; }
    let cancelled = false;
    setLoading(true); setError(null);
    leadsApi.getLead(id)
      .then((l) => { if (!cancelled) { setLead(l); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err?.message || 'Lead not found'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [id]);

  const mobile = lead ? mapLead(lead) : null;
  const details = parseLeadDetails(lead?.raw);
  const cost = leadPrice(lead?.raw);

  return (
    <MShell
      tab="leads"
      appBar={
        <MAppBar
          leading={<MBack label="" />}
          title="Lead profile"
          subtitle={mobile?.name}
          trailing={<MIconBtn icon="more-horizontal" />}
        />
      }
    >
      {loading && <MLoading label="Loading lead…" />}
      {error && <MErrorState message={error} />}

      {!loading && !error && lead && mobile && (
        <>
          {/* Top bar — same shape as the desktop right-panel header */}
          <div style={{ padding: '14px 14px 0' }}>
            <MCard style={{ padding: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Avatar name={mobile.name} size={52} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink-1)' }}>{mobile.name}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                    <PlatformBadge platform={mapPlatform(lead.platform)} size="sm" />
                    <StatusPill status={mapLeadStatus(lead.status)} />
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => navigate(`/m/leads/${lead.id}`)}
                    style={{
                      background: 'var(--accent)', color: 'white', border: 0,
                      padding: '8px 12px', borderRadius: 999, fontWeight: 600, fontSize: 12,
                      cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5,
                    }}
                  >
                    <Icon name="message-square" size={13} /> Reply
                  </button>
                </div>
              </div>
            </MCard>
          </div>

          {/* Contact */}
          <MSection title="Contact">
            <MCard>
              {lead.customerPhone && (
                <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Icon name="phone" size={14} style={{ color: 'var(--ink-5)' }} />
                  <a href={`tel:${lead.customerPhone}`} style={{ color: 'var(--accent)', fontSize: 13.5, fontFamily: 'var(--font-mono)', textDecoration: 'none' }}>
                    {lead.customerPhone}
                  </a>
                </div>
              )}
              {lead.customerEmail && (
                <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Icon name="mail" size={14} style={{ color: 'var(--ink-5)' }} />
                  <a href={`mailto:${lead.customerEmail}`} style={{ color: 'var(--accent)', fontSize: 13.5, fontFamily: 'var(--font-mono)', textDecoration: 'none' }}>
                    {lead.customerEmail}
                  </a>
                </div>
              )}
              {(lead.city || lead.state || lead.postcode) && (
                <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Icon name="map-pin" size={14} style={{ color: 'var(--ink-5)' }} />
                  <span style={{ fontSize: 13.5, color: 'var(--ink-2)' }}>
                    {[lead.city, lead.state, lead.postcode].filter(Boolean).join(', ')}
                  </span>
                </div>
              )}
              {!lead.customerPhone && !lead.customerEmail && !lead.city && !lead.state && !lead.postcode && (
                <div style={{ padding: '14px', fontSize: 12.5, color: 'var(--ink-5)' }}>
                  No contact info provided.
                </div>
              )}
            </MCard>
          </MSection>

          {/* Service summary */}
          {(lead.category || lead.budget != null || cost) && (
            <MSection title="Service">
              <MCard>
                {lead.category && (
                  <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line-soft)', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Icon name="workflow" size={14} style={{ color: 'var(--ink-5)' }} />
                    <span style={{ fontSize: 13.5, color: 'var(--ink-1)' }}>{lead.category}</span>
                  </div>
                )}
                {lead.budget != null && (
                  <div style={{ padding: '12px 14px', borderBottom: cost ? '1px solid var(--line-soft)' : 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Icon name="dollar-sign" size={14} style={{ color: 'var(--ink-5)' }} />
                    <span style={{ fontSize: 13.5, color: 'var(--ink-1)', fontFamily: 'var(--font-mono)' }}>Budget · ${lead.budget}</span>
                  </div>
                )}
                {cost && (
                  <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Icon name="dollar-sign" size={14} style={{ color: 'var(--ink-5)' }} />
                    <span style={{ fontSize: 13.5, color: 'var(--ink-1)', fontFamily: 'var(--font-mono)' }}>Lead cost · {cost}</span>
                  </div>
                )}
              </MCard>
            </MSection>
          )}

          {/* Original message */}
          {lead.message && (
            <MSection title="Customer's request">
              <MCard style={{ padding: 14 }}>
                <div style={{ fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                  {lead.message}
                </div>
              </MCard>
            </MSection>
          )}

          {/* Request details parsed from Thumbtack / Yelp shapes */}
          {details.length > 0 && (
            <MSection title="Request details">
              <MCard style={{ padding: 14 }}>
                <dl style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {details.map((d, i) => (
                    <div key={i}>
                      <dt style={{ fontSize: 11, color: 'var(--ink-5)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>
                        {d.question}
                      </dt>
                      <dd style={{ margin: 0, fontSize: 13.5, color: 'var(--ink-1)', lineHeight: 1.5 }}>
                        {d.answer}
                      </dd>
                    </div>
                  ))}
                </dl>
              </MCard>
            </MSection>
          )}

          <MSection title="Activity">
            <MCard>
              <div style={{ padding: '12px 14px', display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                <span style={{ color: 'var(--ink-5)' }}>First contact</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink-1)' }}>{formatRelative(lead.createdAt)}</span>
              </div>
              {lead.lastMessageAt && (
                <div style={{ padding: '12px 14px', borderTop: '1px solid var(--line-soft)', display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                  <span style={{ color: 'var(--ink-5)' }}>Last message</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink-1)' }}>{formatRelative(lead.lastMessageAt)}</span>
                </div>
              )}
            </MCard>
          </MSection>
        </>
      )}

      <div style={{ height: 80 }} />
    </MShell>
  );
}
