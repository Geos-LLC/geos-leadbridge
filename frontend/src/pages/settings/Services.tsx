/**
 * Settings → Services tab.
 *
 * Two views switched by selected profile id:
 *   - List view: cards for each ServiceProfile + "Create from preset" button
 *   - Detail view: edit name/mappings/pricing/FAQ/qualification + location
 *                  overrides + activate/archive/duplicate actions
 *
 * All editor fields except name + mappings are JSON textareas (MVP).
 * Per the brief: "MVP can expose JSON-backed structured editors or
 * reuse existing pricing/FAQ forms if available". Specialized forms
 * are deferred until the underlying schemas are more stable.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Layers, Plus, Loader2, X, Check, ArrowLeft, Edit3, Archive,
  CheckCircle2, Copy, Sparkles, MapPin, Trash2, Save,
  Code2, Table2, Clock, ShieldAlert, ListChecks, AlertTriangle,
} from 'lucide-react';
import { SettingCard } from '../../components/automation/ui';
import { notify } from '../../store/notificationStore';
import {
  serviceProfilePresetsApi,
  serviceProfilesApi,
  type ServiceProfilePreset,
  type ServiceProfile,
  type ServiceProfileOverrideRow,
} from '../../services/api';
import {
  PriceChip,
  PriceRow,
  PriceTableSection,
  UnifiedAddRowButton,
} from '../../components/playbook-controls';

export function SettingsServices() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshTok, setRefreshTok] = useState(0);
  const refresh = () => setRefreshTok((t) => t + 1);

  return (
    <div>
      <LegacyServicesBanner />
      {selectedId ? (
        <ProfileDetail
          profileId={selectedId}
          onBack={() => setSelectedId(null)}
        />
      ) : (
        <ProfileList
          onSelect={(id) => setSelectedId(id)}
          refreshTok={refreshTok}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function LegacyServicesBanner() {
  return (
    <div style={{
      padding: '12px 14px',
      marginBottom: 16,
      borderRadius: 10,
      background: '#eff6ff',
      border: '1px solid #bfdbfe',
      display: 'flex',
      gap: 10,
      alignItems: 'flex-start',
      fontSize: 13,
      color: 'var(--lb-ink-2, #132044)',
      lineHeight: 1.5,
    }}>
      <span style={{ flex: 1 }}>
        <strong>Services moved.</strong> Service profiles are now managed under{' '}
        <a href="/settings?tab=general#services-offered" style={{ color: '#1d4ed8', fontWeight: 600 }}>
          General → Services Offered
        </a>
        . Pricing, FAQ, and qualification editors live on the per-service tabs in{' '}
        <a href="/settings?tab=ai-playbook" style={{ color: '#1d4ed8', fontWeight: 600 }}>
          AI Playbook
        </a>
        . This page is still accessible for advanced management (per-account overrides).
      </span>
    </div>
  );
}

// ─── List view ─────────────────────────────────────────────────────

function ProfileList({
  onSelect,
  refreshTok,
  onChanged,
}: {
  onSelect: (id: string) => void;
  refreshTok: number;
  onChanged: () => void;
}) {
  const [presetModalOpen, setPresetModalOpen] = useState(false);
  const [profiles, setProfiles] = useState<ServiceProfile[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProfiles(null);
    setLoadError(null);
    serviceProfilesApi
      .list()
      .then((r) => { if (!cancelled) setProfiles(r.profiles); })
      .catch((err) => { if (!cancelled) setLoadError(err?.response?.data?.message ?? err?.message ?? 'Failed to load'); });
    return () => { cancelled = true; };
  }, [refreshTok]);

  return (
    <div>
      <SettingCard
        icon={Layers}
        iconTone="blue"
        title="Service profiles"
        subtitle="Each service has its own pricing, FAQ, and qualification questions. AI replies use the profile that matches the lead's category."
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            type="button"
            onClick={() => setPresetModalOpen(true)}
            style={primaryBtn}
          >
            <Plus size={16} /> Add service
          </button>
          <div style={{ fontSize: 13, color: 'var(--lb-text-muted)' }}>
            New profiles start as drafts — AI replies stay paused until you activate.
          </div>
        </div>
      </SettingCard>

      <div style={{ marginTop: 16 }}>
        {loadError && (
          <div style={errorBanner}>{loadError}</div>
        )}
        {!profiles && !loadError && (
          <div style={{ padding: 24, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--lb-text-muted)' }}>
            <Loader2 size={14} className="animate-spin" /> Loading profiles…
          </div>
        )}
        {profiles && profiles.length === 0 && (
          <div style={emptyState}>
            <Sparkles size={20} color="var(--lb-blue-600, #2563eb)" />
            <div style={{ fontSize: 14, fontWeight: 600, marginTop: 8 }}>No service profiles yet</div>
            <div style={{ fontSize: 13, color: 'var(--lb-text-muted)', marginTop: 4 }}>
              Click "Create from preset" above to get started with curated pricing + FAQ + qualification.
            </div>
          </div>
        )}
        {profiles && profiles.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {profiles.map((p) => (
              <ProfileCard key={p.id} profile={p} onView={() => onSelect(p.id)} onAction={onChanged} />
            ))}
          </div>
        )}
      </div>

      {presetModalOpen && (
        <AddServiceModal
          onClose={() => setPresetModalOpen(false)}
          onCreated={() => { setPresetModalOpen(false); onChanged(); }}
        />
      )}
    </div>
  );
}

function ProfileCard({
  profile,
  onView,
  onAction,
}: {
  profile: ServiceProfile;
  onView: () => void;
  onAction: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const counts = useMemo(() => {
    let items = 0, faqs = 0, questions = 0;
    try {
      if (profile.pricingJson) {
        const p = JSON.parse(profile.pricingJson);
        items = p?.items?.length ?? p?.priceTable?.length ?? 0;
      }
    } catch { /* ignore */ }
    try {
      if (profile.faqJson) {
        const f = JSON.parse(profile.faqJson);
        faqs = f?.customQA?.length ?? 0;
      }
    } catch { /* ignore */ }
    try {
      if (profile.qualificationSchemaJson) {
        const q = JSON.parse(profile.qualificationSchemaJson);
        questions = q?.questions?.length ?? 0;
      }
    } catch { /* ignore */ }
    return { items, faqs, questions };
  }, [profile.pricingJson, profile.faqJson, profile.qualificationSchemaJson]);

  const mappedNames = useMemo(
    () => (profile.providerCategoryMappingsJson ?? [])
      .map((m) => m.categoryName).filter((s): s is string => !!s),
    [profile.providerCategoryMappingsJson],
  );

  const handleActivate = async () => {
    setBusy('activate');
    try {
      await serviceProfilesApi.transitionStatus(profile.id, 'active');
      notify.success('Activated', `${profile.name} is now active. AI replies will use this profile for matched leads.`);
      onAction();
    } catch (err: any) {
      notify.error('Could not activate', err?.response?.data?.message ?? err?.message ?? 'Activation failed');
    } finally {
      setBusy(null);
    }
  };

  const handleArchive = async () => {
    if (!confirm(`Archive "${profile.name}"? Matched leads will fall back to the default profile.`)) return;
    setBusy('archive');
    try {
      await serviceProfilesApi.transitionStatus(profile.id, 'archived');
      notify.success('Archived', `${profile.name} is archived. No new leads will use this profile.`);
      onAction();
    } catch (err: any) {
      notify.error('Could not archive', err?.response?.data?.message ?? err?.message ?? 'Archive failed');
    } finally {
      setBusy(null);
    }
  };

  const handleDuplicate = async () => {
    setBusy('duplicate');
    try {
      const dup = await serviceProfilesApi.duplicate(profile.id);
      notify.success('Duplicated', `Created "${dup.name}" as a draft.`);
      onAction();
    } catch (err: any) {
      notify.error('Could not duplicate', err?.response?.data?.message ?? err?.message ?? 'Duplicate failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={card}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{profile.name}</div>
          <StatusBadge status={profile.status} />
          {profile.isDefault && <DefaultBadge />}
        </div>
        <div style={{ fontSize: 12, color: 'var(--lb-text-muted)', display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
          <span><Check size={11} style={{ verticalAlign: 'middle' }} /> {counts.items} items</span>
          <span><Check size={11} style={{ verticalAlign: 'middle' }} /> {counts.questions} questions</span>
          <span><Check size={11} style={{ verticalAlign: 'middle' }} /> {counts.faqs} FAQs</span>
        </div>
        {mappedNames.length > 0 && (
          <div style={{ fontSize: 12, color: 'var(--lb-text-muted)' }}>
            Maps to: {mappedNames.join(', ')}
          </div>
        )}
        <div style={{ fontSize: 12, color: profile.status === 'draft' ? 'var(--lb-warning, #b45309)' : 'var(--lb-text-muted)', marginTop: 6 }}>
          {profile.status === 'draft' && 'AI replies are paused for this service until activated.'}
          {profile.status === 'active' && 'AI can reply for matched leads using this service profile.'}
          {profile.status === 'archived' && 'Archived — excluded from AI matching.'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'flex-start' }}>
        <button type="button" onClick={onView} style={secondaryBtn} title="View/edit">
          <Edit3 size={14} /> View
        </button>
        {profile.status === 'draft' && (
          <button type="button" onClick={handleActivate} disabled={!!busy} style={primaryBtn} title="Activate">
            {busy === 'activate' ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Activate
          </button>
        )}
        {profile.status === 'active' && (
          <button type="button" onClick={handleArchive} disabled={!!busy} style={secondaryBtn} title="Archive">
            {busy === 'archive' ? <Loader2 size={14} className="animate-spin" /> : <Archive size={14} />} Archive
          </button>
        )}
        <button type="button" onClick={handleDuplicate} disabled={!!busy} style={secondaryBtn} title="Duplicate as draft">
          {busy === 'duplicate' ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}

// ─── Detail view ────────────────────────────────────────────────────

function ProfileDetail({
  profileId,
  onBack,
}: {
  profileId: string;
  onBack: () => void;
}) {
  const [profile, setProfile] = useState<ServiceProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    name: string;
    mappings: string;
    pricingJson: string;
    faqJson: string;
    qualificationSchemaJson: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    serviceProfilesApi.get(profileId)
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        setDraft({
          name: p.name,
          mappings: JSON.stringify(p.providerCategoryMappingsJson ?? [], null, 2),
          pricingJson: p.pricingJson ?? '',
          faqJson: p.faqJson ?? '',
          qualificationSchemaJson: p.qualificationSchemaJson ?? '',
        });
      })
      .catch((err) => { if (!cancelled) setLoadError(err?.response?.data?.message ?? err?.message ?? 'Failed to load'); });
    return () => { cancelled = true; };
  }, [profileId]);

  const handleSave = async () => {
    if (!draft) return;
    let mappingsParsed: any;
    try {
      mappingsParsed = JSON.parse(draft.mappings);
      if (!Array.isArray(mappingsParsed)) throw new Error('mappings must be an array');
    } catch (err: any) {
      notify.error('Mappings invalid', err?.message ?? 'Mappings must be valid JSON array');
      return;
    }
    setSaving(true);
    try {
      const updated = await serviceProfilesApi.update(profileId, {
        name: draft.name,
        providerCategoryMappingsJson: mappingsParsed,
        pricingJson: draft.pricingJson || null,
        faqJson: draft.faqJson || null,
        qualificationSchemaJson: draft.qualificationSchemaJson || null,
      });
      setProfile(updated);
      notify.success('Saved', 'Service profile updated.');
    } catch (err: any) {
      notify.error('Could not save', err?.response?.data?.message ?? err?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <div>
        <button type="button" onClick={onBack} style={{ ...secondaryBtn, marginBottom: 16 }}>
          <ArrowLeft size={14} /> Back to services
        </button>
        <div style={errorBanner}>{loadError}</div>
      </div>
    );
  }
  if (!profile || !draft) {
    return (
      <div>
        <button type="button" onClick={onBack} style={{ ...secondaryBtn, marginBottom: 16 }}>
          <ArrowLeft size={14} /> Back to services
        </button>
        <div style={{ padding: 24, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--lb-text-muted)' }}>
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      </div>
    );
  }

  return (
    <div>
      <button type="button" onClick={onBack} style={{ ...secondaryBtn, marginBottom: 16 }}>
        <ArrowLeft size={14} /> Back to services
      </button>

      <SettingCard
        icon={Edit3}
        iconTone="blue"
        title={`Edit: ${profile.name}`}
        subtitle="Status, mappings, pricing, FAQ, and qualification questions for this service."
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <StatusBadge status={profile.status} />
          {profile.isDefault && <DefaultBadge />}
        </div>
        <FieldRow label="Name">
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            style={textInput}
          />
        </FieldRow>
        <FieldRow label="Provider category mappings (JSON array)">
          <textarea
            value={draft.mappings}
            onChange={(e) => setDraft({ ...draft, mappings: e.target.value })}
            rows={4}
            style={codeArea}
          />
          <div style={hint}>
            Each entry: <code>{`{ "provider": "thumbtack", "categoryName": "..." }`}</code>. The resolver matches inbound leads against these.
          </div>
        </FieldRow>
        <FieldRow label="Pricing">
          <PricingEditor
            value={draft.pricingJson}
            onChange={(next) => setDraft({ ...draft, pricingJson: next })}
          />
        </FieldRow>
        <FieldRow label="FAQ (JSON)">
          <textarea
            value={draft.faqJson}
            onChange={(e) => setDraft({ ...draft, faqJson: e.target.value })}
            rows={8}
            style={codeArea}
          />
        </FieldRow>
        <FieldRow label="Qualification schema (JSON)">
          <textarea
            value={draft.qualificationSchemaJson}
            onChange={(e) => setDraft({ ...draft, qualificationSchemaJson: e.target.value })}
            rows={8}
            style={codeArea}
          />
        </FieldRow>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={handleSave} disabled={saving} style={primaryBtn}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save changes
          </button>
        </div>
      </SettingCard>

      <ServiceRulesViewer aiInstructionsJson={profile.aiInstructionsJson} />

      <div style={{ marginTop: 16 }}>
        <OverridesSection
          profileId={profileId}
          profileName={profile.name}
        />
      </div>
    </div>
  );
}

function OverridesSection({ profileId, profileName }: { profileId: string; profileName: string }) {
  const [rows, setRows] = useState<ServiceProfileOverrideRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editPricing, setEditPricing] = useState('');
  const [editFaq, setEditFaq] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshTok, setRefreshTok] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setLoadError(null);
    serviceProfilesApi.listOverrides(profileId)
      .then((r) => { if (!cancelled) setRows(r.overrides); })
      .catch((err) => { if (!cancelled) setLoadError(err?.response?.data?.message ?? err?.message ?? 'Failed to load'); });
    return () => { cancelled = true; };
  }, [profileId, refreshTok]);

  const startEdit = (row: ServiceProfileOverrideRow) => {
    setEditing(row.savedAccountId);
    setEditPricing(row.override?.pricingDeltasJson ?? '');
    setEditFaq(row.override?.faqAdditionsJson ?? '');
  };

  const saveOverride = async (savedAccountId: string) => {
    setBusy(savedAccountId);
    try {
      await serviceProfilesApi.setOverride(profileId, savedAccountId, {
        pricingDeltasJson: editPricing || null,
        faqAdditionsJson: editFaq || null,
      });
      notify.success('Override saved', 'Location override updated.');
      setEditing(null);
      setRefreshTok((t) => t + 1);
    } catch (err: any) {
      notify.error('Could not save override', err?.response?.data?.message ?? err?.message ?? 'Save failed');
    } finally {
      setBusy(null);
    }
  };

  const clearOverride = async (savedAccountId: string) => {
    if (!confirm(`Clear override for this location? It will fall back to ${profileName} defaults.`)) return;
    setBusy(savedAccountId);
    try {
      await serviceProfilesApi.clearOverride(profileId, savedAccountId);
      notify.success('Override cleared', 'Location now uses the profile defaults.');
      setRefreshTok((t) => t + 1);
    } catch (err: any) {
      notify.error('Could not clear override', err?.response?.data?.message ?? err?.message ?? 'Clear failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingCard
      icon={MapPin}
      iconTone="violet"
      title="Location overrides"
      subtitle="Optional per-account deltas. Leave a location alone to use the profile defaults above."
    >
      {loadError && <div style={errorBanner}>{loadError}</div>}
      {!rows && !loadError && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--lb-text-muted)' }}>
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      )}
      {rows && rows.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--lb-text-muted)' }}>
          No connected accounts found for this user.
        </div>
      )}
      {rows && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((row) => (
            <div key={row.savedAccountId} style={{ ...card, padding: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{row.businessName}</div>
                <div style={{ fontSize: 12, color: 'var(--lb-text-muted)', marginTop: 2 }}>
                  {row.platform} ·{' '}
                  {row.hasOverride
                    ? <span style={{ color: 'var(--lb-warning, #b45309)' }}>Has override</span>
                    : 'Uses profile defaults'}
                </div>
                {editing === row.savedAccountId && (
                  <div style={{ marginTop: 10 }}>
                    <FieldRow label="Pricing deltas (JSON)">
                      <textarea
                        value={editPricing}
                        onChange={(e) => setEditPricing(e.target.value)}
                        rows={4}
                        style={codeArea}
                        placeholder='e.g. {"sofa": 99}'
                      />
                    </FieldRow>
                    <FieldRow label="FAQ additions (JSON)">
                      <textarea
                        value={editFaq}
                        onChange={(e) => setEditFaq(e.target.value)}
                        rows={4}
                        style={codeArea}
                      />
                    </FieldRow>
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'flex-start' }}>
                {editing === row.savedAccountId ? (
                  <>
                    <button type="button" onClick={() => saveOverride(row.savedAccountId)} disabled={!!busy} style={primaryBtn}>
                      {busy === row.savedAccountId ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
                    </button>
                    <button type="button" onClick={() => setEditing(null)} style={secondaryBtn}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => startEdit(row)} style={secondaryBtn} title="Edit override">
                      <Edit3 size={14} /> {row.hasOverride ? 'Edit' : 'Add'}
                    </button>
                    {row.hasOverride && (
                      <button type="button" onClick={() => clearOverride(row.savedAccountId)} disabled={!!busy} style={secondaryBtn} title="Clear override">
                        {busy === row.savedAccountId ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Clear
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </SettingCard>
  );
}

// ─── Preset picker (unchanged from PR #255) ────────────────────────

export function PresetPickerModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [presets, setPresets] = useState<ServiceProfilePreset[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creatingKey, setCreatingKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    serviceProfilePresetsApi.list()
      .then((res) => { if (!cancelled) setPresets(res.presets); })
      .catch((err) => { if (!cancelled) setLoadError(err?.response?.data?.message ?? err?.message ?? 'Failed to load presets'); });
    return () => { cancelled = true; };
  }, []);

  const handleCreate = async (preset: ServiceProfilePreset) => {
    setCreatingKey(preset.key);
    try {
      await serviceProfilePresetsApi.createFromPreset({ templateId: preset.templateId });
      notify.success('Service profile created', `${preset.label} is in draft. Click Activate when ready.`);
      onCreated();
    } catch (err: any) {
      const status = err?.response?.status;
      const msg = err?.response?.data?.message ?? err?.message ?? 'Failed to create service';
      if (status === 409) {
        notify.error('Already created', `You already have a service profile for ${preset.label}.`);
      } else {
        notify.error('Could not create service', msg);
      }
    } finally {
      setCreatingKey(null);
    }
  };

  return (
    <div onClick={onClose} style={modalBg}>
      <div onClick={(e) => e.stopPropagation()} style={modalBox}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Sparkles size={18} color="var(--lb-blue-600, #2563eb)" />
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Pick a preset</h3>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--lb-text-muted)' }}>
              Each preset bundles pricing, FAQ, and qualification questions sourced from the platform.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={iconBtn}>
            <X size={18} />
          </button>
        </div>
        {loadError && <div style={errorBanner}>{loadError}</div>}
        {!presets && !loadError && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--lb-text-muted)', fontSize: 13 }}>
            <Loader2 size={14} className="animate-spin" /> Loading presets…
          </div>
        )}
        {presets && presets.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--lb-text-muted)' }}>No presets available.</div>
        )}
        {presets && presets.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {presets.map((p) => (
              <div key={p.key} style={card}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{p.label}</div>
                  <div style={{ fontSize: 13, color: 'var(--lb-text-muted)', marginBottom: 8 }}>{p.description}</div>
                  <div style={{ display: 'flex', gap: 12, fontSize: 12, color: 'var(--lb-text-muted)', flexWrap: 'wrap' }}>
                    <span>{p.pricingJson?.items?.length ?? p.pricingJson?.basePrices?.length ?? 0} items</span>
                    <span>
                      {(p.qualificationSchemaJson?.questions.length
                        ?? p.serviceOptionsJson?.groups.length
                        ?? 0)} questions
                    </span>
                    <span>
                      {(p.faqJson?.customQA.length
                        ?? p.customerAnswersJson?.entries.length
                        ?? 0)} answers
                    </span>
                    {p.serviceRules && (
                      <span style={{ color: '#b45309', fontWeight: 600 }}>
                        + service rules
                      </span>
                    )}
                    {p.source === 'admin_template' && (
                      <span style={{ color: '#2563eb', fontWeight: 600 }}>
                        via admin
                      </span>
                    )}
                    <span>via {p.provider}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleCreate(p)}
                  disabled={creatingKey !== null && creatingKey !== p.key}
                  style={primaryBtn}
                >
                  {creatingKey === p.key ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                  Create
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Add Service modal (choice → blank or preset) ─────────────────
//
// Replaces the old "Create from preset" entry point. The choice screen
// gives tenants two paths:
//
//   "Create custom service" — POST /v1/service-profiles with just a
//     name. The backend seeds the new draft from the generic
//     "Custom Service" preset: hourly $100 rate + $100 minimum,
//     quote-required, 6 generic FAQs, 4 required + 2 optional
//     qualification questions, and service rules that lock the AI out
//     of making license / insurance / final-price promises. Tenants
//     reach this path when none of the curated presets fits their
//     actual line of work (roofing, mobile mechanic, photography…).
//
//   "Use a template" — same preset list the old PresetPickerModal showed.
//     House Cleaning + Upholstery & Furniture Cleaning (currently).
//
// We keep PresetPickerModal exported and unchanged so any place still
// linking directly to the preset list keeps working; AddServiceModal is
// the new primary entry point.

type AddServiceView = 'choice' | 'blank' | 'preset';

export function AddServiceModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [view, setView] = useState<AddServiceView>('choice');
  const [blankName, setBlankName] = useState('');
  const [creatingBlank, setCreatingBlank] = useState(false);
  const [presets, setPresets] = useState<ServiceProfilePreset[] | null>(null);
  const [presetLoadError, setPresetLoadError] = useState<string | null>(null);
  const [creatingKey, setCreatingKey] = useState<string | null>(null);

  // Lazy-load presets only when the user picks "Use a template" — keeps
  // the modal snappy when they're going to "Create custom service" anyway.
  useEffect(() => {
    if (view !== 'preset' || presets !== null || presetLoadError !== null) return;
    let cancelled = false;
    serviceProfilePresetsApi.list()
      .then((res) => { if (!cancelled) setPresets(res.presets); })
      .catch((err) => { if (!cancelled) setPresetLoadError(err?.response?.data?.message ?? err?.message ?? 'Failed to load presets'); });
    return () => { cancelled = true; };
  }, [view, presets, presetLoadError]);

  // Curated templates first; generic "Custom Service" lives at the bottom
  // and is rendered with a manual-setup / not-recommended badge — picking
  // it leaves the tenant with hourly defaults that need to be edited by
  // hand before activation.
  const orderedPresets = useMemo(() => {
    if (!presets) return null;
    const others = presets.filter(p => p.key !== 'generic_custom_service');
    const generic = presets.filter(p => p.key === 'generic_custom_service');
    return [...others, ...generic];
  }, [presets]);

  const handleCreateBlank = async () => {
    const name = blankName.trim();
    if (!name) return;
    setCreatingBlank(true);
    try {
      await serviceProfilesApi.createBlank(name);
      notify.success(
        'Service created',
        `${name} is in draft with the generic starter template. Review the pricing, FAQ, and qualification questions in AI Playbook → service tab before activating.`,
      );
      onCreated();
    } catch (err: any) {
      const status = err?.response?.status;
      const msg = err?.response?.data?.message ?? err?.message ?? 'Failed to create service';
      if (status === 409) {
        notify.error('Name already used', `You already have a service called "${name}".`);
      } else {
        notify.error('Could not create service', msg);
      }
    } finally {
      setCreatingBlank(false);
    }
  };

  const handleCreatePreset = async (preset: ServiceProfilePreset) => {
    setCreatingKey(preset.key);
    try {
      await serviceProfilePresetsApi.createFromPreset({ templateId: preset.templateId });
      notify.success('Service created', `${preset.label} is in draft. Click Activate when ready.`);
      onCreated();
    } catch (err: any) {
      const status = err?.response?.status;
      const msg = err?.response?.data?.message ?? err?.message ?? 'Failed to create service';
      if (status === 409) {
        notify.error('Already created', `You already have a service profile for ${preset.label}.`);
      } else {
        notify.error('Could not create service', msg);
      }
    } finally {
      setCreatingKey(null);
    }
  };

  const headerTitle =
    view === 'blank' ? 'Create custom service' :
    view === 'preset' ? 'Pick a template' :
    'Add service';
  const headerSubtitle =
    view === 'blank' ? 'Give your service a name. We pre-fill safe defaults (hourly rate, generic FAQ, scope-first questions) — review and edit them in AI Playbook → service tab before activating.' :
    view === 'preset' ? 'Each template bundles pricing, FAQ, and qualification questions sourced from the platform.' :
    'How do you want to start?';

  return (
    <div onClick={onClose} style={modalBg}>
      <div onClick={(e) => e.stopPropagation()} style={modalBox}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
            {view !== 'choice' && (
              <button
                type="button"
                onClick={() => setView('choice')}
                aria-label="Back"
                style={iconBtn}
                title="Back"
              >
                <ArrowLeft size={16} />
              </button>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                {view === 'preset' && <Sparkles size={18} color="var(--lb-blue-600, #2563eb)" />}
                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{headerTitle}</h3>
              </div>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--lb-text-muted)' }}>
                {headerSubtitle}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={iconBtn}>
            <X size={18} />
          </button>
        </div>

        {view === 'choice' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              type="button"
              onClick={() => setView('blank')}
              style={{
                ...card,
                cursor: 'pointer', textAlign: 'left',
                background: 'white', border: '1.5px solid var(--lb-border, #e5e7eb)',
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Create custom service</div>
                <div style={{ fontSize: 13, color: 'var(--lb-text-muted)', marginBottom: 6 }}>
                  Pre-filled with safe generic defaults (hourly rate, scope-first questions, neutral FAQ). Best when none of the templates fit your line of work.
                </div>
                <div style={{
                  display: 'inline-block',
                  fontSize: 11,
                  fontWeight: 700,
                  color: '#92400e',
                  background: '#fef3c7',
                  padding: '2px 8px',
                  borderRadius: 4,
                  textTransform: 'uppercase',
                  letterSpacing: 0.04,
                }}>
                  ⚠ Manual setup required — not recommended
                </div>
              </div>
              <Plus size={16} color="var(--lb-text-muted)" />
            </button>
            <button
              type="button"
              onClick={() => setView('preset')}
              style={{
                ...card,
                cursor: 'pointer', textAlign: 'left',
                background: 'white', border: '1.5px solid var(--lb-border, #e5e7eb)',
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Sparkles size={14} color="var(--lb-blue-600, #2563eb)" /> Use a template
                </div>
                <div style={{ fontSize: 13, color: 'var(--lb-text-muted)' }}>
                  Pre-filled pricing, FAQ, and qualification questions — sourced from the platform's category data.
                </div>
              </div>
              <Plus size={16} color="var(--lb-text-muted)" />
            </button>
          </div>
        )}

        {view === 'blank' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--lb-ink-2)', display: 'block', marginBottom: 6 }}>
                Service name
              </label>
              <input
                value={blankName}
                onChange={(e) => setBlankName(e.target.value)}
                placeholder="e.g. Tile and grout cleaning"
                maxLength={80}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && blankName.trim()) {
                    e.preventDefault();
                    void handleCreateBlank();
                  }
                }}
                style={{
                  width: '100%', padding: '10px 12px',
                  border: '1.5px solid var(--lb-border, #e5e7eb)', borderRadius: 8,
                  fontSize: 14, fontFamily: 'inherit', color: 'var(--lb-ink-1)',
                  background: 'white', outline: 'none',
                }}
              />
              <div style={{ fontSize: 11.5, color: 'var(--lb-text-muted)', marginTop: 6 }}>
                You can rename it later from the service's tab in AI Playbook.
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                onClick={() => setView('choice')}
                disabled={creatingBlank}
                style={{
                  padding: '8px 14px', borderRadius: 8,
                  border: '1px solid var(--lb-border, #e5e7eb)',
                  background: 'white', color: 'var(--lb-ink-2)',
                  fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => void handleCreateBlank()}
                disabled={!blankName.trim() || creatingBlank}
                style={{
                  ...primaryBtn,
                  opacity: !blankName.trim() || creatingBlank ? 0.6 : 1,
                  cursor: !blankName.trim() || creatingBlank ? 'not-allowed' : 'pointer',
                }}
              >
                {creatingBlank ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                Create service
              </button>
            </div>
          </div>
        )}

        {view === 'preset' && (
          <>
            {presetLoadError && <div style={errorBanner}>{presetLoadError}</div>}
            {!orderedPresets && !presetLoadError && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--lb-text-muted)', fontSize: 13 }}>
                <Loader2 size={14} className="animate-spin" /> Loading templates…
              </div>
            )}
            {orderedPresets && orderedPresets.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--lb-text-muted)' }}>No templates available.</div>
            )}
            {orderedPresets && orderedPresets.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {orderedPresets.map((p) => {
                  const isGeneric = p.key === 'generic_custom_service';
                  return (
                    <div key={p.key} style={card}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{p.label}</div>
                        <div style={{ fontSize: 13, color: 'var(--lb-text-muted)', marginBottom: 8 }}>{p.description}</div>
                        <div style={{ display: 'flex', gap: 12, fontSize: 12, color: 'var(--lb-text-muted)', flexWrap: 'wrap' }}>
                          <span>{p.pricingJson?.items?.length ?? p.pricingJson?.basePrices?.length ?? 0} items</span>
                          <span>
                            {(p.qualificationSchemaJson?.questions.length
                              ?? p.serviceOptionsJson?.groups.length
                              ?? 0)} questions
                          </span>
                          <span>
                            {(p.faqJson?.customQA.length
                              ?? p.customerAnswersJson?.entries.length
                              ?? 0)} answers
                          </span>
                          {p.serviceRules && (
                            <span style={{ color: '#b45309', fontWeight: 600 }}>+ service rules</span>
                          )}
                          {p.source === 'admin_template' && (
                            <span style={{ color: '#2563eb', fontWeight: 600 }}>via admin</span>
                          )}
                          <span>via {p.provider}</span>
                        </div>
                        {isGeneric && (
                          <div style={{
                            display: 'inline-block',
                            marginTop: 8,
                            fontSize: 11,
                            fontWeight: 700,
                            color: '#92400e',
                            background: '#fef3c7',
                            padding: '3px 8px',
                            borderRadius: 4,
                            textTransform: 'uppercase',
                            letterSpacing: 0.04,
                          }}>
                            ⚠ Manual setup required — not recommended
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleCreatePreset(p)}
                        disabled={creatingKey !== null && creatingKey !== p.key}
                        style={primaryBtn}
                      >
                        {creatingKey === p.key ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                        Create
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Pricing editor (item_quantity table + JSON fallback) ─────────

type PricingItem = {
  key: string;
  label: string;
  // Default-column price. Preserved across the rollout so old shapes
  // without `prices` keep working — the table treats this value as the
  // amount under the "Price" column.
  price: number;
  // Per-extra-column overrides — `{ premium: 199, vip: 249 }`. The
  // default column stays in `price`, so the editor only reads/writes
  // this map for columns the operator explicitly added.
  prices?: Record<string, number>;
  source?: string;
  unit?: string;
  notes?: string;
  active?: boolean;
};

type HourlyExtraRate = {
  label: string;
  sub?: string;
  amount: number;
};

type PricingShape = {
  pricingModel?: 'bed_bath_grid' | 'item_quantity' | 'flat_rate' | 'hourly';
  included?: string[];
  items?: PricingItem[];
  // Additional price columns beyond the default "Price". Each name is
  // BOTH the display label and the key into `item.prices`. Storage is
  // optional — undefined means single-column (back-compat).
  columns?: string[];
  addOns?: unknown[];
  currency?: string;
  laborRate?: number;
  minimumCharge?: number;
  quoteRequired?: boolean;
  notes?: string;
  // Hourly only — operator-defined extra rate rows that render below
  // the built-in Labor rate / Minimum charge rows. Storage is optional
  // — undefined means no extras (back-compat with the pre-rollout
  // shape).
  extraRates?: HourlyExtraRate[];
  [key: string]: unknown;
};

// Per the spec the default column is unlabeled ("Price"). All other
// columns get the operator-chosen label in uppercase as a chip tag.
const DEFAULT_PRICE_COLUMN = 'Price';

type PricingMode = 'item_quantity' | 'hourly' | 'json';

function decidePricingMode(value: string): { mode: PricingMode; parsed: PricingShape | null } {
  if (!value || value.trim().length === 0) {
    return { mode: 'item_quantity', parsed: { pricingModel: 'item_quantity', items: [] } };
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const p = parsed as PricingShape;
      if (p.pricingModel === 'item_quantity') return { mode: 'item_quantity', parsed: p };
      if (p.pricingModel === 'hourly') return { mode: 'hourly', parsed: p };
      return { mode: 'json', parsed: p };
    }
    return { mode: 'json', parsed: null };
  } catch {
    return { mode: 'json', parsed: null };
  }
}


export function PricingEditor({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const initial = useMemo(() => decidePricingMode(value), [value]);
  const [mode, setMode] = useState<PricingMode>(initial.mode);

  const items: PricingItem[] = useMemo(() => {
    if (mode !== 'item_quantity') return [];
    const parsed = decidePricingMode(value).parsed;
    return parsed?.items ?? [];
  }, [value, mode]);

  const extraColumns: string[] = useMemo(() => {
    if (mode !== 'item_quantity') return [];
    const parsed = decidePricingMode(value).parsed;
    const cols = parsed?.columns;
    return Array.isArray(cols) ? cols.filter((c): c is string => typeof c === 'string' && c.length > 0) : [];
  }, [value, mode]);

  const writeItems = (next: PricingItem[]) => {
    const base: PricingShape = decidePricingMode(value).parsed ?? { pricingModel: 'item_quantity' };
    const out: PricingShape = { ...base, pricingModel: 'item_quantity', items: next };
    onChange(JSON.stringify(out, null, 2));
  };

  const writeColumns = (nextCols: string[], nextItems?: PricingItem[]) => {
    const base: PricingShape = decidePricingMode(value).parsed ?? { pricingModel: 'item_quantity' };
    const out: PricingShape = {
      ...base,
      pricingModel: 'item_quantity',
      columns: nextCols.length > 0 ? nextCols : undefined,
      items: nextItems ?? base.items ?? [],
    };
    onChange(JSON.stringify(out, null, 2));
  };

  // Operator types the column name in an inline prompt — kept simple
  // so we don't have to build a modal for what's effectively a label
  // input. Duplicates collapse to the existing column; empty names are
  // rejected. New columns default to 0 across every existing row.
  const addColumn = () => {
    const name = window.prompt('Column name (e.g. Premium, VIP, Bulk discount):');
    if (!name) return;
    const trimmed = name.trim().slice(0, 32);
    if (!trimmed) return;
    if (trimmed.toLowerCase() === DEFAULT_PRICE_COLUMN.toLowerCase()) return;
    if (extraColumns.some((c) => c.toLowerCase() === trimmed.toLowerCase())) return;
    const nextCols = [...extraColumns, trimmed];
    const nextItems = items.map((it) => ({
      ...it,
      prices: { ...(it.prices ?? {}), [trimmed]: 0 },
    }));
    writeColumns(nextCols, nextItems);
  };

  const removeColumn = (col: string) => {
    if (!window.confirm(`Remove the "${col}" column? Any prices in that column will be discarded.`)) return;
    const nextCols = extraColumns.filter((c) => c !== col);
    const nextItems = items.map((it) => {
      if (!it.prices) return it;
      const { [col]: _drop, ...rest } = it.prices;
      void _drop;
      return { ...it, prices: Object.keys(rest).length > 0 ? rest : undefined };
    });
    writeColumns(nextCols, nextItems);
  };

  const updateItemColumnPrice = (idx: number, col: string, amount: number) => {
    const nextItems = items.map((it, i) => {
      if (i !== idx) return it;
      const prices = { ...(it.prices ?? {}), [col]: amount };
      return { ...it, prices };
    });
    writeItems(nextItems);
  };

  const hourly: PricingShape = useMemo(() => {
    if (mode !== 'hourly') return {};
    return decidePricingMode(value).parsed ?? { pricingModel: 'hourly' };
  }, [value, mode]);

  const writeHourly = (patch: Partial<PricingShape>) => {
    const base: PricingShape = decidePricingMode(value).parsed ?? { pricingModel: 'hourly' };
    const out: PricingShape = { ...base, pricingModel: 'hourly', ...patch };
    onChange(JSON.stringify(out, null, 2));
  };

  const hourlyExtras: HourlyExtraRate[] = Array.isArray(hourly.extraRates) ? hourly.extraRates : [];

  // Hourly equivalent of the item_quantity "Add column" / cleaning
  // "Add column" — adds another rate row below Labor rate + Minimum
  // charge so operators can capture Weekend rate, Emergency rate, etc.
  const addHourlyRate = () => {
    const name = window.prompt('Rate label (e.g. Weekend rate, Emergency rate):');
    if (!name) return;
    const label = name.trim().slice(0, 40);
    if (!label) return;
    const next: HourlyExtraRate[] = [...hourlyExtras, { label, sub: 'per hour', amount: 0 }];
    writeHourly({ extraRates: next });
  };

  const updateHourlyRate = (idx: number, patch: Partial<HourlyExtraRate>) => {
    const next = hourlyExtras.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    writeHourly({ extraRates: next });
  };

  const removeHourlyRate = (idx: number) => {
    const next = hourlyExtras.filter((_, i) => i !== idx);
    writeHourly({ extraRates: next.length > 0 ? next : undefined });
  };

  const switchTo = (next: PricingMode) => {
    if (next === mode) return;
    if (next === 'hourly') {
      const base: PricingShape = decidePricingMode(value).parsed ?? {};
      const out: PricingShape = {
        ...base,
        pricingModel: 'hourly',
        currency: base.currency ?? 'USD',
        laborRate: typeof base.laborRate === 'number' ? base.laborRate : 100,
        minimumCharge: typeof base.minimumCharge === 'number' ? base.minimumCharge : 100,
        quoteRequired: typeof base.quoteRequired === 'boolean' ? base.quoteRequired : true,
        notes: typeof base.notes === 'string' ? base.notes : '',
      };
      onChange(JSON.stringify(out, null, 2));
    } else if (next === 'item_quantity') {
      const base: PricingShape = decidePricingMode(value).parsed ?? {};
      const out: PricingShape = {
        ...base,
        pricingModel: 'item_quantity',
        items: Array.isArray(base.items) ? base.items : [],
      };
      onChange(JSON.stringify(out, null, 2));
    }
    setMode(next);
  };

  const updateItem = (idx: number, patch: Partial<PricingItem>) => {
    const next = items.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    writeItems(next);
  };

  const addItem = () => {
    const idx = items.length + 1;
    const seededPrices =
      extraColumns.length > 0
        ? Object.fromEntries(extraColumns.map((c) => [c, 0]))
        : undefined;
    writeItems([
      ...items,
      {
        key: `item_${idx}`,
        label: 'New item',
        price: 0,
        prices: seededPrices,
        unit: '',
        notes: '',
        active: true,
        source: 'manual',
      },
    ]);
  };

  const removeItem = (idx: number) => {
    writeItems(items.filter((_, i) => i !== idx));
  };

  // (Auto-key-from-label was hooked to an onBlur on the old card-style
  // item editor. The new compact-row PriceRow doesn't expose an onBlur
  // hook, and the missing slug is harmless — `writeItems` just persists
  // `item_<N>` as the key when the operator didn't supply one. If we
  // need slugged keys back, wire `slugifyKey(label)` into writeItems
  // before persisting.)

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <button
          type="button"
          onClick={() => switchTo('item_quantity')}
          style={mode === 'item_quantity' ? toggleBtnActive : toggleBtn}
        >
          <Table2 size={13} /> Item table
        </button>
        <button
          type="button"
          onClick={() => switchTo('hourly')}
          style={mode === 'hourly' ? toggleBtnActive : toggleBtn}
        >
          <Clock size={13} /> Hourly
        </button>
        <button
          type="button"
          onClick={() => setMode('json')}
          style={mode === 'json' ? toggleBtnActive : toggleBtn}
        >
          <Code2 size={13} /> JSON
        </button>
      </div>

      {mode === 'item_quantity' && (
        <PriceTableSection
          title="Price table"
          icon={<Table2 size={14} color="var(--lb-ink-5, #64748b)" />}
          rightBadge={
            items.length > 0 && (
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--lb-ink-5, #64748b)',
                  background: 'var(--lb-ink-10, #f3f5fa)',
                  padding: '3px 8px',
                  borderRadius: 999,
                  letterSpacing: '0.02em',
                }}
              >
                {items.length} {items.length === 1 ? 'row' : 'rows'}
              </span>
            )
          }
        >
          {items.length === 0 ? (
            <div
              style={{
                padding: 18,
                margin: '0 14px 8px',
                border: '1px dashed var(--lb-line, #e5e9f2)',
                borderRadius: 10,
                background: 'var(--lb-bg, #f4f6fa)',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: 13, color: 'var(--lb-ink-5, #64748b)', marginBottom: 10 }}>
                No items yet. Add your first priced item below.
              </div>
              <UnifiedAddRowButton label="Add item" onClick={addItem} />
            </div>
          ) : (
            <>
              {/* Header row — Item | <default Price> | <extra cols...> */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '6px 14px',
                  borderBottom: '1px solid var(--lb-line-soft, #eef1f7)',
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  color: 'var(--lb-ink-5, #64748b)',
                  textTransform: 'uppercase',
                }}
              >
                <span style={{ flex: 1 }}>Item</span>
                <span style={{ minWidth: 80, textAlign: 'right' }}>Price</span>
                {extraColumns.map((col) => (
                  <span
                    key={col}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      minWidth: 90,
                      justifyContent: 'flex-end',
                    }}
                  >
                    {col}
                    <button
                      type="button"
                      onClick={() => removeColumn(col)}
                      title={`Remove ${col} column`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 16,
                        height: 16,
                        borderRadius: 999,
                        border: 0,
                        background: 'transparent',
                        color: 'var(--lb-ink-5, #64748b)',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
                <span style={{ width: 28 }} />
              </div>
              {items.map((it, idx) => (
                <PriceRow
                  key={`${idx}-${it.key}`}
                  label={it.label}
                  sub={it.unit ?? ''}
                  onChangeLabel={(v) => updateItem(idx, { label: v })}
                  onChangeSub={(v) => updateItem(idx, { unit: v })}
                  onRemove={() => removeItem(idx)}
                  chips={
                    <>
                      <PriceChip
                        amount={it.price}
                        editable
                        onChange={(v) => updateItem(idx, { price: v })}
                      />
                      {extraColumns.map((col) => (
                        <PriceChip
                          key={col}
                          amount={it.prices?.[col] ?? 0}
                          tag={col}
                          editable
                          onChange={(v) => updateItemColumnPrice(idx, col, v)}
                        />
                      ))}
                    </>
                  }
                />
              ))}
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  flexWrap: 'wrap',
                  padding: '12px 14px 4px',
                }}
              >
                <UnifiedAddRowButton label="Add row" onClick={addItem} />
                <UnifiedAddRowButton label="Add column" onClick={addColumn} />
              </div>
            </>
          )}
        </PriceTableSection>
      )}

      {mode === 'hourly' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <PriceTableSection
            title="Price table"
            icon={<Table2 size={14} color="var(--lb-ink-5, #64748b)" />}
            rightBadge={
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--lb-ink-5, #64748b)',
                  background: 'var(--lb-ink-10, #f3f5fa)',
                  padding: '3px 8px',
                  borderRadius: 999,
                  letterSpacing: '0.02em',
                }}
              >
                {hourly.currency ?? 'USD'}
              </span>
            }
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '6px 14px',
                borderBottom: '1px solid var(--lb-line-soft, #eef1f7)',
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: '0.06em',
                color: 'var(--lb-ink-5, #64748b)',
                textTransform: 'uppercase',
              }}
            >
              <span style={{ flex: 1 }}>Item</span>
              <span>Price</span>
            </div>
            <PriceRow
              label="Labor rate"
              sub="per hour"
              chips={
                <PriceChip
                  amount={Number.isFinite(hourly.laborRate as number) ? (hourly.laborRate as number) : 0}
                  editable
                  onChange={(v) => writeHourly({ laborRate: v })}
                />
              }
            />
            <PriceRow
              label="Minimum charge"
              sub="flat"
              chips={
                <PriceChip
                  amount={Number.isFinite(hourly.minimumCharge as number) ? (hourly.minimumCharge as number) : 0}
                  editable
                  onChange={(v) => writeHourly({ minimumCharge: v })}
                />
              }
            />
            {hourlyExtras.map((rate, idx) => (
              <PriceRow
                key={idx}
                label={rate.label}
                sub={rate.sub ?? ''}
                onChangeLabel={(v) => updateHourlyRate(idx, { label: v })}
                onChangeSub={(v) => updateHourlyRate(idx, { sub: v })}
                onRemove={() => removeHourlyRate(idx)}
                chips={
                  <PriceChip
                    amount={rate.amount}
                    editable
                    onChange={(v) => updateHourlyRate(idx, { amount: v })}
                  />
                }
              />
            ))}
            <div style={{ padding: '12px 14px 4px' }}>
              <UnifiedAddRowButton label="Add row" onClick={addHourlyRate} />
            </div>
          </PriceTableSection>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              padding: '12px 14px',
              border: '1px solid var(--lb-line, #e5e9f2)',
              borderRadius: 12,
              background: 'white',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 13,
                  color: 'var(--lb-ink-2, #1f2a44)',
                  cursor: 'pointer',
                }}
              >
                Currency
                <input
                  type="text"
                  value={hourly.currency ?? 'USD'}
                  onChange={(e) => writeHourly({ currency: e.target.value.toUpperCase().slice(0, 6) })}
                  style={{
                    width: 70,
                    padding: '5px 8px',
                    border: '1px solid var(--lb-line, #e5e9f2)',
                    borderRadius: 6,
                    fontSize: 13,
                    fontFamily: 'inherit',
                  }}
                  placeholder="USD"
                />
              </label>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 13,
                  color: 'var(--lb-ink-2, #1f2a44)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={hourly.quoteRequired !== false}
                  onChange={(e) => writeHourly({ quoteRequired: e.target.checked })}
                />
                Quote required
              </label>
            </div>
            <textarea
              value={hourly.notes ?? ''}
              onChange={(e) => writeHourly({ notes: e.target.value })}
              rows={2}
              style={{
                width: '100%',
                padding: '8px 10px',
                border: '1px solid var(--lb-line, #e5e9f2)',
                borderRadius: 8,
                fontSize: 13,
                fontFamily: 'inherit',
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
              placeholder="Notes (optional) — e.g. Final pricing depends on the scope, complexity, and location of the job."
            />
          </div>
        </div>
      )}

      {mode === 'json' && (
        <div>
          <div style={hint}>
            Raw JSON editor — used for non-item_quantity pricing models (e.g. bed/bath grid).
          </div>
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={12}
            style={{ ...codeArea, marginTop: 6 }}
          />
        </div>
      )}
    </div>
  );
}

// ─── Service rules viewer (read-only v1) ──────────────────────────

type ParsedServiceRules = {
  requiredDetails: string[];
  unsupportedServices: string[];
  workflowSteps: string[];
};

function extractServiceRulesFromInstructions(json: string | null | undefined): ParsedServiceRules | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rules = (parsed as Record<string, unknown>).serviceRules;
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return null;
  const r = rules as Record<string, unknown>;
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const required = arr(r.requiredDetails);
  const unsupported = arr(r.unsupportedServices);
  const workflow = arr(r.workflowSteps);
  if (required.length === 0 && unsupported.length === 0 && workflow.length === 0) return null;
  return {
    requiredDetails: required,
    unsupportedServices: unsupported,
    workflowSteps: workflow,
  };
}

// `additionalInstructions` extraction + viewer were removed
// (2026-06-22). The field was inert at runtime — no AI consumer read
// it — and the corresponding admin template-builder textarea was
// dropped at the same time. Service rules viewer remains below.

function ServiceRulesViewer({ aiInstructionsJson }: { aiInstructionsJson: string | null }) {
  const rules = useMemo(() => extractServiceRulesFromInstructions(aiInstructionsJson), [aiInstructionsJson]);
  if (!rules) return null;
  return (
    <div style={{ marginTop: 16 }}>
      <SettingCard
        icon={ShieldAlert}
        iconTone="amber"
        title="Service rules"
        subtitle="Operator guardrails sourced from the preset. Editing these inline lands in a follow-up release."
      >
        {rules?.requiredDetails && rules.requiredDetails.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
              <ListChecks size={14} /> Required details
            </div>
            <ul style={ruleList}>
              {rules.requiredDetails.map((d) => (
                <li key={d} style={ruleItem}>{d}</li>
              ))}
            </ul>
          </div>
        )}
        {rules?.unsupportedServices && rules.unsupportedServices.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, marginBottom: 6, color: '#b45309' }}>
              <AlertTriangle size={14} /> Not supported
            </div>
            <ul style={ruleList}>
              {rules.unsupportedServices.map((d) => (
                <li key={d} style={{ ...ruleItem, color: '#b45309' }}>{d}</li>
              ))}
            </ul>
          </div>
        )}
        {rules?.workflowSteps && rules.workflowSteps.length > 0 && (
          <div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
              <ListChecks size={14} /> Workflow steps
            </div>
            <ol style={{ ...ruleList, paddingLeft: 22 }}>
              {rules.workflowSteps.map((s, i) => (
                <li key={`${i}-${s}`} style={ruleItem}>{s}</li>
              ))}
            </ol>
          </div>
        )}
      </SettingCard>
    </div>
  );
}

