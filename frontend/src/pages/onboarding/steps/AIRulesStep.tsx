import { useState } from 'react';
import { Bell, Eye, FileText, Loader2, Shield } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../../../store/appStore';
import { followUpApi } from '../../../services/api';
import { notify } from '../../../store/notificationStore';
import { getStepMeta } from '../wizardConfig';

interface Props {
  onSaveContinue: () => Promise<void> | void;
  saving: boolean;
  setSaving: (v: boolean) => void;
}

// Default values mirror what the backend already treats as "on" when
// followUpSettingsJson is missing the key. Showing them as defaults
// here lets the user confirm the standard behavior without having to
// understand every stop / handoff trigger up-front.
const DEFAULT_STOP_RULES = {
  aiStopOnOptOut: true,
  aiStopOnBooked: true,
  aiStopOnPriceAgreed: true,
};

const DEFAULT_HANDOFF_TRIGGERS = {
  handoffTriggerAgreed: true,
  handoffTriggerWantsLiveContact: true,
  handoffTriggerProvidedPhone: true,
  handoffTriggerProvidedSquareFootage: true,
  handoffTriggerQualificationComplete: true,
};

// Mirror of automation.service.ts default — kept here so the preview
// drawer can render the manager-alert without round-tripping. When the
// user edits the template later it lives in Templates, not here.
const DEFAULT_HANDOFF_TEMPLATE = 'Lead {{lead.name}} ready for handoff ({{intent}}): "{{message}}"';

const STOP_RULES_META = [
  { key: 'aiStopOnOptOut', label: 'Customer asks not to be contacted' },
  { key: 'aiStopOnBooked', label: 'Job is booked or confirmed' },
  { key: 'aiStopOnPriceAgreed', label: 'Customer agrees on price — hand off to manager' },
] as const;

const HANDOFF_TRIGGERS_META = [
  { key: 'handoffTriggerAgreed', label: 'Ready to book' },
  { key: 'handoffTriggerWantsLiveContact', label: 'Wants live contact' },
  { key: 'handoffTriggerProvidedPhone', label: 'Provided phone number' },
  { key: 'handoffTriggerProvidedSquareFootage', label: 'Provided square footage' },
  { key: 'handoffTriggerQualificationComplete', label: 'Qualification complete' },
] as const;

