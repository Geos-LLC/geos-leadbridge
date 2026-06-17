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
  Calendar, Shield, PhoneCall, Send, User as UserIcon, Globe,
  ChevronDown, ChevronUp, RefreshCw, Pencil, CheckCircle, CheckCircle2, MessageSquare, Trash2,
  Archive, Plus,
  type LucideIcon,
} from 'lucide-react';
import { SectionCard, StatusPill } from '../../components/automation/ui';
import { AI_SETTINGS_ASSISTANT_APPLIED_EVENT, type AiSettingsAssistantAppliedDetail } from '../../components/Layout';
import {
  followUpApi,
  usersApi,
  aiSettingsAssistantApi,
  serviceProfilesApi,
  type ChatInstructionEntry,
  type ServiceProfile,
} from '../../services/api';
import { useAppStore } from '../../store/appStore';
import { notify } from '../../store/notificationStore';
// AccountFaqForm + ServicePricingForm imports removed in PR-B.1 — both
// surfaces moved to Settings → Services. ServiceScopedInfoCard replaces
// them on the Global tab with a pointer to the new location.
// PR-D reuses the structured PricingEditor from the Services page on the
// per-Service AI Playbook tab so users can edit pricing without leaving
// the playbook surface.
import { PricingEditor } from './Services';
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

// ─── Scope router (PR-B) ──────────────────────────────────────────────────
//
// AI Playbook is scoped to either:
//   - Global: the existing per-account behavior. Save fans out to every
//     connected SavedAccount's followUpSettingsJson + User.globalAiPrompt.
//   - Service: one specific ServiceProfile. Save targets ONLY that profile's
//     aiInstructionsJson wrapper (the envelope PR-A introduced —
//     { version, serviceRules?, aiPlaybookV2 }). serviceRules is preserved
//     verbatim; only the aiPlaybookV2 sub-tree is edited from this page.
//
// FAQ + Pricing + Global Custom Instructions are intentionally hidden from
// Service scope. FAQ and pricing for a service live in Settings → Services
// (PR-A); global custom instructions are a tenant-wide field by definition.

type Scope = { kind: 'global' } | { kind: 'service'; profileId: string };

function readScopeFromParams(search: URLSearchParams): Scope {
  const raw = search.get('scope');
  if (!raw || raw === 'global') return { kind: 'global' };
  return { kind: 'service', profileId: raw };
}

export function SettingsAiPlaybook() {
  const [searchParams, setSearchParams] = useSearchParams();
  const scope = readScopeFromParams(searchParams);

  // ServiceProfile list — used by the tab strip + to resolve the active
  // profile when scope=service. Cached at this level so switching tabs
  // doesn't refetch on every click.
  const [profiles, setProfiles] = useState<ServiceProfile[] | null>(null);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [refreshTok, setRefreshTok] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setProfilesError(null);
    serviceProfilesApi
      .list()
      .then((r) => { if (!cancelled) setProfiles(r.profiles); })
      .catch((err: any) => {
        if (!cancelled) setProfilesError(err?.response?.data?.message ?? err?.message ?? 'Failed to load services');
      });
    return () => { cancelled = true; };
  }, [refreshTok]);

  const activeProfile =
    scope.kind === 'service'
      ? (profiles ?? []).find((p) => p.id === scope.profileId) ?? null
      : null;

  // Invalid ?scope=<id> after profiles load → silently snap back to Global.
  // We don't surface an error because users land here via shared URLs and
  // archived/deleted profiles are valid prior state.
  useEffect(() => {
    if (scope.kind !== 'service') return;
    if (!profiles) return;
    if (activeProfile) return;
    const sp = new URLSearchParams(searchParams);
    sp.delete('scope');
    setSearchParams(sp, { replace: true });
  }, [scope.kind, scope.kind === 'service' ? scope.profileId : null, profiles, activeProfile, searchParams, setSearchParams]);

  // Deep-link target — `?section=pricing` lands the user directly on the
  // pricing table. Pricing is service-scoped, so if no service is selected
  // we auto-pick the default (or first non-archived) profile, then the
  // sibling effect scrolls to the pricing card once it mounts.
  useEffect(() => {
    if (searchParams.get('section') !== 'pricing') return;
    if (!profiles) return;
    if (scope.kind === 'service') return;
    const def =
      profiles.find((p) => p.status !== 'archived' && p.isDefault) ??
      profiles.find((p) => p.status !== 'archived');
    if (!def) return;
    const sp = new URLSearchParams(searchParams);
    sp.set('scope', def.id);
    setSearchParams(sp, { replace: true });
  }, [profiles, scope.kind, searchParams, setSearchParams]);

  // Scroll to the pricing card once the service editor has mounted. The
  // card carries id="ai-playbook-pricing"; we clear `?section` after the
  // first scroll so subsequent navigation isn't hijacked.
  useEffect(() => {
    if (searchParams.get('section') !== 'pricing') return;
    if (scope.kind !== 'service' || !activeProfile) return;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById('ai-playbook-pricing');
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const sp = new URLSearchParams(searchParams);
      sp.delete('section');
      setSearchParams(sp, { replace: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [scope.kind, activeProfile, searchParams, setSearchParams]);

  const selectScope = (next: Scope) => {
    const sp = new URLSearchParams(searchParams);
    if (next.kind === 'global') sp.delete('scope');
    else sp.set('scope', next.profileId);
    setSearchParams(sp, { replace: false });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScopeTabStrip
        profiles={profiles}
        scope={scope}
        activeProfile={activeProfile}
        onSelect={selectScope}
        error={profilesError}
      />
      {scope.kind === 'global' && <GlobalPlaybookEditor />}
      {scope.kind === 'service' && activeProfile && (
        <ServicePlaybookEditor
          key={activeProfile.id}
          profile={activeProfile}
          onSaved={() => setRefreshTok((t) => t + 1)}
        />
      )}
      {scope.kind === 'service' && profiles && !activeProfile && (
        <SectionCard padding="18px 22px">
          <div style={{ fontSize: 13, color: 'var(--lb-ink-3)' }}>
            Service profile not found — switching to Global.
          </div>
        </SectionCard>
      )}
    </div>
  );
}

// ─── Tab strip ────────────────────────────────────────────────────────────

function ScopeTabStrip({
  profiles,
  scope,
  activeProfile,
  onSelect,
  error,
}: {
  profiles: ServiceProfile[] | null;
  scope: Scope;
  activeProfile: ServiceProfile | null;
  onSelect: (next: Scope) => void;
  error: string | null;
}) {
  const loading = profiles === null && !error;
  // Default: hide archived from the strip. Operators can reveal them with
  // the "Show archived" toggle below. If the active scope IS an archived
  // profile (e.g. via shared URL), we expand automatically so the user
  // can see what they're editing.
  const archivedScopeActive =
    scope.kind === 'service' && activeProfile?.status === 'archived';
  const [showArchived, setShowArchived] = useState(false);
  const archivedExpanded = showArchived || archivedScopeActive;

  const { primary, archived } = useMemo(() => {
    if (!profiles) return { primary: [] as ServiceProfile[], archived: [] as ServiceProfile[] };
    const rank = (p: ServiceProfile) =>
      p.status === 'active' ? (p.isDefault ? 0 : 1) : 2; // draft = 2
    const primarySorted = profiles
      .filter((p) => p.status !== 'archived')
      .slice()
      .sort((a, b) => {
        const d = rank(a) - rank(b);
        if (d !== 0) return d;
        return getServiceDisplayName(a).localeCompare(getServiceDisplayName(b));
      });
    const archivedSorted = profiles
      .filter((p) => p.status === 'archived')
      .slice()
      .sort((a, b) => getServiceDisplayName(a).localeCompare(getServiceDisplayName(b)));
    return { primary: primarySorted, archived: archivedSorted };
  }, [profiles]);

  return (
    <SectionCard padding="14px 18px">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <ScopeTabButton
            label="Global"
            active={scope.kind === 'global'}
            badge="global"
            onClick={() => onSelect({ kind: 'global' })}
          />
          {primary.map((p) => (
            <ScopeTabButton
              key={p.id}
              label={getServiceDisplayName(p)}
              active={scope.kind === 'service' && scope.profileId === p.id}
              badge={p.status === 'active' ? 'service' : 'draft'}
              onClick={() => onSelect({ kind: 'service', profileId: p.id })}
            />
          ))}
          {archivedExpanded && archived.map((p) => (
            <ScopeTabButton
              key={p.id}
              label={getServiceDisplayName(p)}
              active={scope.kind === 'service' && scope.profileId === p.id}
              badge="archived"
              onClick={() => onSelect({ kind: 'service', profileId: p.id })}
            />
          ))}
          {archived.length > 0 && !archivedScopeActive && (
            <button
              type="button"
              onClick={() => setShowArchived((v) => !v)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '6px 10px', borderRadius: 8,
                border: '1px dashed var(--lb-line)',
                background: 'transparent',
                color: 'var(--lb-ink-5)',
                fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              <Archive size={12} />
              {showArchived ? 'Hide archived' : `Show ${archived.length} archived`}
            </button>
          )}
          {loading && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--lb-ink-5)' }}>
              <Loader2 size={12} className="animate-spin" /> Loading services…
            </span>
          )}
        </div>
        {scope.kind === 'service' && activeProfile && (
          <ScopeStatusLine profile={activeProfile} />
        )}
        {scope.kind === 'global' && (
          <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)' }}>
            Applies to all services. Use Global for tenant-wide tone and instructions; service tabs override per category.
          </div>
        )}
        {error && (
          <div style={{ fontSize: 12, color: '#b91c1c' }}>
            Could not load services: {error}
          </div>
        )}
      </div>
    </SectionCard>
  );
}

