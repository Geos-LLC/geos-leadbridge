/**
 * Settings → AI Playbook — Stage 3.
 *
 * Lets users add business-specific instructions per category to the AI's
 * reply prompt. Behavior summary (left column) is GENERATED from the user's
 * existing AI settings — read-only here. Instructions (right column) are
 * free-form text saved to followUpSettingsJson.aiPlaybookInstructions.
 *
 * Per-account storage with same-payload-to-all-accounts save (one Playbook
 * applied across every connected source). When multi-account tenants need
 * per-account override, Stage 3.5 will add a picker — for now, 16/16 prod
 * tenants have 1 connected account and "set once" is the obvious UX.
 *
 * The Playbook does NOT control behavior. Stop rules / handoff triggers /
 * follow-up enrollment all still run as gates before AI reply generation.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Info, Loader2, Sparkles } from 'lucide-react';
import { SectionCard, StatusPill } from '../../components/automation/ui';
import { followUpApi } from '../../services/api';
import { useAppStore } from '../../store/appStore';
import { UpgradeOverlay } from '../../components/UpgradeOverlay';
import {
  previewPlaybookCategories,
  CATEGORY_ORDER,
  CATEGORY_UI_LABELS,
  INSTRUCTION_LENGTH_SOFT,
  INSTRUCTION_LENGTH_WARN,
  type PlaybookCategoryKey,
  type PlaybookInstructionsBlob,
  type RawSavedAccount,
} from '../../lib/playbook-renderer';

export function SettingsAiPlaybook() {
  const accounts = useAppStore(s => s.savedAccounts);
  const [instructions, setInstructions] = useState<PlaybookInstructionsBlob>({});
  // Snapshot of the source account so the behavior summary preview reflects
  // current toggle state (read-only).
  const [sourceAccount, setSourceAccount] = useState<RawSavedAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Track per-category dirty state so we can save only what changed.
  const dirtyRef = useRef<Set<PlaybookCategoryKey>>(new Set());

  // Auto-clear "Saved" pill.
  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(null), 2000);
    return () => clearTimeout(t);
  }, [savedAt]);

  // Load instructions from the first connected account on mount. Settings is
  // tenant-wide UX even though storage is per-account — we treat the first
  // account as the source of truth for what the user sees + edits.
  useEffect(() => {
    let alive = true;
    if (accounts.length === 0) { setLoading(false); return; }

    const firstId = accounts[0].id;
    setLoading(true); setError(null);
    followUpApi.getSettings(firstId).then((res: { settings?: Record<string, unknown> | null }) => {
      if (!alive) return;
      const settings = res?.settings ?? null;
      const rawInstr = settings && typeof settings === 'object'
        ? (settings as Record<string, unknown>).aiPlaybookInstructions
        : null;
      if (rawInstr && typeof rawInstr === 'object' && !Array.isArray(rawInstr)) {
        setInstructions(rawInstr as PlaybookInstructionsBlob);
      } else {
        setInstructions({});
      }
      // Build a RawSavedAccount snapshot for the preview renderer using
      // whatever fields the settings response includes. aiConversationMode
      // and servicePricingJson aren't on this endpoint today; the preview
      // falls back to defaults for those, which keeps the UI close enough
      // for v1. Backend always uses real values at reply time.
      const aiConversationMode = settings && typeof (settings as Record<string, unknown>).aiConversationMode === 'string'
        ? ((settings as Record<string, unknown>).aiConversationMode as string)
        : null;
      setSourceAccount({
        aiConversationMode,
        followUpSettingsJson: settings ? JSON.stringify(settings) : null,
        servicePricingJson: null, // not fetched in v1 — pricing bullet shows the "no table" state in the preview
      });
    }).catch((e: { message?: string }) => {
      if (alive) setError(e?.message ?? 'Failed to load Playbook');
    }).finally(() => {
      if (alive) setLoading(false);
    });

    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts]);

  // Behavior summary preview — recomputed locally whenever sourceAccount
  // updates. Same derivation as the backend renderer so what the user sees
  // matches (approximately) what the LLM sees.
  const preview = useMemo(() => {
    if (!sourceAccount) return [];
    const p = previewPlaybookCategories(sourceAccount);
    // Merge live (unsaved) instructions into the preview so the user sees
    // their in-flight edits reflected in the rendered Playbook block.
    return p.map(c => ({ ...c, instructions: (instructions[c.category] ?? '').trim() }));
  }, [sourceAccount, instructions]);

  const onInstructionChange = (category: PlaybookCategoryKey, value: string) => {
    dirtyRef.current.add(category);
    setInstructions(prev => ({ ...prev, [category]: value }));
  };

  const handleSave = async () => {
    if (dirtyRef.current.size === 0) return;
    if (accounts.length === 0) return;
    setSaving(true); setError(null);
    const payload = { aiPlaybookInstructions: instructions };
    try {
      // Fan out: same Playbook applied to every connected account.
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
  const accountCount = accounts.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error && <StatusPill status="error" message={error} />}
      {!error && saving && <StatusPill status="saving" />}
      {!error && !saving && savedAt && <StatusPill status="saved" />}
      {!error && !savedAt && loading && <StatusPill status="loading" />}

      {/* AI Playbook is part of AI Conversation — Convert tier. Wrap so
          non-Convert users see the page with a transparent upgrade overlay. */}
      <UpgradeOverlay tier="convert">

      <HelpBlock />

      {accountCount === 0 && (
        <SectionCard padding="22px 24px">
          <div style={{ fontSize: 14, color: 'var(--lb-ink-3)' }}>
            Connect a lead source first (Settings → Connected Sources) to start customizing your Playbook.
          </div>
        </SectionCard>
      )}

      {accountCount > 0 && preview.length === 0 && loading && (
        <SectionCard padding="22px 24px">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--lb-ink-3)' }}>
            <Loader2 size={16} className="animate-spin" />
            Loading your Playbook…
          </div>
        </SectionCard>
      )}

      {preview.length > 0 && CATEGORY_ORDER.map(category => {
        const card = preview.find(c => c.category === category)!;
        return (
          <PlaybookCard
            key={category}
            category={category}
            label={CATEGORY_UI_LABELS[category]}
            behaviorBullets={card.behaviorBullets}
            value={instructions[category] ?? ''}
            onChange={v => onInstructionChange(category, v)}
          />
        );
      })}

      {preview.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, alignItems: 'center' }}>
          {accountCount > 1 && (
            <span style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginRight: 'auto' }}>
              Applied to all {accountCount} connected accounts.
            </span>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={!hasDirty || saving}
            style={{
              padding: '10px 18px', fontSize: 13.5, fontWeight: 600,
              background: hasDirty ? 'var(--lb-accent)' : '#cbd5e1',
              color: 'white',
              border: 0, borderRadius: 10,
              cursor: hasDirty && !saving ? 'pointer' : 'not-allowed',
              fontFamily: 'inherit',
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? 'Saving…' : hasDirty ? 'Save Playbook' : 'No changes'}
          </button>
        </div>
      )}

      </UpgradeOverlay>
    </div>
  );
}

