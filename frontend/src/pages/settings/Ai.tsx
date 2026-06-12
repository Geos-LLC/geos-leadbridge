import { useEffect, useState } from 'react';
import {
  Zap, HelpCircle, ChevronDown, ChevronUp, Loader2, Pencil, RefreshCw, CheckCircle, Info,
} from 'lucide-react';
import { SettingCard, FooterBanner } from '../../components/automation/ui';
import { useAppStore } from '../../store/appStore';
import { usersApi } from '../../services/api';
import { notify } from '../../store/notificationStore';
import AccountFaqForm from '../../components/AccountFaqForm';

export function SettingsAi() {
  const accounts = useAppStore(s => s.savedAccounts);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <GlobalAiPromptCard />
      {accounts.length > 0 && <AccountFaqCard />}
      <FooterBanner
        icon={Info}
        body="The AI uses these settings on every auto-reply and follow-up. Pricing lives in its own tab."
      />
    </div>
  );
}

function GlobalAiPromptCard() {
  const [prompt, setPrompt] = useState('');
  const [isDefault, setIsDefault] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    usersApi.getGlobalAiPrompt()
      .then(res => { setPrompt(res.prompt); setIsDefault(res.isDefault); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      await usersApi.updateGlobalAiPrompt(prompt);
      setIsDefault(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      notify.error('Error', 'Failed to save AI prompt');
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
      notify.error('Error', 'Failed to reset AI prompt');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;

  return (
    <SettingCard
      icon={Zap}
      iconTone="violet"
      title="AI global prompt"
      subtitle={isDefault
        ? 'Using the built-in default. Applied to every AI auto-reply on top of strategy prompts.'
        : 'Custom prompt active. Applied to every AI auto-reply on top of strategy prompts.'}
      headerRight={
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 10px', border: '1px solid var(--lb-line)',
            borderRadius: 8, background: 'white', cursor: 'pointer',
            fontSize: 12, fontWeight: 600, color: 'var(--lb-ink-3)',
          }}
        >
          {expanded ? <>Collapse <ChevronUp size={14} /></> : <>View / edit <ChevronDown size={14} /></>}
        </button>
      }
    >
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 12, color: 'var(--lb-ink-5)', margin: 0 }}>
            Applied to all AI auto-replies. Strategy prompts (Hybrid, Price-Anchor, etc.) are added on top.
          </p>
          <textarea
            value={prompt}
            onChange={e => { setPrompt(e.target.value); setDirty(true); setSaved(false); }}
            readOnly={!editing}
            rows={12}
            style={{
              width: '100%',
              border: '1px solid ' + (editing ? '#93c5fd' : 'var(--lb-line)'),
              borderRadius: 10,
              padding: 12,
              fontSize: 12,
              fontFamily: 'var(--lb-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
              lineHeight: 1.55,
              background: editing ? 'white' : 'var(--lb-surface-soft, #f8fafc)',
              color: 'var(--lb-ink-1)',
              outline: 'none',
              resize: 'vertical',
              boxShadow: editing ? '0 0 0 3px rgba(59,130,246,0.12)' : 'none',
              cursor: editing ? 'text' : 'default',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {!editing ? (
              <button
                type="button"
                onClick={() => setEditing(true)}
                style={btnSecondary()}
              >
                <Pencil size={13} /> Edit prompt
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={async () => { await handleSave(); setEditing(false); setDirty(false); }}
                  disabled={saving || !dirty}
                  style={btnPrimary(saving || !dirty)}
                >
                  {saving
                    ? <Loader2 size={13} className="animate-spin" />
                    : saved ? <CheckCircle size={13} /> : null}
                  {saved ? 'Saved' : 'Save'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false); setDirty(false);
                    usersApi.getGlobalAiPrompt().then(r => { setPrompt(r.prompt); setIsDefault(r.isDefault); });
                  }}
                  disabled={saving}
                  style={btnSecondary(saving)}
                >
                  Cancel
                </button>
                {!isDefault && (
                  <button
                    type="button"
                    onClick={async () => { await handleReset(); setEditing(false); setDirty(false); }}
                    disabled={saving}
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
    </SettingCard>
  );
}

function AccountFaqCard() {
  const accounts = useAppStore(s => s.savedAccounts);
  const [sharedFaq, setSharedFaq] = useState(true);

  return (
    <SettingCard
      icon={HelpCircle}
      iconTone="blue"
      title="Account FAQ"
      subtitle="Verified answers to common customer questions. The AI uses these verbatim and defers on anything left blank — no fabricating insurance, payment, or pet-policy claims."
    >
      {accounts.length > 1 && (
        <label style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          marginBottom: 16, cursor: 'pointer', userSelect: 'none',
        }}>
          <input
            type="checkbox"
            checked={sharedFaq}
            onChange={e => setSharedFaq(e.target.checked)}
            style={{ width: 14, height: 14, accentColor: 'var(--lb-accent)' }}
          />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-2)' }}>
            Same FAQ for all businesses
          </span>
        </label>
      )}

      {accounts.length === 1 || sharedFaq ? (
        <AccountFaqForm
          accountId={sharedFaq ? accounts.map(a => a.id).join(',') : accounts[0].id}
          accountName={sharedFaq && accounts.length > 1 ? 'All Businesses' : accounts[0].businessName}
          saveToAll={sharedFaq && accounts.length > 1 ? accounts.map(a => a.id) : undefined}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {accounts.map(acc => (
            <details key={acc.id} style={{
              border: '1px solid var(--lb-line)', borderRadius: 10, overflow: 'hidden',
            }}>
              <summary style={{
                padding: '10px 14px', background: 'var(--lb-surface-soft, #f8fafc)',
                cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-2)',
              }}>
                {acc.businessName}{' '}
                <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--lb-ink-6)', marginLeft: 4 }}>
                  ({acc.platform})
                </span>
              </summary>
              <div style={{ padding: 14 }}>
                <AccountFaqForm accountId={acc.id} accountName={acc.businessName} />
              </div>
            </details>
          ))}
        </div>
      )}
    </SettingCard>
  );
}

function btnPrimary(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 14px',
    background: '#2563eb', color: 'white',
    border: 0, borderRadius: 8,
    fontSize: 12, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}

function btnSecondary(disabled = false): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 14px',
    background: 'var(--lb-surface-soft, #f1f5f9)', color: 'var(--lb-ink-2)',
    border: 0, borderRadius: 8,
    fontSize: 12, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}

function btnGhostDanger(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '8px 14px',
    background: 'transparent', color: 'var(--lb-ink-5)',
    border: 0, borderRadius: 8,
    fontSize: 12, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}
