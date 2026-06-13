import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Phone, PhoneCall, MessageSquare, Bell, Check, Zap, Loader2, Building2, Pencil, X, AlertCircle, Mail,
} from 'lucide-react';
import {
  SettingCard, FieldRow, ActionLink,
} from '../../components/automation/ui';
import { usersApi, templatesApi, thumbtackApi, notificationsApi, type TenantPhoneNumber } from '../../services/api';
import type { MessageTemplate, NotificationRule, SavedAccount } from '../../types';
import { useAuthStore } from '../../store/authStore';
import { notify } from '../../store/notificationStore';
import { LeadBridgeNumberManager } from '../../components/LeadBridgeNumberManager';
import { LeadBridgeNumberLock } from '../../components/LeadBridgeNumberLock';
import { AdditionalAssociatePhonesEditor } from '../../components/AdditionalAssociatePhonesEditor';

function formatPhone(e164: string | null): string {
  if (!e164) return '—';
  // +18139212100 → +1 (813) 921-2100
  const m = /^\+?1?(\d{3})(\d{3})(\d{4})$/.exec(e164.replace(/\D/g, ''));
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function SettingsCommunication() {
  const navigate = useNavigate();
  const location = useLocation();
  const fromState = { from: location.pathname + location.search, fromLabel: 'Settings · Communication' };
  const user = useAuthStore(s => s.user) as any;
  const authToken = useAuthStore(s => s.token);
  const setAuth = useAuthStore(s => s.setAuth);
  const canPurchase = !!(user?.trialActive || user?.subscriptionTier === 'PRO' || user?.subscriptionTier === 'ENTERPRISE');
  const [loadingPhone, setLoadingPhone] = useState(true);
  const [editingBusinessPhone, setEditingBusinessPhone] = useState(false);
  const [businessPhoneValue, setBusinessPhoneValue] = useState('');
  const [savingBusinessPhone, setSavingBusinessPhone] = useState(false);
  const [businessPhoneError, setBusinessPhoneError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [tenantPhones, setTenantPhones] = useState<TenantPhoneNumber[]>([]);
  const [loadingPerBusiness, setLoadingPerBusiness] = useState(true);
  const [editingOverrideId, setEditingOverrideId] = useState<string | null>(null);
  const [overrideValue, setOverrideValue] = useState('');
  const [savingOverrideId, setSavingOverrideId] = useState<string | null>(null);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  // Notifications state — cascades across every connected account.
  // We keep per-account snapshots so toggles can derive an aggregate
  // (all-on / all-off / mixed) without an extra fetch.
  const [newLeadByAccount, setNewLeadByAccount] = useState<Record<string, NotificationRule | null>>({});
  const [customerReplyByAccount, setCustomerReplyByAccount] = useState<Record<string, NotificationRule | null>>({});
  const [loadingAlerts, setLoadingAlerts] = useState<boolean>(false);
  const [savingRuleKind, setSavingRuleKind] = useState<'new_lead' | 'customer_reply' | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      usersApi.getMyPhoneNumber().catch(() => ({ phoneNumber: null as string | null, allocationId: null, hasPhoneNumber: false })),
      templatesApi.getTemplates().catch(() => ({ templates: [] as MessageTemplate[], count: 0 })),
      thumbtackApi.getSavedAccounts().catch(() => ({ accounts: [] as SavedAccount[], count: 0 })),
      notificationsApi.listTenantPhones().catch(() => ({ success: false, data: [] as TenantPhoneNumber[] })),
    ]).then(([_phoneRes, tplRes, acctRes, tpnRes]) => {
      if (!alive) return;
      setTemplates(tplRes.templates || []);
      setAccounts(acctRes.accounts || []);
      setTenantPhones((tpnRes.data || []).filter((p: TenantPhoneNumber) => p.status === 'ACTIVE'));
    }).finally(() => {
      if (!alive) return;
      setLoadingPhone(false);
      setLoadingPerBusiness(false);
    });
    return () => { alive = false; };
  }, []);

  // Load the Notifications state across EVERY account whenever the
  // account list arrives. Cascade design — there is no per-account
  // selector here; the toggles act on all accounts in parallel.
  useEffect(() => {
    if (accounts.length === 0) return;
    let alive = true;
    setLoadingAlerts(true);
    Promise.all(accounts.map(a =>
      notificationsApi.getRules(a.id)
        .catch(() => ({ success: false, count: 0, rules: [] as NotificationRule[] }))
        .then(rulesRes => ({
          accountId: a.id,
          rules: (rulesRes.rules || []) as NotificationRule[],
        })),
    )).then(results => {
      if (!alive) return;
      const newLeadMap: Record<string, NotificationRule | null> = {};
      const replyMap: Record<string, NotificationRule | null> = {};
      for (const { accountId, rules } of results) {
        // Owner-side alerts only — exclude sendToCustomer rules (auto-reply lives on Automation).
        newLeadMap[accountId] = rules.find(r => r.triggerType === 'new_lead' && !r.sendToCustomer) || null;
        replyMap[accountId]   = rules.find(r => r.triggerType === 'customer_reply' && !r.sendToCustomer) || null;
      }
      setNewLeadByAccount(newLeadMap);
      setCustomerReplyByAccount(replyMap);
    }).finally(() => {
      if (alive) setLoadingAlerts(false);
    });
    return () => { alive = false; };
  }, [accounts]);

  // Conventional alert template names — match what TemplateEditorModal seeds.
  const businessPhone = (user?.businessPhone as string | null | undefined) ?? null;

  function toE164(raw: string): string {
    const digits = (raw || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
    return raw.trim().startsWith('+') ? raw.trim() : '+' + digits;
  }
  function isValidE164(value: string): boolean {
    return /^\+[1-9]\d{7,14}$/.test(value);
  }

  // Resolve the target alert phone for a given account.
  // Mirrors backend resolveAgentPhone: account override → User.businessPhone.
  function resolveAlertPhone(accountId: string): string | null {
    const acct = accounts.find(a => a.id === accountId);
    return (acct?.agentPhoneOverride as any) || businessPhone || null;
  }

  // Aggregate helpers — derive all-on / all-off / mixed from the per-account map.
  function aggregate(states: boolean[]): { allOn: boolean; allOff: boolean; mixed: boolean; on: number; total: number } {
    const total = states.length;
    const on = states.filter(Boolean).length;
    return { allOn: total > 0 && on === total, allOff: on === 0, mixed: on > 0 && on < total, on, total };
  }

  async function cascadeRule(
    kind: 'new_lead' | 'customer_reply',
    on: boolean,
  ) {
    setSavingRuleKind(kind);
    const ruleByAccount = kind === 'new_lead' ? newLeadByAccount : customerReplyByAccount;
    const setter = kind === 'new_lead' ? setNewLeadByAccount : setCustomerReplyByAccount;
    const defaults = kind === 'new_lead'
      ? {
          name: 'Lead Alert - SMS',
          triggerType: 'new_lead' as const,
          template: 'New lead: {{lead.name}}\nPhone: {{lead.phone}}\nService: {{lead.service}}\nLocation: {{lead.location}}',
        }
      : {
          name: 'Customer Reply Alert',
          triggerType: 'customer_reply' as const,
          replyTriggerMode: 'every_reply' as const,
          template: 'Lead {{lead.name}} replied: "{{message}}"',
        };

    const missingPhone: string[] = [];
    const results = await Promise.all(accounts.map(async a => {
      const existing = ruleByAccount[a.id];
      try {
        if (existing) {
          // Idempotent — re-issuing the same enabled value is fine.
          const res = await notificationsApi.updateRule(a.id, existing.id, { enabled: on });
          return { accountId: a.id, rule: res.rule, error: null as string | null };
        }
        if (!on) {
          // No rule and target is OFF: nothing to do.
          return { accountId: a.id, rule: null, error: null };
        }
        const toPhone = resolveAlertPhone(a.id);
        if (!toPhone) {
          missingPhone.push(a.businessName);
          return { accountId: a.id, rule: null, error: 'no_phone' };
        }
        const res = await notificationsApi.createRule(a.id, {
          ...defaults,
          toPhone,
          enabled: true,
        });
        return { accountId: a.id, rule: res.rule, error: null };
      } catch (err: any) {
        return { accountId: a.id, rule: existing || null, error: err?.response?.data?.message || err?.message || 'failed' };
      }
    }));

    setter(prev => {
      const next = { ...prev };
      for (const r of results) next[r.accountId] = r.rule;
      return next;
    });
    setSavingRuleKind(null);

    const failed = results.filter(r => r.error && r.error !== 'no_phone');
    if (missingPhone.length > 0) {
      notify.error(
        'Missing alert phone',
        `Set an alert phone for ${missingPhone.length} ${missingPhone.length === 1 ? 'business' : 'businesses'} (${missingPhone.slice(0, 3).join(', ')}${missingPhone.length > 3 ? '…' : ''}).`,
      );
    } else if (failed.length > 0) {
      notify.error('Partial failure', `${failed.length} of ${accounts.length} accounts failed to update.`);
    } else {
      notify.success('Saved', on ? `${kind === 'new_lead' ? 'New lead' : 'Customer reply'} alert on for ${accounts.length} accounts` : `${kind === 'new_lead' ? 'New lead' : 'Customer reply'} alert off`);
    }
  }

  function goToTemplate(name: string) {
    const params = new URLSearchParams({ filter: 'alerts' });
    const t = templates.find(t => t.name.toLowerCase().includes(name.toLowerCase()));
    if (t) params.set('highlight', t.id);
    navigate(`/templates?${params.toString()}`, { state: fromState });
  }

  async function reloadTenantPhones() {
    try {
      const r = await notificationsApi.listTenantPhones();
      setTenantPhones((r.data || []).filter((p: TenantPhoneNumber) => p.status === 'ACTIVE'));
    } catch { /* keep stale list */ }
  }

  async function handleSaveBusinessPhone() {
    setBusinessPhoneError(null);
    const trimmed = businessPhoneValue.trim();
    let value: string | null;
    if (!trimmed) {
      value = null;
    } else {
      const e164 = toE164(trimmed);
      if (!isValidE164(e164)) {
        setBusinessPhoneError('Phone must be E.164 (e.g. +12125550100)');
        return;
      }
      value = e164;
    }
    setSavingBusinessPhone(true);
    try {
      const res = await usersApi.updateProfile({ businessPhone: value ?? undefined });
      if (authToken) {
        setAuth({ ...(user as any), ...res.user }, authToken);
      }
      setEditingBusinessPhone(false);
      setBusinessPhoneValue('');
      notify.success('Saved', value ? 'Business phone updated' : 'Business phone cleared');
    } catch (err: any) {
      setBusinessPhoneError(err?.response?.data?.message || err?.message || 'Failed to save');
    } finally {
      setSavingBusinessPhone(false);
    }
  }

  async function handleSaveOverride(accountId: string) {
    setOverrideError(null);
    const trimmed = overrideValue.trim();
    // Empty → clear override (inherit User.businessPhone).
    // Equal to tenant default → also clear; storing the same number as the
    // default is just noise and the resolver falls through to it anyway.
    let value: string | null;
    if (!trimmed) {
      value = null;
    } else {
      const e164 = toE164(trimmed);
      if (!isValidE164(e164)) {
        setOverrideError('Phone must be E.164 (e.g. +12125550100)');
        return;
      }
      value = (businessPhone && e164 === businessPhone) ? null : e164;
    }
    setSavingOverrideId(accountId);
    try {
      await thumbtackApi.updateSavedAccount(accountId, { agentPhoneOverride: value });
      setAccounts(prev => prev.map(a => a.id === accountId ? { ...a, agentPhoneOverride: value } : a));
      setEditingOverrideId(null);
      setOverrideValue('');
    } catch (err: any) {
      setOverrideError(err?.response?.data?.message || err?.message || 'Failed to save');
    } finally {
      setSavingOverrideId(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SettingCard
        icon={Phone}
        iconTone="violet"
        title="Phone numbers"
        subtitle="Numbers Leadbridge uses to send and receive calls and texts."
        contentPad="8px 24px 24px"
      >
        <FieldRow icon={Phone} iconTone="violet" label="Business phone" sublabel="Where lead calls forward when bridged.">
          {editingBusinessPhone ? (
            <AlertPhoneEditor
              value={businessPhoneValue}
              onChange={setBusinessPhoneValue}
              onSave={handleSaveBusinessPhone}
              onCancel={() => { setEditingBusinessPhone(false); setBusinessPhoneValue(''); setBusinessPhoneError(null); }}
              saving={savingBusinessPhone}
              placeholder="+12125550100"
              error={businessPhoneError}
            />
          ) : (
            <PhoneTile
              number={formatPhone(businessPhone)}
              label={businessPhone ? 'Primary' : 'Set your business phone'}
              verified={!!businessPhone}
              onEdit={() => {
                setBusinessPhoneValue(businessPhone || '');
                setEditingBusinessPhone(true);
                setBusinessPhoneError(null);
              }}
            />
          )}
        </FieldRow>
        <div style={{ paddingTop: 16, marginTop: 16, borderTop: '1px solid var(--lb-line-soft)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
            <div style={{ minWidth: 0, width: 170, flexShrink: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--lb-ink-2)' }}>LeadBridge numbers</div>
              <div style={{ fontSize: 12, color: 'var(--lb-ink-5)', marginTop: 2 }}>
                Numbers Leadbridge texts customers from. Per‑business routing shown below.
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {loadingPhone || loadingPerBusiness ? (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--lb-ink-5)', fontSize: 13 }}>
                  <Loader2 size={14} className="animate-spin" /> Loading…
                </div>
              ) : (
                <LeadBridgeNumberManager
                  accounts={accounts}
                  canPurchase={canPurchase}
                  onSuccess={msg => { notify.success('Success', msg); reloadTenantPhones(); }}
                  onError={msg => notify.error('Error', msg)}
                />
              )}
            </div>
          </div>
        </div>
      </SettingCard>

      <SettingCard
        icon={Building2}
        iconTone="blue"
        title="Per business"
        subtitle="Which LeadBridge number and alert phone each connected source uses."
        contentPad="8px 24px 24px"
      >
        {loadingPerBusiness ? (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--lb-ink-5)', fontSize: 13, padding: '12px 0' }}>
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : accounts.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--lb-ink-5)', padding: '12px 0' }}>
            No connected sources yet. Connect Thumbtack, Yelp or Angi from the
            {' '}<ActionLink onClick={() => navigate('/settings?tab=accounts')}>Connected Sources</ActionLink> tab.
          </div>
        ) : (
          accounts.map((acct, idx) => {
            // Mirror backend resolveBotPhone: account-scoped → unassigned → any active TPN.
            // When only one number exists tenant-wide, it serves every business as "Shared".
            const assignedPhone = tenantPhones.find(p => p.savedAccountId === acct.id)
              || tenantPhones.find(p => !p.savedAccountId)
              || tenantPhones[0]
              || null;
            const lbShared = !!assignedPhone && assignedPhone.savedAccountId !== acct.id;
            const alertPhone = acct.agentPhoneOverride || businessPhone;
            const usingOverride = !!acct.agentPhoneOverride;
            const isThumbtack = acct.platform === 'thumbtack';
            const additionalPhones = isThumbtack ? readAdditionalAssociatePhones(acct.followUpSettingsJson) : null;
            return (
              <FieldRow
                key={acct.id}
                icon={Building2}
                iconTone={acct.platform === 'yelp' ? 'orange' : 'blue'}
                label={acct.businessName}
                sublabel={acct.platform.charAt(0).toUpperCase() + acct.platform.slice(1)}
                align="top"
                noBorder={idx === accounts.length - 1}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <PerBusinessTile
                      icon={PhoneCall}
                      label="LeadBridge number"
                      value={assignedPhone ? formatPhone(assignedPhone.phoneNumber) : 'Not assigned'}
                      badge={!assignedPhone ? null : lbShared ? { text: 'Shared', tone: 'slate' } : { text: 'Dedicated', tone: 'blue' }}
                      muted={!assignedPhone}
                    />
                    {editingOverrideId === acct.id ? (
                      <AlertPhoneEditor
                        value={overrideValue}
                        onChange={setOverrideValue}
                        onSave={() => handleSaveOverride(acct.id)}
                        onCancel={() => { setEditingOverrideId(null); setOverrideValue(''); setOverrideError(null); }}
                        saving={savingOverrideId === acct.id}
                        placeholder={businessPhone || '+12125550100'}
                        error={overrideError}
                      />
                    ) : (
                      <PerBusinessTile
                        icon={Phone}
                        label="Alert phone"
                        value={alertPhone ? formatPhone(alertPhone) : 'Not set'}
                        badge={!alertPhone ? null : usingOverride ? { text: 'Override', tone: 'amber' } : { text: 'Default', tone: 'slate' }}
                        muted={!alertPhone}
                        onEdit={() => {
                          setOverrideValue(acct.agentPhoneOverride || '');
                          setEditingOverrideId(acct.id);
                          setOverrideError(null);
                        }}
                      />
                    )}
                  </div>
                  {isThumbtack && (
                    <div>
                      <div style={{
                        fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
                        letterSpacing: 0.3, color: 'var(--lb-ink-5, #64748b)',
                        marginBottom: 6,
                      }}>
                        Additional associate numbers
                      </div>
                      <AdditionalAssociatePhonesEditor
                        savedAccountId={acct.id}
                        initialValue={additionalPhones}
                        onSaved={(next) => {
                          // Write the new list back into followUpSettingsJson on the
                          // cached account so re-renders show the saved state
                          // without a full re-fetch.
                          setAccounts(prev => prev.map(a => {
                            if (a.id !== acct.id) return a;
                            let parsed: Record<string, any> = {};
                            try {
                              parsed = a.followUpSettingsJson ? JSON.parse(a.followUpSettingsJson) : {};
                            } catch { parsed = {}; }
                            parsed.additionalAssociatePhones = next;
                            return { ...a, followUpSettingsJson: JSON.stringify(parsed) };
                          }));
                        }}
                      />
                    </div>
                  )}
                </div>
              </FieldRow>
            );
          })
        )}
      </SettingCard>

      <LeadBridgeNumberLock feature="Notifications" />
      <SettingCard
        icon={Bell}
        iconTone="orange"
        title="Notifications"
        subtitle={accounts.length > 0
          ? `SMS sent to your team about lead activity. Applies to all ${accounts.length} ${accounts.length === 1 ? 'source' : 'sources'}.`
          : 'SMS sent to your team about lead activity.'}
        contentPad="8px 24px 24px"
      >
        {accounts.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--lb-ink-5)', padding: '12px 0' }}>
            Connect a source first to configure alerts.
          </div>
        ) : loadingAlerts ? (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--lb-ink-5)', fontSize: 13, padding: '12px 0' }}>
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : (() => {
          const newLeadAgg = aggregate(accounts.map(a => !!newLeadByAccount[a.id]?.enabled));
          const replyAgg = aggregate(accounts.map(a => !!customerReplyByAccount[a.id]?.enabled));
          return (
            <>
              <BusinessAlertRow
                icon={Mail}
                iconTone="blue"
                label="New lead alert"
                sublabel="When a new lead arrives from any source."
                agg={newLeadAgg}
                saving={savingRuleKind === 'new_lead'}
                onToggle={on => cascadeRule('new_lead', on)}
                onEditTemplate={() => goToTemplate('Lead Alert')}
              />
              <BusinessAlertRow
                icon={MessageSquare}
                iconTone="green"
                label="Customer reply alert"
                sublabel="When a customer replies to your LeadBridge number."
                agg={replyAgg}
                saving={savingRuleKind === 'customer_reply'}
                onToggle={on => cascadeRule('customer_reply', on)}
                onEditTemplate={() => goToTemplate('Customer Reply')}
                noBorder
              />
            </>
          );
        })()}
      </SettingCard>
    </div>
  );
}