// ─── Help block ────────────────────────────────────────────────────────────

function HelpBlock() {
  return (
    <SectionCard padding="18px 22px">
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flexShrink: 0, paddingTop: 2 }}>
          <Info size={18} style={{ color: 'var(--lb-accent)' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--lb-ink-1)', marginBottom: 6 }}>
            How AI Playbook works
          </div>
          <div style={{ fontSize: 13, color: 'var(--lb-ink-3)', lineHeight: 1.55 }}>
            Behavior comes from your AI settings.<br />
            Instructions tell AI how to respond.
          </div>
          <div style={{ fontSize: 13, color: 'var(--lb-ink-3)', lineHeight: 1.55, marginTop: 10 }}>
            Changing instructions does not change:
            <ul style={{ margin: '4px 0 0 0', padding: '0 0 0 20px', listStyleType: 'disc' }}>
              <li>Stop rules</li>
              <li>Handoff rules</li>
              <li>Follow-up timing</li>
              <li>Automation behavior</li>
            </ul>
          </div>
          <div style={{ fontSize: 13, color: 'var(--lb-ink-5)', marginTop: 10 }}>
            To change those, go to <a href="/automation/convert" style={{ color: 'var(--lb-accent)', fontWeight: 600 }}>Automation → AI Conversation</a>.
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

// ─── Per-category card ────────────────────────────────────────────────────

function PlaybookCard({
  category, label, behaviorBullets, value, onChange,
}: {
  category: PlaybookCategoryKey;
  label: string;
  behaviorBullets: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const chars = value.length;
  const overSoft = chars >= INSTRUCTION_LENGTH_SOFT;
  const overWarn = chars >= INSTRUCTION_LENGTH_WARN;

  const counterColor = overWarn ? '#b91c1c' : overSoft ? '#d97706' : 'var(--lb-ink-6)';

  return (
    <SectionCard padding="22px 24px">
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 14 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: '#ede9fe', color: '#6d28d9',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <Sparkles size={18} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
            {label}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* LEFT — generated behavior summary */}
        <div>
          <div style={{
            fontSize: 11, fontWeight: 700, color: 'var(--lb-ink-5)',
            letterSpacing: 0.06, textTransform: 'uppercase', marginBottom: 8,
            fontFamily: 'var(--lb-font-mono)',
          }}>
            Current behavior
          </div>
          {behaviorBullets.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--lb-ink-5)', fontStyle: 'italic' }}>
              No automatic behavior for this category right now.
            </div>
          ) : (
            <ul style={{ margin: 0, padding: '0 0 0 20px', fontSize: 13, color: 'var(--lb-ink-2)', lineHeight: 1.6 }}>
              {behaviorBullets.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          )}
          <div style={{ fontSize: 11.5, color: 'var(--lb-ink-6)', marginTop: 12, fontStyle: 'italic' }}>
            Generated from your AI settings — not editable here.
          </div>
        </div>

        {/* RIGHT — editable instructions */}
        <div>
          <div style={{
            fontSize: 11, fontWeight: 700, color: 'var(--lb-ink-5)',
            letterSpacing: 0.06, textTransform: 'uppercase', marginBottom: 8,
            fontFamily: 'var(--lb-font-mono)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          }}>
            <span>Instructions</span>
            {(overSoft || chars > 0) && (
              <span style={{ color: counterColor, fontFamily: 'var(--lb-font-mono)', fontSize: 10.5 }}>
                {chars.toLocaleString()}{overSoft ? ` / ~${INSTRUCTION_LENGTH_WARN.toLocaleString()}` : ''}
              </span>
            )}
          </div>
          <textarea
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={PLACEHOLDERS[category]}
            rows={6}
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '10px 12px',
              border: '1px solid ' + (overWarn ? '#fca5a5' : overSoft ? '#fcd34d' : 'var(--lb-line)'),
              borderRadius: 8,
              fontFamily: 'inherit', fontSize: 13, lineHeight: 1.55,
              color: 'var(--lb-ink-1)', background: 'white',
              resize: 'vertical',
              minHeight: 120,
            }}
          />
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
      </div>
    </SectionCard>
  );
}

