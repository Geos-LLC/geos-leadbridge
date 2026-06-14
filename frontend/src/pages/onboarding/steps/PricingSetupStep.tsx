import { useMemo, useState } from 'react';
import { ArrowRight, ExternalLink, Eye, Loader2, Pencil, Sparkles, Wrench } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../../../store/appStore';
import { usersApi } from '../../../services/api';
import { notify } from '../../../store/notificationStore';
import { DEFAULT_CLEANING_PRICING, hydratePricing } from '../../../data/defaultPricing';
import { WizardStepActions } from '../WizardStepActions';

interface Props {
  // Continue path persists "default" template to all accounts; Skip
  // path marks the step as skipped and deep-links the user to the
  // AI Playbook (where the actual pricing table lives) for manual
  // pricing setup later.
  onSaveContinue: () => Promise<void> | void;
  onSkipManual: () => Promise<void> | void;
  saving: boolean;
  setSaving: (v: boolean) => void;
}

type Choice = 'default' | 'manual';

/**
 * Wizard step 5 — Pricing.
 *
 * Two radio-selectable cards (Default / Manual). The card itself is the
 * selection; clicking it doesn't trigger anything. A "Preview default
 * pricing" button on the Default card opens a read-only modal showing
 * the cleaning template before the user commits.
 *
 * Save & Continue (in the sticky top action row) applies the selected
 * choice:
 *   - "default" → writes DEFAULT_CLEANING_PRICING to the primary
 *     SavedAccount and cascades to all siblings, then advances.
 *   - "manual"  → marks the step skipped, opens AI Playbook (where the
 *     full pricing table lives), and advances.
 *
 * The 20-row pricing table never appears in the wizard itself — the
 * Preview modal is the only place users see it before commit; full
 * editing happens in Settings → AI Playbook → Pricing Guidance.
 */
