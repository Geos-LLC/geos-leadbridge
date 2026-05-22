import { useEffect, useState } from 'react';
import { Plus, Save, X, Loader2, Sparkles, AlertTriangle, Eye } from 'lucide-react';
import {
  partnerNetworkApi,
  type PartnerBusiness,
  type PartnerRelationship,
} from '../../services/partnerNetwork';
import { Card, Btn } from '../../components/ui';
import {
  WidgetPreview,
  WIDGET_TEMPLATES,
  OFFER_TEMPLATES,
  type WidgetTemplate,
} from './widgets/WidgetPreview';

interface FormState {
  sourceBusinessId: string;
  destinationBusinessId: string;
  name: string;
  defaultOfferText: string;
  notes: string;
  widgetEnabled: boolean;
  widgetType: string;
  popupDelayMs: string;
  autoOpenFromReferral: boolean;
  aiHint: string;
}
const EMPTY_FORM: FormState = {
  sourceBusinessId: '',
  destinationBusinessId: '',
  name: '',
  defaultOfferText: '',
  notes: '',
  widgetEnabled: false,
  widgetType: '',
  popupDelayMs: '',
  autoOpenFromReferral: false,
  aiHint: '',
};

export default function PartnerNetworkRelationships() {
  const [relationships, setRelationships] = useState<PartnerRelationship[]>([]);
  const [businesses, setBusinesses] = useState<PartnerBusiness[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiInfo, setAiInfo] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [r, b] = await Promise.all([
        partnerNetworkApi.listRelationships(),
        partnerNetworkApi.listBusinesses(),
      ]);
      setRelationships(r);
      setBusinesses(b);
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const onSubmit = async () => {
    if (!form.sourceBusinessId || !form.destinationBusinessId) {
      setError('Pick a source and destination business');
      return;
    }
    if (form.sourceBusinessId === form.destinationBusinessId) {
      setError('Source and destination must be different');
      return;
    }
    setSubmitting(true);
    setError(null);
    const popupDelayMs = form.popupDelayMs.trim()
      ? Number.parseInt(form.popupDelayMs.trim(), 10)
      : undefined;
    if (popupDelayMs !== undefined && (Number.isNaN(popupDelayMs) || popupDelayMs < 0)) {
      setError('Popup delay must be a non-negative number of milliseconds');
      setSubmitting(false);
      return;
    }
    try {
      if (editingId) {
        await partnerNetworkApi.updateRelationship(editingId, {
          name: form.name.trim() || undefined,
          defaultOfferText: form.defaultOfferText.trim() || undefined,
          notes: form.notes.trim() || undefined,
          widgetEnabled: form.widgetEnabled,
          widgetType: form.widgetType.trim() || undefined,
          popupDelayMs: popupDelayMs ?? null,
          autoOpenFromReferral: form.autoOpenFromReferral,
        });
      } else {
        await partnerNetworkApi.createRelationship({
          sourceBusinessId: form.sourceBusinessId,
          destinationBusinessId: form.destinationBusinessId,
          name: form.name.trim() || undefined,
          defaultOfferText: form.defaultOfferText.trim() || undefined,
          notes: form.notes.trim() || undefined,
          widgetEnabled: form.widgetEnabled,
          widgetType: form.widgetType.trim() || undefined,
          popupDelayMs,
          autoOpenFromReferral: form.autoOpenFromReferral,
        });
      }
      setShowForm(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleActive = async (r: PartnerRelationship) => {
    try {
      await partnerNetworkApi.updateRelationship(r.id, { active: !r.active });
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Update failed');
    }
  };

  const startEdit = (r: PartnerRelationship) => {
    setEditingId(r.id);
    setForm({
      sourceBusinessId: r.sourceBusinessId,
      destinationBusinessId: r.destinationBusinessId,
      name: r.name ?? '',
      defaultOfferText: r.defaultOfferText ?? '',
      notes: r.notes ?? '',
      widgetEnabled: r.widgetEnabled ?? false,
      widgetType: r.widgetType ?? '',
      popupDelayMs: r.popupDelayMs == null ? '' : String(r.popupDelayMs),
      autoOpenFromReferral: r.autoOpenFromReferral ?? false,
      aiHint: '',
    });
    setAiError(null);
    setAiInfo(null);
    setShowForm(true);
  };

  // AI-suggest a partnership Name + Default Offer Text. Both businesses must
  // be picked first. Output is editable — the suggester just primes the
  // fields, the admin still has to click Save.
  const onAiSuggest = async () => {
    setAiError(null);
    setAiInfo(null);
    if (!form.sourceBusinessId || !form.destinationBusinessId) {
      setAiError('Pick both a source and destination business first.');
      return;
    }
    if (form.sourceBusinessId === form.destinationBusinessId) {
      setAiError('Source and destination must be different.');
      return;
    }
    setAiBusy(true);
    try {
      const out = await partnerNetworkApi.suggestRelationshipCopy({
        sourceBusinessId: form.sourceBusinessId,
        destinationBusinessId: form.destinationBusinessId,
        hint: form.aiHint.trim() || undefined,
      });
      setForm(f => ({ ...f, name: out.name, defaultOfferText: out.offerText }));
      if (!out.usedMetadata) {
        // Output quality is meaningfully better with cached site metadata —
        // flag this so the admin knows to click "Verify" on the business
        // pages before generating again.
        setAiInfo(
          "Generated from business name + category only. For sharper, site-grounded copy, click “Verify” on each business's website first.",
        );
      }
    } catch (err: any) {
      setAiError(err?.response?.data?.message || 'AI suggestion failed.');
    } finally {
      setAiBusy(false);
    }
  };

  // True when at least one of the picked businesses has cached site metadata
  // (set by the Verify button on the business form). Used to decide whether
  // to show the "Click Verify first for better results" hint.
  const sourceBusiness = businesses.find(b => b.id === form.sourceBusinessId) || null;
  const destinationBusiness = businesses.find(b => b.id === form.destinationBusinessId) || null;
  const hasAnyMetadata = !!(sourceBusiness?.websiteMetadataJson || destinationBusiness?.websiteMetadataJson);
  const bothPicked = !!form.sourceBusinessId && !!form.destinationBusinessId;

  // Constrain freeform widgetType strings to the three known templates;
  // anything else (or empty) falls back to 'banner' so the preview always
  // has something to render. Saved value stays a string per the existing
  // PartnerRelationship.widgetType column.
  const widgetTemplate: WidgetTemplate = ((): WidgetTemplate => {
    const t = form.widgetType.trim().toLowerCase();
    if (t === 'card' || t === 'modal' || t === 'banner') return t;
    return 'banner';
  })();
  const setWidgetTemplate = (t: WidgetTemplate) => setForm(f => ({ ...f, widgetType: t }));

  const applyOfferTemplate = (text: string) => {
    setForm(f => ({ ...f, defaultOfferText: text }));
  };

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--lb-ink-1)', margin: 0 }}>Partner relationships</h2>
          <p style={{ fontSize: 13, color: 'var(--lb-ink-5)', margin: '4px 0 0' }}>
            Configure which business sends leads to which.
          </p>
        </div>
        {!showForm && (
          <Btn variant="accent" icon={<Plus size={14} />} onClick={() => { setEditingId(null); setForm(EMPTY_FORM); setShowForm(true); }}>
            New relationship
          </Btn>
        )}
      </div>

      {error && (
        <div style={{ padding: 12, background: 'var(--lb-danger-tint)', color: '#991b1b', borderRadius: 8, fontSize: 13 }}>
          {error}
        </div>
      )}

      {showForm && (
        <Card title={editingId ? 'Edit relationship' : 'New relationship'} action={
          <Btn icon={<X size={13} />} onClick={() => { setShowForm(false); setEditingId(null); setForm(EMPTY_FORM); }}>Cancel</Btn>
        }>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Source business *">
              <select
                value={form.sourceBusinessId}
                onChange={e => setForm({ ...form, sourceBusinessId: e.target.value })}
                style={inputStyle}
                disabled={!!editingId}
              >
                <option value="">— Select —</option>
                {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            <Field label="Destination business *">
              <select
                value={form.destinationBusinessId}
                onChange={e => setForm({ ...form, destinationBusinessId: e.target.value })}
                style={inputStyle}
                disabled={!!editingId}
              >
                <option value="">— Select —</option>
                {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            <Field label="AI suggestion (optional)" wide>
              <div style={{
                display: 'flex', flexDirection: 'column', gap: 8,
                padding: 12, borderRadius: 8,
                background: 'linear-gradient(135deg, #faf5ff 0%, #eff6ff 100%)',
                border: '1px dashed #c4b5fd',
              }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
                  <input
                    value={form.aiHint}
                    onChange={e => setForm({ ...form, aiHint: e.target.value })}
                    style={{ ...inputStyle, flex: 1 }}
                    placeholder="Optional hint, e.g. 'lead with a first-time discount'"
                    disabled={aiBusy}
                  />
                  <button
                    type="button"
                    onClick={() => void onAiSuggest()}
                    disabled={!bothPicked || aiBusy}
                    style={{
                      padding: '8px 14px', fontSize: 12, fontWeight: 600,
                      borderRadius: 8, border: '1px solid #7c3aed',
                      background: bothPicked && !aiBusy ? '#7c3aed' : 'var(--lb-ink-10)',
                      color: bothPicked && !aiBusy ? '#fff' : 'var(--lb-ink-5)',
                      cursor: aiBusy ? 'wait' : (bothPicked ? 'pointer' : 'not-allowed'),
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {aiBusy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                    {aiBusy ? 'Generating…' : 'Generate with AI'}
                  </button>
                </div>
                {bothPicked && !hasAnyMetadata && !aiBusy && !aiError && !aiInfo && (
                  <div style={{ fontSize: 11, color: 'var(--lb-ink-5)', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                    <AlertTriangle size={12} style={{ color: '#d97706', flexShrink: 0, marginTop: 1 }} />
                    <span>
                      Tip: visit Businesses and click <strong>Verify</strong> on each site first.
                      The AI uses each site's title and description to write a sharper offer.
                    </span>
                  </div>
                )}
                {aiInfo && (
                  <div style={{ padding: 8, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, fontSize: 11, color: '#92400e' }}>
                    {aiInfo}
                  </div>
                )}
                {aiError && (
                  <div style={{ padding: 8, background: 'var(--lb-danger-tint)', border: '1px solid #fecaca', borderRadius: 6, fontSize: 11, color: '#991b1b' }}>
                    {aiError}
                  </div>
                )}
              </div>
            </Field>
            <Field label="Name (optional)" wide>
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={inputStyle} placeholder="Spotless → Premium Upholstery" />
            </Field>
            <Field label="Default offer text" wide>
              <textarea value={form.defaultOfferText} onChange={e => setForm({ ...form, defaultOfferText: e.target.value })} style={{ ...inputStyle, minHeight: 80 }} placeholder="Get $25 off your first upholstery cleaning" />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                <span style={{ fontSize: 10.5, color: 'var(--lb-ink-5)', alignSelf: 'center', textTransform: 'uppercase', letterSpacing: 0.04, fontWeight: 500 }}>
                  Quick start:
                </span>
                {OFFER_TEMPLATES.map(t => (
                  <button
                    key={t.label}
                    type="button"
                    onClick={() => applyOfferTemplate(t.text(destinationBusiness?.name || 'this partner'))}
                    style={{
                      padding: '4px 10px', fontSize: 11, fontWeight: 500,
                      borderRadius: 999, border: '1px solid var(--lb-line)',
                      background: 'var(--lb-surface)', color: 'var(--lb-ink-2)',
                      cursor: 'pointer', whiteSpace: 'nowrap',
                    }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Notes" wide>
              <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} style={{ ...inputStyle, minHeight: 60 }} />
            </Field>
            <Field label="Widget" wide>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--lb-ink-3)' }}>
                <input
                  type="checkbox"
                  checked={form.widgetEnabled}
                  onChange={e => setForm({ ...form, widgetEnabled: e.target.checked })}
                />
                Enable embeddable widget for this relationship
              </label>

              {form.widgetEnabled && (
                <>
                  {/* Template picker — three small cards, click to select.
                      Saves the chosen key into widgetType so the future
                      partner-widget.js runtime can read it as-is. */}
                  <div style={{ marginTop: 12, marginBottom: 4 }}>
                    <div style={{ fontSize: 11, color: 'var(--lb-ink-5)', textTransform: 'uppercase', letterSpacing: 0.04, fontWeight: 500, marginBottom: 6 }}>
                      Template
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                      {WIDGET_TEMPLATES.map(t => {
                        const active = widgetTemplate === t.key;
                        return (
                          <button
                            key={t.key}
                            type="button"
                            onClick={() => setWidgetTemplate(t.key)}
                            style={{
                              padding: '10px 12px',
                              borderRadius: 10,
                              border: active ? '2px solid #7c3aed' : '1px solid var(--lb-line)',
                              background: active ? '#faf5ff' : 'var(--lb-surface)',
                              cursor: 'pointer',
                              textAlign: 'left',
                              fontFamily: 'inherit',
                              transition: 'border-color 120ms, background 120ms',
                            }}
                          >
                            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-1)' }}>
                              {t.label}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--lb-ink-5)', marginTop: 2 }}>
                              {t.sublabel}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Behavior controls — only meaningful for card/modal which
                      can pop after a delay or auto-open from ?ref=. Banner
                      is always visible at page top, so the delay is ignored
                      there. We keep both fields editable regardless and
                      explain the no-op in the helper text. */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
                    <input
                      style={inputStyle}
                      type="number"
                      min={0}
                      max={120000}
                      placeholder="popupDelayMs (e.g. 4000)"
                      value={form.popupDelayMs}
                      onChange={e => setForm({ ...form, popupDelayMs: e.target.value })}
                      disabled={widgetTemplate === 'banner'}
                    />
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--lb-ink-3)' }}>
                      <input
                        type="checkbox"
                        checked={form.autoOpenFromReferral}
                        onChange={e => setForm({ ...form, autoOpenFromReferral: e.target.checked })}
                        disabled={widgetTemplate === 'banner'}
                      />
                      Auto-open when arriving with <code>?ref=</code>
                    </label>
                  </div>

                  {/* Live preview — renders the chosen template on a mock
                      partner-site frame using the real destination name +
                      current offer text so the admin can iterate copy and
                      style together. */}
                  <div style={{ marginTop: 14 }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      fontSize: 11, color: 'var(--lb-ink-5)', textTransform: 'uppercase',
                      letterSpacing: 0.04, fontWeight: 500, marginBottom: 6,
                    }}>
                      <Eye size={12} /> Preview
                    </div>
                    {bothPicked ? (
                      <WidgetPreview
                        template={widgetTemplate}
                        destinationName={destinationBusiness?.name || ''}
                        offerText={form.defaultOfferText}
                        sourceName={sourceBusiness?.name || ''}
                        sourceWebsite={sourceBusiness?.website || null}
                      />
                    ) : (
                      <div style={{
                        padding: 18, borderRadius: 10,
                        border: '1px dashed var(--lb-line)',
                        background: 'var(--lb-ink-12, #f7f7fa)',
                        fontSize: 12, color: 'var(--lb-ink-5)', textAlign: 'center',
                      }}>
                        Pick a source and destination business above to see the preview.
                      </div>
                    )}
                  </div>

                  <p style={{ fontSize: 11, color: 'var(--lb-ink-5)', marginTop: 10 }}>
                    Preview only — the embed runtime (<code>partner-widget.js</code>) is shipping next.
                    Your choices save now so the widget renders correctly the moment it goes live.
                  </p>
                </>
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

      <Card padding={0}>
        {loading ? (
          <div style={{ padding: 16, color: 'var(--lb-ink-5)', display: 'flex', gap: 8 }}>
            <Loader2 className="animate-spin" size={16} /> Loading…
          </div>
        ) : relationships.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--lb-ink-5)', textAlign: 'center', fontSize: 13 }}>
            No relationships yet.
          </div>
        ) : (
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr style={{ color: 'var(--lb-ink-5)', textAlign: 'left' }}>
                <th style={th}>Source</th>
                <th style={th}>→</th>
                <th style={th}>Destination</th>
                <th style={th}>Offer</th>
                <th style={th}>Status</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {relationships.map(r => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--lb-line-soft)' }}>
                  <td style={td}><strong>{r.sourceBusiness.name}</strong></td>
                  <td style={td}>→</td>
                  <td style={td}><strong>{r.destinationBusiness.name}</strong></td>
                  <td style={{ ...td, color: 'var(--lb-ink-4)', maxWidth: 280 }}>
                    {r.defaultOfferText ? r.defaultOfferText.slice(0, 80) + (r.defaultOfferText.length > 80 ? '…' : '') : '—'}
                  </td>
                  <td style={td}>
                    <span style={{
                      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                      background: r.active ? 'var(--lb-success-tint)' : 'var(--lb-ink-10)',
                      color: r.active ? '#15803d' : 'var(--lb-ink-5)',
                    }}>{r.active ? 'Active' : 'Inactive'}</span>
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <Btn size="sm" onClick={() => startEdit(r)}>Edit</Btn>
                    <span style={{ marginLeft: 6 }} />
                    <Btn size="sm" onClick={() => toggleActive(r)}>{r.active ? 'Deactivate' : 'Activate'}</Btn>
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
  fontFamily: 'inherit',
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
