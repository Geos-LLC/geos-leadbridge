/**
 * Wire types for the AI Settings Assistant.
 *
 * The assistant is a controlled settings editor — not a raw prompt editor.
 * The /interpret endpoint returns one of four discriminated statuses; the
 * frontend renders different UI for each. /apply only accepts a
 * server-signed proposal that came out of /interpret.
 *
 * Phase-1 MVP target surfaces (everything else is unsupported and rejected
 * up front so a half-mapped LLM response can't write the wrong column):
 *
 *   - business_information       → SavedAccount.followUpSettingsJson.aiPlaybookV2.business_information.customInstructions
 *   - pricing_guidance           → SavedAccount.followUpSettingsJson.aiPlaybookV2.pricing_guidance.customInstructions
 *   - brand_voice                → SavedAccount.followUpSettingsJson.aiPlaybookV2.personality_brand_voice.customInstructions
 *   - faq                        → SavedAccount.faqJson  (append a Q&A pair)
 *   - global_custom_instructions → User.globalAiPrompt
 *
 * The runtime read path for all of these is already wired (see
 * playbook-renderer.ts + ai.service.ts) — applying a write here surfaces
 * in the next AI reply with no additional plumbing.
 */

export type AssistantArea =
  | 'business_information'
  | 'pricing_guidance'
  | 'brand_voice'
  | 'faq'
  | 'global_custom_instructions';

export type AssistantStatus =
  | 'apply_ready'
  | 'needs_clarification'
  | 'conflict'
  | 'noop'
  | 'unsupported';

export type AssistantOperation = 'append' | 'replace' | 'set' | 'add_faq';

/**
 * Conflict resolution choices presented to the user when a new rule
 * contradicts an existing one. The frontend gets PRE-SIGNED proposals
 * (one per applicable option) and echoes the chosen one back to /apply.
 *
 * 'keep_existing' carries no proposal — selecting it is a pure dismiss
 * (no write, no audit). 'replace_conflicting_rule' produces a proposal
 * with operation='replace' and newValue = current text minus the
 * conflicting excerpt + new rule. 'add_anyway' produces an append
 * proposal whose payload carries `conflictOverride: true` so the audit
 * log records that the user knowingly overrode the warning.
 */
export type ConflictResolution =
  | 'keep_existing'
  | 'replace_conflicting_rule'
  | 'add_anyway';

export interface AssistantTarget {
  area: AssistantArea;
  /** For playbook sections this is the V2 section key; for faq this is 'faqJson'; for global this is 'globalAiPrompt'. */
  storageKey: string;
}

export interface ProposedChange {
  operation: AssistantOperation;
  currentValue: string | null;
  newValue: string;
  diff?: string;
  /** Only set for `add_faq` — the new Q&A pair the writer will append. */
  faqEntry?: { question: string; answer: string };
  /**
   * True when the user is applying this proposal via the "Add anyway"
   * resolution on a conflict-detected change. Stored verbatim into the
   * audit log so we can count override events and surface a re-confirm
   * prompt at read time. Cannot be set by the frontend — the server is
   * the only party that mints proposals with this flag (during the
   * conflict response). HMAC signature covers it, so an attacker can't
   * forge an override flag onto a clean proposal.
   */
  conflictOverride?: boolean;
}

export interface ConflictInfo {
  existingRule?: string;
  newRule?: string;
  reason?: string;
}

/**
 * Server-signed proposal envelope. The frontend treats this as opaque —
 * it stores the whole thing in component state and passes the same object
 * back to /apply. The backend verifies signature + expiry, then applies
 * the embedded payload. The frontend MUST NOT forge or mutate any field.
 */
export interface SignedProposal {
  /** Stable id used in audit logs and React keys. */
  id: string;
  /** Unix ms — proposal becomes invalid past this point. */
  expiresAt: number;
  /** The user id this proposal was minted for. Apply enforces a match. */
  userId: string;
  /** Embedded payload (everything below) — signed in `signature`. */
  payload: {
    target: AssistantTarget;
    proposedChange: ProposedChange;
    /** Original user message — copied verbatim into the audit log on apply. */
    userMessage: string;
    /** One-line human-readable summary the UI shows. */
    summary: string;
    /** Optional savedAccountId scope. Null for global-scope writes. */
    savedAccountId: string | null;
  };
  /** HMAC-SHA256(JSON(payload) + expiresAt + userId + id). */
  signature: string;
}

export interface InterpretRequest {
  message: string;
  context: {
    /** Hint from the page the chat was opened on. Today purely informational; reserved for future routing. */
    surface?: 'ai-playbook' | 'automation' | 'pricing' | 'general' | 'unknown';
    savedAccountId?: string;
  };
}

/**
 * One pre-signed conflict-resolution option. The frontend renders a
 * button per entry; on click it POSTs the embedded `proposal` to /apply
 * unchanged. `keep_existing` carries no proposal because that path is
 * a pure dismiss — no write, no audit row.
 */
export interface ConflictResolutionOption {
  resolution: ConflictResolution;
  label: string;
  /** Server-signed proposal to apply when this resolution is chosen. Omitted for keep_existing. */
  proposal?: SignedProposal;
}

export interface InterpretResponse {
  status: AssistantStatus;
  summary: string;
  /** Present when status === 'apply_ready'. */
  proposal?: SignedProposal;
  /** Present when status === 'needs_clarification'. */
  clarifyingQuestion?: string;
  /** Present when status === 'conflict' or 'noop'. */
  conflict?: ConflictInfo;
  /** Present when status === 'conflict' — the 3 user choices, each carrying a pre-signed proposal (except keep_existing). */
  resolutionOptions?: ConflictResolutionOption[];
  /** Present when status === 'unsupported' or 'conflict' or 'noop'. */
  reason?: string;
  /** Present when status === 'noop' — the existing rule the new request duplicates. */
  existingRule?: string;
  /** Present when status === 'noop' — the new request that was deemed already-covered. */
  newRule?: string;
}

export interface ApplyRequest {
  proposal: SignedProposal;
}

export interface ApplyResponse {
  success: boolean;
  appliedAt: string; // ISO
  auditLogId: string;
}
