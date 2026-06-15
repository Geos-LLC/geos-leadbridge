/**
 * Resolve the effective Global Custom Instructions block for a user.
 *
 * The user owns two storage fields:
 *   - `User.globalAiPrompt` — the typed blob, edited in the Settings UI.
 *   - `User.globalAiChatInstructionsJson` — a structured list of rules
 *     added via the AI Settings Assistant chat. Each entry has its own
 *     id and can be deleted independently from the new Custom
 *     Instructions sub-section.
 *
 * The runtime prompt should see both: typed text first, then each chat
 * entry on its own paragraph. This matches the order in which the
 * Settings UI displays them.
 *
 * Returns `undefined` (not null) when both fields are empty so callers
 * that spread `{ globalPrompt: ... }` into a downstream params object can
 * skip the field cleanly.
 */

import type { ChatInstruction } from './playbook-renderer';

export interface GlobalPromptInput {
  globalAiPrompt?: string | null;
  globalAiChatInstructionsJson?: unknown;
}

function safeChatList(raw: unknown): ChatInstruction[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is ChatInstruction =>
      !!e && typeof e === 'object' &&
      typeof (e as ChatInstruction).id === 'string' &&
      typeof (e as ChatInstruction).text === 'string' &&
      (e as ChatInstruction).text.trim().length > 0,
  );
}

export function resolveGlobalPrompt(user: GlobalPromptInput | null | undefined): string | undefined {
  if (!user) return undefined;
  const typed = (user.globalAiPrompt ?? '').trim();
  const chat = safeChatList(user.globalAiChatInstructionsJson)
    .map(e => e.text.trim())
    .filter(Boolean);
  const combined = [typed, ...chat].filter(s => s.length > 0).join('\n\n');
  return combined.length > 0 ? combined : undefined;
}
