import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plug, Plus, AlertTriangle, Info, Download, ChevronDown, ChevronUp, Loader2,
  CheckCircle, AlertCircle, X, RefreshCw, DollarSign, Clock, List, Trash2,
  ArrowUpRight, Pencil,
} from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import { SettingCard, ActionLink, FooterBanner } from '../../components/automation/ui';
import type { SavedAccount } from '../../types';
import ConnectionModal from '../../components/ConnectionModal';
import { ServiceFlowConnectionCard } from '../../components/settings/ServiceFlowConnectionCard';
import {
  thumbtackApi, leadsApi, integrationsApi, platformsApi, followUpApi,
} from '../../services/api';
import { notify } from '../../store/notificationStore';

const PLATFORM_LABEL: Record<string, string> = {
  thumbtack: 'Thumbtack',
  yelp:      'Yelp',
  angi:      'Angi',
  google:    'Google',
};

const PLATFORM_COLOR: Record<string, string> = {
  thumbtack: 'var(--lb-thumbtack)',
  yelp:      'var(--lb-yelp)',
  angi:      'var(--lb-angi)',
  google:    'var(--lb-google)',
};

type ImportResult = { id: string; success: boolean; isNew?: boolean; error?: string };
type BudgetSnapshot = {
  id: string; weeklyBudget: string; currency: string; capturedAt: string;
  effectiveFrom: string; effectiveTo: string | null; active: boolean;
  scopeCategory: string | null; scopeLocation: string | null; snapshotType: string;
};

