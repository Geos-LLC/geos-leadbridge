import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ExternalLink, Loader2, Plus, ShieldAlert, Sparkles, Wrench } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  serviceProfilePresetsApi,
  serviceProfilesApi,
  type ServiceProfile,
  type ServiceProfilePreset,
} from '../../../services/api';
import { useAppStore } from '../../../store/appStore';
import { notify } from '../../../store/notificationStore';
import { WizardStepActions } from '../WizardStepActions';

interface Props {
  onSaveContinue: () => Promise<void> | void;
  onSkipFallback: () => Promise<void> | void;
  saving: boolean;
  setSaving: (v: boolean) => void;
}

interface AccountAssignmentRow {
  savedAccountId: string;
  businessName: string;
  platform: string;
  configured: boolean;
  enabledServiceProfileIds: string[];
  defaultServiceProfileId: string | null;
}

/**
 * Wizard "Services" step (multi-service refactor 2026-06-18).
 *
 * For each connected SavedAccount, lets the operator pick which
 * ServiceProfiles that account offers, plus an optional account-level
 * default. Writes via PUT /v1/saved-accounts/:id/service-assignments.
 *
 * Also exposes two ways to add a service in-place:
 *   1. From a preset/template (curated code presets + admin templates).
 *   2. Custom (blank profile with just a name).
 *
 * Skip path: marks the step skipped and warns that AI will resolve via
 * the tenant's default ServiceProfile until assignments are configured.
 * Does NOT touch any assignment rows on skip — null assignment means
 * "use the runtime legacy fallback".
 */
