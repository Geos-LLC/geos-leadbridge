/**
 * Settings → AI Playbook — V2.
 *
 * V2 contract: Playbook is HOW, Automation is WHEN.
 *   - 8 HOW sections: business_information, pricing_guidance,
 *     qualification_guidance, booking_guidance, objection_handling,
 *     human_handoff_guidance, followup_tone, personality_brand_voice.
 *     Each card: collapsible default prompt + custom instructions textarea.
 *     Storage: SavedAccount.followUpSettingsJson.aiPlaybookV2[key].customInstructions
 *
 *   - 1 FAQ section: embeds the existing AccountFaqForm. Storage:
 *     SavedAccount.faqJson (UNCHANGED runtime field).
 *
 *   - 1 Global Custom Instructions section: surfaces User.globalAiPrompt
 *     (the existing tenant-wide field). UNCHANGED runtime field.
 *
 * No new data stores. The runtime AI prompt still reads globalAiPrompt as
 * the GLOBAL block, faqJson as REFERENCE: ACCOUNT FAQ, and the V2 storage
 * via the layered renderer (BASE HARD RULES + AI PLAYBOOK).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Info, Loader2, Sparkles, Building, CircleDollarSign, ListChecks,
  Calendar, Shield, PhoneCall, Send, User as UserIcon, Globe, BookOpen,
  ChevronDown, ChevronUp, RefreshCw, Pencil, CheckCircle,
  type LucideIcon,
} from 'lucide-react';
import { SectionCard, StatusPill } from '../../components/automation/ui';
import { followUpApi, usersApi } from '../../services/api';
import { useAppStore } from '../../store/appStore';
import { notify } from '../../store/notificationStore';
import AccountFaqForm from '../../components/AccountFaqForm';
import ServicePricingForm from '../../components/ServicePricingForm';
import {
  PLAYBOOK_SECTION_UI_LABELS,
  PLAYBOOK_SECTION_SUBTITLES,
  SECTION_DEFAULT_PROMPTS,
  INSTRUCTION_LENGTH_SOFT,
  INSTRUCTION_LENGTH_WARN,
  type PlaybookSectionKey,
  type PlaybookV2Storage,
} from '../../lib/playbook-renderer';

const SECTION_ICONS: Record<PlaybookSectionKey, LucideIcon> = {
  business_information:   Building,
  pricing_guidance:       CircleDollarSign,
  qualification_guidance: ListChecks,
  booking_guidance:       Calendar,
  objection_handling:     Shield,
  human_handoff_guidance: PhoneCall,
  followup_tone:          Send,
  personality_brand_voice: UserIcon,
};

export function SettingsAiPlaybook() {
  const accounts = useAppStore(s => s.savedAccounts);

  // Advanced/legacy mode (?advanced=1 or ?debug=1) — exposes the 5 legacy
  // sections (Qualification, Booking, Handoff, Objection Handling,
  // Follow-up Tone) that still emit at runtime via the backend renderer
  // but are no longer part of the normal Playbook UI. Each carries a
  // "preserved for compatibility" badge so it's obvious they're legacy.
  const [searchParams] = useSearchParams();
  const advancedMode =
    searchParams.get('advanced') === '1' ||
    searchParams.get('debug') === '1';
  const [v2, setV2] = useState<PlaybookV2Storage>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef<Set<PlaybookSectionKey>>(new Set());

  // Auto-clear "Saved" pill
  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(null), 2000);
    return () => clearTimeout(t);
  }, [savedAt]);

  // Load aiPlaybookV2 from the first connected account (Playbook is shared
  // across all accounts in V1 — save fans out to every account below).
  useEffect(() => {
    let alive = true;
    if (accounts.length === 0) { setLoading(false); return; }
    setLoading(true); setError(null);
    followUpApi.getSettings(accounts[0].id).then((res: { settings?: Record<string, unknown> | null }) => {
      if (!alive) return;
      const settings = res?.settings;
      const raw = settings && typeof settings === 'object'
        ? (settings as Record<string, unknown>).aiPlaybookV2
        : null;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        setV2(raw as PlaybookV2Storage);
      } else {
        setV2({});
      }
    }).catch((e: { message?: string }) => {
      if (alive) setError(e?.message ?? 'Failed to load Playbook');
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts]);

  const onSectionChange = (section: PlaybookSectionKey, value: string) => {
    dirtyRef.current.add(section);
    // Editing implicitly clears `suggestedFromWebsite` — the user is taking
    // ownership of this section. The badge above the card disappears as
    // soon as `suggestedFromWebsite` flips to false in local state, and the
    // save fan-out writes the cleared flag back to every account.
    setV2(prev => ({ ...prev, [section]: { customInstructions: value, suggestedFromWebsite: false } }));
  };

  const handleSave = async () => {
    if (dirtyRef.current.size === 0 || accounts.length === 0) return;
    setSaving(true); setError(null);
    const payload = { aiPlaybookV2: v2 };
    try {
      await Promise.all(
        accounts.map(a => followUpApi.saveWizardSettings(a.id, payload).catch(() => undefined)),
      );
      dirtyRef.current = new Set();
      setSavedAt(Date.now());
    } catch (e) {
      const msg = (e as { message?: string })?.message;
      setError(msg ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const hasDirty = dirtyRef.current.size > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error && <StatusPill status="error" message={error} />}
      {!error && saving && <StatusPill status="saving" />}
      {!error && !saving && savedAt && <StatusPill status="saved" />}
      {!error && !savedAt && loading && <StatusPill status="loading" />}

      <HelpBlock />

      {accounts.length === 0 && (
        <SectionCard padding="22px 24px">
          <div style={{ fontSize: 14, color: 'var(--lb-ink-3)' }}>
            Connect a lead source first (Settings → Connected Sources) to start customizing your Playbook.
          </div>
        </SectionCard>
      )}

      {/* === Cards rendered in Playbook V2.4 order — simplified to 5 ===
            Workflow-logic sections (Qualification, Booking, Human Handoff,
            Phone Call) live in Automation → AI Conversation Goals; their
            backend default prompts still emit at runtime so behavior is
            unchanged. The Objection Handling + Follow-up Tone sections
            are folded into Pricing Guidance + Communication Style at
            content-application time (see playbook-seed-applier.ts) and
            their UI cards are hidden so users see one canonical home for
            each piece of behavior. No backend deletions — every backend
            section key still exists; only the UI surface narrows.

            Visible cards (5 total):
              1. Business Information
              2. FAQ
              3. Pricing Guidance (with embedded Pricing Table)
              4. Communication Style & Brand Voice
                 (backend key: personality_brand_voice)
              5. Global Custom Instructions */}

      {accounts.length > 0 && <>
        {/* 1. Business Information */}
        <HowSectionCard
          section="business_information"
          value={v2.business_information?.customInstructions ?? ''}
          onChange={v => onSectionChange('business_information', v)}
          isSuggested={!!v2.business_information?.suggestedFromWebsite}
        />

        {/* 2. FAQ */}
        <FaqCard
          accountId={accounts[0].id}
          accountName={accounts[0].businessName ?? accounts[0].platform ?? 'Your account'}
          accountIds={accounts.map(a => a.id)}
        />

        {/* 3. Pricing Guidance (with embedded Pricing Table) */}
        <PricingGuidanceCard
          value={v2.pricing_guidance?.customInstructions ?? ''}
          onChange={v => onSectionChange('pricing_guidance', v)}
          accountId={accounts[0].id}
          accountName={accounts[0].businessName ?? accounts[0].platform ?? 'Your account'}
          accountIds={accounts.map(a => a.id)}
          isSuggested={!!v2.pricing_guidance?.suggestedFromWebsite}
        />

        {/* === Advanced legacy sections — only when ?advanced=1 / ?debug=1 ===
              These 5 backend section keys still emit their default prompts
              at runtime via src/ai/section-default-prompts.ts; the textareas
              accept user customInstructions and the runtime renderer still
              reads them. They're hidden from the normal user UI because
              workflow logic now lives in Automation → AI Conversation
              Goals and tone/follow-up logic folded into the visible
              Communication Style card below. Advanced/support users can
              still hand-tune the underlying prompts here. */}
        {advancedMode && (
          <>
            <AdvancedSectionsBanner />
            <HowSectionCard
              section="qualification_guidance"
              value={v2.qualification_guidance?.customInstructions ?? ''}
              onChange={v => onSectionChange('qualification_guidance', v)}
              legacyAdvanced
            />
            <HowSectionCard
              section="booking_guidance"
              value={v2.booking_guidance?.customInstructions ?? ''}
              onChange={v => onSectionChange('booking_guidance', v)}
              legacyAdvanced
              isSuggested={!!v2.booking_guidance?.suggestedFromWebsite}
            />
            <HowSectionCard
              section="human_handoff_guidance"
              value={v2.human_handoff_guidance?.customInstructions ?? ''}
              onChange={v => onSectionChange('human_handoff_guidance', v)}
              legacyAdvanced
              isSuggested={!!v2.human_handoff_guidance?.suggestedFromWebsite}
            />
            <HowSectionCard
              section="objection_handling"
              value={v2.objection_handling?.customInstructions ?? ''}
              onChange={v => onSectionChange('objection_handling', v)}
              legacyAdvanced
              isSuggested={!!v2.objection_handling?.suggestedFromWebsite}
            />
            <HowSectionCard
              section="followup_tone"
              value={v2.followup_tone?.customInstructions ?? ''}
              onChange={v => onSectionChange('followup_tone', v)}
              legacyAdvanced
            />
          </>
        )}

        {/* 4. Communication Style & Brand Voice
              (backend key still personality_brand_voice — see
              frontend/src/lib/playbook-renderer.ts label mapping). */}
        <HowSectionCard
          section="personality_brand_voice"
          value={v2.personality_brand_voice?.customInstructions ?? ''}
          onChange={v => onSectionChange('personality_brand_voice', v)}
          isSuggested={!!v2.personality_brand_voice?.suggestedFromWebsite}
        />

        {/* 5. Global Custom Instructions — surfaces User.globalAiPrompt */}
        <GlobalCustomInstructionsCard />
      </>}

      {/* Footer save button */}
      {accounts.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, alignItems: 'center' }}>
          {accounts.length > 1 && (
            <span style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginRight: 'auto' }}>
              Custom instructions apply to all {accounts.length} connected accounts.
            </span>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={!hasDirty || saving}
            style={{
              padding: '10px 18px', fontSize: 13.5, fontWeight: 600,
              background: hasDirty ? 'var(--lb-accent)' : '#cbd5e1',
              color: 'white', border: 0, borderRadius: 10,
              cursor: hasDirty && !saving ? 'pointer' : 'not-allowed',
              fontFamily: 'inherit',
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? 'Saving…' : hasDirty ? 'Save Playbook' : 'No changes'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Help block ───────────────────────────────────────────────────────────

function HelpBlock() {
  return (
    <SectionCard padding="18px 22px">
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flexShrink: 0, paddingTop: 2 }}>
          <Info size={18} style={{ color: 'var(--lb-accent)' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--lb-ink-1)', marginBottom: 6 }}>
            AI Playbook controls HOW AI communicates
          </div>
          <div style={{ fontSize: 13, color: 'var(--lb-ink-3)', lineHeight: 1.55 }}>
            <a href="/automation/convert" style={{ color: 'var(--lb-accent)', fontWeight: 600 }}>Automation → AI Conversation</a> controls <em>WHAT</em> AI is trying to achieve and <em>WHEN</em> conversations are handed to your team.
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

// ─── HOW section card — generic for the HOW sections ─────────────────────

function HowSectionCard({
  section, value, onChange, managedByGoals, isSuggested, legacyAdvanced,
}: {
  section: PlaybookSectionKey;
  value: string;
  onChange: (v: string) => void;
  /** When true, render a "Managed with Conversation Goals, still used by AI."
   *  badge at the top of the card. The customInstructions textarea remains
   *  editable since these prompts continue to take effect at runtime — the
   *  Goal-level setup in Automation just controls WHEN/WHAT, not HOW. */
  managedByGoals?: boolean;
  /** Set by the website Apply-to-Playbook flow. Shows the "Suggested from
   *  website" pill. Goes away on first edit (parent clears the flag). */
  isSuggested?: boolean;
  /** Render the section with an "Advanced — preserved for compatibility"
   *  badge, used for the 5 legacy sections exposed only in ?advanced=1
   *  mode (qualification_guidance, booking_guidance, etc.). The textarea
   *  is fully editable; behavior is unchanged. */
  legacyAdvanced?: boolean;
}) {
  const Icon = SECTION_ICONS[section];
  return (
    <PlaybookSectionShell
      icon={Icon}
      title={PLAYBOOK_SECTION_UI_LABELS[section]}
      subtitle={PLAYBOOK_SECTION_SUBTITLES[section]}
    >
      {isSuggested && <SuggestedFromWebsiteBadge />}
      {managedByGoals && <ManagedByGoalsBadge />}
      {legacyAdvanced && <LegacyAdvancedBadge />}
      <DefaultPromptExpander text={SECTION_DEFAULT_PROMPTS[section]} />
      <CustomInstructionsEditor
        value={value}
        defaultText={SECTION_DEFAULT_PROMPTS[section]}
        onChange={onChange}
        onRevertToDefault={() => onChange('')}
      />
    </PlaybookSectionShell>
  );
}

function LegacyAdvancedBadge() {
  return (
    <div style={{
      marginBottom: 12,
      padding: '8px 12px',
      background: '#fef3c7',
      border: '1px solid #fde68a',
      borderRadius: 8,
      fontSize: 12, color: '#92400e',
      display: 'flex', alignItems: 'center', gap: 8,
      lineHeight: 1.4,
    }}>
      <Info size={13} style={{ flexShrink: 0 }} />
      <span><strong>Advanced prompt section</strong> — preserved for compatibility. Still emitted at runtime; edit only if you know what you need.</span>
    </div>
  );
}

function AdvancedSectionsBanner() {
  return (
    <SectionCard padding="14px 20px">
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <Info size={16} style={{ color: '#92400e', flexShrink: 0, marginTop: 2 }} />
        <div style={{ fontSize: 13, color: 'var(--lb-ink-3)', lineHeight: 1.55 }}>
          <strong>Advanced legacy sections.</strong> These prompt sections still emit at runtime but are no longer part of the normal Playbook UI. Their workflow logic now lives in <a href="/automation/convert" style={{ color: 'var(--lb-accent)', fontWeight: 600 }}>Automation → AI Conversation Goals</a>. Edit below only for support / power-user tuning.
        </div>
      </div>
    </SectionCard>
  );
}

function SuggestedFromWebsiteBadge() {
  return (
    <div style={{
      marginBottom: 12,
      padding: '8px 12px',
      background: '#fef7f0',
      border: '1px solid #fde0c8',
      borderRadius: 8,
      fontSize: 12, color: '#9a5b1e',
      display: 'flex', alignItems: 'center', gap: 8,
      lineHeight: 1.4,
    }}>
      <Sparkles size={13} style={{ flexShrink: 0, color: '#c8771b' }} />
      <span><strong>✨ Suggested from website</strong> — review and edit. Your changes replace this suggestion.</span>
    </div>
  );
}

function ManagedByGoalsBadge() {
  return (
    <div style={{
      marginBottom: 12,
      padding: '8px 12px',
      background: '#eff6ff',
      border: '1px solid #c3d4ff',
      borderRadius: 8,
      fontSize: 12, color: 'var(--lb-accent)',
      display: 'flex', alignItems: 'center', gap: 8,
      lineHeight: 1.4,
    }}>
      <Info size={13} style={{ flexShrink: 0 }} />
      <span><strong>Managed with Conversation Goals</strong>, still used by AI. The WHEN/WHAT for this scenario is configured in <a href="/automation/convert" style={{ color: 'var(--lb-accent)', fontWeight: 600 }}>Automation → AI Conversation</a>. The HOW (wording / tone) below still takes effect at runtime.</span>
    </div>
  );
}

// ─── Pricing Guidance — HOW textarea + ServicePricingForm embed ──────────

function PricingGuidanceCard({
  value, onChange, accountId, accountName, accountIds, isSuggested,
}: {
  value: string;
  onChange: (v: string) => void;
  accountId: string;
  accountName: string;
  accountIds: string[];
  isSuggested?: boolean;
}) {
  return (
    <PlaybookSectionShell
      icon={CircleDollarSign}
      title={PLAYBOOK_SECTION_UI_LABELS.pricing_guidance}
      subtitle={PLAYBOOK_SECTION_SUBTITLES.pricing_guidance}
    >
      {isSuggested && <SuggestedFromWebsiteBadge />}
      <DefaultPromptExpander text={SECTION_DEFAULT_PROMPTS.pricing_guidance} />
      <CustomInstructionsEditor
        value={value}
        defaultText={SECTION_DEFAULT_PROMPTS.pricing_guidance}
        onChange={onChange}
        onRevertToDefault={() => onChange('')}
      />
      <div style={{
        marginTop: 18, padding: '14px 16px',
        background: '#f8fafc',
        border: '1px solid var(--lb-line-soft)',
        borderRadius: 10,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, color: 'var(--lb-ink-5)',
          letterSpacing: 0.06, textTransform: 'uppercase', marginBottom: 10,
          fontFamily: 'var(--lb-font-mono)',
        }}>
          Pricing table — the source AI uses for actual numbers
        </div>
        <ServicePricingForm
          accountId={accountId}
          accountName={accountName}
          saveToAll={accountIds}
        />
      </div>
    </PlaybookSectionShell>
  );
}

// ─── FAQ — embed AccountFaqForm ──────────────────────────────────────────

function FaqCard({
  accountId, accountName, accountIds,
}: {
  accountId: string;
  accountName: string;
  accountIds: string[];
}) {
  return (
    <PlaybookSectionShell
      icon={BookOpen}
      title="FAQ"
      subtitle="Verified answers AI uses verbatim for common customer questions."
    >
      <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginBottom: 14, lineHeight: 1.5 }}>
        AI uses these answers when the customer asks a covered question. If a question isn't covered, AI defers to the team rather than guess.
      </div>
      <AccountFaqForm
        accountId={accountId}
        accountName={accountName}
        saveToAll={accountIds}
      />
    </PlaybookSectionShell>
  );
}

// ─── Global Custom Instructions — surfaces User.globalAiPrompt ───────────

function GlobalCustomInstructionsCard() {
  const [prompt, setPrompt] = useState('');
  const [isDefault, setIsDefault] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    usersApi.getGlobalAiPrompt()
      .then(res => { setPrompt(res.prompt); setIsDefault(res.isDefault); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await usersApi.updateGlobalAiPrompt(prompt);
      setIsDefault(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      notify.error('Error', 'Failed to save global instructions');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    try {
      await usersApi.updateGlobalAiPrompt('');
      const res = await usersApi.getGlobalAiPrompt();
      setPrompt(res.prompt);
      setIsDefault(true);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      notify.error('Error', 'Failed to reset');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;

  return (
    <PlaybookSectionShell
      icon={Globe}
      title="Global Custom Instructions"
      subtitle={isDefault
        ? 'Tenant-wide guidance applied to every AI auto-reply (using shipped default).'
        : 'Tenant-wide guidance applied to every AI auto-reply (customized).'}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 10px', border: '1px solid var(--lb-line)',
            borderRadius: 8, background: 'white', cursor: 'pointer',
            fontSize: 12, fontWeight: 600, color: 'var(--lb-ink-3)',
            fontFamily: 'inherit',
          }}
        >
          {expanded ? <>Collapse <ChevronUp size={14} /></> : <>View / edit ({prompt.length.toLocaleString()} chars) <ChevronDown size={14} /></>}
        </button>
        <span style={{
          fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 999,
          background: isDefault ? '#f1f5f9' : '#dcfce7',
          color:      isDefault ? '#475569' : '#15803d',
          letterSpacing: 0.05, textTransform: 'uppercase', fontFamily: 'var(--lb-font-mono)',
        }}>
          {isDefault ? 'Default' : 'Customized'}
        </span>
      </div>

      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <textarea
            value={prompt}
            onChange={e => { setPrompt(e.target.value); setDirty(true); setSaved(false); }}
            readOnly={!editing}
            rows={14}
            style={{
              width: '100%', boxSizing: 'border-box',
              border: '1px solid ' + (editing ? '#93c5fd' : 'var(--lb-line)'),
              borderRadius: 10, padding: 12,
              fontSize: 12,
              fontFamily: 'var(--lb-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
              lineHeight: 1.55,
              background: editing ? 'white' : '#f8fafc',
              color: 'var(--lb-ink-1)',
              outline: 'none', resize: 'vertical',
              boxShadow: editing ? '0 0 0 3px rgba(59,130,246,0.12)' : 'none',
            }}
          />
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            {!editing ? (
              <button type="button" onClick={() => setEditing(true)} style={btnSecondary()}>
                <Pencil size={13} /> Edit
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={saving || !dirty}
                  onClick={async () => { await handleSave(); setEditing(false); setDirty(false); }}
                  style={btnPrimary(saving || !dirty)}
                >
                  {saving ? <Loader2 size={13} className="animate-spin" /> : saved ? <CheckCircle size={13} /> : null}
                  {saved ? 'Saved' : 'Save'}
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    setEditing(false); setDirty(false);
                    usersApi.getGlobalAiPrompt().then(r => { setPrompt(r.prompt); setIsDefault(r.isDefault); });
                  }}
                  style={btnSecondary(saving)}
                >
                  Cancel
                </button>
                {!isDefault && (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={async () => { await handleReset(); setEditing(false); setDirty(false); }}
                    style={btnGhostDanger(saving)}
                  >
                    <RefreshCw size={13} /> Reset to default
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </PlaybookSectionShell>
  );
}

// ─── Building blocks ──────────────────────────────────────────────────────

function PlaybookSectionShell({
  icon: Icon, title, subtitle, children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <SectionCard padding="22px 24px">
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 14 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: '#ede9fe', color: '#6d28d9',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <Icon size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
            {title}
          </div>
          {subtitle && (
            <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 4, lineHeight: 1.5 }}>
              {subtitle}
            </div>
          )}
        </div>
      </div>
      {children}
    </SectionCard>
  );
}

function DefaultPromptExpander({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ marginBottom: 14 }}>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        style={{
          background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
          fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600,
          color: 'var(--lb-accent)',
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}
      >
        {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        {expanded ? 'Hide default prompt' : 'View default prompt'}
      </button>
      {expanded && (
        <div style={{
          marginTop: 8,
          padding: '10px 12px',
          background: '#f8fafc',
          border: '1px solid var(--lb-line-soft)',
          borderRadius: 8,
          fontSize: 12.5, color: 'var(--lb-ink-2)',
          lineHeight: 1.55,
        }}>
          {text}
        </div>
      )}
    </div>
  );
}

function CustomInstructionsEditor({
  value, defaultText, onChange, onRevertToDefault,
}: {
  value: string;
  defaultText: string;
  onChange: (v: string) => void;
  onRevertToDefault: () => void;
}) {
  const chars = value.length;
  const overSoft = chars >= INSTRUCTION_LENGTH_SOFT;
  const overWarn = chars >= INSTRUCTION_LENGTH_WARN;
  const isUsingDefault = value.trim().length === 0;
  const counterColor = overWarn ? '#b91c1c' : overSoft ? '#d97706' : 'var(--lb-ink-6)';

  // Used for placeholder
  const placeholder = useMemo(() => {
    const lines = defaultText.split('. ').slice(0, 2).join('. ');
    return `Add custom instructions to refine this section…\n\nDefault behavior:\n${lines.slice(0, 200)}…`;
  }, [defaultText]);

  return (
    <div>
      <div style={{
        fontSize: 11, fontWeight: 700, color: 'var(--lb-ink-5)',
        letterSpacing: 0.06, textTransform: 'uppercase', marginBottom: 8,
        fontFamily: 'var(--lb-font-mono)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      }}>
        <span>Custom instructions {isUsingDefault && <span style={{
          marginLeft: 8, fontSize: 9.5, color: '#475569',
          background: '#f1f5f9', padding: '2px 6px', borderRadius: 999,
        }}>using default</span>}</span>
        {(overSoft || chars > 0) && (
          <span style={{ color: counterColor, fontFamily: 'var(--lb-font-mono)', fontSize: 10.5 }}>
            {chars.toLocaleString()}{overSoft ? ` / ~${INSTRUCTION_LENGTH_WARN.toLocaleString()}` : ''}
          </span>
        )}
      </div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={5}
        style={{
          width: '100%', boxSizing: 'border-box',
          padding: '10px 12px',
          border: '1px solid ' + (overWarn ? '#fca5a5' : overSoft ? '#fcd34d' : 'var(--lb-line)'),
          borderRadius: 8,
          fontFamily: 'inherit', fontSize: 13, lineHeight: 1.55,
          color: 'var(--lb-ink-1)', background: 'white',
          resize: 'vertical', minHeight: 90,
        }}
      />
      {!isUsingDefault && (
        <div style={{ marginTop: 6, textAlign: 'right' }}>
          <button
            type="button"
            onClick={onRevertToDefault}
            style={{
              background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600,
              color: 'var(--lb-ink-5)',
            }}
          >
            Revert to default ↺
          </button>
        </div>
      )}
      {overWarn && (
        <div style={{
          marginTop: 8,
          padding: '8px 10px',
          background: '#fef3c7',
          border: '1px solid #fde68a',
          borderRadius: 6,
          fontSize: 12, color: '#92400e',
          lineHeight: 1.45,
        }}>
          ⚠ Large instructions may make AI responses less consistent.<br />
          Consider splitting into specific scenarios or trimming to essentials.
        </div>
      )}
    </div>
  );
}

function btnPrimary(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '7px 14px', fontSize: 12.5, fontWeight: 600,
    background: disabled ? '#cbd5e1' : 'var(--lb-accent)', color: 'white',
    border: 0, borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit', opacity: disabled ? 0.7 : 1,
  };
}
function btnSecondary(disabled = false): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '7px 14px', fontSize: 12.5, fontWeight: 600,
    background: 'white', color: 'var(--lb-ink-2)',
    border: '1px solid var(--lb-line)', borderRadius: 8,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit', opacity: disabled ? 0.7 : 1,
  };
}
function btnGhostDanger(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '7px 14px', fontSize: 12.5, fontWeight: 600,
    background: 'transparent', color: '#b91c1c',
    border: 0, cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit', opacity: disabled ? 0.7 : 1,
  };
}

// Suppress the unused Sparkles import warning since iconography may evolve.
void Sparkles;