type ScopeBadge = 'global' | 'service' | 'draft' | 'archived';

const SCOPE_BADGE_STYLES: Record<ScopeBadge, { bg: string; fg: string; border: string; label: string }> = {
  global:   { bg: '#eff6ff', fg: '#1d4ed8', border: '#bfdbfe', label: 'GLOBAL' },
  service:  { bg: '#dcfce7', fg: '#15803d', border: '#bbf7d0', label: 'SERVICE' },
  draft:    { bg: '#fef3c7', fg: '#b45309', border: '#fde68a', label: 'DRAFT' },
  archived: { bg: '#f3f4f6', fg: '#6b7280', border: '#e5e7eb', label: 'ARCHIVED' },
};

function ScopeBadgePill({ badge }: { badge: ScopeBadge }) {
  const s = SCOPE_BADGE_STYLES[badge];
  return (
    <span style={{
      padding: '2px 8px',
      borderRadius: 4,
      background: s.bg,
      color: s.fg,
      border: `1px solid ${s.border}`,
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: 0.06,
    }}>{s.label}</span>
  );
}

function ScopeTabButton({
  label,
  active,
  badge,
  onClick,
}: {
  label: string;
  active: boolean;
  badge: ScopeBadge;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        borderRadius: 10,
        border: `1px solid ${active ? 'var(--lb-accent)' : 'var(--lb-line)'}`,
        background: active ? 'var(--lb-accent-tint, #eff6ff)' : 'white',
        color: active ? 'var(--lb-accent)' : 'var(--lb-ink-2)',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
        maxWidth: 280,
      }}
      title={label}
    >
      <span style={{
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: 200,
      }}>
        {label}
      </span>
      <ScopeBadgePill badge={badge} />
    </button>
  );
}

function ScopeStatusLine({ profile }: { profile: ServiceProfile }) {
  const status = profile.status;
  const isArchived = status === 'archived';
  const isDraft = status === 'draft';
  const displayName = getServiceDisplayName(profile);
  return (
    <div style={{ fontSize: 12.5, color: isArchived ? '#6b7280' : isDraft ? '#b45309' : 'var(--lb-ink-5)' }}>
      {isArchived && <>Not used for AI replies.</>}
      {isDraft && <>AI paused until activated.</>}
      {!isArchived && !isDraft && <>Applies only to {displayName}.</>}
    </div>
  );
}

// ─── Service-scope editor ─────────────────────────────────────────────────
//
// Reads ServiceProfile.aiInstructionsJson, parses the wrapper, edits the
// aiPlaybookV2 sub-tree only, and saves the merged wrapper back. The
// wrapper's other keys (version, serviceRules) are preserved verbatim so
// PR-A's service rules viewer in Settings → Services keeps working.

type AiInstructionsWrapper = {
  version: number;
  aiPlaybookV2: PlaybookV2Storage;
  // Pass-through bag for forward-compat keys (serviceRules + anything we
  // didn't think of). Preserved verbatim on save.
  passthrough: Record<string, unknown>;
};

function parseAiInstructionsWrapper(json: string | null | undefined): AiInstructionsWrapper {
  if (!json) return { version: 1, aiPlaybookV2: {}, passthrough: {} };
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { version: 1, aiPlaybookV2: {}, passthrough: {} };
    }
    const obj = parsed as Record<string, unknown>;
    const hasWrapperShape =
      'version' in obj || 'serviceRules' in obj || 'aiPlaybookV2' in obj;
    if (hasWrapperShape) {
      const v2 =
        obj.aiPlaybookV2 && typeof obj.aiPlaybookV2 === 'object' && !Array.isArray(obj.aiPlaybookV2)
          ? (obj.aiPlaybookV2 as PlaybookV2Storage)
          : {};
      const passthrough: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'version' || k === 'aiPlaybookV2') continue;
        passthrough[k] = v;
      }
      const version = typeof obj.version === 'number' ? obj.version : 1;
      return { version, aiPlaybookV2: v2, passthrough };
    }
    // Legacy raw-sections shape — treat the entire blob as the V2 sub-tree
    // and emit it under the wrapper on next save (no data loss).
    return { version: 1, aiPlaybookV2: obj as PlaybookV2Storage, passthrough: {} };
  } catch {
    return { version: 1, aiPlaybookV2: {}, passthrough: {} };
  }
}