export default function ServicesOfferedStep({
  onSaveContinue,
  onSkipFallback,
  saving,
  setSaving,
}: Props) {
  const navigate = useNavigate();
  const savedAccounts = useAppStore(s => s.savedAccounts);

  const [profiles, setProfiles] = useState<ServiceProfile[]>([]);
  const [assignments, setAssignments] = useState<AccountAssignmentRow[]>([]);
  const [presets, setPresets] = useState<ServiceProfilePreset[]>([]);
  const [loading, setLoading] = useState(true);

  // "Add service" panel state.
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [selectedPresetKey, setSelectedPresetKey] = useState<string>('');
  const [customName, setCustomName] = useState('');
  const [creating, setCreating] = useState(false);

  // Refresh the full step state (profiles + assignments). Called on
  // mount and after every mutation so the checkboxes reflect server
  // state without a page reload.
  async function refreshState() {
    try {
      const [profilesRes, assignmentsRes, presetsRes] = await Promise.all([
        serviceProfilesApi.list(),
        serviceProfilesApi.listSavedAccountAssignments(),
        serviceProfilePresetsApi.list().catch(() => ({ presets: [] as ServiceProfilePreset[] })),
      ]);
      setProfiles(profilesRes.profiles ?? []);
      setAssignments(assignmentsRes.accounts ?? []);
      setPresets(presetsRes.presets ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Only show active + draft services in the picker — archived are
  // hidden everywhere in the resolver, so they should be hidden here
  // too. Sort: default first, then active before draft, then by name.
  const availableServices = useMemo(
    () => profiles
      .filter(p => p.status !== 'archived')
      .sort((a, b) => {
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
    [profiles],
  );

  const hasAnyActive = availableServices.some(s => s.status === 'active');

  // Toggle one service for one account — write-through to backend so
  // the user doesn't need a per-row Save button. Optimistic UI: update
  // local state immediately, roll back on failure.
  async function toggleAssignment(savedAccountId: string, serviceProfileId: string) {
    const row = assignments.find(a => a.savedAccountId === savedAccountId);
    const existing = row?.enabledServiceProfileIds ?? [];
    const next = existing.includes(serviceProfileId)
      ? existing.filter(id => id !== serviceProfileId)
      : [...existing, serviceProfileId];

    // If we just removed the current default, drop it too — the
    // backend would 400 otherwise (default must be in enabled list).
    const nextDefault =
      row?.defaultServiceProfileId && next.includes(row.defaultServiceProfileId)
        ? row.defaultServiceProfileId
        : null;

    // Optimistic update.
    setAssignments(prev => prev.map(a =>
      a.savedAccountId === savedAccountId
        ? { ...a, configured: true, enabledServiceProfileIds: next, defaultServiceProfileId: nextDefault }
        : a,
    ));

    try {
      await serviceProfilesApi.setSavedAccountAssignments(savedAccountId, {
        enabledServiceProfileIds: next,
        defaultServiceProfileId: nextDefault,
      });
    } catch (err: any) {
      // Roll back on failure.
      await refreshState();
      notify.error(
        'Could not save assignment',
        err.response?.data?.message || 'Please try again.',
      );
    }
  }

  // Pick the default service for one account. Default must be in the
  // enabled list — if the user hasn't enabled it yet, enable it as part
  // of the same call.
  async function setDefaultFor(savedAccountId: string, serviceProfileId: string | null) {
    const row = assignments.find(a => a.savedAccountId === savedAccountId);
    let next = row?.enabledServiceProfileIds ?? [];
    if (serviceProfileId && !next.includes(serviceProfileId)) {
      next = [...next, serviceProfileId];
    }

    setAssignments(prev => prev.map(a =>
      a.savedAccountId === savedAccountId
        ? { ...a, configured: true, enabledServiceProfileIds: next, defaultServiceProfileId: serviceProfileId }
        : a,
    ));

    try {
      await serviceProfilesApi.setSavedAccountAssignments(savedAccountId, {
        enabledServiceProfileIds: next,
        defaultServiceProfileId: serviceProfileId,
      });
    } catch (err: any) {
      await refreshState();
      notify.error('Could not set default', err.response?.data?.message || 'Please try again.');
    }
  }

  async function handleCreateFromPreset() {
    if (!selectedPresetKey || creating) return;
    const preset = presets.find(p =>
      (p.source === 'code_preset' && p.presetKey === selectedPresetKey)
      || (p.source === 'admin_template' && p.templateId === selectedPresetKey),
    );
    if (!preset) {
      notify.error('Pick a service template', 'Select one from the dropdown first.');
      return;
    }
    setCreating(true);
    try {
      await serviceProfilePresetsApi.createFromPreset(
        preset.source === 'code_preset'
          ? { presetKey: preset.presetKey!, status: 'active' }
          : { templateId: preset.templateId! },
      );
      setSelectedPresetKey('');
      await refreshState();
      notify.success('Service added', `${preset.label} is ready to set up.`);
    } catch (err: any) {
      notify.error(
        'Could not add service',
        err.response?.data?.message || 'Please try again.',
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleCreateCustom() {
    const name = customName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      await serviceProfilesApi.createBlank(name);
      setCustomName('');
      await refreshState();
      notify.success('Service added', `${name} is ready to set up.`);
    } catch (err: any) {
      notify.error(
        'Could not add service',
        err.response?.data?.message || 'Please try again.',
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleContinue() {
    if (saving) return;
    setSaving(true);
    try {
      await onSaveContinue();
    } finally {
      setSaving(false);
    }
  }

  async function handleSkip() {
    if (saving) return;
    setSaving(true);
    try {
      await onSkipFallback();
    } finally {
      setSaving(false);
    }
  }

  const noAccounts = savedAccounts.length === 0;
  const hasUnconfiguredAccount = assignments.some(a => !a.configured);

  return (
    <div className="pt-2">
      <WizardStepActions>
        <button
          type="button"
          onClick={() => void handleContinue()}
          disabled={saving}
          className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-md shadow-blue-200 transition-all"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {saving ? 'Continuing…' : 'Save & Continue'}
          {!saving && <ArrowRight className="w-4 h-4" />}
        </button>
        <button
          type="button"
          onClick={() => void handleSkip()}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-all"
        >
          Skip — use default service for now
        </button>
        <button
          type="button"
          onClick={() => navigate('/settings?tab=accounts')}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-all"
        >
          Manage services in Settings
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
      </WizardStepActions>

      {loading ? (
        <div className="py-12 text-center text-sm text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        </div>
      ) : noAccounts ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-600">
          You haven't connected any accounts yet, so there's nothing to
          assign services to. Go back to the{' '}
          <strong>Connect</strong> step first.
        </div>
      ) : (
        <>
          {/* Per-account assignment grid. Each account row carries
              its own checkbox list + default radio. */}
          <div className="space-y-4">
            {savedAccounts.map(account => {
              const row = assignments.find(a => a.savedAccountId === account.id);
              const enabled = row?.enabledServiceProfileIds ?? [];
              const currentDefault = row?.defaultServiceProfileId ?? null;
              return (
                <div
                  key={account.id}
                  className="rounded-2xl border border-slate-200 bg-white p-5"
                >
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div>
                      <div className="text-sm font-bold text-slate-900">
                        {account.businessName || 'Unnamed account'}
                      </div>
                      <div className="text-xs text-slate-500 uppercase tracking-wide">
                        {account.platform}
                      </div>
                    </div>
                    {!row?.configured && (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
                        <ShieldAlert className="w-3 h-3" />
                        Using default fallback
                      </span>
                    )}
                  </div>

                  {availableServices.length === 0 ? (
                    <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">
                      No services yet — add one below from a template or
                      create a custom service.
                    </div>
                  ) : (
                    <ul className="space-y-2">
                      {availableServices.map(svc => {
                        const isEnabled = enabled.includes(svc.id);
                        const isDefault = currentDefault === svc.id;
                        return (
                          <li key={svc.id} className="flex items-center gap-3 py-1">
                            <input
                              type="checkbox"
                              id={`${account.id}-${svc.id}`}
                              checked={isEnabled}
                              onChange={() => void toggleAssignment(account.id, svc.id)}
                              className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500"
                            />
                            <label
                              htmlFor={`${account.id}-${svc.id}`}
                              className="flex-1 text-sm text-slate-700 cursor-pointer"
                            >
                              {svc.name}
                              {svc.isDefault && (
                                <span className="ml-2 text-xs font-semibold text-slate-400">
                                  tenant default
                                </span>
                              )}
                              {svc.status === 'draft' && (
                                <span className="ml-2 text-xs font-semibold text-amber-600">
                                  draft (AI paused)
                                </span>
                              )}
                            </label>
                            {isEnabled && (
                              <button
                                type="button"
                                onClick={() => void setDefaultFor(account.id, isDefault ? null : svc.id)}
                                className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                                  isDefault
                                    ? 'bg-blue-100 text-blue-700'
                                    : 'text-slate-500 hover:bg-slate-100'
                                }`}
                              >
                                {isDefault ? 'Default for account' : 'Set as default'}
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>

          {/* Add-service panel. Collapsed by default so the per-account
              grid stays the focus. */}
          <div className="mt-6">
            {!showAddPanel ? (
              <button
                type="button"
                onClick={() => setShowAddPanel(true)}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-xl transition-all"
              >
                <Plus className="w-4 h-4" />
                Add a service
              </button>
            ) : (
              <div className="rounded-2xl border border-blue-200 bg-blue-50/40 p-5 space-y-4">
                <div className="flex items-start gap-2 text-xs text-slate-600">
                  <Sparkles className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                  <div>
                    Start from a curated template (Thumbtack/Yelp categories
                    are pre-mapped) or create a custom service with just a
                    name and fill it in next.
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">
                    From a template
                  </label>
                  <div className="flex gap-2">
                    <select
                      value={selectedPresetKey}
                      onChange={e => setSelectedPresetKey(e.target.value)}
                      disabled={creating || presets.length === 0}
                      className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                    >
                      <option value="">Pick a template…</option>
                      {presets.map(p => {
                        const key = p.source === 'code_preset' ? p.presetKey! : p.templateId!;
                        return (
                          <option key={`${p.source}-${key}`} value={key}>
                            {p.label}
                            {p.source === 'admin_template' ? ' (custom template)' : ''}
                          </option>
                        );
                      })}
                    </select>
                    <button
                      type="button"
                      onClick={() => void handleCreateFromPreset()}
                      disabled={creating || !selectedPresetKey}
                      className="inline-flex items-center gap-1 px-4 py-2 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg"
                    >
                      {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                      Add
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">
                    Custom service
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={customName}
                      onChange={e => setCustomName(e.target.value)}
                      disabled={creating}
                      maxLength={80}
                      placeholder="e.g. Pressure washing"
                      className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg bg-white"
                    />
                    <button
                      type="button"
                      onClick={() => void handleCreateCustom()}
                      disabled={creating || !customName.trim()}
                      className="inline-flex items-center gap-1 px-4 py-2 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg"
                    >
                      {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wrench className="w-3.5 h-3.5" />}
                      Create
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setShowAddPanel(false)}
                  className="text-xs font-semibold text-slate-500 hover:text-slate-700"
                >
                  Hide add panel
                </button>
              </div>
            )}
          </div>

          {/* Footer warning when at least one account is still
              unassigned. Doesn't block continue — AI will fall back to
              the tenant's default ServiceProfile until assignments are
              configured. */}
          {(hasUnconfiguredAccount || !hasAnyActive) && (
            <div className="mt-6 flex items-start gap-2 rounded-xl border border-amber-100 bg-amber-50/60 px-3 py-2.5 text-xs text-amber-900">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
              <div>
                {!hasAnyActive
                  ? "You don't have any active services yet — AI will fall back to your default service until you add one."
                  : "Some accounts have no services assigned yet. AI will use your default service for them until assignments are set."}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
