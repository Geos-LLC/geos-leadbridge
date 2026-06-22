import { useState, useEffect } from 'react';
import { Loader2, MessageSquare } from 'lucide-react';
import { usersApi, serviceProfilesApi } from '../services/api';
import {
  CollapsibleSection,
  FaqRow,
  UnifiedAddRowButton,
  UnifiedSaveButton,
} from './playbook-controls';
import {
  StructuredFaqGroups,
  type StructuredFaqValue,
} from './StructuredFaqGroups';

export interface AccountFaq {
  insuredAndBonded?: { value?: 'yes' | 'no' | 'unset'; details?: string };
  bringsSupplies?: { value?: 'yes' | 'no' | 'unset'; details?: string };
  petPolicy?: { value?: 'pet_friendly' | 'extra_charge' | 'no_pets' | 'unset'; details?: string };
  paymentMethods?: string[];
  customerMustBeHome?: { value?: 'no' | 'yes' | 'optional' | 'unset'; details?: string };
  sameCleanerForRecurring?: { value?: 'try' | 'guaranteed' | 'no' | 'unset'; details?: string };
  standardScope?: string;
  deepScope?: string;
  laborRatePerCleanerHour?: number;
  crewSizeRule?: { hoursThreshold?: number; sizeUnder?: number; sizeOver?: number };
  customQA?: Array<{ question?: string; answer?: string }>;
}

const DEFAULT_FAQ: AccountFaq = {
  insuredAndBonded: { value: 'unset' },
  bringsSupplies: { value: 'unset' },
  petPolicy: { value: 'unset' },
  paymentMethods: [],
  customerMustBeHome: { value: 'unset' },
  sameCleanerForRecurring: { value: 'unset' },
  standardScope: '',
  deepScope: '',
  laborRatePerCleanerHour: 50,
  crewSizeRule: { hoursThreshold: 4, sizeUnder: 1, sizeOver: 2 },
  customQA: [],
};


interface AccountFaqFormProps {
  accountId: string;
  accountName: string;
  saveToAll?: string[];
  // When set, the form loads/saves against a per-Service FAQ
  // (ServiceProfile.faqJson) instead of the SavedAccount FAQ. accountId is
  // still required for the SavedAccount fallback shape but is ignored at
  // the load/save layer. saveToAll is ignored in this mode — a service's
  // FAQ is scoped to that one profile, not fanned out across accounts.
  serviceProfileId?: string;
}

