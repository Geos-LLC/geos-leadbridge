import { ArrowRight, CheckCircle2, Circle, Rocket, SkipForward } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi, onboardingApi } from '../../services/api';
import { useAppStore } from '../../store/appStore';
import { useAuthStore } from '../../store/authStore';
import type { OnboardingConfigSummary, OnboardingProfile, WizardChecklist, WizardStep } from '../../types';
import { ACTIONABLE_STEPS, FIRST_ACTIONABLE_STEP, WIZARD_STEP_META } from './wizardConfig';

// Steps that go stale when their underlying data disappears. These
// each write their configuration into per-account JSON on
// SavedAccount (faqJson.quickFacts / servicePricingJson /
// followUpSettingsJson), so a SavedAccount cascade-delete also wipes
// what the step represented. Connect + Business are handled
// separately because their completion signal IS the data itself
// (SavedAccount existence / User.website).
const ACCOUNT_DATA_STEPS: WizardStep[] = ['ai', 'pricing', 'automation', 'ai_rules'];

export interface DisplayChecklistContext {
  /** Count of SavedAccount rows owned by the current user. */
  accountCount: number;
  /** Whether the user has a non-empty website on file. */
  hasWebsite: boolean;
  /**
   * Per-step config rollup from the backend
   * (`GET /v1/onboarding/config-summary`). When provided, the four
   * "stored-only" steps (ai / pricing / automation / ai_rules) become
   * data-driven too: configured-in-Settings shows green without the
   * user having to re-walk the wizard, and deleted-from-Settings
   * removes the tick. Optional so legacy callers that haven't been
   * updated still type-check; in that mode the four steps fall back
   * to the stored checklist as before.
   */
  configSummary?: OnboardingConfigSummary | null;
}

// Derive the displayed checklist from the persisted wizard state +
// live "what data does the user actually have?" signals. Wizard
// progress is derived state; the underlying settings ARE the source
// of truth, the stored checklist is just a UX cache.
//
// Per-step rules:
//
//   connect    — data-driven from accountCount.
//   business   — data-driven from hasWebsite.
//   ai         — data-driven from configSummary.faqConfigured.
//   pricing    — data-driven from configSummary.pricingConfigured.
//   automation — data-driven from configSummary.automationConfigured.
//   ai_rules   — data-driven from configSummary.aiRulesConfigured.
//
// 'skipped' is always preserved — an explicit user "do this later"
// shouldn't be silently un-skipped by data appearing. The same
// principle the connect/business derivation already followed; now
// uniformly applied across all six actionable steps.
//
// When data is gone (account deleted, FAQ wiped, etc.) the stored
// 'done' is dropped so the rail reflects reality. Connect dropping
// to 0 also cascade-drops the per-account JSON steps because their
// underlying data was cascade-wiped with the SavedAccount.
export function deriveDisplayChecklist(
  stored: WizardChecklist,
  ctx: DisplayChecklistContext | number,
): WizardChecklist {
  // Back-compat: older callers passed accountCount as a bare number.
  const context: DisplayChecklistContext =
    typeof ctx === 'number'
      ? { accountCount: ctx, hasWebsite: true /* legacy callers — don't second-guess */ }
      : ctx;

  const copy: WizardChecklist = { ...stored };

  // Connect: data-driven from accountCount. When the user has at
  // least one SavedAccount, the step IS done — even if they
  // previously clicked "Skip this step". 'skipped' is a "do it
  // later" deferral, and doing it later is what just happened. Hard
  // data wins.
  //
  // When accountCount is back to 0 we drop a stale stored 'done'
  // (the data behind it is gone) but preserve a stored 'skipped'
  // so the user's earlier "I'll handle this later" intent is still
  // visible on the rail.
  if (context.accountCount > 0) {
    copy.connect = 'done';
  } else {
    if (copy.connect === 'done') delete copy.connect;
    // Per-account JSON steps: their data was cascade-wiped with
    // the SavedAccount. Drop their stored 'done' too; keep
    // 'skipped' for the same reason as above.
    for (const step of ACCOUNT_DATA_STEPS) {
      if (copy[step] === 'done') delete copy[step];
    }
  }

  // Business: same data-wins-over-skip logic, tied to User.website.
  if (context.hasWebsite) {
    copy.business = 'done';
  } else if (copy.business === 'done') {
    delete copy.business;
  }

  // ai / pricing / automation / ai_rules — derive from the backend
  // config summary when available. Skipped survives (explicit user
  // choice); otherwise data presence flips the tick green and data
  // absence drops a stale stored 'done'.
  //
  // When summary is missing (haven't fetched yet, or pre-update
  // caller), leave the stored checklist alone so we don't flicker
  // the tick off on mount.
  const summary = context.configSummary;
  if (summary) {
    applyDataDerivation(copy, 'ai', summary.faqConfigured);
    applyDataDerivation(copy, 'pricing', summary.pricingConfigured);
    applyDataDerivation(copy, 'automation', summary.automationConfigured);
    applyDataDerivation(copy, 'ai_rules', summary.aiRulesConfigured);
  }

  return copy;
}