// Per-category placeholder text shown when the user hasn't written anything
// yet. Concrete examples drawn from the Stage 3 design discussion.
const PLACEHOLDERS: Record<PlaybookCategoryKey, string> = {
  booking_requests:
    "e.g. Offer the earliest available slot first.\n     Mention recurring service discounts when appropriate.",
  human_contact:
    "e.g. Ask for the best callback time before pausing.\n     Share the main business line if customer wants a phone number.",
  pricing:
    "e.g. When customer says \"too expensive\": ask what budget they had in mind first.\n     Offer reduced scope if their budget is below our range.\n     Never discount immediately — always exchange something.",
  customer_defers:
    "e.g. Acknowledge they want time to decide — don't pressure.\n     If they named a specific date, confirm we'll reach out then.",
  hired_another:
    "e.g. Wish them well sincerely.\n     Leave the door open for future jobs.",
  opt_out:
    "e.g. If the customer seems frustrated rather than opting out, ask once.\n     Send the standard goodbye message on confirmed opt-out.",
  key_details:
    "e.g. Confirm the phone number back to the customer.\n     For deep cleans, also ask about pet hair and cabinet interiors before quoting.",
  general_behavior:
    "e.g. Match the customer's tone.\n     Use the owner's first name in sign-offs.\n     Switch to Spanish if the customer writes in Spanish.",
};
