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
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { serviceProfilesApi, type ServiceProfile } from '../../../services/api';
import { notify } from '../../../store/notificationStore';
import { WizardStepActions } from '../WizardStepActions';

interface Props {
  onSaveContinue: () => Promise<void> | void;
  saving: boolean;
  setSaving: (v: boolean) => void;
}

interface EditorState {
  pricingJson: string;
  faqJson: string;
  qualificationSchemaJson: string;
  quoteRequired: boolean;
  dirty: boolean;
  savingThis: boolean;
}

const EMPTY_EDITOR: EditorState = {
  pricingJson: '',
  faqJson: '',
  qualificationSchemaJson: '',
  quoteRequired: false,
  dirty: false,
  savingThis: false,
};

/**
 * Wizard "Service setup" step (multi-service refactor 2026-06-18).
 *
 * Accordion of every active+draft ServiceProfile. Each row exposes
 * pricing, customer answers (FAQ), and the optional qualification
 * schema. Save persists via PATCH /v1/service-profiles/:id; activating a
 * draft uses PATCH /v1/service-profiles/:id/status with allowReactivate
 * left false.
 *
 * Completion semantics (per spec confirmation 2026-06-18):
 *   - ACTIVE services need pricing (table or quoteRequired) AND
 *     customer answers.
 *   - DRAFT services show "incomplete / AI paused" but do NOT block
 *     Done.
 *   - Service options / qualification schema is optional everywhere.
 *
 * The editors are JSON textareas to match Settings → Services. A
 * structured form refactor is a follow-up (tracked separately).
 */
