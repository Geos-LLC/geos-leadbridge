/**
 * Apply a verified assistant proposal to the underlying storage.
 *
 * Returns `{ beforeValue, afterValue }` so the audit log can record exactly
 * what changed. Every write is scoped — we only touch the column/section
 * dictated by `proposal.payload.target.area`. There is no generic "patch"
 * path; adding a new MVP area is a deliberate code change here.
 *
 * Storage model per playbook / global area, by operation:
 *
 *   - operation='append':
 *       Push a structured `ChatInstruction` entry into the section's
 *       `chatInstructions[]` array (per playbook section) or into
 *       `User.globalAiChatInstructionsJson[]` (global). The typed
 *       `customInstructions` / `globalAiPrompt` blob is NEVER mutated.
 *       The Custom Instructions UI lists each entry and lets the user
 *       delete one at a time without fuzzy substring matching.
 *
 *   - operation='replace' / 'set':
 *       Used by conflict-resolution ("Replace conflicting rule"). The
 *       proposal carries a precomputed newValue that's the merged text
 *       minus the excerpt. We REPLACE the typed `customInstructions` /
 *       `globalAiPrompt` blob with that value, leaving the chat list
 *       untouched. This preserves the long-standing conflict-resolution
 *       UX where the merged result lives in the typed blob.
 *
 *   - faq:
 *       Append a Q&A pair into `SavedAccount.faqJson.entries[]`. Already
 *       structured — unchanged.
 *
 * `beforeValue` / `afterValue` recorded in the audit log are the
 * *combined* effective text for the area (typed + every chat entry
 * joined by paragraph breaks) — what the runtime prompt actually sees.
 */

import { PrismaService } from '../common/utils/prisma.service';
import { SignedProposal, AssistantArea } from './assistant.types';
import { randomUUID } from 'crypto';
import type { ChatInstruction } from '../ai/playbook-renderer';

export interface WriteResult {
  beforeValue: string | null;
  afterValue: string | null;
  /** Storage key actually written. Mirrors target.storageKey for the audit log. */
  storageKey: string;
}

interface FaqEntry { question: string; answer: string }

const PLAYBOOK_AREA_TO_SECTION: Record<Exclude<AssistantArea, 'faq' | 'global_custom_instructions'>, string> = {
  business_information: 'business_information',
  pricing_guidance: 'pricing_guidance',
  brand_voice: 'personality_brand_voice', // UI calls it Brand Voice; storage key is the longer name
};

/** Drop malformed entries the same way the renderer does. */
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

/**
 * Effective text the runtime + conflict detector see: typed blob
 * followed by each chat entry, joined by blank lines.
 */
function combineSection(
  customInstructions: string | null | undefined,
  chatList: ChatInstruction[],
): string {
  const typed = (customInstructions ?? '').trim();
  const chat = chatList.map(e => e.text.trim()).filter(Boolean);
  return [typed, ...chat].filter(s => s.length > 0).join('\n\n');
}

function newEntry(text: string, userMessage: string | undefined): ChatInstruction {
  return {
    id: randomUUID(),
    text: text.trim(),
    userMessage,
    createdAt: new Date().toISOString(),
  };
}

export async function applyProposal(
  prisma: PrismaService,
  userId: string,
  proposal: SignedProposal,
): Promise<WriteResult> {
  const { target, proposedChange, savedAccountId, userMessage } = proposal.payload;
  const isReplace = proposedChange.operation === 'replace' || proposedChange.operation === 'set';

  // global_custom_instructions
  if (target.area === 'global_custom_instructions') {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { globalAiPrompt: true, globalAiChatInstructionsJson: true },
    });
    const existingChat = safeChatList(user?.globalAiChatInstructionsJson as unknown);
    const before = combineSection(user?.globalAiPrompt, existingChat) || null;

    if (isReplace) {
      const nextTyped = proposedChange.newValue;
      await prisma.user.update({
        where: { id: userId },
        data: { globalAiPrompt: nextTyped || null },
      });
      const after = combineSection(nextTyped, existingChat);
      return { beforeValue: before, afterValue: after, storageKey: 'globalAiPrompt' };
    }

    const nextChat = [...existingChat, newEntry(proposedChange.newValue, userMessage)];
    await prisma.user.update({
      where: { id: userId },
      data: { globalAiChatInstructionsJson: nextChat as any },
    });
    const after = combineSection(user?.globalAiPrompt, nextChat);
    return { beforeValue: before, afterValue: after, storageKey: 'globalAiChatInstructionsJson' };
  }

  // For everything else we need a savedAccountId
  if (!savedAccountId) {
    throw new Error('savedAccountId required for non-global area');
  }
  const account = await prisma.savedAccount.findFirst({
    where: { id: savedAccountId, userId },
    select: { id: true, faqJson: true, followUpSettingsJson: true },
  });
  if (!account) throw new Error('account_not_found');

  // faq — unchanged
  if (target.area === 'faq') {
    let faq: { entries?: FaqEntry[] } & Record<string, any> = {};
    if (account.faqJson) {
      try { faq = JSON.parse(account.faqJson) || {}; } catch { faq = {}; }
    }
    const entries: FaqEntry[] = Array.isArray(faq.entries) ? [...faq.entries] : [];
    const entry = proposedChange.faqEntry;
    if (!entry || !entry.question || !entry.answer) {
      throw new Error('faqEntry missing on FAQ proposal');
    }
    entries.push({ question: entry.question.trim(), answer: entry.answer.trim() });
    const next = { ...faq, entries };
    const beforeStr = account.faqJson;
    const afterStr = JSON.stringify(next);
    await prisma.savedAccount.update({
      where: { id: account.id },
      data: { faqJson: afterStr },
    });
    return { beforeValue: beforeStr, afterValue: afterStr, storageKey: 'faqJson' };
  }

  // Playbook V2 sections — read-modify-write on followUpSettingsJson.
  const sectionKey = PLAYBOOK_AREA_TO_SECTION[target.area];
  let settings: Record<string, any> = {};
  if (account.followUpSettingsJson) {
    try { settings = JSON.parse(account.followUpSettingsJson) || {}; } catch { settings = {}; }
  }
  const v2 = settings.aiPlaybookV2 && typeof settings.aiPlaybookV2 === 'object'
    ? { ...settings.aiPlaybookV2 }
    : {};
  const section = v2[sectionKey] && typeof v2[sectionKey] === 'object' ? { ...v2[sectionKey] } : {};
  const existingChat = safeChatList(section.chatInstructions);
  const typed: string = typeof section.customInstructions === 'string' ? section.customInstructions : '';

  const before = combineSection(typed, existingChat) || null;

  let storageKey: string;
  let nextTyped = typed;
  let nextChat = existingChat;
  if (isReplace) {
    nextTyped = proposedChange.newValue;
    storageKey = `aiPlaybookV2.${sectionKey}.customInstructions`;
  } else {
    nextChat = [...existingChat, newEntry(proposedChange.newValue, userMessage)];
    storageKey = `aiPlaybookV2.${sectionKey}.chatInstructions`;
  }

  section.customInstructions = nextTyped;
  section.chatInstructions = nextChat;
  v2[sectionKey] = section;
  settings.aiPlaybookV2 = v2;

  await prisma.savedAccount.update({
    where: { id: account.id },
    data: { followUpSettingsJson: JSON.stringify(settings) },
  });

  const after = combineSection(nextTyped, nextChat);
  return { beforeValue: before, afterValue: after, storageKey };
}