export default function AccountFaqForm({ accountId, accountName, saveToAll, serviceProfileId }: AccountFaqFormProps) {
  const [faq, setFaq] = useState<AccountFaq | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [inherited, setInherited] = useState(false);

  const loadId = saveToAll && saveToAll.length > 0 ? saveToAll[0] : accountId;
  useEffect(() => {
    setLoading(true);
    if (serviceProfileId) {
      // Per-Service FAQ — load from ServiceProfile.faqJson (string of
      // serialized AccountFaq shape). Falls back to DEFAULT_FAQ when the
      // JSON is missing or unparseable so the editor still renders.
      serviceProfilesApi
        .get(serviceProfileId)
        .then(profile => {
          let parsed: AccountFaq | null = null;
          if (profile.faqJson) {
            try { parsed = JSON.parse(profile.faqJson) as AccountFaq; } catch { /* fall through */ }
          }
          setFaq({ ...DEFAULT_FAQ, ...(parsed || {}) });
          setInherited(false);
        })
        .catch(() => setFaq(DEFAULT_FAQ))
        .finally(() => setLoading(false));
      return;
    }
    if (!loadId) { setLoading(false); return; }
    usersApi.getAccountFaq(loadId)
      .then(res => {
        setFaq({ ...DEFAULT_FAQ, ...(res.faq || {}) });
        setInherited(!!res.inherited);
      })
      .catch(() => setFaq(DEFAULT_FAQ))
      .finally(() => setLoading(false));
  }, [loadId, serviceProfileId]);

  const update = <K extends keyof AccountFaq>(key: K, value: AccountFaq[K]) => {
    setFaq(prev => ({ ...(prev || DEFAULT_FAQ), [key]: value }));
  };

  const updateCustomQA = (idx: number, field: 'question' | 'answer', value: string) => {
    setFaq(prev => {
      const list = [...(prev?.customQA || [])];
      list[idx] = { ...list[idx], [field]: value };
      return { ...(prev || DEFAULT_FAQ), customQA: list };
    });
  };

  const addCustomQA = () => {
    setFaq(prev => ({
      ...(prev || DEFAULT_FAQ),
      customQA: [...(prev?.customQA || []), { question: '', answer: '' }],
    }));
  };


  const removeCustomQA = (idx: number) => {
    setFaq(prev => ({
      ...(prev || DEFAULT_FAQ),
      customQA: (prev?.customQA || []).filter((_, i) => i !== idx),
    }));
  };

  const handleSave = async () => {
    if (!faq) return;
    setSaving(true);
    try {
      const cleaned: AccountFaq = {
        ...faq,
        customQA: (faq.customQA || []).filter(qa => (qa.question || '').trim() && (qa.answer || '').trim()),
      };
      if (serviceProfileId) {
        await serviceProfilesApi.update(serviceProfileId, { faqJson: JSON.stringify(cleaned) });
      } else if (saveToAll && saveToAll.length > 0) {
        await Promise.all(saveToAll.map(id => usersApi.updateAccountFaq(id, cleaned)));
      } else {
        await usersApi.updateAccountFaq(accountId, cleaned);
      }
      setSaved(true);
      setInherited(false);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      alert('Failed to save FAQ');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-slate-400 py-4"><Loader2 size={16} className="animate-spin" /> Loading FAQ...</div>;
  }
  if (!faq) return null;

  return (
    <div className="space-y-5">
      {/* Quick answers eyebrow — mono uppercase per FinalDesign FAQ
          (standalone) canonical. The account name is the smaller
          subtitle line; the inherited badge keeps its right-aligned
          warning when the FAQ has not yet been customized for this
          account. */}
      <div className="flex items-center justify-between">
        <div>
          <h4 style={{
            fontSize: 11,
            fontWeight: 700,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--lb-ink-6, #8b94ab)',
            margin: 0,
          }}>
            Quick answers
          </h4>
          <p className="text-[11px] text-slate-400 mt-0.5">{accountName}</p>
        </div>
        {inherited && (
          <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-100 px-2 py-1 rounded-lg">
            Inherited — save to make it specific to this account
          </span>
        )}
      </div>

      <p className="text-xs text-slate-500 leading-relaxed bg-blue-50/60 border border-blue-100 rounded-xl p-3">
        Answers the AI gives verbatim when customers ask common questions. Anything left blank, the AI defers to the team ("we'll confirm shortly") rather than guess.
      </p>

      {/* Five baseline chip groups — shared with every non-cleaning
          service so the FAQ chrome is identical across verticals. The
          remaining cleaning-specific groups (same cleaner, scope text,
          labor rate, crew sizing) keep rendering inline below. */}
      <StructuredFaqGroups
        value={{
          insuredAndBonded: faq.insuredAndBonded as StructuredFaqValue['insuredAndBonded'],
          bringsSupplies: faq.bringsSupplies as StructuredFaqValue['bringsSupplies'],
          petPolicy: faq.petPolicy as StructuredFaqValue['petPolicy'],
          paymentMethods: faq.paymentMethods,
          customerMustBeHome: faq.customerMustBeHome as StructuredFaqValue['customerMustBeHome'],
          sameCleanerForRecurring: faq.sameCleanerForRecurring as StructuredFaqValue['sameCleanerForRecurring'],
          standardScope: faq.standardScope,
          deepScope: faq.deepScope,
          laborRatePerCleanerHour: faq.laborRatePerCleanerHour,
          crewSizeRule: faq.crewSizeRule,
        }}
        onChange={(next) => {
          if (next.insuredAndBonded !== undefined) update('insuredAndBonded', next.insuredAndBonded as AccountFaq['insuredAndBonded']);
          if (next.bringsSupplies !== undefined) update('bringsSupplies', next.bringsSupplies as AccountFaq['bringsSupplies']);
          if (next.petPolicy !== undefined) update('petPolicy', next.petPolicy as AccountFaq['petPolicy']);
          if (next.paymentMethods !== undefined) update('paymentMethods', next.paymentMethods);
          if (next.customerMustBeHome !== undefined) update('customerMustBeHome', next.customerMustBeHome as AccountFaq['customerMustBeHome']);
          if (next.sameCleanerForRecurring !== undefined) update('sameCleanerForRecurring', next.sameCleanerForRecurring as AccountFaq['sameCleanerForRecurring']);
          if (next.standardScope !== undefined) update('standardScope', next.standardScope);
          if (next.deepScope !== undefined) update('deepScope', next.deepScope);
          if (next.laborRatePerCleanerHour !== undefined) update('laborRatePerCleanerHour', next.laborRatePerCleanerHour);
          if (next.crewSizeRule !== undefined) update('crewSizeRule', next.crewSizeRule);
        }}
      />

      {/* Cleaning-specific fields (same cleaner / scope / labor rate /
          crew sizing) now render through StructuredFaqGroups above,
          so they wear the new chip styling AND also appear on every
          non-cleaning service tab. The cleaning file-upload helper
          buttons are intentionally not in the shared component yet;
          if needed they can be re-added as a cleaning-only adjunct. */}

      {/* Custom Q&A — unified collapsible section with FaqRow per pair,
          matching the Custom service FAQ tab and the pricing tables. */}
      <CollapsibleSection
        title="Custom Q&A"
        icon={<MessageSquare size={14} color="var(--lb-ink-5, #64748b)" />}
        rightBadge={
          (faq.customQA || []).length > 0 && (
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
              {(faq.customQA || []).length}{' '}
              {(faq.customQA || []).length === 1 ? 'row' : 'rows'}
            </span>
          )
        }
      >
        {(faq.customQA || []).length === 0 ? (
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
              Add anything the AI should know how to answer. Examples: weekend availability,
              eco product brands, parking instructions.
            </div>
            <UnifiedAddRowButton label="Add Q&A" onClick={addCustomQA} />
          </div>
        ) : (
          <>
            {(faq.customQA || []).map((qa, idx) => (
              <FaqRow
                key={idx}
                index={idx}
                question={qa.question || ''}
                answer={qa.answer || ''}
                onChangeQuestion={(v) => updateCustomQA(idx, 'question', v)}
                onChangeAnswer={(v) => updateCustomQA(idx, 'answer', v)}
                onRemove={() => removeCustomQA(idx)}
              />
            ))}
            <div style={{ padding: '12px 14px 4px' }}>
              <UnifiedAddRowButton label="Add row" onClick={addCustomQA} />
            </div>
          </>
        )}
      </CollapsibleSection>

      {/* Save — full-width footer pill, same as Save Pricing across the playbook. */}
      <div className="pt-2 border-t border-slate-100">
        <UnifiedSaveButton
          label="Save FAQ"
          dirty
          saving={saving}
          savedAt={saved ? Date.now() : null}
          onClick={() => void handleSave()}
          fullWidth
        />
      </div>
    </div>
  );
}
