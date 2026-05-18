import { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../../../store/appStore';
import { thumbtackApi, usersApi } from '../../../services/api';
import { notify } from '../../../store/notificationStore';
import { getStepMeta } from '../wizardConfig';

// "Quick facts" the AI uses when replying to leads. Per the onboarding
// spec we collect only the high-value, common facts here — labor rate,
// crew sizing, checklist upload, and full FAQ stay in Settings → AI.
type Supplies = 'yes' | 'no';
type Insured = 'yes' | 'no';
type PetPolicy = 'pet_friendly' | 'extra_fee' | 'not_accepted';
type PaymentMethod = 'card' | 'cash' | 'venmo' | 'zelle' | 'check' | 'invoice' | 'paypal';

interface QuickFacts {
  bringsSupplies?: Supplies;
  insured?: Insured;
  petPolicy?: PetPolicy;
  paymentMethods?: PaymentMethod[];
}

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'venmo', label: 'Venmo' },
  { value: 'zelle', label: 'Zelle' },
  { value: 'check', label: 'Check' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'paypal', label: 'PayPal' },
];

interface Props {
  onSaveContinue: () => Promise<void> | void;
  saving: boolean;
  setSaving: (v: boolean) => void;
}

// Step 4 — AI Knowledge. Writes the four "quick facts" into
// SavedAccount.faqJson.quickFacts on the first connected account, then
// cascades the entire faqJson to all sibling accounts via the existing
// copy-to-all endpoint (matches the "Applies to all connected accounts"
// copy in the spec).
export default function AIKnowledgeStep({ onSaveContinue, saving, setSaving }: Props) {
  const navigate = useNavigate();
  const savedAccounts = useAppStore(s => s.savedAccounts);
  const setSavedAccounts = useAppStore(s => s.setSavedAccounts);
  const meta = getStepMeta('ai');

  const [facts, setFacts] = useState<QuickFacts>({});
  const [loading, setLoading] = useState(true);

  // The "source" account whose faqJson we write to + cascade from.
  // Picks the first connected account if available; falls back to the
  // first SavedAccount regardless. We never block this step on having
  // a connected account — the user can skip via the wizard footer.
  const primaryAccountId = useMemo(() => savedAccounts[0]?.id ?? null, [savedAccounts]);

  // Pull current faqJson for the primary account so we can pre-populate
  // any previously-saved quickFacts (handles wizard resume + later edit
  // from Settings).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // Refresh saved accounts in case the store is empty from a deep link.
        if (savedAccounts.length === 0) {
          const { accounts } = await thumbtackApi.getSavedAccounts();
          if (cancelled) return;
          setSavedAccounts(accounts);
          if (accounts.length === 0) return;
        }
        const targetId = savedAccounts[0]?.id;
        if (!targetId) return;
        const { faq } = await usersApi.getAccountFaq(targetId);
        if (cancelled) return;
        if (faq?.quickFacts) {
          setFacts(faq.quickFacts);
        }
      } catch {
        /* non-fatal — defaults are fine */
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function togglePayment(method: PaymentMethod) {
    setFacts(prev => {
      const current = new Set(prev.paymentMethods ?? []);
      if (current.has(method)) current.delete(method);
      else current.add(method);
      return { ...prev, paymentMethods: Array.from(current) };
    });
  }

  async function handleSave() {
    if (saving) return;
    if (!primaryAccountId) {
      // No connected accounts — let the user skip via the wizard footer.
      // Quick-facts have no useful destination without an account, so we
      // route this through onSaveContinue without writing anything; the
      // wizard records "done" for the step.
      await onSaveContinue();
      return;
    }
    setSaving(true);
    try {
      // Read-modify-write on the primary account so we preserve any
      // existing FAQ entries (full FAQ table edited in Settings).
      const { faq: currentFaq } = await usersApi.getAccountFaq(primaryAccountId);
      const merged = { ...(currentFaq ?? {}), quickFacts: facts };
      await usersApi.updateAccountFaq(primaryAccountId, merged);
      // Apply to all sibling accounts per the "Applies to all connected
      // accounts" spec line. The endpoint copies the entire faqJson,
      // not just quickFacts, which is what we want here (consistent
      // onboarding state across accounts).
      if (savedAccounts.length > 1) {
        await usersApi.copyAccountFaqToAll(primaryAccountId).catch(() => {
          // Non-fatal — primary was saved. Show a softer notice.
          notify.info('Saved to primary account', 'We had trouble copying to siblings; check Settings → AI to apply.');
        });
      }
      await onSaveContinue();
    } catch (err: any) {
      notify.error('Could not save', err.response?.data?.message || 'Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const showCascadeCopy = savedAccounts.length > 1;

  return (
    <div className="pt-2">
      <h1 className="text-2xl md:text-3xl font-extrabold text-slate-900 tracking-tight mb-2">
        {meta.title}
      </h1>
      <p className="text-base text-slate-500 leading-relaxed mb-6 max-w-xl">
        {meta.description}
      </p>

      {loading ? (
        <div className="py-12 text-center text-sm text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        </div>
      ) : (
        <div className="space-y-6">
          <FactCard
            label="Do you bring supplies?"
            value={facts.bringsSupplies}
            options={[
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
            ]}
            onPick={(v: Supplies) => setFacts(p => ({ ...p, bringsSupplies: v }))}
          />

          <FactCard
            label="Insured?"
            value={facts.insured}
            options={[
              { value: 'yes', label: 'Yes' },
              { value: 'no', label: 'No' },
            ]}
            onPick={(v: Insured) => setFacts(p => ({ ...p, insured: v }))}
          />

          <FactCard
            label="Pet policy"
            value={facts.petPolicy}
            options={[
              { value: 'pet_friendly', label: 'Pet friendly' },
              { value: 'extra_fee', label: 'Extra fee' },
              { value: 'not_accepted', label: 'Not accepted' },
            ]}
            onPick={(v: PetPolicy) => setFacts(p => ({ ...p, petPolicy: v }))}
          />

          <div>
            <label className="block text-sm font-bold text-slate-900 mb-2">
              Payment methods <span className="text-slate-400 font-medium">(select all that apply)</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {PAYMENT_METHODS.map(m => {
                const active = facts.paymentMethods?.includes(m.value);
                return (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => togglePayment(m.value)}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full border-2 text-sm font-semibold transition-all ${
                      active
                        ? 'border-blue-600 bg-blue-50 text-blue-900'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    {active && <Check className="w-3.5 h-3.5" />}
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="mt-8 flex flex-col gap-3">
        <div className="flex flex-col sm:flex-row gap-3">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || loading}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-md shadow-blue-200 transition-all"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {saving ? 'Saving…' : 'Save & Continue'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/settings')}
            disabled={saving}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all"
          >
            Advanced AI settings
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
        {showCascadeCopy && (
          <p className="text-xs text-slate-400 max-w-md">
            Applies to all connected accounts. You can customize each account later in Settings → AI.
          </p>
        )}
      </div>
    </div>
  );
}

interface FactCardProps<T extends string> {
  label: string;
  value: T | undefined;
  options: { value: T; label: string }[];
  onPick: (v: T) => void;
}

function FactCard<T extends string>({ label, value, options, onPick }: FactCardProps<T>) {
  return (
    <div>
      <label className="block text-sm font-bold text-slate-900 mb-2">{label}</label>
      <div className="flex flex-wrap gap-2">
        {options.map(opt => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onPick(opt.value)}
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-full border-2 text-sm font-semibold transition-all ${
                active
                  ? 'border-blue-600 bg-blue-50 text-blue-900'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
              }`}
            >
              {active && <Check className="w-3.5 h-3.5" />}
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