// Step 7 — AI Rules. Summary view of the AI stop conditions and
// human-takeover triggers, all of which already exist as keys on
// SavedAccount.followUpSettingsJson. We deliberately do NOT show the
// alert template editor here — template editing belongs on the
// Templates page. The "Preview manager alerts →" drawer renders the
// default template content read-only so the user knows what their
// dispatcher will see.
//
// "Lead is done / scheduled / archived" is intentionally shown as a
// locked "always on" row — the terminal-status guard is hard-coded in
// follow-up-engine and not user-controllable. Surfacing it here keeps
// the rule set complete without misleading users that they can toggle
// it off.
export default function AIRulesStep({ onSaveContinue, saving, setSaving }: Props) {
  const navigate = useNavigate();
  const savedAccounts = useAppStore(s => s.savedAccounts);
  const meta = getStepMeta('ai_rules');

  const [stopRules, setStopRules] = useState({ ...DEFAULT_STOP_RULES });
  const [handoffTriggers, setHandoffTriggers] = useState({ ...DEFAULT_HANDOFF_TRIGGERS });
  const [previewOpen, setPreviewOpen] = useState(false);

  const cascadeNote = savedAccounts.length > 1;

  async function apply() {
    if (saving) return;
    const payload = { ...stopRules, ...handoffTriggers };
    setSaving(true);
    try {
      if (savedAccounts.length === 0) {
        await onSaveContinue();
        return;
      }
      let firstError: any = null;
      for (const acct of savedAccounts) {
        try {
          await followUpApi.saveWizardSettings(acct.id, payload);
        } catch (err) {
          if (!firstError) firstError = err;
        }
      }
      if (firstError) {
        const msg = firstError.response?.data?.message || 'Some accounts did not save — you can re-apply from the Automation page.';
        notify.error('Partial save', msg);
      }
      await onSaveContinue();
    } catch (err: any) {
      notify.error('Could not save', err.response?.data?.message || 'Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pt-2">
      <h1 className="text-2xl md:text-3xl font-extrabold text-slate-900 tracking-tight mb-2">
        {meta.title}
      </h1>
      <p className="text-base text-slate-500 leading-relaxed mb-6 max-w-xl">
        {meta.description}
      </p>

      {/* Stop rules */}
      <section className="mb-8">
        <h2 className="flex items-center gap-2 text-sm font-extrabold text-slate-900 mb-3">
          <Shield className="w-4 h-4 text-slate-500" />
          AI stops replying when
        </h2>
        <ul className="space-y-2">
          {STOP_RULES_META.map(({ key, label }) => {
            const checked = stopRules[key];
            return (
              <RuleRow
                key={key}
                label={label}
                checked={checked}
                onChange={v => setStopRules(prev => ({ ...prev, [key]: v }))}
                disabled={saving}
              />
            );
          })}
          <RuleRow label="Lead is done, scheduled, or archived" checked locked />
        </ul>
      </section>

      {/* Handoff triggers */}
      <section>
        <h2 className="flex items-center gap-2 text-sm font-extrabold text-slate-900 mb-3">
          <Bell className="w-4 h-4 text-slate-500" />
          Notify your team when AI detects
        </h2>
        <ul className="space-y-2">
          {HANDOFF_TRIGGERS_META.map(({ key, label }) => {
            const checked = handoffTriggers[key];
            return (
              <RuleRow
                key={key}
                label={label}
                checked={checked}
                onChange={v => setHandoffTriggers(prev => ({ ...prev, [key]: v }))}
                disabled={saving}
              />
            );
          })}
        </ul>
        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          disabled={saving}
          className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-40"
        >
          <Eye className="w-4 h-4" />
          Preview manager alerts
        </button>
      </section>

      <div className="mt-8 flex flex-col gap-3">
        <button
          type="button"
          onClick={() => void apply()}
          disabled={saving}
          className="self-start inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-md shadow-blue-200 transition-all"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {saving ? 'Saving…' : 'Save & Continue'}
        </button>
        {cascadeNote && (
          <p className="text-xs text-slate-400 max-w-md">
            Applies to all connected accounts. You can customize each account later on the Automation page.
          </p>
        )}
      </div>

      {previewOpen && (
        <div
          className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm"
          onClick={() => setPreviewOpen(false)}
        >
          <div
            className="bg-white rounded-3xl shadow-2xl w-full max-w-lg p-7"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <span className="w-9 h-9 rounded-xl bg-slate-100 text-slate-600 inline-flex items-center justify-center">
                <FileText className="w-4 h-4" />
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-base font-extrabold text-slate-900 tracking-tight">
                  Manager alert — preview
                </div>
                <div className="text-xs text-slate-500">
                  Default template. Edit in Templates to customize.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPreviewOpen(false)}
                className="text-sm font-semibold text-slate-400 hover:text-slate-700"
              >
                Close
              </button>
            </div>

            <div className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 text-sm text-slate-700 font-mono leading-relaxed">
              {DEFAULT_HANDOFF_TEMPLATE}
            </div>

            <div className="mt-4 text-xs text-slate-500 leading-relaxed">
              <strong className="text-slate-700">Variables:</strong>
              {' '}<code className="px-1 rounded bg-slate-100">{'{{lead.name}}'}</code> is the customer name,
              {' '}<code className="px-1 rounded bg-slate-100">{'{{intent}}'}</code> is a short reason like
              {' '}"ready to book" or "wants live call", and
              {' '}<code className="px-1 rounded bg-slate-100">{'{{message}}'}</code> is the first ~200 chars of
              {' '}the customer's message.
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPreviewOpen(false)}
                className="px-4 py-2 text-sm font-semibold text-slate-500 hover:text-slate-700 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setPreviewOpen(false);
                  navigate('/templates');
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
              >
                Edit in Templates
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface RuleRowProps {
  label: string;
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  locked?: boolean;
}

function RuleRow({ label, checked, onChange, disabled, locked }: RuleRowProps) {
  return (
    <li
      className={`flex items-center gap-3 px-4 py-3 rounded-2xl border ${
        locked ? 'border-slate-100 bg-slate-50/60' : 'border-slate-200 bg-white'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled || locked}
        onChange={locked || !onChange ? undefined : e => onChange(e.target.checked)}
        className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500/20 disabled:opacity-60"
      />
      <span className={`flex-1 text-sm font-semibold ${locked ? 'text-slate-500' : 'text-slate-900'}`}>
        {label}
      </span>
      {locked && (
        <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
          Always on
        </span>
      )}
    </li>
  );
}
