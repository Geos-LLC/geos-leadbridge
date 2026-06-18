import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ExternalLink,
  Loader2,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { serviceProfilesApi, type ServiceProfile } from '../../../services/api';
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
 * Wizard "Service setup" step (multi-service refactor 2026-06-18).
 *
 * Per ServiceProfile accordion. Each row exposes the same structured
 * editors as Settings → AI Playbook → (per-service tab):
 *   - <ServicePricingForm  serviceProfileId={...} /> — pricing table
 *   - <AccountFaqForm      serviceProfileId={...} /> — customer answers
 *   - lightweight "Additional AI instructions" textarea + deep link
 *
 * Both forms are already polymorphic on serviceProfileId and write
 * directly to ServiceProfile.pricingJson / ServiceProfile.faqJson, so
 * no per-account fan-out and no JSON textareas.
 *
 * Completion semantics:
 *   - ACTIVE services need pricing (table OR quoteRequired) AND
 *     customer answers to count toward serviceSetup.done.
 *   - DRAFT services show "Draft · AI paused" but do NOT block Done.
 *   - AI instructions and qualification are optional everywhere.
 */
export default function ServiceSetupStep({
  onSaveContinue,
  saving,
  setSaving,
}: Props) {
  const navigate = useNavigate();
  const savedAccounts = useAppStore(s => s.savedAccounts);

  const [profiles, setProfiles] = useState<ServiceProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  // Per-profile AI instructions draft state, keyed by profile id.
  const [aiDraft, setAiDraft] = useState<Record<string, { value: string; dirty: boolean; saving: boolean }>>({});

  // Primary SavedAccount — required prop for AccountFaqForm /
  // ServicePricingForm even when they're in serviceProfile mode (only
  // used for display fallback inside those forms).
  const primaryAccount = savedAccounts[0];

  async function refreshProfiles() {
    try {
      const res = await serviceProfilesApi.list();
      const list = (res.profiles ?? []).filter(p => p.status !== 'archived');
      setProfiles(list);
      if (openId === null && list.length > 0) {
        const firstIncomplete = list.find(p => p.status === 'active' && !looksConfigured(p));
        setOpenId((firstIncomplete ?? list[0]).id);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshProfiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ordered: active before draft, then default-first, then name.
  const ordered = useMemo(
    () => [...profiles].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    }),
    [profiles],
  );

  // Seed the AI textarea from the profile when first opened so the
  // user sees their existing additionalInstructions if any.
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

  // Persist additionalInstructions into ServiceProfile.aiInstructionsJson
  // WITHOUT touching the rest of the envelope. Reads the current
  // wrapper, patches additionalInstructions, writes back. Preserves
  // serviceRules / aiPlaybookV2 that Settings → AI Playbook may have
  // configured.
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

      // If after patching we have nothing meaningful left, store null
      // so the resolver doesn't read an empty envelope.
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

  // Draft → active. Backend rejects with EMPTY_CONFIG if the service
  // has no pricing/FAQ/qualification at all, so the button is gated to
  // looksConfigured rows.
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

  // Refetch a single profile after the embedded form saves so the
  // status pill (and any banner counts) reflects reality without the
  // user having to collapse/expand the accordion.
  async function refreshOne(profileId: string) {
    try {
      const updated = await serviceProfilesApi.get(profileId);
      setProfiles(prev => prev.map(p => (p.id === profileId ? updated : p)));
    } catch { /* non-fatal */ }
  }

  async function handleContinue() {
    if (saving) return;
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

  return (
    <div className="pt-2">
      <WizardStepActions>
        <button
          type="button"
          onClick={() => void handleContinue()}
          disabled={saving}
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
      </WizardStepActions>

      {loading ? (
        <div className="py-12 text-center text-sm text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        </div>
      ) : ordered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-600">
          You don't have any services yet. Go back to the{' '}
          <strong>Services</strong> step to add one from a template or
          create a custom service.
        </div>
      ) : (
        <>
          {/* Status summary banner. Tells the user what's blocking
              Done at the top so they don't need to scan the accordion. */}
          {incompleteActive.length > 0 && (
            <div className="mb-5 flex items-start gap-2 rounded-xl border border-amber-100 bg-amber-50/60 px-3 py-2.5 text-xs text-amber-900">
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
            <div className="mb-5 flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-600">
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
                        ensureAiDraft(profile);
                        // Pull fresh data when re-opening so the embedded
                        // form initial values reflect what the user
                        // already saved on a previous visit.
                        void refreshOne(profile.id);
                      }
                    }}
                    className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {open ? (
                        <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                      )}
                      <div className="text-left min-w-0">
                        <div className="text-sm font-bold text-slate-900 truncate">
                          {profile.name}
                          {profile.isDefault && (
                            <span className="ml-2 text-xs font-semibold text-slate-400">
                              default
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          <StatusPill status={profile.status} configured={configured} />
                        </div>
                      </div>
                    </div>
                  </button>

                  {open && (
                    <div className="border-t border-slate-100 p-4 space-y-6 bg-slate-50/40">
                      {/* Pricing — same structured form as Settings →
                          AI Playbook → Pricing Guidance. Writes to
                          ServiceProfile.pricingJson. */}
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

                      {/* Customer answers / FAQ — same structured form as
                          Settings → AI Playbook → FAQ. Writes to
                          ServiceProfile.faqJson. */}
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

                      {/* AI instructions — lightweight textarea that
                          merges into the aiInstructionsJson envelope as
                          { additionalInstructions: '...' }. Existing
                          aiPlaybookV2 / serviceRules entries are
                          preserved. Deep link points at the full
                          per-service AI Playbook editor. */}
                      <Section label="AI instructions (optional)">
                        <div className="rounded-xl border border-slate-200 bg-white p-3 space-y-2">
                          <div className="flex items-start gap-2 text-xs text-slate-500">
                            <Sparkles className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                            <span>
                              Anything AI should remember when handling{' '}
                              <strong>{profile.name}</strong> leads — sales
                              angle, what to avoid, special wording.
                            </span>
                          </div>
                          <textarea
                            value={aiDraft[profile.id]?.value ?? ''}
                            onChange={e => updateAiDraft(profile.id, e.target.value)}
                            placeholder={`e.g., Always mention that insurance is included. Don't quote weekend rates.`}
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
                            <button
                              type="button"
                              onClick={() => navigate(`/settings?tab=ai-playbook&scope=${profile.id}`)}
                              className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-800"
                            >
                              Full AI playbook for this service
                              <ExternalLink className="w-3 h-3" />
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

function StatusPill({
  status,
  configured,
}: {
  status: 'active' | 'draft' | 'archived';
  configured: boolean;
}) {
  if (status === 'draft') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
        Draft · AI paused
      </span>
    );
  }
  if (configured) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">
        <CheckCircle2 className="w-3 h-3" />
        Ready
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
      <ShieldAlert className="w-3 h-3" />
      Needs pricing + answers
    </span>
  );
}

// Local mirror of the backend `isServicePricingConfigured` +
// `isServiceCustomerAnswersConfigured` predicates. Kept in sync
// manually — the wizard wants instant feedback as the user types
// without a backend round-trip.
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

// Mirror of backend isServiceCustomerAnswersConfigured. Accepts the
// structured legacy SavedAccount FAQ shape (insuredAndBonded /
// paymentMethods / etc.) that AccountFaqForm writes, plus the v2
// admin-template customQA + entries shapes.
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

// Read `additionalInstructions` out of the aiInstructionsJson envelope.
// Falls back to empty string when the envelope is missing or malformed.
function readAdditionalInstructions(json: string | null): string {
  const obj = safeParse(json);
  if (!obj || typeof obj !== 'object') return '';
  return typeof obj.additionalInstructions === 'string' ? obj.additionalInstructions : '';
}

function safeParse(s: string | null | undefined): any {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