function serializeWrapper(wrapper: AiInstructionsWrapper): string {
  const out: Record<string, unknown> = {
    version: wrapper.version || 1,
    ...wrapper.passthrough,
    aiPlaybookV2: wrapper.aiPlaybookV2,
  };
  return JSON.stringify(out);
}

// ─── Display name resolution ─────────────────────────────────────────────
//
// Many tenants land on the seed "Default Service" name even when their
// real service is House Cleaning (bed/bath pricing model is the giveaway).
// We render a friendlier display name in the tab + header, but do NOT
// mutate the DB unless the operator explicitly clicks Rename. Heuristic:
//   - Only kicks in for isDefault profiles whose name is literally
//     "Default Service" (the wizard seed).
//   - bed_bath_grid pricing model → House Cleaning
//   - OR FAQ/pricing text mentions bedroom/bathroom/sqft → House Cleaning
//   - Otherwise the seed name stays.

const DEFAULT_PROFILE_SEED_NAME = 'Default Service';
const HOUSE_CLEANING_INDICATOR = /\b(bedroom|bathroom|sq ?ft|square ?feet|cleaning)\b/i;

function detectHouseCleaning(profile: ServiceProfile): boolean {
  try {
    if (profile.pricingJson) {
      const pricing = JSON.parse(profile.pricingJson);
      if (pricing && pricing.pricingModel === 'bed_bath_grid') return true;
    }
  } catch {
    // unparseable pricingJson — fall through to text check
  }
  const blob = `${profile.pricingJson ?? ''} ${profile.faqJson ?? ''}`;
  return HOUSE_CLEANING_INDICATOR.test(blob);
}

function isDefaultRenamable(profile: ServiceProfile): boolean {
  return profile.isDefault && profile.name === DEFAULT_PROFILE_SEED_NAME && detectHouseCleaning(profile);
}

function getServiceDisplayName(profile: ServiceProfile): string {
  return isDefaultRenamable(profile) ? 'House Cleaning' : profile.name;
}

// ─── Service rules viewer (read-only, frontend-only) ─────────────────────
//
// Mirrors the extractServiceRules logic that lives on the backend (PR-A).
// We don't import the backend helper because this is a Vite bundle —
// instead we duplicate the small parser.

type ParsedServiceRules = {
  requiredDetails: string[];
  unsupportedServices: string[];
  workflowSteps: string[];
};

function extractServiceRulesFromWrapper(
  wrapper: AiInstructionsWrapper,
): ParsedServiceRules | null {
  const raw = wrapper.passthrough?.serviceRules;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const required = arr(r.requiredDetails);
  const unsupported = arr(r.unsupportedServices);
  const workflow = arr(r.workflowSteps);
  if (required.length === 0 && unsupported.length === 0 && workflow.length === 0) return null;
  return { requiredDetails: required, unsupportedServices: unsupported, workflowSteps: workflow };
}

function ServiceRulesViewer({ rules }: { rules: ParsedServiceRules }) {
  return (
    <SectionCard padding="18px 22px">
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--lb-ink-1)', marginBottom: 4 }}>
          Service rules
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)' }}>
          Read-only. Edit in <a href="/settings/services" style={{ color: 'var(--lb-accent)', fontWeight: 600 }}>Settings → Services</a>.
        </div>
      </div>
      {rules.requiredDetails.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--lb-ink-3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.04 }}>
            Required details
          </div>
          <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {rules.requiredDetails.map((d) => (
              <li key={d} style={{ fontSize: 13, color: 'var(--lb-ink-2)', lineHeight: 1.4 }}>{d}</li>
            ))}
          </ul>
        </div>
      )}
      {rules.unsupportedServices.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#b45309', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.04 }}>
            Not supported
          </div>
          <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {rules.unsupportedServices.map((d) => (
              <li key={d} style={{ fontSize: 13, color: '#b45309', lineHeight: 1.4 }}>{d}</li>
            ))}
          </ul>
        </div>
      )}
      {rules.workflowSteps.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--lb-ink-3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.04 }}>
            Workflow steps
          </div>
          <ol style={{ margin: 0, paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {rules.workflowSteps.map((s, i) => (
              <li key={`${i}-${s}`} style={{ fontSize: 13, color: 'var(--lb-ink-2)', lineHeight: 1.4 }}>{s}</li>
            ))}
          </ol>
        </div>
      )}
    </SectionCard>
  );
}

// ─── Service-data editor cards (PR-D) ────────────────────────────────────
//
// Replaces the old ServiceSummaryCard (PR-B.1) which only linked out to
// Settings → Services. Each card shows a summary by default with an
// "Edit" toggle that reveals the inline editor. Save lives on the page
// footer so a user editing pricing + FAQ + a HOW section commits all
// drafts in a single PATCH.

function CountSummary({ count, noun }: { count: number; noun: string }) {
  return (
    <span style={{ fontSize: 13, color: 'var(--lb-ink-5)' }}>
      {count === 0 ? `No ${noun} yet.` : `${count} ${noun}${count === 1 ? '' : 's'}.`}
    </span>
  );
}