export default function PricingSetupStep({ onSaveContinue, onSkipManual, saving, setSaving }: Props) {
  const navigate = useNavigate();
  const savedAccounts = useAppStore(s => s.savedAccounts);
  // Title + description live in WizardShell header (2026-06-13 redesign).
  const [choice, setChoice] = useState<Choice>('default');
  const [previewOpen, setPreviewOpen] = useState(false);

  const primaryAccountId = useMemo(() => savedAccounts[0]?.id ?? null, [savedAccounts]);
  const cascadeNote = savedAccounts.length > 1;

  async function applyDefault() {
    if (saving) return;
    if (!primaryAccountId) {
      // Same fallback as AI Knowledge — if there's no account we can't
      // write anything; mark the step done so the user can revisit.
      await onSaveContinue();
      return;
    }
    setSaving(true);
    try {
      await usersApi.updateServicePricing(primaryAccountId, DEFAULT_CLEANING_PRICING);
      if (savedAccounts.length > 1) {
        await usersApi.copyServicePricingToAll(primaryAccountId).catch(() => {
          notify.info(
            'Saved to primary account',
            'We had trouble copying to siblings; finish from Settings → AI Playbook.',
          );
        });
      }
      await onSaveContinue();
    } catch (err: any) {
      notify.error('Could not save pricing', err.response?.data?.message || 'Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function applyManual() {
    if (saving) return;
    await onSkipManual();
    // Deep-link to AI Playbook — the pricing table lives inside the
    // Pricing Guidance card on that page, not in the legacy Settings
    // tab. The Overview setup card keeps prompting until pricing is
    // filled in.
    navigate('/settings/ai-playbook');
  }

  async function handleSaveContinue() {
    if (choice === 'default') return applyDefault();
    return applyManual();
  }

  // Show the full default table — users want to verify the numbers before
  // committing, and the modal scrolls if it overflows. Hydrated so that the
  // wizard preview and the AI Playbook editable table always produce the
  // same visible service columns (the rule: Deep Cleaning never disappears).
  const previewPricing = hydratePricing(DEFAULT_CLEANING_PRICING);
  const previewRows = previewPricing.priceTable;
  const previewTypes = previewPricing.cleaningTypes;
  const previewExtras = previewPricing.extras;
  const previewFrequencies = previewPricing.frequencyDiscounts;
  const petSurcharge = previewPricing.petSurcharge;

  return (
    <div className="pt-2">
      <WizardStepActions>
        <button
          type="button"
          onClick={() => void handleSaveContinue()}
          disabled={saving}
          className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-md shadow-blue-200 transition-all"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {saving ? 'Saving…' : 'Save & Continue'}
          {!saving && <ArrowRight className="w-4 h-4" />}
        </button>
        {cascadeNote && choice === 'default' && (
          <span className="text-[11px] text-slate-500">
            Applies to all connected accounts.
          </span>
        )}
      </WizardStepActions>

      {/* Title + description moved to WizardShell header (2026-06-13 redesign). */}

      <div className="space-y-3">
        <PricingChoiceCard
          selected={choice === 'default'}
          onSelect={() => setChoice('default')}
          icon={<Sparkles className="w-5 h-5" />}
          title="Default pricing"
          subtitle="Cleaning-business template — bed/bath grid, frequency discounts, common extras. You can edit anything later."
        >
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setPreviewOpen(true); }}
            disabled={saving}
            className="inline-flex items-center gap-1.5 mt-3 text-sm font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-40"
          >
            <Eye className="w-4 h-4" />
            Preview default pricing
          </button>
        </PricingChoiceCard>

        <PricingChoiceCard
          selected={choice === 'manual'}
          onSelect={() => setChoice('manual')}
          icon={<Wrench className="w-5 h-5" />}
          title="Build pricing manually"
          subtitle="I'll add my services and prices myself in AI Playbook. We'll mark this step as pending so you can finish later."
        >
          <a
            href="/settings/ai-playbook"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1.5 mt-3 text-sm font-semibold text-blue-600 hover:text-blue-700"
          >
            <ExternalLink className="w-4 h-4" />
            Open AI Playbook pricing table
          </a>
        </PricingChoiceCard>
      </div>

      {previewOpen && (
        <div
          className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm"
          onClick={() => setPreviewOpen(false)}
        >
          <div
            className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[88vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-7 pt-7 pb-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <div className="text-base font-extrabold text-slate-900 tracking-tight">
                  Default pricing — full preview
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  Default cleaning rates. You can change any row from AI Playbook later.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPreviewOpen(false)}
                className="text-sm font-semibold text-slate-400 hover:text-slate-700 shrink-0"
              >
                Close
              </button>
            </div>

            <div className="px-7 py-5 overflow-y-auto flex-1">
              <div className="rounded-2xl border border-slate-100 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-widest sticky top-0">
                    <tr>
                      <th className="text-left py-2 px-3 font-bold">Bed / Bath</th>
                      {previewTypes.map((t) => (
                        <th key={t.key} className="text-right py-2 px-3 font-bold">
                          {t.label.split(' ')[0]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row, i) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="py-2 px-3 text-slate-700 font-semibold">
                          {row.bed}b / {row.bath}b
                        </td>
                        {previewTypes.map((t) => {
                          const v = row[t.key];
                          return (
                            <td key={t.key} className="py-2 px-3 text-right text-slate-900">
                              {v === 0 ? '$0' : v != null ? `$${v}` : '—'}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {previewFrequencies.length > 0 && (
                <div className="mt-5">
                  <div className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-2">
                    Frequency discounts
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {previewFrequencies.map((f: any, i: number) => (
                      <span
                        key={i}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 text-xs font-semibold"
                      >
                        {f.label || f.name || 'Frequency'}
                        {typeof f.discount === 'number' ? ` · −${f.discount}%` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {previewExtras.length > 0 && (
                <div className="mt-5">
                  <div className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-2">
                    Extras
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {previewExtras.map((e: any, i: number) => (
                      <span
                        key={i}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 text-xs font-semibold"
                      >
                        {e.name || e.label || 'Extra'}
                        {typeof e.price === 'number' ? ` · $${e.price}` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {typeof petSurcharge === 'number' && (
                <div className="mt-5 text-xs text-slate-500">
                  <strong className="text-slate-700">Pet surcharge:</strong> ${petSurcharge} per visit.
                </div>
              )}
            </div>

            <div className="px-7 py-4 border-t border-slate-100 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setPreviewOpen(false);
                  navigate('/settings/ai-playbook');
                }}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all"
              >
                <Pencil className="w-4 h-4" />
                Edit in AI Playbook
              </button>
              <button
                type="button"
                onClick={() => {
                  setPreviewOpen(false);
                  setChoice('default');
                }}
                disabled={saving}
                className="inline-flex items-center gap-2 px-5 py-2 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-md shadow-blue-200 transition-all"
              >
                Use this — close preview
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface PricingChoiceCardProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  selected: boolean;
  onSelect: () => void;
  children?: React.ReactNode;
}

// Radio-selectable card. The whole card is the selection target — the
// inner action buttons (Preview, Open AI Playbook) stop propagation so
// they can run their own behavior without flipping the radio.
function PricingChoiceCard({ icon, title, subtitle, selected, onSelect, children }: PricingChoiceCardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`w-full flex items-start gap-4 p-5 rounded-2xl border-2 text-left transition-all ${
        selected
          ? 'border-blue-600 bg-blue-50/40'
          : 'border-slate-200 bg-white hover:border-slate-300'
      }`}
    >
      <span
        className={`w-10 h-10 rounded-xl inline-flex items-center justify-center shrink-0 ${
          selected ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'
        }`}
      >
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-base font-extrabold text-slate-900 tracking-tight">{title}</span>
        </div>
        <p className="text-sm text-slate-500 leading-relaxed">{subtitle}</p>
        {children}
      </div>
      {/* Radio dot — visible affordance that this card IS the selection,
          not a "click to apply" button. */}
      <span
        className={`w-5 h-5 rounded-full border-2 shrink-0 mt-1 flex items-center justify-center ${
          selected ? 'border-blue-600 bg-blue-600' : 'border-slate-300 bg-white'
        }`}
        aria-hidden
      >
        {selected && <span className="w-2 h-2 rounded-full bg-white" />}
      </span>
    </button>
  );
}
