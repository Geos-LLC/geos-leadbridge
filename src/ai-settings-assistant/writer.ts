/**
 * Apply a verified assistant proposal to the underlying storage.
 *
 * Returns `{ beforeValue, afterValue }` so the audit log can record exactly
 * what changed. Every write is scoped — we only touch the column/section
 * dictated by `proposal.payload.target.area`. There is no generic "patch"
 * path; adding a new MVP area is a deliberate code change here.
 *
 * SavedAccount.followUpSettingsJson is a single TEXT blob in the DB. We
 * read-modify-write under a per-account narrow scope and only touch the
 * `aiPlaybookV2[sectionKey].customInstructions` field. Other keys in the
 * blob are preserved verbatim. This matches the merge semantics used in
 * follow-up-engine.controller.ts's saveSettings handler.
 */

import { PrismaService } from '../common/utils/prisma.service';
import { SignedProposal, AssistantArea } from './assistant.types';

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

function appendInstruction(current: string | null, addition: string): string {
  const cur = (current ?? '').trim();
  const add = addition.trim();
  if (!cur) return add;
  // Separate paragraph so each AI-Assistant write is visually distinguishable
  // when the user opens the section card in Settings.
  return `${cur}\n\n${add}`;
}

export async function applyProposal(
  prisma: PrismaService,
  userId: string,
  proposal: SignedProposal,
): Promise<WriteResult> {
  const { target, proposedChange, savedAccountId } = proposal.payload;

  // global_custom_instructions — User.globalAiPrompt
  if (target.area === 'global_custom_instructions') {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { globalAiPrompt: true },
    });
    const before = user?.globalAiPrompt ?? null;
    const next =
      proposedChange.operation === 'set'
        ? proposedChange.newValue
        : appendInstruction(before, proposedChange.newValue);
    await prisma.user.update({
      where: { id: userId },
      data: { globalAiPrompt: next || null },
    });
    return { beforeValue: before, afterValue: next, storageKey: 'globalAiPrompt' };
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

  // faq — append to SavedAccount.faqJson
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

  // The three playbook V2 surfaces — read-modify-write on followUpSettingsJson
  const sectionKey = PLAYBOOK_AREA_TO_SECTION[target.area];
  let settings: Record<string, any> = {};
  if (account.followUpSettingsJson) {
    try { settings = JSON.parse(account.followUpSettingsJson) || {}; } catch { settings = {}; }
  }
  const v2 = settings.aiPlaybookV2 && typeof settings.aiPlaybookV2 === 'object'
    ? { ...settings.aiPlaybookV2 }
    : {};
  const section = v2[sectionKey] && typeof v2[sectionKey] === 'object' ? { ...v2[sectionKey] } : {};
  const before: string | null = typeof section.customInstructions === 'string'
    ? section.customInstructions
    : null;
  const next = proposedChange.operation === 'replace' || proposedChange.operation === 'set'
    ? proposedChange.newValue
    : appendInstruction(before, proposedChange.newValue);
  section.customInstructions = next;
  v2[sectionKey] = section;
  settings.aiPlaybookV2 = v2;

  await prisma.savedAccount.update({
    where: { id: account.id },
    data: { followUpSettingsJson: JSON.stringify(settings) },
  });
  return {
    beforeValue: before,
    afterValue: next,
    storageKey: `aiPlaybookV2.${sectionKey}.customInstructions`,
  };
}
