import { useEffect, useState } from 'react';
import { Plus, Loader2, Save, Pencil, X, CheckCircle2, AlertTriangle, Globe } from 'lucide-react';
import { partnerNetworkApi, type PartnerBusiness } from '../../services/partnerNetwork';
import { US_LOCATION_SUGGESTIONS, looksLikeServiceArea } from './data/us-locations';
import { Card, Btn } from '../../components/ui';

interface BusinessFormState {
  name: string;
  category: string;
  phone: string;
  website: string;
  serviceArea: string;
}

interface WebsiteVerifyState {
  kind: 'idle' | 'checking';
}
interface WebsiteVerifyOutcome {
  reachable: boolean;
  normalizedUrl: string;
  metadata?: { title?: string; description?: string; phone?: string };
  errorCode?: string;
  errorMessage?: string;
}

const EMPTY_FORM: BusinessFormState = {
  name: '',
  category: '',
  phone: '',
  website: '',
  serviceArea: '',
};

// Format raw digits into "(555) 555-1234" or "+1 (555) 555-1234". Display
// only — submitted value goes through the backend's normalizePhoneE164 which
// will accept any of the formats we render here.
function formatPhoneDisplay(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 0) return '';
  if (digits.length <= 3) return `(${digits}`;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  if (digits.length <= 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return `+${digits}`;
}

