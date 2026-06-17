/**
 * Admin Service Template Builder — page surface for /admin/service-templates.
 *
 * Workflow:
 *   1. Admin fills the form (name, provider, category, two textareas).
 *   2. "Generate Template" calls POST /v1/admin/service-templates/generate
 *      → deterministic parser → returns four JSON blobs.
 *   3. Admin reviews / edits the blobs in textareas.
 *   4. "Save Draft" persists as draft.
 *   5. "Publish" promotes a saved draft.
 *
 * Page is admin-only — same gate as AdminDashboard (redirects on
 * non-admin users). Templates list shows everything (drafts + published
 * + archived) with status pills.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Sparkles, Save, Upload, Archive as ArchiveIcon, FileText, RefreshCw } from 'lucide-react';
import { adminServiceTemplatesApi } from '../../services/api';
import type { AdminGeneratedTemplate, AdminServiceTemplate } from '../../services/api';
import { notify } from '../../store/notificationStore';
import { useAuthStore } from '../../store/authStore';

type ProviderOption = 'thumbtack' | 'yelp' | 'manual';

const PROVIDER_OPTIONS: ProviderOption[] = ['thumbtack', 'yelp', 'manual'];

/** What the page edits between generate → save. Each JSON column is a
 *  string in the editable preview pane so admins can hand-tune raw JSON. */
type EditableTemplate = {
  serviceName: string;
  provider: ProviderOption;
  providerCategoryName: string;
  providerCategoryId: string;
  notes: string;
  rawOptionsText: string;
  rawPricingText: string;
  // Generator output — stored as strings (pretty-printed JSON) so the
  // edit pane can show them verbatim. JSON.parse on save.
  serviceOptionsJson: string;
  pricingJson: string;
  customerAnswersJson: string;
  additionalInstructions: string;
  keyOverride: string;
  description: string;
  sourceJson: AdminGeneratedTemplate['sourceJson'] | null;
};

const EMPTY: EditableTemplate = {
  serviceName: '',
  provider: 'thumbtack',
  providerCategoryName: '',
  providerCategoryId: '',
  notes: '',
  rawOptionsText: '',
  rawPricingText: '',
  serviceOptionsJson: '',
  pricingJson: '',
  customerAnswersJson: '',
  additionalInstructions: '',
  keyOverride: '',
  description: '',
  sourceJson: null,
};

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

/** Treat unparseable input as the raw text so admin can fix on next save attempt. */
function safeParse<T>(raw: string): T | string {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw;
  }
}

function statusPillStyle(status: 'draft' | 'published' | 'archived'): React.CSSProperties {
  const base: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: 9999,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  };
  if (status === 'published') return { ...base, background: '#dcfce7', color: '#166534' };
  if (status === 'archived') return { ...base, background: '#f3f4f6', color: '#6b7280' };
  return { ...base, background: '#fef3c7', color: '#92400e' };
}