/**
 * Parse the per-account `additionalAssociatePhones` array out of a
 * SavedAccount's followUpSettingsJson string. Tolerates malformed JSON.
 */
function readAdditionalAssociatePhones(
  followUpSettingsJson: string | null | undefined,
): Array<{ id: string; phoneNumber: string; label?: string }> | null {
  if (!followUpSettingsJson) return null;
  try {
    const parsed = JSON.parse(followUpSettingsJson);
    const raw = parsed?.additionalAssociatePhones;
    return Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

function BusinessAlertRow({
  icon: Icon, iconTone, label, sublabel, agg, saving, onToggle,
  onEditTemplate, onConfigure, noBorder,
}: {
  icon: typeof Bell;
  iconTone: 'blue' | 'green' | 'orange';
  label: string;
  sublabel: string;
  agg: { allOn: boolean; allOff: boolean; mixed: boolean; on: number; total: number };
  saving?: boolean;
  onToggle: (v: boolean) => void;
  onEditTemplate?: () => void;
  onConfigure?: () => void;
  noBorder?: boolean;
}) {
  const iconBg = iconTone === 'blue' ? '#dbeafe' : iconTone === 'green' ? '#d1fae5' : '#fed7aa';
  const iconFg = iconTone === 'blue' ? '#1d4ed8' : iconTone === 'green' ? '#047857' : '#c2410c';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '14px 0',
      borderBottom: noBorder ? 'none' : '1px solid var(--lb-line-soft)',
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 8,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: iconBg, color: iconFg, flexShrink: 0,
      }}>
        <Icon size={16} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--lb-ink-1)' }}>{label}</div>
          {agg.mixed && (
            <span style={{
              padding: '2px 8px', borderRadius: 999,
              background: '#fef3c7', color: '#b45309',
              fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap',
            }} title={`${agg.on} of ${agg.total} accounts have this alert on`}>
              Mixed · {agg.on}/{agg.total} on
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--lb-ink-5)', marginTop: 2 }}>{sublabel}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        {onEditTemplate && (
          <button
            type="button"
            onClick={onEditTemplate}
            style={{
              padding: '5px 10px',
              background: 'white', color: 'var(--lb-ink-2)',
              border: '1px solid var(--lb-line)', borderRadius: 8,
              fontSize: 11.5, fontFamily: 'inherit', fontWeight: 500,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            Edit template
          </button>
        )}
        {onConfigure && (
          <button
            type="button"
            onClick={onConfigure}
            style={{
              padding: '5px 10px',
              background: 'white', color: 'var(--lb-ink-2)',
              border: '1px solid var(--lb-line)', borderRadius: 8,
              fontSize: 11.5, fontFamily: 'inherit', fontWeight: 500,
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            Configure
          </button>
        )}
        <BusinessAlertToggle agg={agg} saving={!!saving} onToggle={onToggle} />
      </div>
    </div>
  );
}

function BusinessAlertToggle({
  agg, saving, onToggle,
}: {
  agg: { allOn: boolean; mixed: boolean };
  saving: boolean;
  onToggle: (v: boolean) => void;
}) {
  // Mixed → flipping the toggle cascades all to ON (consistent with old UX).
  const targetWhenClicked = !agg.allOn;
  const visualOn = agg.allOn;
  const bg = agg.mixed ? '#f59e0b' : visualOn ? 'var(--lb-accent)' : '#cbd5e1';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={visualOn}
      disabled={saving}
      onClick={() => onToggle(targetWhenClicked)}
      style={{
        position: 'relative',
        width: 40, height: 22,
        border: 0,
        borderRadius: 999,
        background: bg,
        cursor: saving ? 'wait' : 'pointer',
        transition: 'background 120ms',
        opacity: saving ? 0.6 : 1,
        padding: 0,
      }}
    >
      <span style={{
        position: 'absolute',
        top: 2, left: visualOn ? 20 : 2,
        width: 18, height: 18, borderRadius: 999,
        background: 'white',
        boxShadow: '0 1px 2px rgba(10,21,48,0.18)',
        transition: 'left 140ms',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {saving && <Loader2 size={10} className="animate-spin" style={{ color: 'var(--lb-ink-5)' }} />}
      </span>
    </button>
  );
}

function PerBusinessTile({
  icon: Icon, label, value, badge, muted, onEdit,
}: {
  icon: typeof Phone;
  label: string;
  value: string;
  badge: { text: string; tone: 'blue' | 'amber' | 'slate' } | null;
  muted?: boolean;
  onEdit?: () => void;
}) {
  const tonePalette: Record<'blue' | 'amber' | 'slate', { bg: string; fg: string }> = {
    blue:  { bg: '#dbeafe', fg: '#1d4ed8' },
    amber: { bg: '#fef3c7', fg: '#b45309' },
    slate: { bg: '#f1f5f9', fg: '#475569' },
  };
  const tone = badge ? tonePalette[badge.tone] : null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 12px',
      background: '#f8fafc',
      border: '1px solid var(--lb-line-soft)',
      borderRadius: 10,
      minWidth: 0,
    }}>
      <Icon size={14} style={{ color: 'var(--lb-ink-6)', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 700,
          color: muted ? 'var(--lb-ink-5)' : 'var(--lb-ink-1)',
          fontFamily: 'var(--lb-font-mono)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {value}
        </div>
        <div style={{ fontSize: 11, color: 'var(--lb-ink-5)', marginTop: 1 }}>{label}</div>
      </div>
      {badge && tone && (
        <span style={{
          padding: '2px 8px', borderRadius: 999,
          background: tone.bg, color: tone.fg,
          fontSize: 10.5, fontWeight: 600,
          whiteSpace: 'nowrap',
        }}>
          {badge.text}
        </span>
      )}
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label="Edit"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 24, height: 24, padding: 0,
            background: 'transparent', border: 0,
            color: 'var(--lb-ink-6)', cursor: 'pointer',
            borderRadius: 6, flexShrink: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#eef2f7'; e.currentTarget.style.color = 'var(--lb-ink-2)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--lb-ink-6)'; }}
        >
          <Pencil size={13} />
        </button>
      )}
    </div>
  );
}