export function SettingsAccounts() {
  const navigate = useNavigate();
  const accounts = useAppStore(s => s.savedAccounts);
  const [modal, setModal] = useState<{ open: boolean; reconnect?: SavedAccount | null }>({ open: false });

  // "Configure" jumps to the legacy Services screen which still owns per-account
  // settings UI today; remembered last-account is read from localStorage there.
  const goConfigure = (a: SavedAccount) => {
    localStorage.setItem('lb_last_account_id', a.id);
    navigate('/automation-classic');
  };

  // ── Import & Sync state (ported from legacy SettingsPage) ─────────────
  const ttAccounts   = accounts.filter(a => a.platform === 'thumbtack');
  const yelpAccounts = accounts.filter(a => a.platform === 'yelp');

  const [importAccountId, setImportAccountId] = useState<string | null>(() => {
    const saved = localStorage.getItem('lb_importAccountId');
    if (saved && accounts.some(a => a.id === saved)) return saved;
    return accounts[0]?.id ?? null;
  });

  // Keep selection valid when accounts list changes (e.g., after reconnect).
  useEffect(() => {
    if (!accounts.length) { setImportAccountId(null); return; }
    if (!importAccountId || !accounts.some(a => a.id === importAccountId)) {
      const firstId = accounts[0].id;
      setImportAccountId(firstId);
      localStorage.setItem('lb_importAccountId', firstId);
    }
  }, [accounts, importAccountId]);

  const [ttCollapsed, setTtCollapsed] = useState(true);
  const [yelpCollapsed, setYelpCollapsed] = useState(true);

  // Import-from-extension run state
  const [importing, setImporting] = useState(false);
  const [importResults, setImportResults] = useState<ImportResult[]>([]);
  const [importTotal, setImportTotal] = useState(0);
  const [showImportResults, setShowImportResults] = useState(false);
  const [importError, setImportError] = useState('');
  const [reimporting, setReimporting] = useState(false);
  const [reimportResult, setReimportResult] = useState<string | null>(null);

  // Follow-up historical-leads opt-in (persisted into per-account follow-up settings).
  const [importFuHistorical, setImportFuHistorical] = useState(false);
  const [importFuHistoricalSaving, setImportFuHistoricalSaving] = useState(false);

  // Extension-collected counts for the active account
  const [extensionPendingCount, setExtensionPendingCount] = useState(0);
  const [extensionPendingIds, setExtensionPendingIds] = useState<string[]>([]);
  const [extensionImportedCount, setExtensionImportedCount] = useState(0);
  const [extensionTotalCount, setExtensionTotalCount] = useState(0);
  const [missingCount, setMissingCount] = useState<number | null>(null);
  const [needsScrapeCount, setNeedsScrapeCount] = useState<number | null>(null);

  // Collected leads modal
  const [showCollectedModal, setShowCollectedModal] = useState(false);
  const [collectedLeads, setCollectedLeads] = useState<any[]>([]);
  const [collectedLoading, setCollectedLoading] = useState(false);
  const [collectedSelected, setCollectedSelected] = useState<Set<string>>(new Set());
  const [collectedDeleting, setCollectedDeleting] = useState(false);
  const [collectedDeleteConfirm, setCollectedDeleteConfirm] = useState<{
    message: string; onConfirm: () => void;
  } | null>(null);

  // Budget snapshots & history modal
  const [budgetSnapshots, setBudgetSnapshots] = useState<BudgetSnapshot[]>([]);
  const [showBudgetModal, setShowBudgetModal] = useState(false);

  // Yelp per-month budget editor modal
  const [yelpBudgetEditing, setYelpBudgetEditing] = useState<{ accountId: string; accountName: string } | null>(null);
  const [yelpBudgetYear, setYelpBudgetYear] = useState(() => new Date().getFullYear());
  const [yelpBudgetInputs, setYelpBudgetInputs] = useState<Record<string, string>>({});
  const [yelpBudgetSaving, setYelpBudgetSaving] = useState(false);

  // Extension detection (Thumbtack + Yelp markers)
  const [ttExtensionInstalled, setTtExtensionInstalled] = useState<boolean | null>(null);
  const [yelpExtensionInstalled, setYelpExtensionInstalled] = useState<boolean | null>(null);
  const prevTtExtRef = useRef<boolean | null>(null);
  const prevYelpExtRef = useRef<boolean | null>(null);

  useEffect(() => {
    const check = () => {
      const html = document.documentElement;
      const tt = html.getAttribute('data-leadbridge-ext-thumbtack') === 'true';
      const generic = html.getAttribute('data-leadbridge-extension') === 'true';
      const yelp = html.getAttribute('data-leadbridge-ext-yelp') === 'true';
      const yelpType = html.getAttribute('data-leadbridge-ext-type') === 'yelp';
      setTtExtensionInstalled(tt || (generic && !yelp));
      setYelpExtensionInstalled(yelp || yelpType);
    };
    check();
    const timer = setTimeout(check, 1500);
    const onVisibility = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisibility);
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [
        'data-leadbridge-ext-thumbtack',
        'data-leadbridge-extension',
        'data-leadbridge-ext-yelp',
        'data-leadbridge-ext-type',
      ],
    });
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      observer.disconnect();
    };
  }, []);

  // Auto-expand the matching import card after the user installs the extension.
  useEffect(() => {
    if (ttExtensionInstalled === true) {
      if (localStorage.getItem('lb_expectingExtension') || prevTtExtRef.current === false) {
        localStorage.removeItem('lb_expectingExtension');
        setTtCollapsed(false);
      }
    }
    prevTtExtRef.current = ttExtensionInstalled;
  }, [ttExtensionInstalled]);

  useEffect(() => {
    if (yelpExtensionInstalled === true) {
      if (localStorage.getItem('lb_expectingYelpExtension') || prevYelpExtRef.current === false) {
        localStorage.removeItem('lb_expectingYelpExtension');
        setYelpCollapsed(false);
      }
    }
    prevYelpExtRef.current = yelpExtensionInstalled;
  }, [yelpExtensionInstalled]);

  // Hydrate the "Follow up historical leads" checkbox for the selected account.
  useEffect(() => {
    if (!importAccountId) { setImportFuHistorical(false); return; }
    let cancelled = false;
    followUpApi.getSettings(importAccountId).then((res: any) => {
      if (cancelled) return;
      setImportFuHistorical(Boolean(res?.settings?.followUpApplyToExisting));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [importAccountId]);

  // Reload collected/budget counts whenever the active import account changes.
  useEffect(() => {
    if (!importAccountId) {
      setExtensionPendingCount(0);
      setExtensionPendingIds([]);
      setExtensionImportedCount(0);
      setExtensionTotalCount(0);
      setMissingCount(null);
      setNeedsScrapeCount(null);
      setBudgetSnapshots([]);
      return;
    }
    integrationsApi.getCollectedLeads({ accountId: importAccountId }).then((res) => {
      const allLeads = res.leads || [];
      const pending = allLeads.filter((l: any) => !l.imported);
      const imported = allLeads.filter((l: any) => l.imported);
      setExtensionPendingCount(pending.length);
      setExtensionPendingIds(pending.map((l: any) => l.thumbtackId));
      setExtensionImportedCount(imported.length);
      setExtensionTotalCount(allLeads.length);
    }).catch(() => {
      setExtensionPendingCount(0);
      setExtensionPendingIds([]);
      setExtensionImportedCount(0);
      setExtensionTotalCount(0);
    });
    integrationsApi.getMissingCount(importAccountId).then((res) => {
      setMissingCount(res.missingCount);
    }).catch(() => setMissingCount(null));
    integrationsApi.getNeedsScrape(importAccountId).then((res) => {
      setNeedsScrapeCount(res.count);
    }).catch(() => setNeedsScrapeCount(null));
    integrationsApi.getBudgetSnapshots(importAccountId).then((res) => {
      setBudgetSnapshots(res.snapshots || []);
    }).catch(() => setBudgetSnapshots([]));
  }, [importAccountId]);

  // Listen for the extension's refresh ping so the user doesn't have to reload
  // the page after a fresh sync from the side panel.
  useEffect(() => {
    const handleRefresh = () => {
      if (!importAccountId) return;
      integrationsApi.getCollectedLeads({ accountId: importAccountId }).then((res) => {
        const allLeads = res.leads || [];
        const pending = allLeads.filter((l: any) => !l.imported);
        const imported = allLeads.filter((l: any) => l.imported);
        setExtensionPendingCount(pending.length);
        setExtensionPendingIds(pending.map((l: any) => l.thumbtackId));
        setExtensionImportedCount(imported.length);
        setExtensionTotalCount(allLeads.length);
      }).catch(() => {});
      integrationsApi.getBudgetSnapshots(importAccountId).then((res) => {
        setBudgetSnapshots(res.snapshots || []);
      }).catch(() => {});
    };
    document.addEventListener('leadbridge-refresh-import', handleRefresh);
    return () => document.removeEventListener('leadbridge-refresh-import', handleRefresh);
  }, [importAccountId]);

  // Seed the per-month budget inputs whenever the modal opens, the year
  // changes, or the underlying snapshots reload.
  useEffect(() => {
    if (!yelpBudgetEditing) return;
    const seeded: Record<string, string> = {};
    const latestByPeriod = new Map<string, string>();
    for (const s of budgetSnapshots) {
      if (s.snapshotType !== 'budget_monthly' || !s.scopeCategory) continue;
      if (!latestByPeriod.has(s.scopeCategory)) {
        latestByPeriod.set(s.scopeCategory, String(Number(s.weeklyBudget)));
      }
    }
    for (let m = 1; m <= 12; m++) {
      const key = `${yelpBudgetYear}-${String(m).padStart(2, '0')}`;
      seeded[key] = latestByPeriod.get(key) ?? '';
    }
    setYelpBudgetInputs(seeded);
  }, [yelpBudgetEditing, yelpBudgetYear, budgetSnapshots]);

  const refreshExtensionCounts = () => {
    if (!importAccountId) {
      setExtensionPendingCount(0); setExtensionPendingIds([]);
      setExtensionImportedCount(0); setExtensionTotalCount(0);
      return;
    }
    integrationsApi.getCollectedLeads({ accountId: importAccountId }).then((res) => {
      const allLeads = res.leads || [];
      const pending = allLeads.filter((l: any) => !l.imported);
      const imported = allLeads.filter((l: any) => l.imported);
      setExtensionPendingCount(pending.length);
      setExtensionPendingIds(pending.map((l: any) => l.thumbtackId));
      setExtensionImportedCount(imported.length);
      setExtensionTotalCount(allLeads.length);
    }).catch(() => {});
  };

  const openCollectedModal = async () => {
    setShowCollectedModal(true);
    setCollectedLoading(true);
    try {
      const res = await integrationsApi.getCollectedLeads(importAccountId ? { accountId: importAccountId } : {});
      setCollectedLeads(res.leads || []);
    } catch {
      setCollectedLeads([]);
    } finally {
      setCollectedLoading(false);
    }
  };

  const handleImportFromExtension = async () => {
    if (!importAccountId || extensionPendingIds.length === 0) return;

    setImporting(true);
    setImportError('');
    setImportResults([]);

    // Validate token; if invalid, silently reconnect, fall back to OAuth.
    try {
      const validation = await thumbtackApi.validateToken(importAccountId);
      if (!validation.valid) {
        try {
          await thumbtackApi.reconnectAccount(importAccountId);
        } catch {
          setImporting(false);
          const { authUrl } = await platformsApi.getAuthUrl(true);
          window.location.href = authUrl;
          return;
        }
      }
    } catch {
      setImporting(false);
      const { authUrl } = await platformsApi.getAuthUrl(true);
      window.location.href = authUrl;
      return;
    }

    setImportTotal(extensionPendingIds.length);
    setShowImportResults(true);

    const results: ImportResult[] = [];
    const successIds: string[] = [];
    const skippedOtherAccount: Array<{ id: string; ownerBusinessName: string | null }> = [];
    const skippedWrongScope: string[] = [];

    for (const id of extensionPendingIds) {
      let attempts = 0;
      let lastErr: any;
      let done = false;

      while (attempts < 3 && !done) {
        try {
          const result = await leadsApi.importNegotiation(id, importAccountId);
          if ((result as any).skipped) {
            const reason = (result as any).reason as string | undefined;
            if (reason === 'other_account') {
              skippedOtherAccount.push({ id, ownerBusinessName: (result as any).ownerBusinessName ?? null });
            } else if (reason === 'wrong_scope') {
              skippedWrongScope.push(id);
            }
            results.push({ id, success: false, error: (result as any).message || 'Skipped' });
          } else {
            results.push({ id, success: true, isNew: (result as any).isNew });
            successIds.push(id);
          }
          done = true;
        } catch (err: any) {
          lastErr = err;
          const isNetworkError = !err.response;
          attempts++;
          if (isNetworkError && attempts < 3) {
            await new Promise(resolve => setTimeout(resolve, 2000 * attempts));
          } else {
            break;
          }
        }
      }

      if (!done) {
        const errorMsg = lastErr?.response?.data?.message || lastErr?.response?.data?.error || lastErr?.message || 'Failed to import';
        results.push({ id, success: false, error: errorMsg });
      }

      setImportResults([...results]);
    }

    if (successIds.length > 0) {
      try { await integrationsApi.markLeadsImported(successIds); } catch { /* best effort */ }
    }

    setImporting(false);
    refreshExtensionCounts();

    const newCount = results.filter(r => r.success && r.isNew).length;
    const skippedCount = skippedOtherAccount.length + skippedWrongScope.length;
    const realFailCount = results.filter(r => !r.success).length - skippedCount;
    const skipDetail = skippedOtherAccount.length > 0
      ? ` (${skippedOtherAccount.length} already in ${[...new Set(skippedOtherAccount.map(s => s.ownerBusinessName).filter(Boolean))].join(', ') || 'another account'})`
      : '';
    if (newCount > 0 && realFailCount === 0 && skippedCount === 0) {
      notify.success('Import Complete', `Imported ${newCount} lead(s) from extension`);
    } else if (newCount > 0 && realFailCount === 0 && skippedCount > 0) {
      notify.success('Import Complete', `Imported ${newCount} lead(s); skipped ${skippedCount}${skipDetail}`);
    } else if (skippedCount > 0 && realFailCount === 0 && newCount === 0) {
      notify.success('Already Imported', `${skippedCount} lead(s) already exist${skipDetail} — nothing new to import`);
    } else if (realFailCount > 0 && newCount > 0) {
      notify.warning('Import Partial', `${newCount} imported, ${realFailCount} failed, ${skippedCount} skipped${skipDetail}`);
    } else if (realFailCount > 0) {
      setImportError(`Failed to import ${realFailCount} negotiation(s)${skippedCount > 0 ? ` (${skippedCount} skipped${skipDetail})` : ''}`);
    }
  };

  // Whether the active account belongs to the platform a given card is for.
  const activeAcc = accounts.find(a => a.id === importAccountId);
  const ttCardEligible = activeAcc?.platform === 'thumbtack';
  const yelpCardEligible = activeAcc?.platform === 'yelp';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SettingCard
        icon={Plug}
        iconTone="violet"
        title="Connected sources"
        subtitle="Manage authentication and lead routing for each platform."
        headerRight={
          <button
            type="button"
            onClick={() => setModal({ open: true, reconnect: null })}
            style={{
              padding: '8px 14px', fontSize: 13, fontWeight: 600,
              background: 'var(--lb-accent)', color: 'white',
              border: 0, borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <Plus size={14} /> Connect new
          </button>
        }
        contentPad="8px 24px 24px"
      >
        <div style={{ paddingTop: 4 }}>
          {accounts.length === 0 && (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--lb-ink-5)', fontSize: 13 }}>
              No sources connected yet. Click "Connect new" to get started.
            </div>
          )}
          {accounts.map((a: SavedAccount, i: number) => (
            <div key={a.id} style={{
              display: 'flex', alignItems: 'center', gap: 14,
              padding: '14px 0',
              borderBottom: i === accounts.length - 1 ? 'none' : '1px solid var(--lb-line-soft)',
            }}>
              <PlatformBadge platform={a.platform} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--lb-ink-1)' }}>{a.businessName || PLATFORM_LABEL[a.platform] || a.platform}</div>
                <div style={{ fontSize: 12, color: 'var(--lb-ink-5)' }}>
                  {PLATFORM_LABEL[a.platform] || a.platform}{a.emailHint ? ` · ${a.emailHint}` : ''}
                </div>
              </div>
              {a.tokenDead ? (
                <button
                  type="button"
                  onClick={() => setModal({ open: true, reconnect: a })}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '4px 10px', borderRadius: 999,
                    background: '#fef3c7', color: '#92400e',
                    fontSize: 11, fontWeight: 600,
                    border: 0, cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  <AlertTriangle size={11} /> Reconnect required
                </button>
              ) : (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '4px 10px', borderRadius: 999,
                  background: '#dcfce7', color: '#16a34a',
                  fontSize: 11, fontWeight: 600,
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: '#16a34a' }} />
                  Connected
                </span>
              )}
              <ActionLink onClick={() => goConfigure(a)}>Configure</ActionLink>
            </div>
          ))}
        </div>
      </SettingCard>

      {/* ──────────────────────────────────────────────────────────────
          ServiceFlow Connection (PR-C3) — orchestrated booking + lifecycle.
          Independent from the lead-source platforms above; renders even
          when no SF connection row exists yet (shows Connect button).
         ────────────────────────────────────────────────────────────── */}
      <ServiceFlowConnectionCard />

      {/* ──────────────────────────────────────────────────────────────
          Import & Sync — per-platform Chrome-extension import cards.
          Each card is independent (own collapse) but shares the
          `importAccountId` state (one active account at a time).
         ────────────────────────────────────────────────────────────── */}
      {(ttAccounts.length > 0 || yelpAccounts.length > 0) && (
        <SettingCard
          icon={Download}
          iconTone="blue"
          title="Import & sync"
          subtitle="Pull leads from connected sources via the LeadBridge Chrome extension."
          contentPad="16px 24px 24px"
        >
          <div className="space-y-3">

            {/* ── Thumbtack import card ─────────────────────────────── */}
            {ttAccounts.length > 0 && (
              <div className="bg-blue-50/50 rounded-2xl border border-blue-100 overflow-hidden">
                <div
                  className="flex items-center justify-between p-3 cursor-pointer hover:bg-blue-50 transition-colors"
                  onClick={() => setTtCollapsed(v => !v)}
                >
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white font-bold text-[10px]" style={{ background: 'var(--lb-thumbtack)' }}>TT</div>
                    <h4 className="text-sm font-bold text-slate-900">Import Negotiations (Thumbtack)</h4>
                  </div>
                  {ttCollapsed ? <ChevronDown className="w-5 h-5 text-slate-400" /> : <ChevronUp className="w-5 h-5 text-slate-400" />}
                </div>

                {!ttCollapsed && (
                  <div className="p-4 pt-0 space-y-3">
                    {importError && ttCardEligible && (
                      <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        <span className="flex-1">{importError}</span>
                        <button className="p-1 hover:bg-red-100 rounded transition-colors" onClick={() => setImportError('')}>
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    )}

                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-2">Select Thumbtack account</label>
                      <select
                        value={ttCardEligible ? (importAccountId || '') : ''}
                        onChange={(e) => {
                          const val = e.target.value || null;
                          setImportAccountId(val);
                          if (val) localStorage.setItem('lb_importAccountId', val);
                          else localStorage.removeItem('lb_importAccountId');
                        }}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                      >
                        <option value="">Choose account...</option>
                        {ttAccounts.map(a => (
                          <option key={a.id} value={a.id}>{a.businessName}</option>
                        ))}
                      </select>
                    </div>

                    {ttCardEligible && importAccountId && (
                      <label className="flex items-center gap-3 p-3 rounded-xl bg-white border border-slate-200 cursor-pointer hover:border-blue-200 transition-colors">
                        <input
                          type="checkbox"
                          checked={importFuHistorical}
                          disabled={importFuHistoricalSaving}
                          onChange={async (e) => {
                            const next = e.target.checked;
                            setImportFuHistorical(next);
                            setImportFuHistoricalSaving(true);
                            try {
                              await followUpApi.saveSettings(importAccountId, { includeHistorical: next } as any);
                            } catch {
                              setImportFuHistorical(!next);
                            } finally {
                              setImportFuHistoricalSaving(false);
                            }
                          }}
                          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        />
                        <div className="flex-1">
                          <span className="text-xs font-semibold text-slate-700">Follow up historical leads</span>
                          <span className="block text-[10px] text-slate-400">Enroll all previous conversations that haven't replied yet</span>
                        </div>
                        {importFuHistoricalSaving && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
                      </label>
                    )}

                    {ttCardEligible && importAccountId && (
                      <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                        {ttExtensionInstalled === null ? (
                          <div className="flex items-center gap-2 text-slate-400 text-sm">
                            <Loader2 size={14} className="animate-spin" />
                            <span>Checking for extension...</span>
                          </div>
                        ) : ttExtensionInstalled ? (
                          <>
                            <div className="flex items-center gap-2 mb-2">
                              <CheckCircle size={14} className="text-green-600" />
                              <span className="text-xs font-semibold text-green-700">Extension installed</span>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                onClick={() => {
                                  const acc = accounts.find(a => a.id === importAccountId);
                                  document.dispatchEvent(new CustomEvent('leadbridge-launch', {
                                    detail: { action: 'collect-leads', accountId: acc?.id || null, accountName: acc?.businessName || null, emailHint: acc?.emailHint || null },
                                  }));
                                }}
                                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 inline-flex items-center gap-1.5"
                              >
                                <Download size={13} /> Get IDs
                              </button>
                              <button
                                onClick={() => {
                                  const acc = accounts.find(a => a.id === importAccountId);
                                  document.dispatchEvent(new CustomEvent('leadbridge-launch', {
                                    detail: { action: 'sync-budget', accountId: acc?.id || null, accountName: acc?.businessName || null, emailHint: acc?.emailHint || null },
                                  }));
                                }}
                                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 inline-flex items-center gap-1.5"
                              >
                                <DollarSign size={13} /> Get Budget
                              </button>
                            </div>
                          </>
                        ) : (
                          <div className="flex items-center justify-between gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                            <div>
                              <p className="text-sm font-semibold text-amber-900">Extension not detected</p>
                              <p className="text-xs text-amber-700 mt-0.5">Install the LeadBridge Sync extension to collect IDs automatically.</p>
                            </div>
                            <a
                              href="https://chromewebstore.google.com/detail/leadbridge-sync-thumbtack/mkhkooldgglhnpkjfgmpkneongipfhnm"
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={() => localStorage.setItem('lb_expectingExtension', '1')}
                              className="px-3 py-2 rounded-xl text-xs font-semibold bg-amber-600 text-white hover:bg-amber-700 whitespace-nowrap inline-flex items-center gap-1.5 shrink-0"
                            >
                              Install Extension
                            </a>
                          </div>
                        )}
                      </div>
                    )}

                    {ttCardEligible && importAccountId && (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs">
                          <div className="flex items-center gap-1.5">
                            <Download size={13} className="text-slate-400" />
                            <span className="font-semibold text-slate-700">Leads:</span>
                            {extensionTotalCount > 0 ? (
                              <div className="flex items-center gap-3 ml-1">
                                <span className="text-slate-500"><span className="font-bold text-slate-900">{extensionTotalCount}</span> collected</span>
                                <span className="text-emerald-600"><span className="font-bold">{extensionImportedCount}</span> imported</span>
                                <span className={extensionPendingCount > 0 ? 'text-amber-600' : 'text-slate-400'}>
                                  <span className="font-bold">{extensionPendingCount}</span> pending
                                </span>
                              </div>
                            ) : (
                              <span className="text-slate-400 ml-1">No leads collected yet</span>
                            )}
                          </div>
                          {extensionTotalCount > 0 && (
                            <button onClick={openCollectedModal} className="text-blue-600 hover:text-blue-700 font-semibold hover:underline inline-flex items-center gap-1">
                              <List size={12} /> View
                            </button>
                          )}
                        </div>

                        <div className="flex items-center justify-between px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs">
                          <div className="flex items-center gap-1.5">
                            <DollarSign size={13} className="text-slate-400" />
                            <span className="font-semibold text-slate-700">Budget:</span>
                            {budgetSnapshots.length > 0 ? (
                              <div className="flex items-center gap-2 ml-1">
                                {Number(budgetSnapshots[0].weeklyBudget) === 0 ? (
                                  <span className="font-bold text-indigo-600">Unlimited</span>
                                ) : (
                                  <span className="text-slate-900">
                                    <span className="font-bold">${Number(budgetSnapshots[0].weeklyBudget).toFixed(0)}</span>
                                    <span className="text-slate-400">/{budgetSnapshots[0].currency}/wk</span>
                                  </span>
                                )}
                                {budgetSnapshots[0].active && <span className="px-1.5 py-0.5 bg-green-100 text-green-700 rounded-full text-[10px] font-bold">Active</span>}
                                <span className="text-slate-400">· {budgetSnapshots.length} snapshot{budgetSnapshots.length !== 1 ? 's' : ''}</span>
                              </div>
                            ) : (
                              <span className="text-slate-400 ml-1">No budget data yet</span>
                            )}
                          </div>
                          {budgetSnapshots.length > 0 && (
                            <button onClick={() => setShowBudgetModal(true)} className="text-blue-600 hover:text-blue-700 font-semibold hover:underline inline-flex items-center gap-1">
                              <Clock size={12} /> History
                            </button>
                          )}
                        </div>
                      </div>
                    )}

                    {ttCardEligible && importAccountId && extensionPendingCount > 0 && (
                      <div className="flex items-center justify-between p-3 bg-green-50 border border-green-100 rounded-xl">
                        <div>
                          <p className="text-sm font-semibold text-green-800">{extensionPendingCount} pending from extension</p>
                          <p className="text-xs text-green-600">Collected lead IDs ready to import</p>
                        </div>
                        <button
                          onClick={handleImportFromExtension}
                          disabled={importing}
                          className="px-4 py-2 bg-green-600 text-white rounded-xl text-sm font-semibold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
                        >
                          {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                          Import All
                        </button>
                      </div>
                    )}

                    {ttCardEligible && importAccountId && missingCount !== null && missingCount > 0 && (
                      <div className="flex items-center justify-between p-3 bg-amber-50 border border-amber-200 rounded-xl">
                        <div>
                          <p className="text-sm font-semibold text-amber-800">
                            {missingCount} lead{missingCount !== 1 ? 's' : ''} not imported yet
                          </p>
                          <p className="text-xs text-amber-600">Collected but missing from your leads list</p>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <button
                            onClick={async () => {
                              if (!confirm(`Import ${missingCount} missing lead(s)? This may take a while.`)) return;
                              setReimporting(true);
                              setReimportResult(null);
                              try {
                                const res = await integrationsApi.reimportFailed(importAccountId);
                                setReimportResult(`Done: ${res.imported} imported, ${res.failed} failed`);
                                integrationsApi.getMissingCount(importAccountId).then((r) => setMissingCount(r.missingCount)).catch(() => {});
                              } catch {
                                setReimportResult('Import failed');
                              } finally {
                                setReimporting(false);
                              }
                            }}
                            disabled={reimporting || importing}
                            className="px-3 py-1.5 bg-amber-600 text-white rounded-xl text-xs font-semibold hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
                          >
                            {reimporting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                            Import Missing
                          </button>
                          {reimportResult && <span className="text-xs text-slate-500">{reimportResult}</span>}
                        </div>
                      </div>
                    )}

                    {ttCardEligible && importAccountId && needsScrapeCount !== null && needsScrapeCount > 0 && (
                      <div className="flex items-center justify-between p-3 bg-orange-50 border border-orange-200 rounded-xl">
                        <div>
                          <p className="text-sm font-semibold text-orange-800">
                            {needsScrapeCount} lead{needsScrapeCount !== 1 ? 's' : ''} missing details
                          </p>
                          <p className="text-xs text-orange-600">Re-run the extension to scrape missing data from Thumbtack pages</p>
                        </div>
                        <button
                          onClick={() => {
                            document.dispatchEvent(new CustomEvent('leadbridge-scrape-missing', {
                              detail: {
                                accountId: importAccountId,
                                apiUrl: import.meta.env.VITE_API_URL?.replace('/api', '') || '',
                              },
                            }));
                          }}
                          className="px-3 py-1.5 bg-orange-600 text-white rounded-xl text-xs font-semibold hover:bg-orange-700 inline-flex items-center gap-1.5"
                        >
                          <RefreshCw className="w-3 h-3" />
                          Re-run Extension
                        </button>
                      </div>
                    )}

                    {ttCardEligible && importing && importTotal > 0 && (
                      <div className="space-y-2">
                        <div className="flex justify-between text-sm">
                          <span className="font-medium text-slate-700">Importing...</span>
                          <span className="text-slate-500">{importResults.length} / {importTotal}</span>
                        </div>
                        <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full bg-blue-600 rounded-full transition-all duration-300" style={{ width: `${(importResults.length / importTotal) * 100}%` }} />
                        </div>
                      </div>
                    )}

                    {ttCardEligible && showImportResults && importResults.length > 0 && !importing && (
                      <div className="space-y-2">
                        <h4 className="text-sm font-bold text-slate-700">Results ({importResults.length} / {importTotal})</h4>
                        <div className="space-y-2 max-h-48 overflow-y-auto">
                          {importResults.map((result, idx) => (
                            <div key={idx} className="flex items-center justify-between p-2 rounded-xl bg-white border border-slate-100 text-sm">
                              <span className="font-mono text-xs text-slate-600">{result.id}</span>
                              {result.success ? (
                                <span className="flex items-center gap-1.5">
                                  <CheckCircle className={`w-4 h-4 ${result.isNew ? 'text-emerald-500' : 'text-blue-500'}`} />
                                  <span className={`text-xs font-medium ${result.isNew ? 'text-emerald-600' : 'text-blue-600'}`}>
                                    {result.isNew ? 'New' : 'Exists'}
                                  </span>
                                </span>
                              ) : (
                                <span className="flex items-center gap-1.5">
                                  <AlertCircle className="w-4 h-4 text-red-500" />
                                  <span className="text-xs text-red-600 max-w-[200px] truncate" title={result.error}>
                                    {result.error}
                                  </span>
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── Yelp import card ──────────────────────────────────── */}
            {yelpAccounts.length > 0 && (
              <div className="bg-red-50/50 rounded-2xl border border-red-100 overflow-hidden">
                <div
                  className="flex items-center justify-between p-3 cursor-pointer hover:bg-red-50 transition-colors"
                  onClick={() => setYelpCollapsed(v => !v)}
                >
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white font-bold text-[10px]" style={{ background: 'var(--lb-yelp)' }}>Y</div>
                    <h4 className="text-sm font-bold text-slate-900">Import Yelp Leads</h4>
                  </div>
                  {yelpCollapsed ? <ChevronDown className="w-5 h-5 text-slate-400" /> : <ChevronUp className="w-5 h-5 text-slate-400" />}
                </div>

                {!yelpCollapsed && (
                  <div className="p-4 pt-0 space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-2">Select Yelp Account</label>
                      <select
                        value={yelpCardEligible ? (importAccountId || '') : ''}
                        onChange={(e) => {
                          const val = e.target.value || null;
                          setImportAccountId(val);
                          if (val) localStorage.setItem('lb_importAccountId', val);
                          else localStorage.removeItem('lb_importAccountId');
                        }}
                        className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-red-100 focus:border-red-300"
                      >
                        <option value="">Choose account...</option>
                        {yelpAccounts.map(a => (
                          <option key={a.id} value={a.id}>{a.businessName}</option>
                        ))}
                      </select>
                    </div>

                    {yelpCardEligible && importAccountId && (
                      <label className="flex items-center gap-3 p-3 rounded-xl bg-white border border-slate-200 cursor-pointer hover:border-red-200 transition-colors">
                        <input
                          type="checkbox"
                          checked={importFuHistorical}
                          disabled={importFuHistoricalSaving}
                          onChange={async (e) => {
                            const next = e.target.checked;
                            setImportFuHistorical(next);
                            setImportFuHistoricalSaving(true);
                            try {
                              await followUpApi.saveSettings(importAccountId, { includeHistorical: next } as any);
                            } catch {
                              setImportFuHistorical(!next);
                            } finally {
                              setImportFuHistoricalSaving(false);
                            }
                          }}
                          className="w-4 h-4 rounded border-slate-300 text-red-600 focus:ring-red-500"
                        />
                        <div className="flex-1">
                          <span className="text-xs font-semibold text-slate-700">Follow up historical leads</span>
                          <span className="block text-[10px] text-slate-400">Enroll all previous conversations that haven't replied yet</span>
                        </div>
                        {importFuHistoricalSaving && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
                      </label>
                    )}

                    {yelpCardEligible && importAccountId && (
                      <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                        {yelpExtensionInstalled === null ? (
                          <div className="flex items-center gap-2 text-slate-400 text-sm">
                            <Loader2 size={14} className="animate-spin" />
                            <span>Checking for extension...</span>
                          </div>
                        ) : yelpExtensionInstalled ? (
                          <>
                            <div className="flex items-center gap-2 mb-2">
                              <CheckCircle size={14} className="text-green-600" />
                              <span className="text-xs font-semibold text-green-700">Yelp Sync extension detected</span>
                            </div>
                            <button
                              onClick={() => {
                                const acc = accounts.find(a => a.id === importAccountId);
                                if (!acc) return;
                                localStorage.setItem('lb_yelp_launch_accountId', acc.id);
                                localStorage.setItem('lb_yelp_launch_accountName', acc.businessName);
                                window.dispatchEvent(new CustomEvent('leadbridge-yelp-launch', {
                                  detail: {
                                    action: 'sync-leads',
                                    accountId: acc.id,
                                    accountName: acc.businessName,
                                    businessId: acc.businessId,
                                    autoStart: true,
                                  },
                                }));
                              }}
                              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-600 text-white hover:bg-red-700 inline-flex items-center gap-1.5"
                            >
                              <Download size={13} /> Get IDs
                            </button>
                            <p className="text-[10px] text-slate-400 mt-1">Opens Yelp inbox and starts syncing automatically.</p>
                          </>
                        ) : (
                          <div className="flex items-center justify-between gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                            <div>
                              <p className="text-sm font-semibold text-amber-900">Extension not detected</p>
                              <p className="text-xs text-amber-700 mt-0.5">Install the LeadBridge Sync - Yelp extension to import leads.</p>
                            </div>
                            <a
                              href="https://chromewebstore.google.com/detail/olpfodkjdkcmdmombgifpnnhmaecfkmg"
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={() => localStorage.setItem('lb_expectingYelpExtension', '1')}
                              className="px-3 py-2 rounded-xl text-xs font-semibold bg-amber-600 text-white hover:bg-amber-700 whitespace-nowrap inline-flex items-center gap-1.5 shrink-0"
                            >
                              Install Extension
                            </a>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Leads counts (Yelp) */}
                    {yelpCardEligible && importAccountId && (
                      <div className="flex items-center justify-between px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs">
                        <div className="flex items-center gap-1.5">
                          <Download size={13} className="text-slate-400" />
                          <span className="font-semibold text-slate-700">Leads:</span>
                          {extensionTotalCount > 0 ? (
                            <div className="flex items-center gap-3 ml-1">
                              <span className="text-slate-500"><span className="font-bold text-slate-900">{extensionTotalCount}</span> collected</span>
                              <span className="text-emerald-600"><span className="font-bold">{extensionImportedCount}</span> imported</span>
                              <span className={extensionPendingCount > 0 ? 'text-amber-600' : 'text-slate-400'}>
                                <span className="font-bold">{extensionPendingCount}</span> pending
                              </span>
                            </div>
                          ) : (
                            <span className="text-slate-400 ml-1">No leads collected yet</span>
                          )}
                        </div>
                        {extensionTotalCount > 0 && (
                          <button onClick={openCollectedModal} className="text-red-600 hover:text-red-700 font-semibold hover:underline inline-flex items-center gap-1">
                            <List size={12} /> View
                          </button>
                        )}
                      </div>
                    )}

                    {/* Monthly Budget — per-month manual entry (Yelp doesn't expose a budget API). */}
                    {yelpCardEligible && importAccountId && (() => {
                      const acc = accounts.find(a => a.id === importAccountId);
                      const monthlyByPeriod = new Map<string, { weeklyBudget: string; currency: string }>();
                      for (const s of budgetSnapshots) {
                        if (s.snapshotType !== 'budget_monthly' || !s.scopeCategory) continue;
                        if (!s.active && monthlyByPeriod.has(s.scopeCategory)) continue;
                        if (!monthlyByPeriod.has(s.scopeCategory)) {
                          monthlyByPeriod.set(s.scopeCategory, { weeklyBudget: s.weeklyBudget, currency: s.currency });
                        }
                      }
                      const setMonthsCount = monthlyByPeriod.size;
                      return (
                        <div className="flex items-center justify-between px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs">
                          <div className="flex items-center gap-1.5">
                            <DollarSign size={13} className="text-slate-400" />
                            <span className="font-semibold text-slate-700">Monthly Budget:</span>
                            <span className="text-slate-900 ml-1">
                              {setMonthsCount > 0
                                ? <><span className="font-bold">{setMonthsCount}</span> {setMonthsCount === 1 ? 'month' : 'months'} set</>
                                : <span className="text-slate-400">Not set</span>}
                            </span>
                          </div>
                          <button
                            onClick={() => {
                              if (!acc) return;
                              setYelpBudgetEditing({ accountId: acc.id, accountName: acc.businessName });
                            }}
                            className="text-red-600 hover:text-red-700 font-semibold hover:underline inline-flex items-center gap-1"
                          >
                            {setMonthsCount > 0 ? <><Pencil size={12} /> Manage</> : <><DollarSign size={12} /> Add Budget</>}
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}

          </div>
        </SettingCard>
      )}

      <FooterBanner
        icon={Info}
        body="Disconnecting a source pauses automation for that account but preserves the historical lead data."
      />

      <ConnectionModal
        isOpen={modal.open}
        onClose={() => setModal({ open: false, reconnect: null })}
        accountToReconnect={modal.reconnect}
        savedAccounts={accounts}
        onSuccess={() => setModal({ open: false, reconnect: null })}
      />

      {/* ── Collected Leads modal ───────────────────────────────── */}
      {showCollectedModal && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => { setShowCollectedModal(false); setCollectedSelected(new Set()); }}
        >
          <div className="relative bg-white rounded-3xl p-6 max-w-3xl w-full shadow-2xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-slate-900">Collected Leads</h3>
                {!collectedLoading && collectedLeads.length > 0 && (
                  <p className="text-sm text-slate-500 mt-0.5">
                    {collectedLeads.filter(l => l.imported).length} imported · {collectedLeads.filter(l => !l.imported).length} pending · {collectedLeads.length} total
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {collectedSelected.size > 0 && (
                  <button
                    disabled={collectedDeleting}
                    onClick={() => {
                      const count = collectedSelected.size;
                      setCollectedDeleteConfirm({
                        message: `Delete ${count} selected lead${count !== 1 ? 's' : ''}? This cannot be undone.`,
                        onConfirm: async () => {
                          setCollectedDeleteConfirm(null);
                          setCollectedDeleting(true);
                          try {
                            await integrationsApi.deleteCollectedLeads(Array.from(collectedSelected));
                            setCollectedLeads(prev => prev.filter(l => !collectedSelected.has(l.thumbtackId)));
                            setCollectedSelected(new Set());
                            refreshExtensionCounts();
                            notify.success('Deleted', `Deleted ${count} leads`);
                          } catch { notify.error('Error', 'Delete failed'); }
                          setCollectedDeleting(false);
                        },
                      });
                    }}
                    className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    {collectedDeleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    Delete ({collectedSelected.size})
                  </button>
                )}
                {!collectedLoading && collectedLeads.length > 0 && (
                  <button
                    disabled={collectedDeleting}
                    onClick={() => {
                      const count = collectedLeads.length;
                      setCollectedDeleteConfirm({
                        message: `Delete all ${count} collected lead${count !== 1 ? 's' : ''}? This cannot be undone.`,
                        onConfirm: async () => {
                          setCollectedDeleteConfirm(null);
                          setCollectedDeleting(true);
                          try {
                            const res = await integrationsApi.deleteCollectedLeads();
                            setCollectedLeads([]);
                            setCollectedSelected(new Set());
                            refreshExtensionCounts();
                            notify.success('Deleted', `Deleted ${res.deletedCount} leads`);
                          } catch { notify.error('Error', 'Delete failed'); }
                          setCollectedDeleting(false);
                        },
                      });
                    }}
                    className="px-3 py-1.5 rounded-xl text-xs font-semibold text-red-600 bg-white border border-red-200 hover:bg-red-50 disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    <Trash2 size={13} /> Delete All
                  </button>
                )}
                <button
                  className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-all"
                  onClick={() => { setShowCollectedModal(false); setCollectedSelected(new Set()); }}
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <div className="overflow-y-auto flex-1">
              {collectedLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : collectedLeads.length === 0 ? (
                <div className="text-center py-12 text-slate-400">No collected leads yet</div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-100">
                      <th className="py-2.5 px-2 w-8">
                        <input
                          type="checkbox"
                          checked={collectedSelected.size > 0 && collectedSelected.size === collectedLeads.length}
                          onChange={() => {
                            if (collectedSelected.size === collectedLeads.length) setCollectedSelected(new Set());
                            else setCollectedSelected(new Set(collectedLeads.map(l => l.thumbtackId)));
                          }}
                          className="rounded border-slate-300"
                        />
                      </th>
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">Customer</th>
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">ID</th>
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">Lead Date</th>
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">TT Status</th>
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {collectedLeads.map((lead: any) => (
                      <tr key={lead.id} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                        <td className="py-2.5 px-2">
                          <input
                            type="checkbox"
                            checked={collectedSelected.has(lead.thumbtackId)}
                            onChange={() => {
                              setCollectedSelected(prev => {
                                const next = new Set(prev);
                                if (next.has(lead.thumbtackId)) next.delete(lead.thumbtackId);
                                else next.add(lead.thumbtackId);
                                return next;
                              });
                            }}
                            className="rounded border-slate-300"
                          />
                        </td>
                        <td className="py-2.5 px-3 text-sm font-medium text-slate-900">{lead.customerName || '-'}</td>
                        <td className="py-2.5 px-3">
                          <code className="text-xs font-mono text-slate-700 bg-slate-50 px-2 py-0.5 rounded">{lead.thumbtackId}</code>
                        </td>
                        <td className="py-2.5 px-3 text-sm text-slate-600">
                          {lead.leadDate || new Date(lead.collectedAt || lead.capturedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </td>
                        <td className="py-2.5 px-3 text-sm text-slate-500">{lead.thumbtackStatus || '-'}</td>
                        <td className="py-2.5 px-3">
                          {lead.imported ? (
                            <span className="px-2.5 py-1 bg-green-100 text-green-700 rounded-full text-xs font-bold inline-flex items-center gap-1">
                              <CheckCircle size={12} /> Imported
                            </span>
                          ) : lead.needsRefetch ? (
                            <span className="px-2.5 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-bold inline-flex items-center gap-1">
                              <ArrowUpRight size={12} /> Needs Refetch
                            </span>
                          ) : (
                            <span className="px-2.5 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-bold inline-flex items-center gap-1">
                              <Clock size={12} /> Pending
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {collectedDeleteConfirm && (
              <div className="absolute inset-0 bg-black/40 backdrop-blur-sm rounded-3xl flex items-center justify-center z-10">
                <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full mx-4 p-5 space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-red-100 rounded-full">
                      <AlertTriangle className="w-5 h-5 text-red-600" />
                    </div>
                    <h4 className="text-base font-bold text-slate-900">Delete Leads</h4>
                  </div>
                  <p className="text-sm text-slate-600">{collectedDeleteConfirm.message}</p>
                  <div className="flex justify-end gap-3">
                    <button
                      onClick={() => setCollectedDeleteConfirm(null)}
                      className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={collectedDeleteConfirm.onConfirm}
                      className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-red-600 hover:bg-red-700 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Budget History modal (Thumbtack) ─────────────────────── */}
      {showBudgetModal && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => setShowBudgetModal(false)}
        >
          <div className="bg-white rounded-3xl p-6 max-w-2xl w-full shadow-2xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-xl font-bold text-slate-900">Budget History</h3>
                <p className="text-sm text-slate-500 mt-0.5">
                  {budgetSnapshots.length} snapshot{budgetSnapshots.length !== 1 ? 's' : ''}
                </p>
              </div>
              <button
                className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-all"
                onClick={() => setShowBudgetModal(false)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="overflow-y-auto flex-1">
              {budgetSnapshots.length === 0 ? (
                <div className="text-center py-12 text-slate-400">No budget snapshots yet</div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-100">
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">Budget</th>
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">Category</th>
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">Captured</th>
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">Effective</th>
                      <th className="text-left py-2.5 px-3 text-xs font-bold text-slate-400 uppercase tracking-wide">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {budgetSnapshots.map((snap) => (
                      <tr key={snap.id} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                        <td className="py-2.5 px-3">
                          {Number(snap.weeklyBudget) === 0 ? (
                            <span className="text-sm font-bold text-indigo-600">Unlimited</span>
                          ) : (
                            <span className="text-sm font-bold text-slate-900">
                              ${Number(snap.weeklyBudget).toFixed(0)}
                              <span className="text-xs text-slate-400 ml-0.5 font-normal">/{snap.currency}/wk</span>
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-sm text-slate-600">{snap.scopeCategory || '-'}</td>
                        <td className="py-2.5 px-3 text-sm text-slate-500">
                          {new Date(snap.capturedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                        </td>
                        <td className="py-2.5 px-3 text-sm text-slate-500">
                          {new Date(snap.effectiveFrom).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                          {snap.effectiveTo ? ` – ${new Date(snap.effectiveTo).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ' – now'}
                        </td>
                        <td className="py-2.5 px-3">
                          {snap.active ? (
                            <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs font-bold">Active</span>
                          ) : (
                            <span className="px-2 py-0.5 bg-slate-100 text-slate-500 rounded-full text-xs font-bold">Closed</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Yelp Per-Month Budget editor modal ──────────────────── */}
      {yelpBudgetEditing && (() => {
        const persisted = new Map<string, string>();
        for (const s of budgetSnapshots) {
          if (s.snapshotType !== 'budget_monthly' || !s.scopeCategory) continue;
          if (!persisted.has(s.scopeCategory)) {
            persisted.set(s.scopeCategory, String(Number(s.weeklyBudget)));
          }
        }
        const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const currentYear = new Date().getFullYear();
        return (
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
            onClick={() => !yelpBudgetSaving && setYelpBudgetEditing(null)}
          >
            <div
              className="bg-white rounded-3xl p-6 max-w-lg w-full shadow-2xl max-h-[85vh] flex flex-col"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-lg font-bold text-slate-900">Monthly Yelp Budget</h3>
                  <p className="text-xs text-slate-500 mt-0.5 truncate">{yelpBudgetEditing.accountName}</p>
                </div>
                <button
                  disabled={yelpBudgetSaving}
                  onClick={() => setYelpBudgetEditing(null)}
                  className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-all disabled:opacity-40"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="flex items-center justify-between mb-3">
                <button
                  disabled={yelpBudgetSaving}
                  onClick={() => setYelpBudgetYear(y => y - 1)}
                  className="p-1.5 rounded-lg hover:bg-slate-100 disabled:opacity-40"
                  aria-label="Previous year"
                >
                  <ChevronUp size={16} className="rotate-[-90deg]" />
                </button>
                <span className="text-base font-bold text-slate-900">{yelpBudgetYear}</span>
                <button
                  disabled={yelpBudgetSaving || yelpBudgetYear >= currentYear + 1}
                  onClick={() => setYelpBudgetYear(y => y + 1)}
                  className="p-1.5 rounded-lg hover:bg-slate-100 disabled:opacity-40"
                  aria-label="Next year"
                >
                  <ChevronDown size={16} className="rotate-[-90deg]" />
                </button>
              </div>

              <p className="text-[11px] text-slate-400 mb-3">
                Yelp doesn't expose budgets via API — enter the value you set in your Yelp Ads dashboard for each month. Leave blank to clear.
              </p>

              <div className="overflow-y-auto flex-1 -mx-1 px-1">
                <div className="grid grid-cols-2 gap-2">
                  {monthLabels.map((label, idx) => {
                    const m = idx + 1;
                    const key = `${yelpBudgetYear}-${String(m).padStart(2, '0')}`;
                    const val = yelpBudgetInputs[key] ?? '';
                    const wasSet = persisted.has(key);
                    return (
                      <label key={key} className="flex items-center gap-2">
                        <span className="w-9 shrink-0 text-xs font-semibold text-slate-600">{label}</span>
                        <div className="relative flex-1">
                          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs font-semibold">$</span>
                          <input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="1"
                            placeholder={wasSet ? '' : '0'}
                            value={val}
                            onChange={e => setYelpBudgetInputs(s => ({ ...s, [key]: e.target.value }))}
                            disabled={yelpBudgetSaving}
                            className={`w-full pl-6 pr-2 py-1.5 border rounded-lg text-sm font-medium focus:ring-2 focus:ring-red-100 focus:border-red-300 disabled:opacity-50 ${wasSet ? 'border-slate-300 bg-white' : 'border-slate-200 bg-slate-50'}`}
                          />
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="flex justify-end gap-2 mt-5">
                <button
                  disabled={yelpBudgetSaving}
                  onClick={() => setYelpBudgetEditing(null)}
                  className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  disabled={yelpBudgetSaving}
                  onClick={async () => {
                    const writes: Array<{ period: string; amount: number }> = [];
                    for (const [period, raw] of Object.entries(yelpBudgetInputs)) {
                      if (!period.startsWith(`${yelpBudgetYear}-`)) continue;
                      const trimmed = raw.trim();
                      if (trimmed === '') continue;
                      const amount = Number(trimmed);
                      if (Number.isNaN(amount) || amount < 0) continue;
                      const before = persisted.get(period);
                      if (before != null && Number(before) === amount) continue;
                      writes.push({ period, amount });
                    }
                    if (writes.length === 0) {
                      notify.info('No changes', 'Nothing to save for this year.');
                      return;
                    }
                    setYelpBudgetSaving(true);
                    try {
                      for (const w of writes) {
                        await integrationsApi.saveBudgetSnapshot({
                          savedAccountId: yelpBudgetEditing.accountId,
                          provider: 'yelp',
                          amount: w.amount,
                          cadence: 'monthly',
                          periodMonth: w.period,
                        });
                      }
                      const res = await integrationsApi.getBudgetSnapshots(yelpBudgetEditing.accountId);
                      setBudgetSnapshots(res.snapshots || []);
                      notify.success('Budgets saved', `${writes.length} ${writes.length === 1 ? 'month' : 'months'} updated`);
                      setYelpBudgetEditing(null);
                    } catch (err: any) {
                      notify.error('Save failed', err?.message || 'Could not save budgets');
                    } finally {
                      setYelpBudgetSaving(false);
                    }
                  }}
                  className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-red-600 hover:bg-red-700 inline-flex items-center gap-2 disabled:opacity-40"
                >
                  {yelpBudgetSaving && <Loader2 size={14} className="animate-spin" />}
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function PlatformBadge({ platform }: { platform: string }) {
  const label = PLATFORM_LABEL[platform] || platform;
  const color = PLATFORM_COLOR[platform] || 'var(--lb-ink-5)';
  const letter = (label[0] || '?').toUpperCase();
  return (
    <div style={{
      width: 36, height: 36, borderRadius: 8,
      background: color, color: 'white',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 14, fontWeight: 700, flexShrink: 0,
    }}>
      {letter}
    </div>
  );
}