function CardHeader({
  title,
  summary,
  expanded,
  onToggle,
  badge,
}: {
  title: string;
  summary: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  badge?: React.ReactNode;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
      marginBottom: expanded ? 14 : 0,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--lb-ink-1)' }}>{title}</div>
          {badge}
        </div>
        <div>{summary}</div>
      </div>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '7px 12px', borderRadius: 8,
          border: '1px solid var(--lb-line)',
          background: 'white', color: 'var(--lb-ink-2)',
          fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <Pencil size={12} />
        {expanded ? 'Hide editor' : 'Edit'}
      </button>
    </div>
  );
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function ServicePricingCard({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  // PR-D.1 — service knowledge (pricing/FAQ/qualification) should not
  // hide behind a one-line summary. Open by default; users can collapse
  // with the same toggle if they want to focus on AI instructions.
  const [expanded, setExpanded] = useState(true);
  const summary = useMemo(() => {
    const parsed = safeParse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return <CountSummary count={0} noun="priced item" />;
    }
    const obj = parsed as Record<string, unknown>;
    const items = Array.isArray(obj.items) ? obj.items.length : 0;
    const model = typeof obj.pricingModel === 'string' ? obj.pricingModel : 'unknown';
    return (
      <span style={{ fontSize: 13, color: 'var(--lb-ink-5)' }}>
        {items > 0 ? `${items} priced items` : 'No priced items yet'} · model: {model}
      </span>
    );
  }, [value]);
  return (
    // id used by SettingsAiPlaybook's section=pricing deep link to scroll
    // the user directly to this card after the editor renders.
    <div id="ai-playbook-pricing" style={{ scrollMarginTop: 16 }}>
      <SectionCard padding="16px 20px">
        <CardHeader
          title="Pricing"
          summary={summary}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
        />
        {expanded && (
          <div style={{ marginTop: 8 }}>
            <PricingEditor value={value} onChange={onChange} />
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ─── FAQ rows editor ─────────────────────────────────────────────────────
//
// PR-D shipped a raw JSON textarea ({ customQA: [...] }) inline in the
// Service playbook tab. Users shouldn't have to read JSON — restore a
// structured Q&A table editor: each row is one Question + Answer with a
// delete button, plus an "Add Q&A" button. The on-disk shape is still
// `{ customQA: [{ question, answer }] }` so the runtime renderer keeps
// reading the same field; only the editor surface changed.

type FaqPair = { question: string; answer: string };

function parseFaqRows(value: string): FaqPair[] {
  const parsed = safeParse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const arr = (parsed as Record<string, unknown>).customQA;
  if (!Array.isArray(arr)) return [];
  return arr.map((row: any) => ({
    question: typeof row?.question === 'string' ? row.question : '',
    answer: typeof row?.answer === 'string' ? row.answer : '',
  }));
}

function serializeFaqRows(rows: FaqPair[]): string {
  return JSON.stringify({ customQA: rows });
}

function ServiceFaqRowsEditor({
  rows,
  onChange,
}: {
  rows: FaqPair[];
  onChange: (next: FaqPair[]) => void;
}) {
  const updateRow = (i: number, field: keyof FaqPair, v: string) => {
    onChange(rows.map((row, idx) => (idx === i ? { ...row, [field]: v } : row)));
  };
  const addRow = () => onChange([...rows, { question: '', answer: '' }]);
  const removeRow = (i: number) => onChange(rows.filter((_, idx) => idx !== i));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rows.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--lb-ink-5)' }}>
          No Q&amp;A pairs yet. Click <strong>Add Q&amp;A</strong> to add your first.
        </div>
      )}
      {rows.map((row, i) => (
        <div
          key={i}
          style={{
            border: '1px solid var(--lb-line)',
            borderRadius: 10,
            padding: 12,
            background: 'white',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--lb-ink-5)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
              Q&amp;A {i + 1}
            </div>
            <button
              type="button"
              onClick={() => removeRow(i)}
              title="Remove this Q&A"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '5px 10px', borderRadius: 7,
                border: '1px solid var(--lb-line)', background: 'white',
                color: 'var(--lb-ink-3)', fontSize: 12, fontWeight: 600,
                cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              <Trash2 size={12} /> Delete
            </button>
          </div>
          <input
            value={row.question}
            onChange={(e) => updateRow(i, 'question', e.target.value)}
            placeholder="Question (e.g. Do you bring your own supplies?)"
            style={{
              width: '100%', padding: '9px 12px',
              border: '1px solid var(--lb-line)', borderRadius: 8,
              fontSize: 13.5, fontFamily: 'inherit', color: 'var(--lb-ink-1)',
              background: 'white',
            }}
          />
          <textarea
            value={row.answer}
            onChange={(e) => updateRow(i, 'answer', e.target.value)}
            placeholder="Answer the AI should give"
            rows={3}
            style={{
              width: '100%', padding: '9px 12px',
              border: '1px solid var(--lb-line)', borderRadius: 8,
              fontSize: 13.5, fontFamily: 'inherit', color: 'var(--lb-ink-1)',
              background: 'white', resize: 'vertical',
            }}
          />
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        style={{
          alignSelf: 'flex-start',
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '8px 14px', borderRadius: 8,
          border: '1px dashed var(--lb-line)',
          background: 'white', color: 'var(--lb-ink-2)',
          fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <Plus size={13} /> Add Q&amp;A
      </button>
    </div>
  );
}

function ServiceFaqCard({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  // PR-D.1 — service knowledge (pricing/FAQ/qualification) should not
  // hide behind a one-line summary. Open by default; users can collapse
  // with the same toggle if they want to focus on AI instructions.
  const [expanded, setExpanded] = useState(true);
  const rows = useMemo(() => parseFaqRows(value), [value]);
  const summary = <CountSummary count={rows.length} noun="Q&A pair" />;
  return (
    <SectionCard padding="16px 20px">
      <CardHeader
        title="FAQ"
        summary={summary}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      />
      {expanded && (
        <div style={{ marginTop: 8 }}>
          <ServiceFaqRowsEditor
            rows={rows}
            onChange={(next) => onChange(serializeFaqRows(next))}
          />
        </div>
      )}
    </SectionCard>
  );
}

// ─── Qualification rows editor ───────────────────────────────────────────
//
// Same regression as FAQ — the user shouldn't paste JSON for a question
// schema. Each row exposes the four meaningful fields (key, label, type,
// options) inline. Options is a comma-separated string in the UI for the
// select types; we split/join on the wire. Storage shape unchanged:
// `{ questions: [{ key, label, type, options? }] }`.

type QualType = 'single_select' | 'multi_select' | 'text' | 'number' | 'date';
type QualRow = { key: string; label: string; type: QualType; options?: string[] };

const QUAL_TYPES: Array<{ value: QualType; label: string }> = [
  { value: 'single_select', label: 'Single choice' },
  { value: 'multi_select', label: 'Multi choice' },
  { value: 'text', label: 'Free text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
];

function parseQualRows(value: string): QualRow[] {
  const parsed = safeParse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const arr = (parsed as Record<string, unknown>).questions;
  if (!Array.isArray(arr)) return [];
  return arr.map((row: any) => {
    const type: QualType = (
      ['single_select', 'multi_select', 'text', 'number', 'date'] as QualType[]
    ).includes(row?.type) ? row.type : 'text';
    return {
      key: typeof row?.key === 'string' ? row.key : '',
      label: typeof row?.label === 'string' ? row.label : '',
      type,
      options: Array.isArray(row?.options)
        ? row.options.filter((o: unknown) => typeof o === 'string')
        : undefined,
    };
  });
}

function serializeQualRows(rows: QualRow[]): string {
  return JSON.stringify({
    questions: rows.map((r) => {
      const out: Record<string, unknown> = { key: r.key, label: r.label, type: r.type };
      if (r.type === 'single_select' || r.type === 'multi_select') {
        out.options = r.options ?? [];
      }
      return out;
    }),
  });
}

function ServiceQualificationRowsEditor({
  rows,
  onChange,
}: {
  rows: QualRow[];
  onChange: (next: QualRow[]) => void;
}) {
  const updateRow = (i: number, patch: Partial<QualRow>) => {
    onChange(rows.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  };
  const addRow = () =>
    onChange([...rows, { key: '', label: '', type: 'text' }]);
  const removeRow = (i: number) => onChange(rows.filter((_, idx) => idx !== i));
  const inputStyle: React.CSSProperties = {
    padding: '9px 12px',
    border: '1px solid var(--lb-line)', borderRadius: 8,
    fontSize: 13.5, fontFamily: 'inherit', color: 'var(--lb-ink-1)',
    background: 'white',
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {rows.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--lb-ink-5)' }}>
          No qualification questions yet. Click <strong>Add question</strong> to add one.
        </div>
      )}
      {rows.map((row, i) => {
        const isSelect = row.type === 'single_select' || row.type === 'multi_select';
        return (
          <div
            key={i}
            style={{
              border: '1px solid var(--lb-line)',
              borderRadius: 10,
              padding: 12,
              background: 'white',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--lb-ink-5)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                Question {i + 1}
              </div>
              <button
                type="button"
                onClick={() => removeRow(i)}
                title="Remove this question"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '5px 10px', borderRadius: 7,
                  border: '1px solid var(--lb-line)', background: 'white',
                  color: 'var(--lb-ink-3)', fontSize: 12, fontWeight: 600,
                  cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                <Trash2 size={12} /> Delete
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 180px', gap: 8 }}>
              <input
                value={row.key}
                onChange={(e) => updateRow(i, { key: e.target.value })}
                placeholder="Key (e.g. bedrooms)"
                style={inputStyle}
              />
              <input
                value={row.label}
                onChange={(e) => updateRow(i, { label: e.target.value })}
                placeholder="Label shown to the customer"
                style={inputStyle}
              />
              <select
                value={row.type}
                onChange={(e) => {
                  const nextType = e.target.value as QualType;
                  const isNextSelect = nextType === 'single_select' || nextType === 'multi_select';
                  updateRow(i, {
                    type: nextType,
                    options: isNextSelect ? row.options ?? [] : undefined,
                  });
                }}
                style={{ ...inputStyle, padding: '8px 10px' }}
              >
                {QUAL_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            {isSelect && (
              <input
                value={(row.options ?? []).join(', ')}
                onChange={(e) =>
                  updateRow(i, {
                    options: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="Options, comma-separated (e.g. 1, 2, 3, 4+)"
                style={inputStyle}
              />
            )}
          </div>
        );
      })}
      <button
        type="button"
        onClick={addRow}
        style={{
          alignSelf: 'flex-start',
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '8px 14px', borderRadius: 8,
          border: '1px dashed var(--lb-line)',
          background: 'white', color: 'var(--lb-ink-2)',
          fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <Plus size={13} /> Add question
      </button>
    </div>
  );
}

function ServiceQualificationCard({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  // PR-D.1 — service knowledge (pricing/FAQ/qualification) should not
  // hide behind a one-line summary. Open by default; users can collapse
  // with the same toggle if they want to focus on AI instructions.
  const [expanded, setExpanded] = useState(true);
  const rows = useMemo(() => parseQualRows(value), [value]);
  const summary = <CountSummary count={rows.length} noun="qualification question" />;
  return (
    <SectionCard padding="16px 20px">
      <CardHeader
        title="Qualification questions"
        summary={summary}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      />
      {expanded && (
        <div style={{ marginTop: 8 }}>
          <ServiceQualificationRowsEditor
            rows={rows}
            onChange={(next) => onChange(serializeQualRows(next))}
          />
        </div>
      )}
    </SectionCard>
  );
}

// ─── Service tab header (badge + description + rename CTA) ───────────────

function ServiceHeader({
  profile,
  onRenamed,
}: {
  profile: ServiceProfile;
  onRenamed: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const displayName = getServiceDisplayName(profile);
  const showRenameCta = isDefaultRenamable(profile);
  const handleRename = async () => {
    setRenaming(true);
    try {
      await serviceProfilesApi.update(profile.id, { name: 'House Cleaning' });
      notify.success('Service renamed', 'Default Service is now House Cleaning.');
      onRenamed();
    } catch (err: any) {
      notify.error('Could not rename', err?.response?.data?.message ?? err?.message ?? 'Rename failed');
    } finally {
      setRenaming(false);
    }
  };
  return (
    <SectionCard padding="18px 22px">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--lb-ink-1)' }}>
              {displayName}
            </div>
            {profile.isDefault && <ScopeBadgePill badge="global" />}
            <ScopeBadgePill
              badge={profile.status === 'active' ? 'service' : profile.status === 'draft' ? 'draft' : 'archived'}
            />
          </div>
          <div style={{ fontSize: 13, color: 'var(--lb-ink-4)', lineHeight: 1.55 }}>
            Instructions on this tab apply only to leads matched to <strong>{displayName}</strong>.
          </div>
          {showRenameCta && (
            <div style={{
              marginTop: 12,
              padding: 10,
              borderRadius: 8,
              background: '#fffbeb',
              border: '1px solid #fde68a',
              fontSize: 12.5,
              color: '#92400e',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}>
              <Info size={13} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 200 }}>
                This is your fallback service. Rename it to your main service so the tab is easier to recognize.
              </span>
              <button
                type="button"
                onClick={handleRename}
                disabled={renaming}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  borderRadius: 8,
                  border: '1px solid #fcd34d',
                  background: '#fef3c7',
                  color: '#92400e',
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: renaming ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {renaming ? <Loader2 size={12} className="animate-spin" /> : <Pencil size={12} />}
                Rename to House Cleaning
              </button>
            </div>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

// ─── Global tab: service-scoped info card (PR-B.1) ───────────────────────
// Replaces the FaqCard + PricingGuidanceCard that used to live on Global
// and were inherently service-specific.

function ServiceScopedInfoCard() {
  return (
    <SectionCard padding="16px 20px">
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ flexShrink: 0, paddingTop: 2 }}>
          <Info size={16} style={{ color: 'var(--lb-accent)' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--lb-ink-1)', marginBottom: 6 }}>
            Pricing, FAQ, and qualification questions are service-specific
          </div>
          <div style={{ fontSize: 13, color: 'var(--lb-ink-3)', lineHeight: 1.55 }}>
            Select a service tab above to edit its instructions, or open{' '}
            <a href="/settings/services" style={{ color: 'var(--lb-accent)', fontWeight: 600 }}>
              Settings → Services
            </a>{' '}
            to manage pricing tables, FAQs, and qualification questions.
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

// ─── Status banners ──────────────────────────────────────────────────────

function ArchivedWarningBanner({
  onReactivate,
  reactivating,
}: {
  onReactivate: () => void;
  reactivating: boolean;
}) {
  return (
    <div style={{
      padding: '12px 14px',
      borderRadius: 10,
      background: '#f3f4f6',
      border: '1px solid #e5e7eb',
      display: 'flex',
      gap: 12,
      alignItems: 'flex-start',
      flexWrap: 'wrap',
    }}>
      <Archive size={16} style={{ color: '#6b7280', flexShrink: 0, marginTop: 2 }} />
      <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.5, flex: 1, minWidth: 200 }}>
        <strong>This service is archived</strong> and is not used for AI replies. Edits stay saved, but the resolver will not match new leads to it. Reactivate to bring it back into the AI flow.
      </div>
      <button
        type="button"
        onClick={onReactivate}
        disabled={reactivating}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '7px 12px', borderRadius: 8,
          border: '1px solid #bfdbfe',
          background: '#2563eb', color: 'white',
          fontSize: 12.5, fontWeight: 600,
          cursor: reactivating ? 'not-allowed' : 'pointer',
          fontFamily: 'inherit',
          flexShrink: 0,
        }}
      >
        {reactivating ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
        Reactivate
      </button>
    </div>
  );
}

function DraftWarningBanner() {
  return (
    <div style={{
      padding: '12px 14px',
      borderRadius: 10,
      background: '#fffbeb',
      border: '1px solid #fde68a',
      display: 'flex',
      gap: 10,
      alignItems: 'flex-start',
    }}>
      <Info size={16} style={{ color: '#b45309', flexShrink: 0, marginTop: 2 }} />
      <div style={{ fontSize: 13, color: '#92400e', lineHeight: 1.5 }}>
        <strong>AI replies are paused</strong> until this service is activated. You can still edit instructions now — they take effect the moment you activate the service in Settings → Services.
      </div>
    </div>
  );
}


function ServicePlaybookEditor({
  profile,
  onSaved,
}: {
  profile: ServiceProfile;
  onSaved: () => void;
}) {
  const [searchParams] = useSearchParams();
  const advancedMode =
    searchParams.get('advanced') === '1' || searchParams.get('debug') === '1';

  const initialWrapper = useMemo(
    () => parseAiInstructionsWrapper(profile.aiInstructionsJson),
    [profile.aiInstructionsJson],
  );
  const [v2, setV2] = useState<PlaybookV2Storage>(initialWrapper.aiPlaybookV2);
  // PR-D — pricing/FAQ/qualification drafts now live alongside v2 so the
  // Service tab is self-contained (no need to bounce out to Settings →
  // Services for these surfaces). Each draft holds the raw JSON string;
  // dirtyFields tracks which of the four areas changed so handleSave
  // sends exactly the fields the user touched.
  const [pricingDraft, setPricingDraft] = useState<string>(profile.pricingJson ?? '');
  const [faqDraft, setFaqDraft] = useState<string>(profile.faqJson ?? '');
  const [qualDraft, setQualDraft] = useState<string>(profile.qualificationSchemaJson ?? '');
  const [saving, setSaving] = useState(false);
  const [reactivating, setReactivating] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef<Set<PlaybookSectionKey>>(new Set());
  const dirtyFieldsRef = useRef<Set<'pricing' | 'faq' | 'qualification'>>(new Set());
  // Force a re-render when dirty state changes so the Save button enables/
  // disables. Ref-only tracking would otherwise keep the button stale.
  const [, bumpDirty] = useState(0);

  const handleReactivate = async () => {
    if (!confirm(`Reactivate "${profile.name}"? AI replies will resume for leads matched to this service.`)) return;
    setReactivating(true);
    setError(null);
    try {
      await serviceProfilesApi.transitionStatus(profile.id, 'active', true);
      notify.success('Reactivated', `${profile.name} is active again.`);
      onSaved();
    } catch (err: any) {
      setError(err?.response?.data?.message ?? err?.message ?? 'Reactivation failed');
      notify.error('Could not reactivate', err?.response?.data?.message ?? err?.message ?? 'Reactivation failed');
    } finally {
      setReactivating(false);
    }
  };

  // Reset state when profile changes (parent uses key=profile.id, so this
  // is belt-and-suspenders — the key already forces a remount).
  useEffect(() => {
    setV2(initialWrapper.aiPlaybookV2);
    setPricingDraft(profile.pricingJson ?? '');
    setFaqDraft(profile.faqJson ?? '');
    setQualDraft(profile.qualificationSchemaJson ?? '');
    dirtyRef.current = new Set();
    dirtyFieldsRef.current = new Set();
  }, [initialWrapper, profile.pricingJson, profile.faqJson, profile.qualificationSchemaJson]);

  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(null), 2000);
    return () => clearTimeout(t);
  }, [savedAt]);

  const onSectionChange = (section: PlaybookSectionKey, value: string) => {
    dirtyRef.current.add(section);
    setV2((prev) => ({
      ...prev,
      [section]: { customInstructions: value, suggestedFromWebsite: false },
    }));
    bumpDirty((n) => n + 1);
  };

  const onPricingChange = (next: string) => {
    dirtyFieldsRef.current.add('pricing');
    setPricingDraft(next);
    bumpDirty((n) => n + 1);
  };
  const onFaqChange = (next: string) => {
    dirtyFieldsRef.current.add('faq');
    setFaqDraft(next);
    bumpDirty((n) => n + 1);
  };
  const onQualChange = (next: string) => {
    dirtyFieldsRef.current.add('qualification');
    setQualDraft(next);
    bumpDirty((n) => n + 1);
  };

  const handleSave = async () => {
    const aiDirty = dirtyRef.current.size > 0;
    const fields = dirtyFieldsRef.current;
    if (!aiDirty && fields.size === 0) return;
    setSaving(true);
    setError(null);
    try {
      // Build a single PATCH covering every dirty field. Undefined fields
      // are not sent, so untouched data stays untouched on the server.
      const patch: Record<string, unknown> = {};
      if (aiDirty) {
        const merged: AiInstructionsWrapper = {
          version: initialWrapper.version || 1,
          aiPlaybookV2: v2,
          passthrough: initialWrapper.passthrough,
        };
        patch.aiInstructionsJson = serializeWrapper(merged);
      }
      if (fields.has('pricing')) patch.pricingJson = pricingDraft || null;
      if (fields.has('faq')) patch.faqJson = faqDraft || null;
      if (fields.has('qualification')) patch.qualificationSchemaJson = qualDraft || null;
      await serviceProfilesApi.update(profile.id, patch as any);
      dirtyRef.current = new Set();
      dirtyFieldsRef.current = new Set();
      setSavedAt(Date.now());
      onSaved();
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const hasDirty = dirtyRef.current.size > 0 || dirtyFieldsRef.current.size > 0;
  const serviceRules = useMemo(
    () => extractServiceRulesFromWrapper(initialWrapper),
    [initialWrapper],
  );
  const isArchived = profile.status === 'archived';
  const isDraft = profile.status === 'draft';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error && <StatusPill status="error" message={error} />}
      {!error && saving && <StatusPill status="saving" />}
      {!error && !saving && savedAt && <StatusPill status="saved" />}

      <ServiceHeader profile={profile} onRenamed={onSaved} />
      {isArchived && (
        <ArchivedWarningBanner
          onReactivate={handleReactivate}
          reactivating={reactivating}
        />
      )}
      {isDraft && <DraftWarningBanner />}
      {serviceRules && <ServiceRulesViewer rules={serviceRules} />}

      <ServicePricingCard value={pricingDraft} onChange={onPricingChange} />
      <ServiceFaqCard value={faqDraft} onChange={onFaqChange} />
      <ServiceQualificationCard value={qualDraft} onChange={onQualChange} />

      {/* Service-scoped HOW labels make clear these are additions, not
          global facts. Storage keys + runtime prompt assembly stay the
          same — only the UI label changes. */}
      <HowSectionCard
        section="business_information"
        value={v2.business_information?.customInstructions ?? ''}
        onChange={(v) => onSectionChange('business_information', v)}
        titleOverride="Service business details"
        subtitleOverride={`What AI should know specifically when handling ${getServiceDisplayName(profile)} leads. Layered on top of Global business info.`}
      />

      <HowSectionCard
        section="pricing_guidance"
        value={v2.pricing_guidance?.customInstructions ?? ''}
        onChange={(v) => onSectionChange('pricing_guidance', v)}
        titleOverride="Service pricing instructions"
        subtitleOverride={`How AI should discuss pricing for ${getServiceDisplayName(profile)}. The pricing table above is the source of truth for numbers.`}
      />

      <HowSectionCard
        section="personality_brand_voice"
        value={v2.personality_brand_voice?.customInstructions ?? ''}
        onChange={(v) => onSectionChange('personality_brand_voice', v)}
        titleOverride="Service communication style"
        subtitleOverride={`Tone + voice tweaks specifically for ${getServiceDisplayName(profile)}. Layered on top of the Global brand voice.`}
      />

      {advancedMode && (
        <>
          <AdvancedSectionsBanner />
          <HowSectionCard
            section="qualification_guidance"
            value={v2.qualification_guidance?.customInstructions ?? ''}
            onChange={(v) => onSectionChange('qualification_guidance', v)}
            legacyAdvanced
          />
          <HowSectionCard
            section="booking_guidance"
            value={v2.booking_guidance?.customInstructions ?? ''}
            onChange={(v) => onSectionChange('booking_guidance', v)}
            legacyAdvanced
          />
          <HowSectionCard
            section="human_handoff_guidance"
            value={v2.human_handoff_guidance?.customInstructions ?? ''}
            onChange={(v) => onSectionChange('human_handoff_guidance', v)}
            legacyAdvanced
          />
          <HowSectionCard
            section="objection_handling"
            value={v2.objection_handling?.customInstructions ?? ''}
            onChange={(v) => onSectionChange('objection_handling', v)}
            legacyAdvanced
          />
          <HowSectionCard
            section="followup_tone"
            value={v2.followup_tone?.customInstructions ?? ''}
            onChange={(v) => onSectionChange('followup_tone', v)}
            legacyAdvanced
          />
        </>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, alignItems: 'center' }}>
        <span style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginRight: 'auto' }}>
          Editing the {getServiceDisplayName(profile)} service playbook.
        </span>
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
          {saving ? 'Saving…' : hasDirty ? 'Save service playbook' : 'No changes'}
        </button>
      </div>
    </div>
  );
}

function GlobalPlaybookEditor() {
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

      {/* === Cards rendered in Playbook V2.5 order — simplified to 4 ===
            Visible Playbook now answers two business-owner questions:
            "What should AI know about my company?" and "What business
            rules should AI follow?" Communication Style & Brand Voice
            (personality_brand_voice) moved to advanced mode along with
            the other legacy sections — friendly/professional/local
            behavior is already in BASE_HARD_RULES and the system prompt,
            users rarely know what to enter, and future personalization
            will happen via the AI assistant chat. Every backend section
            key still exists and still emits at runtime; only the UI
            surface narrows.

            Visible cards (4 total):
              1. Business Information
              2. FAQ
              3. Pricing Guidance (with embedded Pricing Table)
              4. Global Custom Instructions

            Advanced-mode cards (when ?advanced=1 / ?debug=1):
              - Qualification Guidance
              - Booking Guidance
              - Human Handoff Guidance
              - Objection Handling
              - Follow-up Tone
              - Communication Style & Brand Voice
                (backend key: personality_brand_voice) */}

      {accounts.length > 0 && <>
        {/* 0. Custom Instructions (consolidated, chat-added rules across all areas) */}
        <CustomInstructionsAllCard savedAccountId={accounts[0].id} />

        {/* 1. Business Information (company-wide) */}
        <HowSectionCard
          section="business_information"
          value={v2.business_information?.customInstructions ?? ''}
          onChange={v => onSectionChange('business_information', v)}
          isSuggested={!!v2.business_information?.suggestedFromWebsite}
        />

        {/* 2. Communication Style & Brand Voice (promoted from advanced in
              PR-B.1 — tenant-wide tone belongs on the Global tab so users
              don't have to flip ?advanced=1 to set their default voice.) */}
        <HowSectionCard
          section="personality_brand_voice"
          value={v2.personality_brand_voice?.customInstructions ?? ''}
          onChange={v => onSectionChange('personality_brand_voice', v)}
          isSuggested={!!v2.personality_brand_voice?.suggestedFromWebsite}
        />

        {/* Service-scoped info card — FaqCard + PricingGuidanceCard were
              removed in PR-B.1 because their content is inherently service-
              specific (FAQ, pricing table). Operators select a service tab
              above or visit Settings → Services for those surfaces. */}
        <ServiceScopedInfoCard />

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

        {/* 4. Global Custom Instructions — surfaces User.globalAiPrompt */}
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
  titleOverride, subtitleOverride,
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
  /** PR-D.1 — override the canonical section label. Used on Service tabs
   *  to clarify "Service business details" vs the Global "Business
   *  Information" section; the storage key stays the same so runtime
   *  prompt assembly is unchanged. */
  titleOverride?: string;
  subtitleOverride?: string;
}) {
  const Icon = SECTION_ICONS[section];
  return (
    <PlaybookSectionShell
      icon={Icon}
      title={titleOverride ?? PLAYBOOK_SECTION_UI_LABELS[section]}
      subtitle={subtitleOverride ?? PLAYBOOK_SECTION_SUBTITLES[section]}
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

// PricingGuidanceCard + FaqCard removed in PR-B.1 — content was inherently
// service-specific and now lives in Settings → Services. The Global tab
// renders ServiceScopedInfoCard in their place to make the migration
// obvious to operators.

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

// ─── Consolidated Custom Instructions card ───────────────────────────────
// One place that lists EVERY chat-added rule across all areas
// (business_information / pricing_guidance / brand_voice / global),
// each with its own delete button and an area label so the user can
// tell at a glance which section the rule belongs to. This is the top
// card on Settings → AI Playbook so the rules surface immediately
// without scrolling.
//
// Replaces the per-section subsections from the first cut — the user
// asked for one consolidated view rather than rules hidden under each
// playbook section card.
//
// Source of truth is the backend list endpoint (one call per area).
// Re-fetches on the AI Settings Assistant applied event so chat writes
// auto-appear without a manual refresh.

type AreaSpec = { area: string; label: string; savedAccountId?: string };

function CustomInstructionsAllCard({ savedAccountId }: { savedAccountId: string }) {
  // Areas surfaced by the chat assistant today. `savedAccountId` is
  // only required for the per-section playbook areas; global is
  // user-scoped.
  const areas: AreaSpec[] = useMemo(() => ([
    { area: 'business_information', label: 'Business Information', savedAccountId },
    { area: 'pricing_guidance',     label: 'Pricing Guidance',     savedAccountId },
    { area: 'brand_voice',          label: 'Brand Voice',          savedAccountId },
    { area: 'global_custom_instructions', label: 'Global' },
  ]), [savedAccountId]);

  // entries grouped by area, in fetch order. Flattened on render.
  const [byArea, setByArea] = useState<Record<string, ChatInstructionEntry[]>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetchOne = async (a: AreaSpec) => {
    const res = await aiSettingsAssistantApi.listChatInstructions(a.area, a.savedAccountId);
    setByArea(prev => ({ ...prev, [a.area]: res.entries ?? [] }));
  };

  const refetchAll = async () => {
    setError(null);
    try {
      const results = await Promise.all(
        areas.map(a => aiSettingsAssistantApi.listChatInstructions(a.area, a.savedAccountId)
          .then(r => [a.area, r.entries ?? []] as const)
          .catch(() => [a.area, [] as ChatInstructionEntry[]] as const)),
      );
      const next: Record<string, ChatInstructionEntry[]> = {};
      for (const [area, entries] of results) next[area] = entries;
      setByArea(next);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load custom instructions');
    }
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    refetchAll().finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedAccountId]);

  // Re-fetch when the chat assistant applies a write anywhere — we
  // refresh only the area that was touched (cheaper) and fall back to
  // a full refetch on unknown areas.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<AiSettingsAssistantAppliedDetail>).detail;
      if (!detail) return;
      const match = areas.find(a => a.area === detail.area);
      if (!match) { refetchAll(); return; }
      refetchOne(match).catch(() => { /* leave existing on transient error */ });
    };
    window.addEventListener(AI_SETTINGS_ASSISTANT_APPLIED_EVENT, handler);
    return () => window.removeEventListener(AI_SETTINGS_ASSISTANT_APPLIED_EVENT, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areas]);

  // Flat list, newest first across all areas.
  const flat = useMemo(() => {
    const rows: Array<{ entry: ChatInstructionEntry; spec: AreaSpec }> = [];
    for (const a of areas) {
      for (const e of byArea[a.area] ?? []) rows.push({ entry: e, spec: a });
    }
    rows.sort((x, y) => (Date.parse(y.entry.createdAt) || 0) - (Date.parse(x.entry.createdAt) || 0));
    return rows;
  }, [byArea, areas]);

  const handleDelete = async (entryId: string, spec: AreaSpec) => {
    setBusyId(entryId); setError(null);
    try {
      const res = await aiSettingsAssistantApi.deleteChatInstruction(spec.area, entryId, spec.savedAccountId);
      setByArea(prev => ({ ...prev, [spec.area]: res.entries ?? [] }));
    } catch (e: any) {
      setError(e?.message ?? 'Failed to delete entry');
    } finally {
      setBusyId(null);
    }
  };

  const handleClearAll = async () => {
    if (flat.length === 0) return;
    if (!window.confirm(`Delete all ${flat.length} chat-added instruction${flat.length === 1 ? '' : 's'}?`)) return;
    setClearing(true); setError(null);
    try {
      for (const { entry, spec } of flat) {
        const res = await aiSettingsAssistantApi.deleteChatInstruction(spec.area, entry.id, spec.savedAccountId);
        setByArea(prev => ({ ...prev, [spec.area]: res.entries ?? [] }));
      }
    } catch (e: any) {
      setError(e?.message ?? 'Failed to clear entries');
    } finally {
      setClearing(false);
    }
  };

  return (
    <PlaybookSectionShell
      icon={MessageSquare}
      title="Custom Instructions"
      subtitle="Rules you've added through the AI Settings Assistant chat. Each one is applied at runtime alongside the section's default prompt."
    >
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        marginBottom: 12,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 700, color: 'var(--lb-ink-5)',
          letterSpacing: 0.06, textTransform: 'uppercase',
          fontFamily: 'var(--lb-font-mono)',
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}>
          {flat.length} active rule{flat.length === 1 ? '' : 's'}
        </div>
        {flat.length > 0 && (
          <button
            type="button"
            onClick={handleClearAll}
            disabled={clearing || busyId !== null}
            style={{
              background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600,
              color: '#b91c1c', opacity: clearing ? 0.6 : 1,
            }}
          >
            {clearing ? 'Clearing…' : 'Clear all ↺'}
          </button>
        )}
      </div>

      {loading && (
        <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      )}

      {!loading && flat.length === 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', lineHeight: 1.5 }}>
          No chat-added instructions yet. Open the AI Settings Assistant
          (the sparkle icon in the top right) and describe a rule in
          natural language — each one will appear here with its own
          delete button.
        </div>
      )}

      {!loading && flat.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {flat.map(({ entry, spec }) => (
            <li
              key={`${spec.area}:${entry.id}`}
              style={{
                padding: '10px 12px',
                background: 'white',
                border: '1px solid var(--lb-line)',
                borderRadius: 8,
                display: 'flex', gap: 10, alignItems: 'flex-start',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
                    background: '#ede9fe', color: '#6d28d9',
                    letterSpacing: 0.04, textTransform: 'uppercase',
                    fontFamily: 'var(--lb-font-mono)',
                  }}>
                    {spec.label}
                  </span>
                  {entry.createdAt && (
                    <span style={{ fontSize: 11, color: 'var(--lb-ink-6)' }}>{formatRelative(entry.createdAt)}</span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: 'var(--lb-ink-1)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                  {entry.text}
                </div>
                {entry.userMessage && (
                  <div style={{ marginTop: 4, fontSize: 11, color: 'var(--lb-ink-6)' }} title="What you typed">
                    "{truncateText(entry.userMessage, 100)}"
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => handleDelete(entry.id, spec)}
                disabled={busyId === entry.id || clearing}
                title="Delete this instruction"
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 28, height: 28, borderRadius: 6,
                  background: 'transparent', border: 0, cursor: 'pointer',
                  color: '#b91c1c', opacity: busyId === entry.id ? 0.6 : 1,
                  flexShrink: 0,
                }}
              >
                {busyId === entry.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <div style={{
          marginTop: 8,
          padding: '6px 10px',
          background: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: 6,
          fontSize: 12, color: '#991b1b',
        }}>
          {error}
        </div>
      )}
    </PlaybookSectionShell>
  );
}

function truncateText(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diffMs = Date.now() - t;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(t).toLocaleDateString();
}

// Suppress the unused Sparkles import warning since iconography may evolve.
void Sparkles;