export default function ServiceSetupStep({
  onSaveContinue,
  saving,
  setSaving,
}: Props) {
  const navigate = useNavigate();

  const [profiles, setProfiles] = useState<ServiceProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  // Per-profile draft editor state. Keyed by profile id.
  const [editors, setEditors] = useState<Record<string, EditorState>>({});

  async function refreshProfiles() {
    try {
      const res = await serviceProfilesApi.list();
      const list = (res.profiles ?? []).filter(p => p.status !== 'archived');
      setProfiles(list);
      // Open the first incomplete active profile by default so the
      // user sees something actionable on land.
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

  // Sorted: active before draft, then default-first, then name.
  const ordered = useMemo(
    () => [...profiles].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    }),
    [profiles],
  );

  // Lazy-load the editor state when a profile is opened for the
  // first time. We seed from the current ServiceProfile JSON so the
  // textareas show what's already there.
  function ensureEditor(profile: ServiceProfile) {
    if (editors[profile.id]) return;
    const parsedPricing = safeParse(profile.pricingJson);
    setEditors(prev => ({
      ...prev,
      [profile.id]: {
        ...EMPTY_EDITOR,
        pricingJson: profile.pricingJson ?? '',
        faqJson: profile.faqJson ?? '',
        qualificationSchemaJson: profile.qualificationSchemaJson ?? '',
        quoteRequired: parsedPricing?.quoteRequired === true,
      },
    }));
  }

  function updateEditor(profileId: string, patch: Partial<EditorState>) {
    setEditors(prev => ({
      ...prev,
      [profileId]: { ...(prev[profileId] ?? EMPTY_EDITOR), ...patch, dirty: true },
    }));
  }

  // Single Save button per profile. Persists all three JSON fields
  // even when only one changed — cheaper than tracking per-field dirt.
  async function saveProfile(profile: ServiceProfile) {
    const editor = editors[profile.id];
    if (!editor || editor.savingThis) return;

    // Normalize "blank textarea" → null. Empty string is not valid JSON
    // and would break the backend's parse-on-read.
    const normalize = (raw: string): string | null => {
      const trimmed = raw.trim();
      if (!trimmed) return null;
      try {
        JSON.parse(trimmed);
        return trimmed;
      } catch {
        return null;
      }
    };

    // If user toggled "quote-required", merge it into pricingJson before
    // sending. We respect the user's edits if they wrote `quoteRequired`
    // by hand; the toggle just shifts the default.
    let pricingPayload = normalize(editor.pricingJson);
    if (editor.quoteRequired) {
      const obj = pricingPayload ? safeParse(pricingPayload) : {};
      pricingPayload = JSON.stringify({ ...(obj ?? {}), quoteRequired: true });
    }

    setEditors(prev => ({
      ...prev,
      [profile.id]: { ...prev[profile.id], savingThis: true },
    }));
    try {
      const updated = await serviceProfilesApi.update(profile.id, {
        pricingJson: pricingPayload,
        faqJson: normalize(editor.faqJson),
        qualificationSchemaJson: normalize(editor.qualificationSchemaJson),
      });
      setProfiles(prev => prev.map(p => (p.id === profile.id ? updated : p)));
      setEditors(prev => ({
        ...prev,
        [profile.id]: { ...prev[profile.id], dirty: false, savingThis: false },
      }));
      notify.success('Service saved', `${profile.name} updated.`);
    } catch (err: any) {
      setEditors(prev => ({
        ...prev,
        [profile.id]: { ...prev[profile.id], savingThis: false },
      }));
      notify.error(
        'Could not save service',
        err.response?.data?.message || 'Please try again.',
      );
    }
  }

  // Draft → active promotion. Backend rejects with EMPTY_CONFIG if the
  // service has no pricing/FAQ/qualification at all, so the button is
  // gated to looksConfigured rows.
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
          Advanced editor
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
              const editor = editors[profile.id];
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
                      if (next) ensureEditor(profile);
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
                    <div className="border-t border-slate-100 p-4 space-y-4 bg-slate-50/40">
                      <Section label="Pricing">
                        <div className="flex items-center gap-2 mb-2">
                          <input
                            type="checkbox"
                            id={`qr-${profile.id}`}
                            checked={editor?.quoteRequired ?? false}
                            onChange={e => updateEditor(profile.id, { quoteRequired: e.target.checked })}
                            className="w-3.5 h-3.5 rounded text-blue-600 focus:ring-blue-500"
                          />
                          <label htmlFor={`qr-${profile.id}`} className="text-xs font-semibold text-slate-700 cursor-pointer">
                            Quote-required (no flat pricing — AI collects info and quotes manually)
                          </label>
                        </div>
                        <textarea
                          value={editor?.pricingJson ?? ''}
                          onChange={e => updateEditor(profile.id, { pricingJson: e.target.value })}
                          placeholder='{"priceTable": [...]} or {"items": [...]} or leave blank with quote-required ticked'
                          rows={6}
                          className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg bg-white"
                        />
                      </Section>

                      <Section label="Customer answers (FAQ)">
                        <textarea
                          value={editor?.faqJson ?? ''}
                          onChange={e => updateEditor(profile.id, { faqJson: e.target.value })}
                          placeholder='{"customQA": [{"question": "Do you bring supplies?", "answer": "Yes"}]}'
                          rows={6}
                          className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg bg-white"
                        />
                      </Section>

                      <Section label="Service options / qualification (optional)">
                        <textarea
                          value={editor?.qualificationSchemaJson ?? ''}
                          onChange={e => updateEditor(profile.id, { qualificationSchemaJson: e.target.value })}
                          placeholder='{"questions": [{"key": "rooms", "label": "How many rooms?", "type": "number"}]}'
                          rows={4}
                          className="w-full px-3 py-2 text-xs font-mono border border-slate-200 rounded-lg bg-white"
                        />
                        <p className="mt-1 text-xs text-slate-400">
                          Optional. AI will use these to gather info before quoting
                          if the customer's first message doesn't include them.
                        </p>
                      </Section>

                      <div className="flex items-center gap-2 pt-2">
                        <button
                          type="button"
                          onClick={() => void saveProfile(profile)}
                          disabled={editor?.savingThis || !editor?.dirty}
                          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg"
                        >
                          {editor?.savingThis ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                          {editor?.savingThis ? 'Saving…' : editor?.dirty ? 'Save service' : 'Saved'}
                        </button>
                        {profile.status === 'draft' && configured && (
                          <button
                            type="button"
                            onClick={() => void activate(profile)}
                            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg"
                          >
                            Activate service
                          </button>
                        )}
                      </div>
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
      <div className="text-xs font-bold text-slate-700 mb-1">{label}</div>
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
// without a backend round-trip. Status pill semantics:
//   - quote-required pricing OR populated price table counts as pricing
//   - non-empty customQA / paymentMethods etc. counts as answers
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
