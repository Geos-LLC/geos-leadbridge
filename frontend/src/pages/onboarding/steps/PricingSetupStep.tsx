import { useMemo, useState } from 'react';
import { ExternalLink, Eye, Loader2, Pencil, Sparkles, Wrench } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../../../store/appStore';
import { usersApi } from '../../../services/api';
import { notify } from '../../../store/notificationStore';
import { DEFAULT_CLEANING_PRICING } from '../../../components/ServicePricingForm';
import { getStepMeta } from '../wizardConfig';

interface Props {
  // Continue path persists "recommended" defaults to all accounts; Skip
  // path marks the step as skipped and deep-links the user to Settings
  // for manual pricing setup later.
  onSaveContinue: () => Promise<void> | void;
  onSkipManual: () => Promise<void> | void;
  saving: boolean;
  setSaving: (v: boolean) => void;
}

// Step 5 — Pricing. Per the spec we never show the full 20-row pricing
// table inside onboarding. Two paths only:
//   1. "Use recommended pricing" — applies DEFAULT_CLEANING_PRICING to
//      the primary connected account via the existing PATCH endpoint,
//      then cascades to all sibling accounts via copy-to-all.
//   2. "Build pricing manually" — marks the step skipped and deep links
//      to Settings → Pricing for the user to handle later.
// A "Preview pricing" affordance opens a read-only modal showing the
// default cleaning ranges so the user knows what "recommended" means
// before they commit.
export default function PricingSetupStep({ onSaveContinue, onSkipManual, saving, setSaving }: Props) {
  const navigate = useNavigate();
  const savedAccounts = useAppStore(s => s.savedAccounts);
  const meta = getStepMeta('pricing');
  const [previewOpen, setPreviewOpen] = useState(false);

  const primaryAccountId = useMemo(() => savedAccounts[0]?.id ?? null, [savedAccounts]);
  const cascadeNote = savedAccounts.length > 1;

  async function applyRecommended() {
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
            'We had trouble copying to siblings; finish from Settings → Pricing.',
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

  async function pickManual() {
    if (saving) return;
    await onSkipManual();
    // Deep-link to Settings so the user has a clear next action. The
    // step is already marked skipped at this point, and the Overview
    // setup card will keep prompting until pricing is filled in.
    navigate('/settings');
  }

  // Show the full recommended table — users want to verify the
  // numbers before committing, and the modal scrolls if it overflows.
  const previewRows = (DEFAULT_CLEANING_PRICING as any)?.priceTable ?? [];
  const previewExtras = (DEFAULT_CLEANING_PRICING as any)?.extras ?? [];
  const previewFrequencies = (DEFAULT_CLEANING_PRICING as any)?.frequencyDiscounts ?? [];
  const petSurcharge = (DEFAULT_CLEANING_PRICING as any)?.petSurcharge;

  return (
    <div className="pt-2">
      <h1 className="text-2xl md:text-3xl font-extrabold text-slate-900 tracking-tight mb-2">
        {meta.title}
      </h1>
      <p className="text-base text-slate-500 leading-relaxed mb-8 max-w-xl">
        {meta.description}
      </p>

      <div className="space-y-3">
        <PricingChoiceCard
          recommended
          icon={<Sparkles className="w-5 h-5" />}
          title="Use recommended pricing"
          subtitle="Cleaning-business defaults — bed/bath grid, frequency discounts, common extras. You can edit anything later."
          ctaLabel="Use recommended"
          onClick={() => void applyRecommended()}
          saving={saving}
        />
        <PricingChoiceCard
          icon={<Wrench className="w-5 h-5" />}
          title="Build pricing manually"
          subtitle="I'll add my services and prices myself. We'll mark this step as pending so you can finish from Settings."
          ctaLabel="I'll do it later"
          onClick={() => void pickManual()}
          saving={saving}
        />
      </div>

      <div className="mt-6 flex items-center gap-4">
        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          disabled={saving}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-40"
        >
          <Eye className="w-4 h-4" />
          Preview recommended pricing
        </button>
      </div>

      {cascadeNote && (
        <p className="mt-5 text-xs text-slate-400 max-w-md">
          Applies to all connected accounts. You can customize each account later in Settings → Pricing.
        </p>
      )}

      {previewOpen && (
        <div
          className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm"
          onClick={() => setPreviewOpen(false)}
        >
          <div
            className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[88vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* Header — sticky inside the modal so it stays on screen
                while the body scrolls. */}
            <div className="px-7 pt-7 pb-4 border-b border-slate-100 flex items-center justify-between">
              <div>
                <div className="text-base font-extrabold text-slate-900 tracking-tight">
                  Recommended pricing — full preview
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  Default cleaning rates. You can change any row from Settings later.
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

            {/* Scrollable body */}
            <div className="px-7 py-5 overflow-y-auto flex-1">
              <div className="rounded-2xl border border-slate-100 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-widest sticky top-0">
                    <tr>
                      <th className="text-left py-2 px-3 font-bold">Bed / Bath</th>
                      <th className="text-right py-2 px-3 font-bold">Regular</th>
                      <th className="text-right py-2 px-3 font-bold">Deep</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row: any, i: number) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="py-2 px-3 text-slate-700 font-semibold">
                          {row.bed}b / {row.bath}b
                        </td>
                        <td className="py-2 px-3 text-right text-slate-900">${row.regular ?? row.standard ?? '—'}</td>
                        <td className="py-2 px-3 text-right text-slate-900">${row.deep ?? '—'}</td>
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

            {/* Footer with primary actions. "Apply & continue" runs
                the same path as the main "Use recommended" button so
                a user who only opened the preview can commit without
                closing it. */}
            <div className="px-7 py-4 border-t border-slate-100 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setPreviewOpen(false);
                  navigate('/settings');
                }}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all"
              >
                <Pencil className="w-4 h-4" />
                Edit pricing
              </button>
              <button
                type="button"
                onClick={() => {
                  setPreviewOpen(false);
                  void applyRecommended();
                }}
                disabled={saving}
                className="inline-flex items-center gap-2 px-5 py-2 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-md shadow-blue-200 transition-all"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {saving ? 'Saving…' : 'Apply & continue'}
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
  ctaLabel: string;
  recommended?: boolean;
  onClick: () => void;
  saving: boolean;
}

function PricingChoiceCard({ icon, title, subtitle, ctaLabel, recommended, onClick, saving }: PricingChoiceCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={saving}
      className={`w-full flex items-start gap-4 p-5 rounded-2xl border-2 text-left transition-all ${
        recommended
          ? 'border-blue-600 bg-blue-50/40 hover:bg-blue-50'
          : 'border-slate-200 bg-white hover:border-slate-300'
      } disabled:opacity-50 disabled:cursor-not-allowed`}
    >
      <span
        className={`w-10 h-10 rounded-xl inline-flex items-center justify-center shrink-0 ${
          recommended ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'
        }`}
      >
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-base font-extrabold text-slate-900 tracking-tight">{title}</span>
          {recommended && (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-blue-600 text-white text-[10px] font-bold uppercase tracking-widest">
              Recommended
            </span>
          )}
        </div>
        <p className="text-sm text-slate-500 leading-relaxed">{subtitle}</p>
        <span className="inline-flex items-center gap-1 mt-3 text-sm font-bold text-blue-700">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {saving ? 'Saving…' : ctaLabel}
          {!saving && <ExternalLink className="w-3.5 h-3.5" />}
        </span>
      </div>
    </button>
  );
}