export default function PartnerNetworkBusinesses() {
  const [businesses, setBusinesses] = useState<PartnerBusiness[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<BusinessFormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [websiteVerify, setWebsiteVerify] = useState<WebsiteVerifyState>({ kind: 'idle' });
  const [websiteOutcome, setWebsiteOutcome] = useState<WebsiteVerifyOutcome | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setBusinesses(await partnerNetworkApi.listBusinesses());
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Failed to load businesses');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Reset the form + clear any cached verify outcome. Called when opening the
  // form fresh, cancelling, or finishing a save.
  const resetForm = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setWebsiteOutcome(null);
    setWebsiteVerify({ kind: 'idle' });
  };

  // Live verify against the partner-network module's own endpoint. The
  // request is identical in shape to the main-app verifier, but the
  // implementation lives entirely under src/modules/partner-network — no
  // dependency on UsersService or any main-app endpoint.
  const onVerifyWebsite = async () => {
    const value = form.website.trim();
    if (!value) return;
    setWebsiteVerify({ kind: 'checking' });
    setWebsiteOutcome(null);
    try {
      const outcome = await partnerNetworkApi.verifyBusinessWebsite(value);
      setWebsiteOutcome(outcome);
      if (outcome.reachable) {
        setForm(f => ({ ...f, website: outcome.normalizedUrl }));
      }
    } catch (err: any) {
      setWebsiteOutcome({
        reachable: false,
        normalizedUrl: value,
        errorMessage: err?.response?.data?.message || 'Could not verify site.',
      });
    } finally {
      setWebsiteVerify({ kind: 'idle' });
    }
  };

  const onSubmit = async () => {
    if (!form.name.trim()) {
      setError('Name is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        name: form.name.trim(),
        category: form.category.trim() || undefined,
        // Backend normalizePhoneE164 handles the digit strip + E.164 prefixing.
        // We submit the display-formatted value; backend treats the raw digits.
        phone: form.phone.trim() || undefined,
        // If the user clicked Verify, use the normalized URL the verifier
        // returned (canonical form, e.g. apex → www., http → https). Otherwise
        // hand the raw value to the backend, which runs the same format-only
        // normalizer (no live probe) before save.
        website: (websiteOutcome?.reachable
          ? websiteOutcome.normalizedUrl
          : form.website.trim()) || undefined,
        // Persist the verify metadata (title / description / phone) so the
        // AI relationship-copy suggester can ground its output in real site
        // info. Only sent when the verify call actually reached the site.
        websiteMetadata: websiteOutcome?.reachable && websiteOutcome.metadata
          ? websiteOutcome.metadata
          : undefined,
        serviceArea: form.serviceArea.trim() || undefined,
      };
      if (editingId) {
        await partnerNetworkApi.updateBusiness(editingId, payload);
      } else {
        await partnerNetworkApi.createBusiness(payload);
      }
      setShowForm(false);
      resetForm();
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (b: PartnerBusiness) => {
    setEditingId(b.id);
    setForm({
      name: b.name,
      category: b.category ?? '',
      // Display existing E.164 numbers in their formatted form so editing
      // feels consistent with creation.
      phone: b.phone ? formatPhoneDisplay(b.phone) : '',
      website: b.website ?? '',
      serviceArea: b.serviceArea ?? '',
    });
    setWebsiteOutcome(null);
    setWebsiteVerify({ kind: 'idle' });
    setShowForm(true);
  };

  const toggleActive = async (b: PartnerBusiness) => {
    try {
      await partnerNetworkApi.updateBusiness(b.id, { active: !b.active });
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Update failed');
    }
  };

  const isVerifyingWebsite = websiteVerify.kind === 'checking';
  const websiteVerified = !!websiteOutcome?.reachable;

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--lb-ink-1)', margin: 0 }}>Businesses</h2>
          <p style={{ fontSize: 13, color: 'var(--lb-ink-5)', margin: '4px 0 0' }}>
            Partner-network businesses you operate or partner with.
          </p>
        </div>
        {!showForm && (
          <Btn variant="accent" icon={<Plus size={14} />} onClick={() => { resetForm(); setShowForm(true); }}>
            New business
          </Btn>
        )}
      </div>

      {error && (
        <div style={{ padding: 12, background: 'var(--lb-danger-tint)', color: '#991b1b', borderRadius: 8, fontSize: 13 }}>
          {error}
        </div>
      )}

      {showForm && (
        <Card title={editingId ? 'Edit business' : 'New business'} action={
          <Btn icon={<X size={13} />} onClick={() => { setShowForm(false); resetForm(); }}>Cancel</Btn>
        }>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Name *">
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={inputStyle} placeholder="Spotless Homes" />
            </Field>
            <Field label="Category">
              <input value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} style={inputStyle} placeholder="House cleaning" />
            </Field>
            <Field label="Phone">
              <input
                value={form.phone}
                onChange={e => setForm({ ...form, phone: formatPhoneDisplay(e.target.value) })}
                inputMode="tel"
                autoComplete="tel"
                style={inputStyle}
                placeholder="(555) 555-1234"
              />
            </Field>
            <Field label="Website">
              <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
                <input
                  value={form.website}
                  onChange={e => {
                    setForm({ ...form, website: e.target.value });
                    // Any edit clears the previous verify result so the user
                    // doesn't accidentally save a stale ✅ next to a changed URL.
                    if (websiteOutcome) setWebsiteOutcome(null);
                  }}
                  inputMode="url"
                  autoComplete="url"
                  style={{ ...inputStyle, flex: 1 }}
                  placeholder="myco.com or https://myco.com"
                />
                <button
                  type="button"
                  onClick={() => void onVerifyWebsite()}
                  disabled={isVerifyingWebsite || !form.website.trim()}
                  style={{
                    padding: '8px 12px', fontSize: 12, fontWeight: 600,
                    borderRadius: 8, border: '1px solid var(--lb-line)',
                    background: websiteVerified ? '#ecfdf5' : 'var(--lb-surface)',
                    color: websiteVerified ? '#15803d' : 'var(--lb-ink-2)',
                    cursor: isVerifyingWebsite ? 'wait' : 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {isVerifyingWebsite ? <Loader2 size={12} className="animate-spin" /> : <Globe size={12} />}
                  {isVerifyingWebsite ? 'Checking…' : websiteVerified ? 'Verified' : 'Verify'}
                </button>
              </div>
              {websiteOutcome && !isVerifyingWebsite && (
                <div style={{ marginTop: 6 }}>
                  {websiteOutcome.reachable ? (
                    <div style={{ padding: 8, background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 6, fontSize: 12, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                      <CheckCircle2 size={14} style={{ color: '#15803d', flexShrink: 0, marginTop: 1 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, color: '#15803d', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {websiteOutcome.metadata?.title || websiteOutcome.normalizedUrl}
                        </div>
                        {websiteOutcome.metadata?.description && (
                          <div style={{ color: '#065f46', fontSize: 11, marginTop: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                            {websiteOutcome.metadata.description}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div style={{ padding: 8, background: 'var(--lb-danger-tint)', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                      <AlertTriangle size={14} style={{ color: '#b91c1c', flexShrink: 0, marginTop: 1 }} />
                      <div style={{ color: '#991b1b' }}>
                        {websiteOutcome.errorMessage || "Couldn't reach that site."} You can still save it — verification is optional.
                      </div>
                    </div>
                  )}
                </div>
              )}
            </Field>
            <Field label="Service area" wide>
              <input
                value={form.serviceArea}
                onChange={e => setForm({ ...form, serviceArea: e.target.value })}
                style={inputStyle}
                placeholder="Boston, MA"
                list="partner-network-us-locations"
                autoComplete="off"
              />
              {form.serviceArea.trim() !== '' && !looksLikeServiceArea(form.serviceArea) && (
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--lb-warning, #b45309)' }}>
                  Tip: use the format <strong>City, ST</strong> (e.g. Boston, MA) or a state name.
                  Off-list entries are accepted — this is just a heads-up.
                </div>
              )}
            </Field>
          </div>
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
            <Btn variant="accent" icon={<Save size={14} />} onClick={onSubmit} disabled={submitting}>
              {submitting ? 'Saving…' : 'Save'}
            </Btn>
          </div>
        </Card>
      )}

      {/* Shared <datalist> for the service-area autocomplete. Lives once at
          the page level (not inside the form) so the browser cache the
          render even when the form unmounts/remounts. ~350 entries, gzips
          to a few KB — small enough to inline. */}
      <datalist id="partner-network-us-locations">
        {US_LOCATION_SUGGESTIONS.map(loc => (
          <option key={loc} value={loc} />
        ))}
      </datalist>

      <Card padding={0}>
        {loading ? (
          <div style={{ padding: 16, color: 'var(--lb-ink-5)', display: 'flex', gap: 8 }}>
            <Loader2 className="animate-spin" size={16} /> Loading…
          </div>
        ) : businesses.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--lb-ink-5)', textAlign: 'center', fontSize: 13 }}>
            No businesses yet. Create your first one to begin.
          </div>
        ) : (
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr style={{ color: 'var(--lb-ink-5)', textAlign: 'left' }}>
                <th style={th}>Name</th>
                <th style={th}>Category</th>
                <th style={th}>Phone</th>
                <th style={th}>Service area</th>
                <th style={th}>Status</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {businesses.map(b => (
                <tr key={b.id} style={{ borderTop: '1px solid var(--lb-line-soft)' }}>
                  <td style={td}><strong>{b.name}</strong></td>
                  <td style={td}>{b.category || '—'}</td>
                  <td style={td}>{b.phone ? formatPhoneDisplay(b.phone) : '—'}</td>
                  <td style={td}>{b.serviceArea || '—'}</td>
                  <td style={td}>
                    <span style={{
                      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                      background: b.active ? 'var(--lb-success-tint)' : 'var(--lb-ink-10)',
                      color: b.active ? '#15803d' : 'var(--lb-ink-5)',
                    }}>{b.active ? 'Active' : 'Inactive'}</span>
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <Btn size="sm" icon={<Pencil size={12} />} onClick={() => startEdit(b)}>Edit</Btn>
                    <span style={{ marginLeft: 6 }} />
                    <Btn size="sm" onClick={() => toggleActive(b)}>{b.active ? 'Deactivate' : 'Activate'}</Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', fontSize: 13,
  border: '1px solid var(--lb-line)', borderRadius: 8, background: 'var(--lb-surface)',
};
const th: React.CSSProperties = { padding: '10px 14px', fontWeight: 500 };
const td: React.CSSProperties = { padding: '10px 14px', verticalAlign: 'middle' };

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ gridColumn: wide ? 'span 2' : 'auto' }}>
      <label style={{ fontSize: 11, color: 'var(--lb-ink-5)', textTransform: 'uppercase', letterSpacing: 0.04, fontWeight: 500, display: 'block', marginBottom: 4 }}>
        {label}
      </label>
      {children}
    </div>
  );
}
