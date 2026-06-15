/**
 * Settings → Services tab (v1).
 *
 * Single button: "Create service from preset". Opens a modal that
 * lists the curated registry (GET /v1/service-profile-presets) and
 * lets the operator spawn a draft ServiceProfile from one (POST
 * /v1/service-profiles/from-preset).
 *
 * Intentionally minimal scope — no profile listing / editing yet.
 * The profile created here lands in status='draft' so the Phase 1b
 * resolver gates AI replies for matched leads until the operator
 * promotes it elsewhere. v1 doesn't expose a promote-to-active
 * surface — that's the next consumer PR.
 */

import { useEffect, useState } from 'react';
import { Sparkles, Plus, Loader2, X, Check, Layers } from 'lucide-react';
import { SettingCard } from '../../components/automation/ui';
import { notify } from '../../store/notificationStore';
import {
  serviceProfilePresetsApi,
  type ServiceProfilePreset,
} from '../../services/api';

export function SettingsServices() {
  const [modalOpen, setModalOpen] = useState(false);
  return (
    <div>
      <SettingCard
        icon={Layers}
        iconTone="blue"
        title="Service profiles"
        subtitle="Create per-service configuration (pricing, FAQ, qualification questions) from curated presets."
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0' }}>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 16px',
              borderRadius: 10,
              border: '1px solid var(--lb-blue-200, #bfdbfe)',
              background: 'var(--lb-blue-600, #2563eb)',
              color: 'white',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <Plus size={16} />
            Create service from preset
          </button>
          <div style={{ fontSize: 13, color: 'var(--lb-text-muted, #6b7280)' }}>
            New profiles start as drafts — AI replies stay paused until you activate.
          </div>
        </div>
      </SettingCard>
      {modalOpen && <PresetPickerModal onClose={() => setModalOpen(false)} />}
    </div>
  );
}

function PresetPickerModal({ onClose }: { onClose: () => void }) {
  const [presets, setPresets] = useState<ServiceProfilePreset[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creatingKey, setCreatingKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    serviceProfilePresetsApi
      .list()
      .then((res) => {
        if (!cancelled) setPresets(res.presets);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err?.response?.data?.message ?? err?.message ?? 'Failed to load presets');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCreate = async (preset: ServiceProfilePreset) => {
    setCreatingKey(preset.key);
    try {
      const result = await serviceProfilePresetsApi.createFromPreset(preset.key);
      notify.success(
        'Service profile created',
        `${result.name} is in draft. Activate it when ready to start receiving AI replies for matched leads.`,
      );
      onClose();
    } catch (err: any) {
      const status = err?.response?.status;
      const msg = err?.response?.data?.message ?? err?.message ?? 'Failed to create service';
      if (status === 409) {
        notify.error('Already created', `You already have a service profile for ${preset.label}.`);
      } else {
        notify.error('Could not create service', msg);
      }
    } finally {
      setCreatingKey(null);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.45)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white',
          borderRadius: 16,
          width: 'min(680px, 100%)',
          maxHeight: '85vh',
          overflow: 'auto',
          boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)',
          padding: 24,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Sparkles size={18} color="var(--lb-blue-600, #2563eb)" />
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Pick a preset</h3>
            </div>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--lb-text-muted, #6b7280)' }}>
              Each preset bundles pricing, FAQ, and qualification questions sourced from the platform.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              padding: 6,
              background: 'transparent',
              border: 'none',
              color: 'var(--lb-text-muted, #6b7280)',
              cursor: 'pointer',
              borderRadius: 6,
            }}
          >
            <X size={18} />
          </button>
        </div>
        {loadError && (
          <div
            style={{
              padding: 12,
              borderRadius: 8,
              background: '#fef2f2',
              color: '#b91c1c',
              fontSize: 13,
              marginBottom: 12,
            }}
          >
            {loadError}
          </div>
        )}
        {!presets && !loadError && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--lb-text-muted)', fontSize: 13 }}>
            <Loader2 size={14} className="animate-spin" /> Loading presets…
          </div>
        )}
        {presets && presets.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--lb-text-muted)' }}>No presets available.</div>
        )}
        {presets && presets.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {presets.map((p) => (
              <PresetCard
                key={p.key}
                preset={p}
                creating={creatingKey === p.key}
                disabled={creatingKey !== null && creatingKey !== p.key}
                onCreate={() => handleCreate(p)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PresetCard({
  preset,
  creating,
  disabled,
  onCreate,
}: {
  preset: ServiceProfilePreset;
  creating: boolean;
  disabled: boolean;
  onCreate: () => void;
}) {
  const itemCount = preset.pricingJson.items?.length ?? 0;
  const questionCount = preset.qualificationSchemaJson.questions.length;
  const faqCount = preset.faqJson.customQA.length;
  return (
    <div
      style={{
        border: '1px solid var(--lb-border, #e5e7eb)',
        borderRadius: 12,
        padding: 16,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 16,
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{preset.label}</div>
        <div style={{ fontSize: 13, color: 'var(--lb-text-muted)', marginBottom: 8 }}>{preset.description}</div>
        <div style={{ display: 'flex', gap: 12, fontSize: 12, color: 'var(--lb-text-muted)' }}>
          <span>
            <Check size={11} style={{ verticalAlign: 'middle' }} /> {itemCount} items
          </span>
          <span>
            <Check size={11} style={{ verticalAlign: 'middle' }} /> {questionCount} questions
          </span>
          <span>
            <Check size={11} style={{ verticalAlign: 'middle' }} /> {faqCount} FAQs
          </span>
          <span>via {preset.provider}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={onCreate}
        disabled={disabled}
        style={{
          padding: '8px 14px',
          borderRadius: 8,
          border: '1px solid var(--lb-blue-200, #bfdbfe)',
          background: disabled ? 'var(--lb-gray-100, #f3f4f6)' : 'var(--lb-blue-600, #2563eb)',
          color: disabled ? 'var(--lb-text-muted)' : 'white',
          fontSize: 13,
          fontWeight: 600,
          cursor: disabled ? 'not-allowed' : 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          whiteSpace: 'nowrap',
        }}
      >
        {creating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
        Create
      </button>
    </div>
  );
}