// Apply the data-derivation rule to one step: skipped wins, otherwise
// data presence promotes to 'done' and data absence drops 'done'.
function applyDataDerivation(
  copy: WizardChecklist,
  step: WizardStep,
  configured: boolean,
): void {
  if (copy[step] === 'skipped') return;
  if (configured) {
    copy[step] = 'done';
  } else if (copy[step] === 'done') {
    delete copy[step];
  }
}

// Setup-progress card shown on Overview. Only renders when the user
// hasn't yet completed the 8-step wizard. The middle six steps
// (connect / business / ai / pricing / automation / ai_rules) are the
// ones that count toward the "X of N complete" progress bar — welcome
// and done are flow-control, not real setup tasks.
export default function SetupProgressCard() {
  const navigate = useNavigate();
  const user = useAuthStore(s => s.user);
  const setAuth = useAuthStore(s => s.setAuth);
  // Fetch a fresh profile + auth-user on mount so the card reflects
  // whatever the user did during the wizard, even when the persisted
  // authStore snapshot is stale (e.g. after a soft refresh). We seed
  // from the store so the card renders immediately and the fetch just
  // patches any drift. /auth/profile also gives us the live
  // user.website so the business step doesn't lie about being "done"
  // when the actual URL was cleared.
  const [profile, setProfile] = useState<OnboardingProfile | null>(user?.onboardingProfile ?? null);
  const [website, setWebsite] = useState<string | null>(user?.website ?? null);
  // Backend config rollup for ai / pricing / automation / ai_rules. Null
  // until the first fetch completes; deriveDisplayChecklist treats null
  // as "fall back to stored checklist" so the card doesn't flicker.
  const [configSummary, setConfigSummary] = useState<OnboardingConfigSummary | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      onboardingApi.getProfile(),
      authApi.getProfile().catch(() => null),
      onboardingApi.getConfigSummary().catch(() => null),
    ])
      .then(([profileRes, freshUser, summaryRes]) => {
        if (cancelled) return;
        if (profileRes?.profile) setProfile(profileRes.profile);
        if (freshUser) setWebsite(freshUser.website ?? null);
        if (summaryRes?.summary) setConfigSummary(summaryRes.summary);
        // Sync persisted auth user so other listeners see the same
        // checklist + website state next render.
        if (user && (profileRes?.profile || freshUser)) {
          const token = localStorage.getItem('token') || '';
          setAuth(
            {
              ...user,
              ...(profileRes?.profile ? { onboardingProfile: profileRes.profile } : {}),
              ...(freshUser ? { website: freshUser.website ?? null, websiteMetadataJson: freshUser.websiteMetadataJson ?? null } : {}),
            },
            token,
          );
        }
      })
      .catch(() => { /* non-fatal — use the seeded value */ });
    return () => { cancelled = true; };
    // Intentionally not depending on user/setAuth — we only want this
    // to fire on Dashboard mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const savedAccounts = useAppStore(s => s.savedAccounts);

  const { completedCount, totalCount, percent, items, hasStarted, isComplete, nextStep } = useMemo(() => {
    const stored: WizardChecklist = profile?.wizardChecklistStatus ?? {};
    const checklist = deriveDisplayChecklist(stored, {
      accountCount: savedAccounts.length,
      hasWebsite: !!website && website.trim().length > 0,
      configSummary,
    });
    const total = ACTIONABLE_STEPS.length;
    const completed = ACTIONABLE_STEPS.filter(s => checklist[s] === 'done').length;
    const itemList = WIZARD_STEP_META.filter(m => m.countsTowardChecklist).map(m => ({
      step: m.slug,
      label: m.label,
      status: checklist[m.slug],
    }));
    const started = !!profile?.wizardStartedAt;
    const complete = !!profile?.wizardCompletedAt;
    // Best step to resume at: the user's last-known current step if it
    // still maps onto something actionable; otherwise the first
    // actionable step that isn't done/skipped. 'welcome' is legacy and
    // no longer a real step — treat it as "not started yet".
    const current = profile?.wizardCurrentStep as WizardStep | undefined;
    const fallbackNext = ACTIONABLE_STEPS.find(s => checklist[s] !== 'done' && checklist[s] !== 'skipped');
    const next = current && current !== 'welcome' && current !== 'done' ? current : (fallbackNext ?? FIRST_ACTIONABLE_STEP);
    return {
      completedCount: completed,
      totalCount: total,
      percent: Math.round((completed / total) * 100),
      items: itemList,
      hasStarted: started,
      isComplete: complete,
      nextStep: next,
    };
  }, [profile, savedAccounts.length, website, configSummary]);

  // Don't render once setup is fully complete — the card is meant as a
  // prompt to finish, not a permanent fixture.
  if (isComplete) return null;

  return (
    <div
      className="rounded-2xl border p-5 md:p-6 flex flex-col md:flex-row items-start md:items-center gap-5"
      style={{
        background: 'linear-gradient(135deg, rgba(37,99,235,0.06), rgba(37,99,235,0.02))',
        borderColor: 'rgba(37,99,235,0.18)',
      }}
    >
      <div
        className="w-12 h-12 shrink-0 rounded-2xl inline-flex items-center justify-center text-white"
        style={{ background: 'var(--lb-accent)' }}
      >
        <Rocket className="w-6 h-6" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <h3 className="text-base font-extrabold text-slate-900 tracking-tight">
            {hasStarted ? 'Finish setting up LeadBridge' : 'Complete your LeadBridge setup'}
          </h3>
          <span className="text-xs font-bold text-blue-700">
            {completedCount} of {totalCount} done · {percent}%
          </span>
        </div>
        <div className="mt-2 h-1.5 w-full bg-blue-100 rounded-full overflow-hidden">
          <div className="h-full bg-blue-600 transition-all duration-300" style={{ width: `${percent}%` }} />
        </div>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {items.map(({ step, label, status }) => {
            const done = status === 'done';
            const skipped = status === 'skipped';
            return (
              <li
                key={step}
                className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
                  done ? 'text-emerald-700' : skipped ? 'text-slate-400' : 'text-slate-500'
                }`}
              >
                {done ? (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                ) : skipped ? (
                  <SkipForward className="w-3.5 h-3.5" />
                ) : (
                  <Circle className="w-3.5 h-3.5" />
                )}
                {label}
              </li>
            );
          })}
        </ul>
      </div>

      <button
        onClick={() => navigate('/onboarding/setup')}
        className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl shadow-md shadow-blue-200 transition-all shrink-0"
        title={hasStarted ? `Resume at ${nextStep}` : 'Start setup'}
      >
        {hasStarted ? 'Continue setup' : 'Start setup'}
        <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
}