function AlertPhoneEditor({
  value, onChange, onSave, onCancel, saving, placeholder, error,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  placeholder: string;
  error: string | null;
}) {
  return (
    <div style={{
      padding: '8px 10px',
      background: '#fffbeb',
      border: '1.5px solid #fcd34d',
      borderRadius: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Phone size={14} style={{ color: '#b45309', flexShrink: 0 }} />
        <input
          type="tel"
          autoFocus
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') onSave();
            if (e.key === 'Escape') onCancel();
          }}
          placeholder={placeholder}
          disabled={saving}
          style={{
            flex: 1, minWidth: 0,
            padding: '4px 6px',
            background: 'white',
            border: '1px solid #fcd34d',
            borderRadius: 6,
            fontSize: 13, fontFamily: 'var(--lb-font-mono)',
            color: 'var(--lb-ink-1)',
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          aria-label="Save"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 26, height: 26, padding: 0,
            background: '#16a34a', color: 'white', border: 0,
            borderRadius: 6, cursor: saving ? 'wait' : 'pointer', flexShrink: 0,
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={14} />}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          aria-label="Cancel"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 26, height: 26, padding: 0,
            background: 'white', color: 'var(--lb-ink-5)', border: '1px solid var(--lb-line)',
            borderRadius: 6, cursor: 'pointer', flexShrink: 0,
          }}
        >
          <X size={14} />
        </button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--lb-ink-5)', marginTop: 4, paddingLeft: 20 }}>
        {error ? (
          <span style={{ color: '#dc2626', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <AlertCircle size={11} /> {error}
          </span>
        ) : (
          'Leave empty to use the business default. E.164 format (+12125550100).'
        )}
      </div>
    </div>
  );
}

function PhoneTile({
  number, label, verified, leadbridge, onEdit,
}: {
  number: string;
  label: string;
  verified?: boolean;
  leadbridge?: boolean;
  onEdit?: () => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 14px',
      background: '#f8fafc',
      border: '1px solid var(--lb-line-soft)',
      borderRadius: 10,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--lb-ink-1)', fontFamily: 'var(--lb-font-mono)' }}>{number}</div>
        <div style={{ fontSize: 12, color: 'var(--lb-ink-5)', marginTop: 2 }}>{label}</div>
      </div>
      {verified && (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '3px 9px', borderRadius: 999,
          background: '#dcfce7', color: '#16a34a',
          fontSize: 11, fontWeight: 600,
        }}>
          <Check size={10} /> Verified
        </span>
      )}
      {leadbridge && (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '3px 9px', borderRadius: 999,
          background: '#dbeafe', color: '#2563eb',
          fontSize: 11, fontWeight: 600,
        }}>
          <Zap size={10} /> Leadbridge
        </span>
      )}
      <ActionLink onClick={onEdit}>Edit</ActionLink>
    </div>
  );
}
