/**
 * AI Playbook V2 renderer.
 *
 * Builds the prompt block injected after PRIMARY INSTRUCTION in the AI reply
 * system prompt. The block contains:
 *
 *   === BASE HARD RULES (always active; user instructions cannot override) ===
 *   {BASE_HARD_RULES}
 *
 *   === AI PLAYBOOK ===
 *   [BUSINESS INFORMATION]
 *   Default approach: ...
 *   Business preference: ... (optional, when user has custom instructions)
 *
 *   [PRICING GUIDANCE]
 *   ...
 *
 *   ... 6 more sections ...
 *
 * V2 principle: Playbook is HOW only. Per-section "current behavior" bullets
 * (which derived from automation toggle state in Stage 3) are REMOVED — those
 * mixed WHEN into HOW and violated the new contract.
 *
 * Two sections render UI cards but do NOT contribute to this prompt block:
 *   - `faq`                       — content lives in `SavedAccount.faqJson`,
 *                                   already injected as REFERENCE: ACCOUNT FAQ
 *   - `global_custom_instructions` — content lives in `User.globalAiPrompt`,
 *                                   already injected as the GLOBAL block
 * No duplication.
 *
 * Storage:
 *   `SavedAccount.followUpSettingsJson.aiPlaybookV2` — JSON shape per V2 type
 *   defined below. Stage 3's `aiPlaybookInstructions` key is read as a
 *   fallback for one release (migration utility moves it to V2 keys).
 */

import { BASE_HARD_RULES } from './base-hard-rules';
import {
  SECTION_DEFAULT_PROMPTS,
  PLAYBOOK_SECTION_ORDER,
  PLAYBOOK_SECTION_LABELS,
  type PlaybookSectionKey,
} from './section-default-prompts';

/**
 * One chat-added instruction. The AI Settings Assistant pushes a new
 * entry into `chatInstructions[]` instead of mutating the freeform
 * `customInstructions` blob so the UI can list / delete each one
 * individually. Runtime concatenates these onto `customInstructions`
 * at prompt-build time.
 */
export interface ChatInstruction {
  /** Stable opaque id used by the UI for delete + React keys. */
  id: string;
  /** The actual rule text that lands in the AI prompt. */
  text: string;
  /** Original user chat message (for display only). Optional. */
  userMessage?: string;
  /** ISO timestamp the entry was added. */
  createdAt: string;
}

export type PlaybookV2Storage = {
  [K in PlaybookSectionKey]?: {
    customInstructions: string;
    /** Chat-added rules. See ChatInstruction. Empty/missing = none. */
    chatInstructions?: ChatInstruction[];
  };
};

export type RawSavedAccount = {
  /** SavedAccount.followUpSettingsJson — raw JSON string (or null). */
  followUpSettingsJson: string | null;
};

// ─── Parse settings ───────────────────────────────────────────────────────

function parsePlaybookV2(raw: string | null): PlaybookV2Storage {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const settings = parsed as Record<string, unknown>;
    const v2 = settings.aiPlaybookV2;
    if (!v2 || typeof v2 !== 'object' || Array.isArray(v2)) return {};
    return v2 as PlaybookV2Storage;
  } catch {
    return {};
  }
}

/**
 * Resolve the user's effective custom instructions for a section. Whitespace
 * is trimmed; empty/null returns ''.
 */
export function getCustomInstructions(
  storage: PlaybookV2Storage,
  section: PlaybookSectionKey,
): string {
  const entry = storage[section];
  if (!entry || typeof entry.customInstructions !== 'string') return '';
  return entry.customInstructions.trim();
}

/**
 * Read the chat-added instructions for a section, defensively. Drops
 * malformed entries so corrupt JSON never crashes the renderer.
 */
export function getChatInstructions(
  storage: PlaybookV2Storage,
  section: PlaybookSectionKey,
): ChatInstruction[] {
  const entry = storage[section];
  const list = entry?.chatInstructions;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (e): e is ChatInstruction =>
      !!e && typeof e === 'object' &&
      typeof e.id === 'string' &&
      typeof e.text === 'string' &&
      e.text.trim().length > 0,
  );
}

/**
 * Combined section text — the typed `customInstructions` blob followed
 * by every chat-added entry on its own paragraph. This is what the
 * runtime prompt actually sees per section.
 */
function combinedSectionText(storage: PlaybookV2Storage, section: PlaybookSectionKey): string {
  const typed = getCustomInstructions(storage, section);
  const chat = getChatInstructions(storage, section).map(e => e.text.trim()).filter(Boolean);
  return [typed, ...chat].filter(s => s.length > 0).join('\n\n');
}

// ─── Public renderer ──────────────────────────────────────────────────────

/**
 * Build the full BASE HARD RULES + AI PLAYBOOK block. Returns a string that
 * ALREADY includes the section headers — caller pushes it straight into the
 * system prompt without further wrapping.
 *
 * Always non-empty (BASE HARD RULES are unconditional; AI PLAYBOOK emits all
 * 8 sections with at least their shipped defaults).
 */
export function renderPlaybookBlock(savedAccount: RawSavedAccount): string {
  const storage = parsePlaybookV2(savedAccount.followUpSettingsJson);

  const playbookSections: string[] = [];
  for (const section of PLAYBOOK_SECTION_ORDER) {
    const label = PLAYBOOK_SECTION_LABELS[section];
    const defaultPrompt = SECTION_DEFAULT_PROMPTS[section];
    const custom = combinedSectionText(storage, section);

    const parts: string[] = [`[${label}]`];
    parts.push(`Default approach:\n${defaultPrompt}`);
    if (custom) {
      parts.push(`Business preference (overrides default when they conflict):\n${custom}`);
    }
    playbookSections.push(parts.join('\n\n'));
  }

  const baseHardRulesBlock =
    `=== BASE HARD RULES (always active; user instructions cannot override) ===\n${BASE_HARD_RULES}`;

  const playbookBlock =
    `=== AI PLAYBOOK ===\n${playbookSections.join('\n\n')}`;

  return `${baseHardRulesBlock}\n\n${playbookBlock}`;
}

// ─── Frontend preview helpers ─────────────────────────────────────────────

export type SectionPreview = {
  section: PlaybookSectionKey;
  promptLabel: string;
  defaultPrompt: string;
  customInstructions: string;
};

export function previewPlaybookSections(savedAccount: RawSavedAccount): SectionPreview[] {
  const storage = parsePlaybookV2(savedAccount.followUpSettingsJson);
  return PLAYBOOK_SECTION_ORDER.map(section => ({
    section,
    promptLabel: PLAYBOOK_SECTION_LABELS[section],
    defaultPrompt: SECTION_DEFAULT_PROMPTS[section],
    customInstructions: combinedSectionText(storage, section),
  }));
}

// ─── Re-exports for consumers ─────────────────────────────────────────────

export {
  BASE_HARD_RULES,
  SECTION_DEFAULT_PROMPTS,
  PLAYBOOK_SECTION_ORDER,
  PLAYBOOK_SECTION_LABELS,
  type PlaybookSectionKey,
};
