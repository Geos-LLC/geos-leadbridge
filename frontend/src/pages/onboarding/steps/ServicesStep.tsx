import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Circle,
  ExternalLink,
  Layers,
  Loader2,
  Plus,
  ShieldAlert,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  serviceProfilePresetsApi,
  serviceProfilesApi,
  type ServiceProfile,
  type ServiceProfilePreset,
} from '../../../services/api';
import { useAppStore } from '../../../store/appStore';
import { notify } from '../../../store/notificationStore';
import AccountFaqForm from '../../../components/AccountFaqForm';
import ServicePricingForm from '../../../components/ServicePricingForm';
import { WizardStepActions } from '../WizardStepActions';

interface Props {
  onSaveContinue: () => Promise<void> | void;
  saving: boolean;
  setSaving: (v: boolean) => void;
}

/**
 * Wizard "Services" step — unified create + configure (2026-06-18 v3).
 *
 * Earlier versions split this into two steps (assignments + per-service
 * setup). That gave us five wizard steps and a per-account assignment
 * grid that nobody actually needed — the runtime resolver already
 * handles "lead category → matching ServiceProfile → tenant default
 * fallback" without per-account wiring. So this step is now a single
 * surface that does both jobs:
 *
 *   1. Top panel: add a service (from a preset/template OR custom).
 *   2. Accordion: per active/draft ServiceProfile, edit pricing
 *      (ServicePricingForm), customer answers (AccountFaqForm),
 *      service rules (imported from template — read-only viewer +
 *      deep link), and a lightweight "additional AI instructions"
 *      textarea.
 *
 * Completion: at least one ACTIVE service with pricing + customer
 * answers configured. Drafts show "AI paused" but don't gate Done.
 */
