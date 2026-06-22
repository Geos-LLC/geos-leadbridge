import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDollarSign,
  HelpCircle,
  Layers,
  Loader2,
  Plus,
  ShieldAlert,
  Sparkles,
  Wrench,
} from 'lucide-react';
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
  const savedAccounts = useAppStore(s => s.savedAccounts);
  const primaryAccount = savedAccounts[0];

  const [profiles, setProfiles] = useState<ServiceProfile[]>([]);
  const [presets, setPresets] = useState<ServiceProfilePreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  // Per-profile inline-editor selection (canonical wizard pattern —
  // summary nav rows on top, editor expands beneath the row when its
  // Edit link is tapped). null = no editor open; set to 'price' /
  // 'ans' to expand. Keyed by profile id so each accordion has its
  // own state. Service rules + Additional AI instructions were
  // removed from the wizard (2026-06-22) — both were inert at runtime
  // and added noise to the onboarding flow.
  type EditSection = 'price' | 'ans' | null;
  const [editByProfile, setEditByProfile] = useState<Record<string, EditSection>>({});
  const toggleEdit = (profileId: string, section: Exclude<EditSection, null>) => {
    setEditByProfile(prev => ({
      ...prev,
      [profileId]: prev[profileId] === section ? null : section,
    }));
  };

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

  // Curated service templates first; generic "Custom Service" lives in
  // its own group at the bottom and is marked as not-recommended /
  // manual-setup-only — picking it leaves the tenant with hourly defaults
  // that need to be edited by hand before activation.
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

  // Additional AI instructions removed from the wizard (2026-06-22).
  // Field was inert at runtime — no AI consumer reads it. Tenants who
  // need per-service free-text guidance can add it via Settings → AI
  // Playbook after onboarding.

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
          style={{
            padding: '10px 22px', borderRadius: 10,
            border: 0, background: 'var(--lb-accent)', color: '#fff',
            fontSize: 13, fontWeight: 700,
            cursor: (saving || !canContinue) ? 'not-allowed' : 'pointer',
            opacity: (saving || !canContinue) ? 0.5 : 1,
            fontFamily: 'inherit',
          }}
        >
          {saving ? 'Continuing…' : 'Continue'}
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
                  {groupedPresets.others.length > 0 && (
                    <optgroup label="Service templates">
                      {groupedPresets.others.map(p => (
                        <option key={p.templateId} value={p.templateId}>
                          {p.label}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {groupedPresets.generic.length > 0 && (
                    <optgroup label="Manual setup (not recommended)">
                      {groupedPresets.generic.map(p => (
                        <option key={p.templateId} value={p.templateId}>
                          {p.label} — requires manual setup
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
              {selectedPresetKey && groupedPresets.generic.some(g => g.templateId === selectedPresetKey) && (
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
                  ⚠ Manual setup required — not recommended
                </div>
              )}
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

                  {open && (() => {
                    const editSection = editByProfile[profile.id] ?? null;
                    return (
                    <div className="p-4 pt-1 bg-slate-50/40" style={{ borderTop: '1px solid var(--lb-line-soft)' }}>
                      {/* Canonical wizard pattern: 2 summary nav rows
                          (Pricing / Customer answers) stacked with
                          `Edit →` links. Tapping a link expands the
                          matching editor inline beneath that row;
                          tapping again collapses it.

                          Service rules + Additional AI instructions
                          were removed from the wizard (2026-06-22) —
                          both were inert at runtime (no AI consumer)
                          and the canonical FinalDesign drops them.
                          Service-rules data still seeds at profile
                          creation from admin templates and can be
                          viewed via Settings → AI Playbook. */}
                      <SummaryNavRow
                        icon={CircleDollarSign}
                        iconTone="green"
                        title="Pricing"
                        body={pricingSummary(profile)}
                        actionLabel={editSection === 'price' ? 'Close ↑' : 'Edit pricing →'}
                        onAction={() => toggleEdit(profile.id, 'price')}
                      />
                      {editSection === 'price' && (
                        <div className="mt-2 mb-3">
                          {primaryAccount ? (
                            <div
                              className="rounded-xl border border-slate-200 bg-white p-3"
                              onBlur={() => void refreshOne(profile.id)}
                            >
                              <ServicePricingForm
                                accountId={primaryAccount.id}
                                accountName={profile.name}
                                serviceProfileId={profile.id}
                                wizardMode
                              />
                            </div>
                          ) : (
                            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                              Connect an account first to edit pricing.
                            </div>
                          )}
                        </div>
                      )}

                      <SummaryNavRow
                        icon={HelpCircle}
                        iconTone="purple"
                        title="Customer answers"
                        body={faqSummary(profile)}
                        actionLabel={editSection === 'ans' ? 'Close ↑' : 'Edit answers →'}
                        onAction={() => toggleEdit(profile.id, 'ans')}
                        noBorder
                      />
                      {editSection === 'ans' && (
                        <div className="mt-2 mb-3">
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
                        </div>
                      )}

                      {profile.status === 'draft' && configured && (
                        <div className="pt-3 mt-3" style={{ borderTop: '1px solid var(--lb-line-soft)' }}>
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
                    );
                  })()}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// Per-canonical wizard: each open service accordion shows 2 summary
// nav rows (Pricing / Customer answers) with an `Edit → ` link.
// SummaryNavRow renders one such row — small icon tile + title +
// 1-line body + right-aligned action button. The existing editor
// forms remain unchanged; they're just hidden behind the row-tap
// until the user opts into editing that section.
const ROW_TONES: Record<string, { bg: string; fg: string }> = {
  green:  { bg: '#d1fae5', fg: '#059669' },
  purple: { bg: '#ede9fe', fg: '#7c3aed' },
};

function SummaryNavRow({
  icon: Icon, iconTone, title, body, actionLabel, onAction, noBorder,
}: {
  icon: React.ComponentType<{ className?: string; size?: number }>;
  iconTone: 'green' | 'purple';
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
  noBorder?: boolean;
}) {
  const tone = ROW_TONES[iconTone];
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '13px 0',
        borderBottom: noBorder ? 'none' : '1px solid var(--lb-line-soft)',
      }}
    >
      <span style={{
        width: 30, height: 30, borderRadius: 8,
        background: tone.bg, color: tone.fg,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Icon size={15} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--lb-ink-1)' }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--lb-ink-5)', marginTop: 1 }}>{body}</div>
      </div>
      <button
        type="button"
        onClick={onAction}
        style={{
          background: 'transparent', border: 0, cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 12.5, fontWeight: 600,
          color: 'var(--lb-accent)',
          whiteSpace: 'nowrap',
        }}
      >
        {actionLabel}
      </button>
    </div>
  );
}

// One-line description of the pricing config for the summary nav row.
// Reads pricingJson and reports the most informative facet: priceTable
// rows, BookingKoala items count, or "set up pricing" placeholder.
function pricingSummary(p: ServiceProfile): string {
  const parsed = safeParse(p.pricingJson);
  if (!parsed || typeof parsed !== 'object') return 'No pricing set — add base rates or a price table.';
  if (parsed.quoteRequired === true) return 'Quote on request — no published rates.';
  if (Array.isArray(parsed.priceTable) && parsed.priceTable.length > 0) {
    return `${parsed.priceTable.length} size band${parsed.priceTable.length === 1 ? '' : 's'} · regular & deep options.`;
  }
  if (Array.isArray(parsed.items) && parsed.items.length > 0) {
    return `${parsed.items.length} priced item${parsed.items.length === 1 ? '' : 's'}.`;
  }
  if (Array.isArray(parsed.basePrices) && parsed.basePrices.length > 0) {
    return `${parsed.basePrices.length} base rate${parsed.basePrices.length === 1 ? '' : 's'}.`;
  }
  if (typeof parsed.laborRate === 'number' && parsed.laborRate > 0) {
    return `Hourly rate: $${parsed.laborRate}/hr.`;
  }
  return 'No pricing set — add base rates or a price table.';
}

// One-line description of the FAQ/customer-answers config. Counts the
// configured quick answers + custom Q&A so the user sees progress
// without opening the editor.
function faqSummary(p: ServiceProfile): string {
  const parsed = safeParse(p.faqJson);
  if (!parsed || typeof parsed !== 'object') return 'No answers set — insured, supplies, payment, custom Q&A.';
  const valueKeys = ['insuredAndBonded', 'bringsSupplies', 'petPolicy', 'customerMustBeHome', 'sameCleanerForRecurring'];
  let quick = 0;
  for (const k of valueKeys) {
    const v = parsed[k]?.value;
    if (typeof v === 'string' && v && v !== 'unset') quick += 1;
  }
  const custom =
    (Array.isArray(parsed.customQA) ? parsed.customQA.filter((q: any) => (q?.question || q?.answer || '').toString().trim()).length : 0) +
    (Array.isArray(parsed.entries) ? parsed.entries.filter((q: any) => (q?.question || q?.answer || '').toString().trim()).length : 0);
  if (quick === 0 && custom === 0) return 'No answers set — insured, supplies, payment, custom Q&A.';
  const parts: string[] = [];
  if (quick > 0) parts.push(`${quick} quick answer${quick === 1 ? '' : 's'}`);
  if (custom > 0) parts.push(`${custom} custom Q&A`);
  return parts.join(' + ') + '.';
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

function safeParse(s: string | null | undefined): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
