/**
 * Public referral page — customer-facing form at /r/:code.
 *
 * Renders without authentication or the LeadBridge layout. The form posts to
 * /api/partner-network/public/r/:code/submit; the server resolves the
 * referral code into source/destination/workspace and persists the lead.
 * UTM params from the query string are forwarded to the backend.
 */

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Loader2, CheckCircle, Phone } from 'lucide-react';
import {
  partnerNetworkApi,
  type PartnerLeadIntent,
  type PublicReferralView,
} from '../../services/partnerNetwork';

const INTENT_OPTIONS: Array<{ value: PartnerLeadIntent; label: string; hint: string }> = [
  { value: 'this_week', label: 'This week', hint: "I need help soon" },
  { value: 'this_month', label: 'This month', hint: "Within the next few weeks" },
  { value: 'not_sure', label: 'Not sure / just interested', hint: 'Exploring options' },
];

export default function PublicReferral() {
  const { code = '' } = useParams<{ code: string }>();
  const [searchParams] = useSearchParams();
  const [view, setView] = useState<PublicReferralView | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  // Set once the user's first input fires so we only POST form_started once
  // per page-load — funnel counts a "started" event per visitor, not per
  // keystroke.
  const [startedLogged, setStartedLogged] = useState(false);

  const [form, setForm] = useState({
    customerName: '',
    customerPhone: '',
    intentTiming: '' as PartnerLeadIntent | '',
    notes: '',
  });

  useEffect(() => {
    let cancelled = false;
    partnerNetworkApi.getPublicReferral(code)
      .then(v => {
        if (cancelled) return;
        setView(v);
        // Best-effort page_view event. We only fire when the code resolves so
        // dead/inactive codes don't pollute the funnel.
        partnerNetworkApi.logPublicEvent(code, 'page_view').catch(() => {});
      })
      .catch(err => {
        if (!cancelled) setError(err?.response?.status === 404 ? 'This referral link is no longer active.' : (err?.response?.data?.message || 'Could not load this link.'));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [code]);

  // Fire form_started once on the first user interaction with any input.
  const markStarted = () => {
    if (startedLogged) return;
    setStartedLogged(true);
    partnerNetworkApi.logPublicEvent(code, 'form_started').catch(() => {});
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.customerName.trim() || !form.customerPhone.trim() || !form.intentTiming) {
      setError('Please complete name, phone, and timing.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await partnerNetworkApi.submitPublicLead(code, {
        customerName: form.customerName.trim(),
        customerPhone: form.customerPhone.trim(),
        intentTiming: form.intentTiming as PartnerLeadIntent,
        notes: form.notes.trim() || undefined,
        utmSource: searchParams.get('utm_source') || undefined,
        utmMedium: searchParams.get('utm_medium') || undefined,
        utmCampaign: searchParams.get('utm_campaign') || undefined,
      });
      setSubmitted(true);
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Submission failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Shell>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#64748b' }}>
          <Loader2 className="animate-spin" size={18} /> Loading…
        </div>
      </Shell>
    );
  }

  if (error && !view) {
    return (
      <Shell>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f172a', margin: 0 }}>Link unavailable</h1>
        <p style={{ marginTop: 8, color: '#475569' }}>{error}</p>
      </Shell>
    );
  }

  if (!view) return null;

  if (submitted) {
    return (
      <Shell>
        <div style={{ textAlign: 'center' }}>
          <CheckCircle size={48} color="#22c55e" style={{ margin: '0 auto' }} />
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f172a', marginTop: 12 }}>Thanks — we got your info!</h1>
          <p style={{ marginTop: 8, color: '#475569' }}>
            {view.destinationBusinessName} will reach out shortly to follow up.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 11, letterSpacing: 1.5, color: '#64748b', textTransform: 'uppercase', fontWeight: 600 }}>
          Referred to
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: '#0f172a', margin: '6px 0 4px' }}>
          {view.destinationBusinessName}
        </h1>
        {view.offerText && (
          <p style={{ marginTop: 4, color: '#0f766e', fontWeight: 600 }}>{view.offerText}</p>
        )}
        <p style={{ marginTop: 10, color: '#475569', fontSize: 14 }}>
          Tell us a little about what you need and we'll get back to you fast.
        </p>
      </div>

      {error && (
        <div style={{ padding: 10, background: '#fef2f2', color: '#991b1b', borderRadius: 8, fontSize: 13, marginTop: 16 }}>
          {error}
        </div>
      )}

      <form onSubmit={onSubmit} style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Your name">
          <input
            required
            value={form.customerName}
            onChange={e => { markStarted(); setForm({ ...form, customerName: e.target.value }); }}
            style={input}
            autoComplete="name"
          />
        </Field>
        <Field label="Phone number">
          <input
            required
            type="tel"
            value={form.customerPhone}
            onChange={e => { markStarted(); setForm({ ...form, customerPhone: e.target.value }); }}
            style={input}
            autoComplete="tel"
            placeholder="(555) 555-5555"
          />
        </Field>

        <div>
          <label style={fieldLabel}>How soon do you need service?</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
            {INTENT_OPTIONS.map(opt => {
              const selected = form.intentTiming === opt.value;
              return (
                <label key={opt.value} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '12px 14px',
                  border: `1px solid ${selected ? '#0ea5e9' : '#e2e8f0'}`,
                  borderRadius: 12,
                  background: selected ? '#f0f9ff' : '#fff',
                  cursor: 'pointer',
                  transition: 'border-color 120ms',
                }}>
                  <input
                    type="radio"
                    checked={selected}
                    onChange={() => { markStarted(); setForm({ ...form, intentTiming: opt.value }); }}
                    style={{ accentColor: '#0ea5e9' }}
                  />
                  <div>
                    <div style={{ fontWeight: 600, color: '#0f172a' }}>{opt.label}</div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>{opt.hint}</div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        <Field label="Notes (optional)">
          <textarea
            value={form.notes}
            onChange={e => { markStarted(); setForm({ ...form, notes: e.target.value }); }}
            style={{ ...input, minHeight: 80, resize: 'vertical' }}
            placeholder="Anything else we should know?"
          />
        </Field>

        <button
          type="submit"
          disabled={submitting}
          style={{
            marginTop: 8, padding: '12px 16px',
            background: '#0ea5e9', color: 'white', border: 0, borderRadius: 12,
            fontWeight: 700, fontSize: 15, cursor: submitting ? 'not-allowed' : 'pointer',
            opacity: submitting ? 0.6 : 1,
          }}
        >
          {submitting ? 'Sending…' : 'Send my info'}
        </button>
      </form>

      <div style={{ marginTop: 16, textAlign: 'center' }}>
        <a
          href="tel:"
          onClick={e => {
            // Fallback: clipboard-copy the destination business name if we
            // don't have a phone number on file (most cases — phone is a
            // PartnerBusiness column we don't expose publicly).
            e.preventDefault();
          }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            color: '#0ea5e9', fontSize: 13, fontWeight: 600, textDecoration: 'none',
          }}
        >
          <Phone size={13} /> Prefer to call? Submit the form and we'll ring you back.
        </a>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%)',
      padding: '24px 16px',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'flex-start',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
      <div style={{
        background: 'white',
        borderRadius: 24,
        padding: 28,
        width: '100%',
        maxWidth: 460,
        boxShadow: '0 20px 60px -20px rgba(15, 23, 42, 0.18)',
        border: '1px solid #e2e8f0',
      }}>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={fieldLabel}>{label}</label>
      <div style={{ marginTop: 4 }}>{children}</div>
    </div>
  );
}

const fieldLabel: React.CSSProperties = {
  fontSize: 12, color: '#475569', fontWeight: 600,
};
const input: React.CSSProperties = {
  width: '100%', padding: '10px 12px', fontSize: 14,
  border: '1px solid #cbd5e1', borderRadius: 10, background: 'white',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};