export default function ServicesStep({
  onSaveContinue,
  saving,
  setSaving,
}: Props) {
  const navigate = useNavigate();
  const savedAccounts = useAppStore(s => s.savedAccounts);
  const primaryAccount = savedAccounts[0];

  const [profiles, setProfiles] = useState<ServiceProfile[]>([]);
  const [presets, setPresets] = useState<ServiceProfilePreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  // Per-profile AI draft state.
  const [aiDraft, setAiDraft] = useState<Record<string, { value: string; dirty: boolean; saving: boolean }>>({});

  // Add-service panel state.
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [selectedPresetKey, setSelectedPresetKey] = useState<string>('');
  const [customName, setCustomName] = useState('');
  const [creating, setCreating] = useState(false);

  async function refreshAll() {
    try {
      const [profilesRes, presetsRes] = await Promise.all([
        serviceProfilesApi.list(),
        serviceProfilePresetsApi.list().catch(() => ({ presets: [] as ServiceProfilePreset[] })),
      ]);
      const list = (profilesRes.profiles ?? []).filter(p => p.status !== 'archived');
      setProfiles(list);
      setPresets(presetsRes.presets ?? []);
      if (openId === null && list.length > 0) {
        const firstIncomplete = list.find(p => p.status === 'active' && !looksConfigured(p));
        setOpenId((firstIncomplete ?? list[0]).id);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sorted: active before draft, default-first within status, then name.
  const ordered = useMemo(
    () => [...profiles].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    }),
    [profiles],
  );

  // Pull the seeded "Custom Service" to the top of the picker; everything
  // else lands in the main list. Both groups read from the same DB-backed
  // presets list — what used to be hardcoded "code presets" are now
  // seeded admin templates with stable keys.
  const groupedPresets = useMemo(() => {
    const generic: typeof presets = [];
    const others: typeof presets = [];
    for (const p of presets) {
      if (p.key === 'generic_custom_service') generic.push(p);
      else others.push(p);
    }
    const byLabel = (a: typeof presets[number], b: typeof presets[number]) => a.label.localeCompare(b.label);
    return {
      generic,
      others: others.sort(byLabel),
    };
  }, [presets]);

  // Pre-select Generic when the panel opens so "Add" with no other
  // input creates the always-works starter.
  useEffect(() => {
    if (!showAddPanel || selectedPresetKey || groupedPresets.generic.length === 0) return;
    setSelectedPresetKey(groupedPresets.generic[0].templateId);
  }, [showAddPanel, selectedPresetKey, groupedPresets.generic]);

  function ensureAiDraft(profile: ServiceProfile) {
    if (aiDraft[profile.id]) return;
    const existing = readAdditionalInstructions(profile.aiInstructionsJson);
    setAiDraft(prev => ({
      ...prev,
      [profile.id]: { value: existing, dirty: false, saving: false },
    }));
  }

  function updateAiDraft(profileId: string, value: string) {
    setAiDraft(prev => ({
      ...prev,
      [profileId]: { ...(prev[profileId] ?? { value: '', dirty: false, saving: false }), value, dirty: true },
    }));
  }

  async function saveAiInstructions(profile: ServiceProfile) {
    const draft = aiDraft[profile.id];
    if (!draft || draft.saving) return;
    setAiDraft(prev => ({
      ...prev,
      [profile.id]: { ...prev[profile.id], saving: true },
    }));
    try {
      let wrapper: any = {};
      try {
        wrapper = profile.aiInstructionsJson ? JSON.parse(profile.aiInstructionsJson) : {};
      } catch { wrapper = {}; }
      if (typeof wrapper !== 'object' || wrapper === null) wrapper = {};
      wrapper.version = wrapper.version ?? 1;
      const trimmed = draft.value.trim();
      if (trimmed) wrapper.additionalInstructions = trimmed;
      else delete wrapper.additionalInstructions;
      const hasMeaning = Object.keys(wrapper).some(k => k !== 'version' && wrapper[k] !== undefined && wrapper[k] !== null);
      const payload = hasMeaning ? JSON.stringify(wrapper) : null;
      const updated = await serviceProfilesApi.update(profile.id, {
        aiInstructionsJson: payload,
      });
      setProfiles(prev => prev.map(p => (p.id === profile.id ? updated : p)));
      setAiDraft(prev => ({
        ...prev,
        [profile.id]: { value: trimmed, dirty: false, saving: false },
      }));
      notify.success('AI instructions saved', `${profile.name} updated.`);
    } catch (err: any) {
      setAiDraft(prev => ({
        ...prev,
        [profile.id]: { ...prev[profile.id], saving: false },
      }));
      notify.error(
        'Could not save AI instructions',
        err.response?.data?.message || 'Please try again.',
      );
    }
  }

  async function activate(profile: ServiceProfile) {
    try {
      const updated = await serviceProfilesApi.transitionStatus(profile.id, 'active');
      setProfiles(prev => prev.map(p => (p.id === profile.id ? updated : p)));
      notify.success('Service activated', `${profile.name} is now live.`);
    } catch (err: any) {
      notify.error(
        'Could not activate',
        err.response?.data?.message || 'Add pricing or customer answers first.',
      );
    }
  }

  async function refreshOne(profileId: string) {
    try {
      const updated = await serviceProfilesApi.get(profileId);
      setProfiles(prev => prev.map(p => (p.id === profileId ? updated : p)));
    } catch { /* non-fatal */ }
  }

  async function handleCreateFromPreset() {
    if (!selectedPresetKey || creating) return;
    const preset = presets.find(p => p.templateId === selectedPresetKey);
    if (!preset) {
      notify.error('Pick a service template', 'Select one from the dropdown first.');
      return;
    }
    setCreating(true);
    try {
      const created = await serviceProfilePresetsApi.createFromPreset({
        templateId: preset.templateId,
      });
      setSelectedPresetKey('');
      await refreshAll();
      setOpenId(created.profileId);
      notify.success('Service added', `${preset.label} is ready to set up.`);
    } catch (err: any) {
      notify.error(
        'Could not add service',
        err.response?.data?.message || 'Please try again.',
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleCreateCustom() {
    const name = customName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const created = await serviceProfilesApi.createBlank(name);
      setCustomName('');
      await refreshAll();
      setOpenId(created.profileId);
      notify.success('Service added', `${name} is ready to set up.`);
    } catch (err: any) {
      notify.error(
        'Could not add service',
        err.response?.data?.message || 'Please try again.',
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleContinue() {
    if (saving) return;
    const hasActive = profiles.some(p => p.status === 'active');
    if (!hasActive) {
      notify.error('Add a service first', 'Set up at least one active service before continuing.');
      return;
    }
    setSaving(true);
    try {
      await onSaveContinue();
    } finally {
      setSaving(false);
    }
  }

  const activeServices = ordered.filter(p => p.status === 'active');
  const incompleteActive = activeServices.filter(p => !looksConfigured(p));
  const draftServices = ordered.filter(p => p.status === 'draft');
  const canContinue = activeServices.length > 0;

  return (
    <div className="pt-2">
      <WizardStepActions>
        <button
          type="button"
          onClick={() => void handleContinue()}
          disabled={saving || !canContinue}
          title={!canContinue ? 'Add at least one active service to continue' : undefined}
          className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-md shadow-blue-200 transition-all"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {saving ? 'Continuing…' : 'Save & Continue'}
          {!saving && <ArrowRight className="w-4 h-4" />}
        </button>
        <button
          type="button"
          onClick={() => navigate('/settings?tab=ai-playbook')}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-all"
        >
          Full AI playbook
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
        {!canContinue && !loading && (
          <span className="text-xs text-amber-600 font-medium">
            Add at least one active service before continuing.
          </span>
        )}
      </WizardStepActions>

      {/* ── Add a service ─────────────────────────────────────────────
          Always visible (collapsed when there's already content) so
          the user understands they can add more services anytime. */}
      <div className="mb-5">
        {!showAddPanel ? (
          <button
            type="button"
            onClick={() => setShowAddPanel(true)}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-xl transition-all"
          >
            <Plus className="w-4 h-4" />
            Add a service
          </button>
        ) : (
          <div className="rounded-2xl border border-blue-200 bg-blue-50/40 p-5 space-y-4">
            <div className="flex items-start gap-2 text-xs text-slate-600">
              <Sparkles className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
              <div>
                Start from a curated template (Thumbtack/Yelp categories
                pre-mapped) or create a custom service with just a name
                and fill it in below.
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-600 mb-1">
                From a template
              </label>
              <div className="flex gap-2">
                <select
                  value={selectedPresetKey}
                  onChange={e => setSelectedPresetKey(e.target.value)}
                  disabled={creating || presets.length === 0}
                  className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                >
                  <option value="">Pick a template…</option>
                  {groupedPresets.generic.length > 0 && (
                    <optgroup label="Recommended starter">
                      {groupedPresets.generic.map(p => (
                        <option key={p.templateId} value={p.templateId}>
                          {p.label} — works for any service
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {groupedPresets.others.length > 0 && (
                    <optgroup label="Service templates">
                      {groupedPresets.others.map(p => (
                        <option key={p.templateId} value={p.templateId}>
                          {p.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <button
                  type="button"
                  onClick={() => void handleCreateFromPreset()}
                  disabled={creating || !selectedPresetKey}
                  className="inline-flex items-center gap-1 px-4 py-2 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg"
                >
                  {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  Add
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-600 mb-1">
                Custom service
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={customName}
                  onChange={e => setCustomName(e.target.value)}
                  disabled={creating}
                  maxLength={80}
                  placeholder="e.g. Pressure washing"
                  className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                />
                <button
                  type="button"
                  onClick={() => void handleCreateCustom()}
                  disabled={creating || !customName.trim()}
                  className="inline-flex items-center gap-1 px-4 py-2 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg"
                >
                  {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wrench className="w-3.5 h-3.5" />}
                  Create
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowAddPanel(false)}
              className="text-xs font-semibold text-slate-500 hover:text-slate-700"
            >
              Hide add panel
            </button>
          </div>
        )}
      </div>

      {/* ── Per-service accordion ──────────────────────────────────── */}

      {loading ? (
        <div className="py-12 text-center text-sm text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        </div>
      ) : ordered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-600">
          No services yet. Add one from a template or create a custom
          service above to get started.
        </div>
      ) : (
        <>
          {incompleteActive.length > 0 && (
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-100 bg-amber-50/60 px-3 py-2.5 text-xs text-amber-900">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
              <div>
                <strong>{incompleteActive.length}</strong> active service
                {incompleteActive.length === 1 ? '' : 's'} still need pricing
                or customer answers. Active services must have both to
                count toward setup completion.
              </div>
            </div>
          )}
          {draftServices.length > 0 && (
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
              <Circle className="w-4 h-4 shrink-0 mt-0.5 text-slate-400" />
              <div>
                <strong>{draftServices.length}</strong> draft service
                {draftServices.length === 1 ? ' is' : 's are'} listed below —
                AI is paused on them until you activate. Drafts don't block
                finishing setup.
              </div>
            </div>
          )}

          <div className="space-y-3">
            {ordered.map(profile => {
              const open = openId === profile.id;
              const configured = looksConfigured(profile);
              const serviceRules = readServiceRules(profile.aiInstructionsJson);
              return (
                <div
                  key={profile.id}
                  className="rounded-2xl border border-slate-200 bg-white overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => {
                      const next = open ? null : profile.id;
                      setOpenId(next);
                      if (next) {
                        ensureAiDraft(profile);
                        void refreshOne(profile.id);
                      }
                    }}
                    className="w-full hover:bg-slate-50 transition-colors"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 13,
                      padding: '16px', textAlign: 'left',
                    }}
                  >
                    {/* Leading layers icon tile — accent-tint per bundle */}
                    <span style={{
                      width: 38, height: 38, borderRadius: 9,
                      background: 'var(--lb-accent-tint)', color: 'var(--lb-accent)',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      <Layers className="w-[18px] h-[18px]" />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--lb-ink-1)' }}>
                          {profile.name}
                        </span>
                        {profile.status === 'active' && (
                          <span style={{
                            fontSize: 10, fontWeight: 700,
                            padding: '2px 7px', borderRadius: 99,
                            background: 'var(--lb-success-tint)', color: '#15803d',
                            textTransform: 'uppercase', letterSpacing: '0.05em',
                          }}>Active</span>
                        )}
                        {profile.isDefault && (
                          <span style={{
                            fontSize: 10, fontWeight: 700,
                            padding: '2px 7px', borderRadius: 99,
                            background: 'var(--lb-ink-10)', color: 'var(--lb-ink-5)',
                            textTransform: 'uppercase', letterSpacing: '0.05em',
                          }}>Default</span>
                        )}
                      </span>
                      <span style={{
                        display: 'block', fontSize: 12,
                        color: 'var(--lb-ink-5)', marginTop: 3,
                      }}>
                        {configured
                          ? 'Pricing, FAQ and qualification configured.'
                          : 'Add pricing and customer answers to activate.'}
                      </span>
                    </span>
                    {open ? (
                      <ChevronUp className="w-4 h-4 text-slate-400 shrink-0" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                    )}
                  </button>

                  {open && (
                    <div className="border-t border-slate-100 p-4 space-y-6 bg-slate-50/40">
                      <Section label="Pricing">
                        {primaryAccount ? (
                          <div
                            className="rounded-xl border border-slate-200 bg-white p-3"
                            onBlur={() => void refreshOne(profile.id)}
                          >
                            <ServicePricingForm
                              accountId={primaryAccount.id}
                              accountName={profile.name}
                              serviceProfileId={profile.id}
                            />
                          </div>
                        ) : (
                          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                            Connect an account first to edit pricing.
                          </div>
                        )}
                      </Section>

                      <Section label="Customer answers (FAQ)">
                        {primaryAccount ? (
                          <div
                            className="rounded-xl border border-slate-200 bg-white p-3"
                            onBlur={() => void refreshOne(profile.id)}
                          >
                            <AccountFaqForm
                              accountId={primaryAccount.id}
                              accountName={profile.name}
                              serviceProfileId={profile.id}
                            />
                          </div>
                        ) : (
                          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                            Connect an account first to edit customer answers.
                          </div>
                        )}
                      </Section>

                      {/* Service rules — read-only viewer over the
                          rules that came with the template (or empty
                          for blank services). Editing happens on the
                          full AI Playbook deep link; the wizard just
                          surfaces what the template seeded. */}
                      <Section label="Service rules">
                        {serviceRules ? (
                          <div className="rounded-xl border border-slate-200 bg-white p-3 space-y-3">
                            <ServiceRulesRow
                              title="Required details"
                              items={serviceRules.requiredDetails}
                            />
                            <ServiceRulesRow
                              title="Workflow steps"
                              items={serviceRules.workflowSteps}
                            />
                            <ServiceRulesRow
                              title="Unsupported services"
                              items={serviceRules.unsupportedServices}
                            />
                            <button
                              type="button"
                              onClick={() => navigate(`/settings?tab=ai-playbook&scope=${profile.id}`)}
                              className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800"
                            >
                              Edit service rules in AI Playbook
                              <ExternalLink className="w-3 h-3" />
                            </button>
                          </div>
                        ) : (
                          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                            No rules yet — templates ship with required
                            details, workflow steps, and unsupported
                            services. Add them via the{' '}
                            <button
                              type="button"
                              onClick={() => navigate(`/settings?tab=ai-playbook&scope=${profile.id}`)}
                              className="font-semibold text-blue-700 hover:underline inline-flex items-center gap-0.5"
                            >
                              full AI Playbook
                              <ExternalLink className="w-3 h-3" />
                            </button>.
                          </div>
                        )}
                      </Section>

                      <Section label="AI instructions (optional)">
                        <div className="rounded-xl border border-slate-200 bg-white p-3 space-y-2">
                          <div className="flex items-start gap-2 text-xs text-slate-500">
                            <Sparkles className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                            <span>
                              Anything AI should remember when handling{' '}
                              <strong>{profile.name}</strong> leads.
                            </span>
                          </div>
                          <textarea
                            value={aiDraft[profile.id]?.value ?? ''}
                            onChange={e => updateAiDraft(profile.id, e.target.value)}
                            placeholder="e.g., Always mention that insurance is included. Don't quote weekend rates."
                            rows={3}
                            className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                          />
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void saveAiInstructions(profile)}
                              disabled={aiDraft[profile.id]?.saving || !aiDraft[profile.id]?.dirty}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg"
                            >
                              {aiDraft[profile.id]?.saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                              {aiDraft[profile.id]?.saving ? 'Saving…' : aiDraft[profile.id]?.dirty ? 'Save AI instructions' : 'Saved'}
                            </button>
                          </div>
                        </div>
                      </Section>

                      {profile.status === 'draft' && configured && (
                        <div className="pt-2">
                          <button
                            type="button"
                            onClick={() => void activate(profile)}
                            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg"
                          >
                            Activate service
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-bold text-slate-700 mb-2 uppercase tracking-wide">
        {label}
      </div>
      {children}
    </div>
  );
}

function ServiceRulesRow({ title, items }: { title: string; items: string[] | undefined }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wide mb-1">
        {title}
      </div>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={`${title}-${i}`} className="text-xs text-slate-700 leading-relaxed pl-3 relative">
            <span className="absolute left-0 top-1.5 w-1 h-1 bg-slate-400 rounded-full" />
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function looksConfigured(p: ServiceProfile): boolean {
  return hasPricing(p.pricingJson) && hasCustomerAnswers(p.faqJson);
}

function hasPricing(json: string | null): boolean {
  const p = safeParse(json);
  if (!p || typeof p !== 'object') return false;
  if (p.quoteRequired === true) return true;
  if (Array.isArray(p.priceTable) && p.priceTable.length > 0) return true;
  if (Array.isArray(p.items) && p.items.length > 0) return true;
  if (Array.isArray(p.basePrices) && p.basePrices.length > 0) return true;
  if (Array.isArray(p.addOns) && p.addOns.length > 0) return true;
  if (typeof p.laborRate === 'number' && p.laborRate > 0) return true;
  return false;
}

function hasCustomerAnswers(json: string | null): boolean {
  const f = safeParse(json);
  if (!f || typeof f !== 'object') return false;
  if (Array.isArray(f.customQA) && f.customQA.some((q: any) => (q?.question || q?.answer || '').toString().trim())) {
    return true;
  }
  if (Array.isArray(f.entries) && f.entries.some((q: any) => (q?.question || q?.answer || '').toString().trim())) {
    return true;
  }
  const valueKeys = ['insuredAndBonded', 'bringsSupplies', 'petPolicy', 'customerMustBeHome', 'sameCleanerForRecurring'];
  for (const k of valueKeys) {
    const v = f[k]?.value;
    if (typeof v === 'string' && v && v !== 'unset') return true;
  }
  if (Array.isArray(f.paymentMethods) && f.paymentMethods.length > 0) return true;
  if (typeof f.standardScope === 'string' && f.standardScope.trim()) return true;
  if (typeof f.deepScope === 'string' && f.deepScope.trim()) return true;
  return false;
}

function readAdditionalInstructions(json: string | null): string {
  const obj = safeParse(json);
  if (!obj || typeof obj !== 'object') return '';
  return typeof obj.additionalInstructions === 'string' ? obj.additionalInstructions : '';
}

function readServiceRules(json: string | null): {
  requiredDetails?: string[];
  workflowSteps?: string[];
  unsupportedServices?: string[];
} | null {
  const obj = safeParse(json);
  if (!obj || typeof obj !== 'object') return null;
  const rules = obj.serviceRules;
  if (!rules || typeof rules !== 'object') return null;
  const out: any = {};
  if (Array.isArray(rules.requiredDetails)) out.requiredDetails = rules.requiredDetails.filter((x: any) => typeof x === 'string');
  if (Array.isArray(rules.workflowSteps)) out.workflowSteps = rules.workflowSteps.filter((x: any) => typeof x === 'string');
  if (Array.isArray(rules.unsupportedServices)) out.unsupportedServices = rules.unsupportedServices.filter((x: any) => typeof x === 'string');
  if (Object.keys(out).length === 0) return null;
  return out;
}

function safeParse(s: string | null | undefined): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