// ─── small atoms + style tokens ────────────────────────────────────

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--lb-text-muted)' }}>{label}</div>
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: ServiceProfile['status'] }) {
  const styles: Record<ServiceProfile['status'], { bg: string; fg: string; label: string }> = {
    draft: { bg: '#fef3c7', fg: '#b45309', label: 'DRAFT' },
    active: { bg: '#dcfce7', fg: '#15803d', label: 'ACTIVE' },
    archived: { bg: '#f3f4f6', fg: '#6b7280', label: 'ARCHIVED' },
  };
  const s = styles[status];
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 4, background: s.bg, color: s.fg,
      fontSize: 10, fontWeight: 700, letterSpacing: 0.06,
    }}>{s.label}</span>
  );
}

function DefaultBadge() {
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 4, background: '#dbeafe', color: '#1e40af',
      fontSize: 10, fontWeight: 700, letterSpacing: 0.06,
    }}>DEFAULT</span>
  );
}

const primaryBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 14px', borderRadius: 8,
  border: '1px solid var(--lb-blue-200, #bfdbfe)',
  background: 'var(--lb-blue-600, #2563eb)', color: 'white',
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
};

const secondaryBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 12px', borderRadius: 8,
  border: '1px solid var(--lb-border, #e5e7eb)',
  background: 'white', color: 'var(--lb-text)',
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
};

