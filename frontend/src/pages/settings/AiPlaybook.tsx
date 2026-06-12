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
    setV2(prev => ({ ...prev, [section]: { customInstructions: value } }));
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

      {/* === Cards rendered in explicit Playbook V2.1 order ===
            1. Business Information (HOW)
            2. FAQ (embed)
            3. Pricing Guidance (HOW + Pricing Table embed)
            4. Qualification Guidance (HOW)
            5. Booking Guidance (HOW)
            6. Phone Call Guidance (planned — UI preview, no save)
            7. Objection Handling (HOW)
            8. Human Handoff Guidance (HOW)
            9. Follow-up Tone (HOW)
           10. AI Personality & Brand Voice (HOW)
           11. Global Custom Instructions (User.globalAiPrompt)

            PLAYBOOK_SECTION_ORDER stays canonical for backend prompt
            assembly — we just choose UI ordering here. */}

      {accounts.length > 0 && <>
        {/* 1. Business Information */}
        <HowSectionCard
          section="business_information"
          value={v2.business_information?.customInstructions ?? ''}
          onChange={v => onSectionChange('business_information', v)}
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
        />

        {/* 4. Qualification Guidance */}
        <HowSectionCard
          section="qualification_guidance"
          value={v2.qualification_guidance?.customInstructions ?? ''}
          onChange={v => onSectionChange('qualification_guidance', v)}
        />

        {/* 5. Booking Guidance */}
        <HowSectionCard
          section="booking_guidance"
          value={v2.booking_guidance?.customInstructions ?? ''}
          onChange={v => onSectionChange('booking_guidance', v)}
        />

        {/* 6. Phone Call Guidance — PLANNED section. UI preview only;
              no backend key yet so this card does not save. Once the
              backend renderer ships a `phone_call_guidance` section key,
              this becomes a real <HowSectionCard />. */}
        <PhoneCallGuidancePlannedCard />

        {/* 7. Objection Handling */}
        <HowSectionCard
          section="objection_handling"
          value={v2.objection_handling?.customInstructions ?? ''}
          onChange={v => onSectionChange('objection_handling', v)}
        />

        {/* 8. Human Handoff Guidance */}
        <HowSectionCard
          section="human_handoff_guidance"
          value={v2.human_handoff_guidance?.customInstructions ?? ''}
          onChange={v => onSectionChange('human_handoff_guidance', v)}
        />

        {/* 9. Follow-up Tone */}
        <HowSectionCard
          section="followup_tone"
          value={v2.followup_tone?.customInstructions ?? ''}
          onChange={v => onSectionChange('followup_tone', v)}
        />

        {/* 10. AI Personality & Brand Voice */}
        <HowSectionCard
          section="personality_brand_voice"
          value={v2.personality_brand_voice?.customInstructions ?? ''}
          onChange={v => onSectionChange('personality_brand_voice', v)}
        />

        {/* 11. Global Custom Instructions — surfaces User.globalAiPrompt */}
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
            AI Playbook controls how AI communicates
          </div>
          <div style={{ fontSize: 13, color: 'var(--lb-ink-3)', lineHeight: 1.55 }}>
            <a href="/automation/convert" style={{ color: 'var(--lb-accent)', fontWeight: 600 }}>Automation</a> controls <em>when</em> AI responds, follows up, and hands off conversations.
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

// ─── Phone Call Guidance — PLANNED section (UI preview only) ─────────────
// Renders the future "Phone Call Guidance" card with a locked textarea.
// No backend storage yet — saving is disabled. Once the backend renderer
// adds a `phone_call_guidance` PlaybookSectionKey, swap this for a real
// <HowSectionCard section="phone_call_guidance" ... />.
function PhoneCallGuidancePlannedCard() {
  return (
    <SectionCard padding="22px 24px">
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 14 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: '#fef3c7', color: '#92400e',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <PhoneCall size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 16, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em',
          }}>
            Phone Call Guidance
            <span style={{
              fontSize: 9.5, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
              background: '#fef3c7', color: '#92400e',
              letterSpacing: 0.05, textTransform: 'uppercase', fontFamily: 'var(--lb-font-mono)',
            }}>Coming Soon</span>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 4, lineHeight: 1.5 }}>
            How AI should explain a phone call and ask for the customer's number when the Phone goal is active.
          </div>
        </div>
      </div>

      <div style={{
        padding: '12px 14px',
        background: '#fffbeb',
        border: '1px dashed #fde68a',
        borderRadius: 10,
        fontSize: 12.5, color: '#92400e',
        lineHeight: 1.55,
        marginBottom: 12,
      }}>
        This section is shipping in a future release. Today, phone-call behavior is driven by the Conversation Goal in <strong>Automation → AI Conversation</strong> (the Phone goal) and the BASE HARD RULES that ship with every AI reply. When this section ships, you'll be able to customize the AI's exact wording for explaining why a call helps and how it asks for a number.
      </div>

      <textarea
        readOnly
        disabled
        rows={4}
        placeholder='Custom instructions for the Phone goal will go here. (Disabled until backend support ships.)'
        style={{
          width: '100%', boxSizing: 'border-box',
          padding: '10px 12px',
          border: '1px solid var(--lb-line)',
          borderRadius: 8,
          fontFamily: 'inherit', fontSize: 13, lineHeight: 1.55,
          color: 'var(--lb-ink-5)', background: '#f8fafc',
          resize: 'vertical', minHeight: 80,
          cursor: 'not-allowed',
        }}
      />
    </SectionCard>
  );
}

// ─── HOW section card — generic for 7 of the 8 HOW sections ───────────────

function HowSectionCard({
  section, value, onChange,
}: {
  section: PlaybookSectionKey;
  value: string;
  onChange: (v: string) => void;
}) {
  const Icon = SECTION_ICONS[section];
  return (
    <PlaybookSectionShell
      icon={Icon}
      title={PLAYBOOK_SECTION_UI_LABELS[section]}
      subtitle={PLAYBOOK_SECTION_SUBTITLES[section]}
    >
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

// ─── Pricing Guidance — HOW textarea + ServicePricingForm embed ──────────

function PricingGuidanceCard({
  value, onChange, accountId, accountName, accountIds,
}: {
  value: string;
  onChange: (v: string) => void;
  accountId: string;
  accountName: string;
  accountIds: string[];
}) {
  return (
    <PlaybookSectionShell
      icon={CircleDollarSign}
      title={PLAYBOOK_SECTION_UI_LABELS.pricing_guidance}
      subtitle={PLAYBOOK_SECTION_SUBTITLES.pricing_guidance}
    >
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