export default function AdminServiceTemplates() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();

  const [draft, setDraft] = useState<EditableTemplate>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [templates, setTemplates] = useState<AdminServiceTemplate[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  // Admin gate — non-admins should never see the page contents.
  useEffect(() => {
    if (!user) return;
    if (user.role !== 'ADMIN') {
      notify.error('Access Denied', 'You must be an admin to access this page');
      navigate('/');
    }
  }, [user, navigate]);

  const loadTemplates = async () => {
    try {
      const res = await adminServiceTemplatesApi.list();
      setTemplates(res.templates);
      setListError(null);
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? 'Failed to load templates';
      setListError(msg);
    }
  };

  useEffect(() => {
    if (user?.role === 'ADMIN') loadTemplates();
  }, [user]);

  const canGenerate = useMemo(
    () =>
      draft.serviceName.trim().length > 0 &&
      draft.provider.trim().length > 0 &&
      draft.providerCategoryName.trim().length > 0,
    [draft.serviceName, draft.provider, draft.providerCategoryName],
  );

  const handleGenerate = async () => {
    if (!canGenerate) {
      notify.error('Missing fields', 'Service name, provider, and category are required.');
      return;
    }
    setGenerating(true);
    try {
      const { generated } = await adminServiceTemplatesApi.generate({
        serviceName: draft.serviceName.trim(),
        provider: draft.provider,
        providerCategoryName: draft.providerCategoryName.trim(),
        providerCategoryId: draft.providerCategoryId.trim() || null,
        notes: draft.notes.trim() || null,
        rawOptionsText: draft.rawOptionsText,
        rawPricingText: draft.rawPricingText,
      });
      setDraft((d) => ({
        ...d,
        keyOverride: generated.key,
        description: generated.description ?? '',
        serviceOptionsJson: pretty(generated.serviceOptionsJson),
        pricingJson: pretty(generated.pricingJson),
        customerAnswersJson: pretty(generated.customerAnswersJson),
        additionalInstructions: generated.additionalInstructions ?? '',
        sourceJson: generated.sourceJson,
      }));
      notify.success('Generated', 'Review the JSON below, then Save Draft or Publish.');
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? 'Generation failed';
      notify.error('Generation failed', msg);
    } finally {
      setGenerating(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!draft.sourceJson) {
      notify.error('Generate first', 'Click "Generate Template" before saving.');
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await adminServiceTemplatesApi.patch(editingId, {
          label: draft.serviceName.trim(),
          provider: draft.provider,
          providerCategoryName: draft.providerCategoryName.trim(),
          providerCategoryId: draft.providerCategoryId.trim() || null,
          description: draft.description.trim() || null,
          serviceOptionsJson: safeParse(draft.serviceOptionsJson),
          pricingJson: safeParse(draft.pricingJson),
          customerAnswersJson: safeParse(draft.customerAnswersJson),
          additionalInstructions: draft.additionalInstructions.trim() || null,
        });
        notify.success('Saved', `Template "${draft.serviceName}" updated.`);
      } else {
        await adminServiceTemplatesApi.create({
          key: draft.keyOverride.trim() || `${draft.provider}_template`,
          label: draft.serviceName.trim(),
          provider: draft.provider,
          providerCategoryName: draft.providerCategoryName.trim(),
          providerCategoryId: draft.providerCategoryId.trim() || null,
          description: draft.description.trim() || null,
          serviceOptionsJson: safeParse(draft.serviceOptionsJson),
          pricingJson: safeParse(draft.pricingJson),
          customerAnswersJson: safeParse(draft.customerAnswersJson),
          additionalInstructions: draft.additionalInstructions.trim() || null,
          sourceJson: draft.sourceJson,
        });
        notify.success('Draft saved', `Template "${draft.serviceName}" created as draft.`);
      }
      await loadTemplates();
      handleReset();
    } catch (err: any) {
      const status = err?.response?.status;
      const msg = err?.response?.data?.message ?? err?.message ?? 'Save failed';
      if (status === 409) {
        notify.error(
          'Key already used',
          'Another template already has this key. Change the key field and try again.',
        );
      } else {
        notify.error('Save failed', msg);
      }
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async (id: string) => {
    try {
      await adminServiceTemplatesApi.publish(id);
      notify.success('Published', 'Template is now visible in the public preset picker.');
      await loadTemplates();
    } catch (err: any) {
      notify.error('Publish failed', err?.response?.data?.message ?? err?.message ?? 'Failed');
    }
  };

  const handleArchive = async (id: string) => {
    try {
      await adminServiceTemplatesApi.archive(id);
      notify.success('Archived', 'Template hidden from the public preset picker.');
      await loadTemplates();
    } catch (err: any) {
      notify.error('Archive failed', err?.response?.data?.message ?? err?.message ?? 'Failed');
    }
  };

  const handleEdit = async (template: AdminServiceTemplate) => {
    setEditingId(template.id);
    setDraft({
      serviceName: template.label,
      provider: (PROVIDER_OPTIONS.includes(template.provider as ProviderOption)
        ? template.provider
        : 'manual') as ProviderOption,
      providerCategoryName: template.providerCategoryName,
      providerCategoryId: template.providerCategoryId ?? '',
      notes: '',
      rawOptionsText: '',
      rawPricingText: '',
      serviceOptionsJson: pretty(safeParse(template.serviceOptionsJson)),
      pricingJson: pretty(safeParse(template.pricingJson)),
      customerAnswersJson: pretty(safeParse(template.customerAnswersJson)),
      additionalInstructions: template.additionalInstructions ?? '',
      keyOverride: template.key,
      description: template.description ?? '',
      sourceJson: (template.sourceJson
        ? (safeParse(template.sourceJson) as AdminGeneratedTemplate['sourceJson'])
        : null) ?? {
        kind: 'admin_generated',
        provider: template.provider,
        rawOptionsText: '',
        rawPricingText: '',
        generatorVersion: 1,
        generatedAt: new Date().toISOString(),
      },
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleReset = () => {
    setDraft(EMPTY);
    setEditingId(null);
  };

  if (user?.role !== 'ADMIN') {
    return null;
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
          <Sparkles size={22} color="#2563eb" /> Service Templates
        </h1>
        <p style={{ color: '#6b7280', marginTop: 4 }}>
          Build reusable Service Profile presets from pasted Service Options + Pricing.
          Drafts stay admin-only. Publishing surfaces them in the customer preset picker.
        </p>
      </div>

      {/* Editor card */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
            {editingId ? 'Edit template' : 'Create template'}
          </h2>
          {editingId && (
            <button type="button" style={ghostBtn} onClick={handleReset}>
              Cancel edit
            </button>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Field label="Service name *">
            <input
              type="text"
              value={draft.serviceName}
              onChange={(e) => setDraft({ ...draft, serviceName: e.target.value })}
              style={inputStyle}
              placeholder="e.g. House Cleaning"
            />
          </Field>
          <Field label="Provider *">
            <select
              value={draft.provider}
              onChange={(e) => setDraft({ ...draft, provider: e.target.value as ProviderOption })}
              style={inputStyle}
            >
              {PROVIDER_OPTIONS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field label="Provider category name *">
            <input
              type="text"
              value={draft.providerCategoryName}
              onChange={(e) => setDraft({ ...draft, providerCategoryName: e.target.value })}
              style={inputStyle}
              placeholder="e.g. House Cleaning"
            />
          </Field>
          <Field label="Provider category ID (optional)">
            <input
              type="text"
              value={draft.providerCategoryId}
              onChange={(e) => setDraft({ ...draft, providerCategoryId: e.target.value })}
              style={inputStyle}
            />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
          <Field label="Service Options (paste)">
            <textarea
              value={draft.rawOptionsText}
              onChange={(e) => setDraft({ ...draft, rawOptionsText: e.target.value })}
              rows={10}
              style={textareaStyle}
              placeholder={'Which types of stains do you clean?\n- Pet stains\n- Food stains\n- Drink stains\n\nHow many rooms?\n- 1 room\n- 2 rooms\n- 3 rooms'}
            />
          </Field>
          <Field label="Pricing (paste)">
            <textarea
              value={draft.rawPricingText}
              onChange={(e) => setDraft({ ...draft, rawPricingText: e.target.value })}
              rows={10}
              style={textareaStyle}
              placeholder={'1 room Avg. $79\n2 rooms Avg. $103\n3 rooms Avg. $132\n\nAdd-ons:\nCleaning 1 flight of stairs\nCleaning stains'}
            />
          </Field>
        </div>

        <Field label="Notes (optional, stored in sourceJson)">
          <textarea
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            rows={2}
            style={textareaStyle}
            placeholder="Anything to remember about how this template was built"
          />
        </Field>

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={!canGenerate || generating}
            style={primaryBtn(!canGenerate || generating)}
          >
            {generating ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Sparkles size={14} />}
            {' '}
            Generate Template
          </button>
        </div>

        {/* Generated JSON preview */}
        {draft.sourceJson && (
          <div style={{ marginTop: 18 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: '#374151' }}>Generated JSON — review and edit</h3>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 8 }}>
              <Field label="Template key">
                <input
                  type="text"
                  value={draft.keyOverride}
                  onChange={(e) => setDraft({ ...draft, keyOverride: e.target.value })}
                  style={inputStyle}
                />
              </Field>
              <Field label="Description (optional)">
                <input
                  type="text"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  style={inputStyle}
                />
              </Field>
            </div>

            <Field label="Service Options JSON">
              <textarea
                value={draft.serviceOptionsJson}
                onChange={(e) => setDraft({ ...draft, serviceOptionsJson: e.target.value })}
                rows={10}
                style={{ ...textareaStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
              />
            </Field>

            <Field label="Pricing JSON">
              <textarea
                value={draft.pricingJson}
                onChange={(e) => setDraft({ ...draft, pricingJson: e.target.value })}
                rows={10}
                style={{ ...textareaStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
              />
            </Field>

            <Field label="Customer Answers JSON">
              <textarea
                value={draft.customerAnswersJson}
                onChange={(e) => setDraft({ ...draft, customerAnswersJson: e.target.value })}
                rows={10}
                style={{ ...textareaStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
              />
            </Field>

            <Field label="Additional Service Instructions (optional)">
              <textarea
                value={draft.additionalInstructions}
                onChange={(e) => setDraft({ ...draft, additionalInstructions: e.target.value })}
                rows={3}
                style={textareaStyle}
                placeholder="e.g. Never guarantee stain removal. Always ask mattress size."
              />
            </Field>

            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button
                type="button"
                onClick={handleSaveDraft}
                disabled={saving}
                style={primaryBtn(saving)}
              >
                {saving ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={14} />}
                {' '}
                {editingId ? 'Save changes' : 'Save Draft'}
              </button>
              <button type="button" onClick={handleReset} style={ghostBtn}>
                Reset
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Templates list */}
      <div style={{ ...cardStyle, marginTop: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FileText size={18} /> Templates
          </h2>
          <button type="button" onClick={loadTemplates} style={ghostBtn} title="Refresh list">
            <RefreshCw size={14} />
          </button>
        </div>

        {listError && (
          <div style={errorBoxStyle}>{listError}</div>
        )}

        {templates === null ? (
          <div style={{ color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading…
          </div>
        ) : templates.length === 0 ? (
          <p style={{ color: '#6b7280', margin: 0 }}>No templates yet. Generate one above to get started.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>
                <th style={thStyle}>Label</th>
                <th style={thStyle}>Provider / Category</th>
                <th style={thStyle}>Key</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Updated</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={tdStyle}>{t.label}</td>
                  <td style={tdStyle}>
                    <span style={{ color: '#6b7280' }}>{t.provider} · </span>
                    {t.providerCategoryName}
                  </td>
                  <td style={{ ...tdStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}>
                    {t.key}
                  </td>
                  <td style={tdStyle}>
                    <span style={statusPillStyle(t.status)}>{t.status}</span>
                  </td>
                  <td style={tdStyle}>{new Date(t.updatedAt).toLocaleString()}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    <button type="button" style={smallGhostBtn} onClick={() => handleEdit(t)}>
                      Edit
                    </button>
                    {t.status !== 'published' && (
                      <button
                        type="button"
                        style={smallPrimaryBtn}
                        onClick={() => handlePublish(t.id)}
                        title="Publish to public preset picker"
                      >
                        <Upload size={11} /> Publish
                      </button>
                    )}
                    {t.status !== 'archived' && (
                      <button
                        type="button"
                        style={smallGhostBtn}
                        onClick={() => handleArchive(t.id)}
                        title="Archive — hidden from public picker"
                      >
                        <ArchiveIcon size={11} /> Archive
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Small inline UI primitives ────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', marginTop: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 4 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

const cardStyle: React.CSSProperties = {
  background: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  padding: 20,
  boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  padding: '8px 10px',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  lineHeight: 1.5,
};

const primaryBtn = (disabled: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 14px',
  background: disabled ? '#93c5fd' : '#2563eb',
  color: 'white',
  fontWeight: 600,
  fontSize: 13,
  border: 'none',
  borderRadius: 6,
  cursor: disabled ? 'not-allowed' : 'pointer',
});

const ghostBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  background: 'white',
  color: '#374151',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
};

const smallPrimaryBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 8px',
  background: '#2563eb',
  color: 'white',
  fontWeight: 600,
  fontSize: 11,
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  marginLeft: 6,
};

const smallGhostBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 8px',
  background: 'white',
  color: '#374151',
  border: '1px solid #d1d5db',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 11,
  marginLeft: 6,
};

const thStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#6b7280',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  padding: '8px 6px',
};

const tdStyle: React.CSSProperties = {
  padding: '10px 6px',
  verticalAlign: 'middle',
};

const errorBoxStyle: React.CSSProperties = {
  background: '#fef2f2',
  color: '#991b1b',
  border: '1px solid #fecaca',
  borderRadius: 6,
  padding: '8px 12px',
  marginBottom: 12,
  fontSize: 13,
};