const iconBtn: React.CSSProperties = {
  padding: 6, background: 'transparent', border: 'none',
  color: 'var(--lb-text-muted, #6b7280)', cursor: 'pointer', borderRadius: 6,
};

const card: React.CSSProperties = {
  border: '1px solid var(--lb-border, #e5e7eb)',
  borderRadius: 12, padding: 16,
  display: 'flex', alignItems: 'flex-start', gap: 16, background: 'white',
};

const textInput: React.CSSProperties = {
  width: '100%', padding: '8px 12px',
  border: '1px solid var(--lb-border, #e5e7eb)',
  borderRadius: 8, fontSize: 14, fontFamily: 'inherit',
};

const codeArea: React.CSSProperties = {
  width: '100%', padding: '8px 12px',
  border: '1px solid var(--lb-border, #e5e7eb)',
  borderRadius: 8, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  resize: 'vertical', minHeight: 60,
};

const hint: React.CSSProperties = {
  fontSize: 11, color: 'var(--lb-text-muted)', marginTop: 4,
};

const toggleBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '6px 10px', borderRadius: 8,
  border: '1px solid var(--lb-border, #e5e7eb)',
  background: 'white', color: 'var(--lb-text-muted)',
  fontSize: 12, fontWeight: 600, cursor: 'pointer',
};

const toggleBtnActive: React.CSSProperties = {
  ...toggleBtn,
  background: 'var(--lb-blue-50, #eff6ff)',
  color: 'var(--lb-blue-700, #1d4ed8)',
  borderColor: 'var(--lb-blue-200, #bfdbfe)',
};

const ruleList: React.CSSProperties = {
  margin: 0,
  paddingLeft: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const ruleItem: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--lb-text)',
  lineHeight: 1.4,
};

const errorBanner: React.CSSProperties = {
  padding: 12, borderRadius: 8, background: '#fef2f2', color: '#b91c1c',
  fontSize: 13, marginBottom: 12,
};

const emptyState: React.CSSProperties = {
  padding: 32, textAlign: 'center',
  border: '1px dashed var(--lb-border, #e5e7eb)',
  borderRadius: 12, background: 'var(--lb-surface, #fafafa)',
};

const modalBg: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.45)',
  zIndex: 1000, display: 'flex', alignItems: 'center',
  justifyContent: 'center', padding: 24,
};

const modalBox: React.CSSProperties = {
  background: 'white', borderRadius: 16, width: 'min(680px, 100%)',
  maxHeight: '85vh', overflow: 'auto',
  boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)', padding: 24,
};
