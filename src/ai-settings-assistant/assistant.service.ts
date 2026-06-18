import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { PrismaService } from '../common/utils/prisma.service';
import {
  AssistantArea,
  AssistantOperation,
  AssistantTarget,
  ApplyRequest,
  ApplyResponse,
  ConflictResolutionOption,
  InterpretRequest,
  InterpretResponse,
  ProposedChange,
  SignedProposal,
} from './assistant.types';
import { checkUserMessageSafety, checkProposedValueSafety } from './safety-rules';
import { signProposal, verifyProposal } from './proposal-signer';
import { ClassifierResult, classifyByLlm, classifyByRules } from './classifier';
import { applyProposal } from './writer';
import {
  ConflictDetectorContext,
  ConflictDetectorResult,
  detectConflict,
  openAiLlmCaller,
} from './conflict-detector';

const AREA_LABELS: Record<AssistantArea, string> = {
  business_information: 'Business Information',
  pricing_guidance: 'Pricing Guidance',
  brand_voice: 'Brand Voice',
  faq: 'FAQ',
  global_custom_instructions: 'Global Custom Instructions',
};

/**
 * Map an assistant area to the v2 storage key under `aiPlaybookV2`. Only
 * the three per-section playbook areas have a section key; FAQ + global
 * live on their own columns and are handled separately by callers.
 */
const PLAYBOOK_AREA_TO_SECTION_KEY: Record<string, string | undefined> = {
  business_information: 'business_information',
  pricing_guidance: 'pricing_guidance',
  brand_voice: 'personality_brand_voice',
};

const LOW_CONFIDENCE_THRESHOLD = 0.55;

@Injectable()
export class AiSettingsAssistantService {
  private readonly logger = new Logger(AiSettingsAssistantService.name);
  private _client: OpenAI | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private get openai(): OpenAI {
    if (!this._client) {
      const apiKey = this.configService.get<string>('OPENAI_API_KEY');
      if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
      this._client = new OpenAI({ apiKey });
    }
    return this._client;
  }

  /**
   * Indirection so tests can monkey-patch the conflict detector with a
   * stub LLM caller. Production uses the real OpenAI-bound caller.
   */
  protected async runConflictDetection(ctx: ConflictDetectorContext): Promise<ConflictDetectorResult> {
    return detectConflict(openAiLlmCaller(this.openai), ctx);
  }

  async interpret(userId: string, req: InterpretRequest): Promise<InterpretResponse> {
    const message = (req?.message || '').trim();
    if (!message) throw new BadRequestException('message is required');
    if (message.length > 1000) {
      throw new BadRequestException('message is too long (max 1000 chars)');
    }

    // Layer 1 — hardcoded safety refusals on the user message itself.
    const safety = checkUserMessageSafety(message);
    if (!safety.allowed) {
      this.logger.log(`[interpret] refused user=${userId} category=${safety.category}`);
      return {
        status: 'unsupported',
        summary: 'This request can\'t be applied.',
        reason: safety.reason,
      };
    }

    // Layer 2 — rule-based classifier first (free, deterministic).
    let result: ClassifierResult | null = classifyByRules(message);
    if (!result) {
      try {
        result = await classifyByLlm(this.openai, message);
      } catch (err: any) {
        this.logger.warn(`[interpret] llm classify failed user=${userId} err=${err?.message || err}`);
        return {
          status: 'needs_clarification',
          summary: 'I couldn\'t classify that confidently.',
          clarifyingQuestion: 'Can you describe more specifically what you want to change — a business fact, a pricing rule, a tone preference, or an FAQ answer?',
        };
      }
    }

    if (!result || result.area === 'unknown' || !result.newValue) {
      return {
        status: 'needs_clarification',
        summary: 'I need more detail.',
        clarifyingQuestion: 'Can you say more specifically what you want me to change? For example: "We bring all standard cleaning supplies" (a business fact) or "Don\'t quote prices without square footage" (a pricing rule).',
      };
    }

    if (result.confidence < LOW_CONFIDENCE_THRESHOLD) {
      return {
        status: 'needs_clarification',
        summary: `This could go in ${AREA_LABELS[result.area]}, but I\'m not sure.`,
        clarifyingQuestion: `Should I add this to ${AREA_LABELS[result.area]}, or somewhere else?`,
      };
    }

    // Layer 3 — re-check the LLM/heuristic proposed value against the
    // safety rules. Jailbreak in roundabout phrasing gets caught here.
    const valueSafety = checkProposedValueSafety(result.newValue);
    if (!valueSafety.allowed) {
      this.logger.log(`[interpret] refused proposed value user=${userId} category=${valueSafety.category}`);
      return {
        status: 'unsupported',
        summary: 'This request can\'t be applied.',
        reason: valueSafety.reason,
      };
    }

    // Resolve savedAccountId for non-global writes. We require one to be
    // available; if the caller didn't pass one we pick the user's first
    // SavedAccount. Future enhancement: explicit account-picker in UI.
    let savedAccountId: string | null = null;
    if (result.area !== 'global_custom_instructions') {
      savedAccountId = req.context?.savedAccountId || null;
      if (!savedAccountId) {
        const first = await this.prisma.savedAccount.findFirst({
          where: { userId },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (!first) {
          return {
            status: 'unsupported',
            summary: 'No connected account to update.',
            reason: 'Connect a Thumbtack or Yelp account first — playbook and FAQ live per-account.',
          };
        }
        savedAccountId = first.id;
      }
    }

    // Read current value so the UI can show a diff in the proposal card.
    const currentValue = await this.readCurrentValue(userId, savedAccountId, result.area);

    const target: AssistantTarget = {
      area: result.area,
      storageKey: this.storageKeyFor(result.area),
    };

    // FAQ duplicate check — exact question match (case-insensitive). No
    // LLM needed for this; FAQ entries are already structured Q&A.
    if (result.area === 'faq' && result.faqQuestion && currentValue) {
      try {
        const parsed = JSON.parse(currentValue);
        const entries: any[] = Array.isArray(parsed?.entries) ? parsed.entries : [];
        const target = result.faqQuestion.trim().toLowerCase();
        const hit = entries.find(e => typeof e?.question === 'string' && e.question.trim().toLowerCase() === target);
        if (hit) {
          return {
            status: 'noop',
            summary: 'This FAQ already exists.',
            reason: 'An FAQ with the same question is already saved on this account.',
            existingRule: `Q: ${hit.question}\nA: ${hit.answer}`,
            newRule: `Q: ${result.faqQuestion}\nA: ${result.newValue}`,
          };
        }
      } catch { /* faqJson malformed — treat as no existing duplicate */ }
    }

    // Conflict detection — only for content-comparison areas with
    // existing text. FAQ skips the LLM comparison (handled above as an
    // exact-question check); the FAQ blob isn't semantic prose so the
    // detector would just be noise.
    if (
      currentValue &&
      currentValue.trim() &&
      result.area !== 'faq'
    ) {
      let detection: ConflictDetectorResult;
      try {
        detection = await this.runConflictDetection({
          currentValue,
          newValue: result.newValue,
          area: result.area,
        });
      } catch (err: any) {
        // Detector wrapper itself shouldn't throw — the inner detectConflict
        // already swallows LLM errors. Belt + suspenders: if it does throw,
        // fall back to compatible-append rather than blocking the user.
        this.logger.warn(`[interpret] conflict detector errored user=${userId} err=${err?.message || err}`);
        detection = { verdict: 'compatible', conflictingExcerpt: '', explanation: 'detector errored; falling back to append', fromLlm: false };
      }

      this.logger.log(
        `[interpret] conflict-detector user=${userId} area=${result.area} verdict=${detection.verdict} fromLlm=${detection.fromLlm}`,
      );

      if (detection.verdict === 'duplicate') {
        return {
          status: 'noop',
          summary: 'This is already covered by an existing rule.',
          reason: detection.explanation,
          existingRule: detection.conflictingExcerpt,
          newRule: result.newValue,
        };
      }

      if (detection.verdict === 'conflict') {
        return this.buildConflictResponse({
          userId,
          message,
          target,
          currentValue,
          newRuleText: result.newValue,
          excerpt: detection.conflictingExcerpt,
          explanation: detection.explanation,
          savedAccountId,
        });
      }
      // compatible — fall through to apply_ready below.
    }

    const proposedChange: ProposedChange = {
      operation: result.operation as AssistantOperation,
      currentValue,
      newValue: result.newValue,
      ...(result.area === 'faq' && result.faqQuestion
        ? {
            faqEntry: {
              question: result.faqQuestion,
              answer: result.newValue,
            },
          }
        : {}),
    };

    const summary = this.buildSummary(result.area, result.operation, result.newValue, result.faqQuestion);

    const proposal: SignedProposal = signProposal(userId, {
      target,
      proposedChange,
      userMessage: message,
      summary,
      savedAccountId,
    });

    return {
      status: 'apply_ready',
      summary,
      proposal,
    };
  }

  /**
   * Read the chat-added instructions list for the given area + scope.
   * Returns `{ entries: ChatInstruction[] }`. Unknown areas resolve to
   * an empty list. Caller scope is enforced via the savedAccountId
   * lookup (userId match required) and the user.id select.
   */
  async listChatInstructions(
    userId: string,
    area: string,
    savedAccountId: string | undefined,
  ) {
    const list = await this.readChatList(userId, area, savedAccountId);
    return { entries: list };
  }

  /**
   * Remove one chat-added instruction by id. The typed `customInstructions`
   * / `globalAiPrompt` blob is never touched — only the structured list
   * shrinks. Returns the remaining entries so the UI can re-render
   * without re-fetching.
   */
  async deleteChatInstruction(
    userId: string,
    area: string,
    entryId: string,
    savedAccountId: string | undefined,
  ) {
    const remaining = await this.writeChatListFiltered(
      userId, area, savedAccountId, e => e.id !== entryId,
    );
    return { entries: remaining };
  }

  private async readChatList(
    userId: string,
    area: string,
    savedAccountId: string | undefined,
  ): Promise<Array<{ id: string; text: string; userMessage?: string; createdAt: string }>> {
    if (area === 'global_custom_instructions') {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { globalAiChatInstructionsJson: true },
      });
      return safeChatListShape(user?.globalAiChatInstructionsJson);
    }
    const sectionKey = PLAYBOOK_AREA_TO_SECTION_KEY[area];
    if (!sectionKey) return [];
    if (!savedAccountId) throw new BadRequestException('savedAccountId is required for this area');
    const acct = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
      select: { followUpSettingsJson: true },
    });
    if (!acct?.followUpSettingsJson) return [];
    try {
      const settings = JSON.parse(acct.followUpSettingsJson);
      return safeChatListShape(settings?.aiPlaybookV2?.[sectionKey]?.chatInstructions);
    } catch { return []; }
  }

  private async writeChatListFiltered(
    userId: string,
    area: string,
    savedAccountId: string | undefined,
    keep: (e: { id: string; text: string; userMessage?: string; createdAt: string }) => boolean,
  ): Promise<Array<{ id: string; text: string; userMessage?: string; createdAt: string }>> {
    if (area === 'global_custom_instructions') {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { globalAiChatInstructionsJson: true },
      });
      const next = safeChatListShape(user?.globalAiChatInstructionsJson).filter(keep);
      await this.prisma.user.update({
        where: { id: userId },
        data: { globalAiChatInstructionsJson: next.length > 0 ? (next as any) : null },
      });
      return next;
    }
    const sectionKey = PLAYBOOK_AREA_TO_SECTION_KEY[area];
    if (!sectionKey) throw new BadRequestException(`unsupported area: ${area}`);
    if (!savedAccountId) throw new BadRequestException('savedAccountId is required for this area');
    const acct = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
      select: { id: true, followUpSettingsJson: true },
    });
    if (!acct) throw new NotFoundException('Account not found');
    let settings: Record<string, any> = {};
    if (acct.followUpSettingsJson) {
      try { settings = JSON.parse(acct.followUpSettingsJson) || {}; } catch { settings = {}; }
    }
    const v2 = settings.aiPlaybookV2 && typeof settings.aiPlaybookV2 === 'object'
      ? { ...settings.aiPlaybookV2 }
      : {};
    const section = v2[sectionKey] && typeof v2[sectionKey] === 'object' ? { ...v2[sectionKey] } : {};
    const next = safeChatListShape(section.chatInstructions).filter(keep);
    section.chatInstructions = next;
    v2[sectionKey] = section;
    settings.aiPlaybookV2 = v2;
    await this.prisma.savedAccount.update({
      where: { id: acct.id },
      data: { followUpSettingsJson: JSON.stringify(settings) },
    });
    return next;
  }

  async apply(userId: string, req: ApplyRequest): Promise<ApplyResponse> {
    if (!req?.proposal) throw new BadRequestException('proposal is required');
    const verify = verifyProposal(req.proposal, userId);
    if (!verify.ok) {
      this.logger.warn(`[apply] proposal rejected user=${userId} reason=${verify.reason}`);
      throw new BadRequestException(`proposal ${verify.reason}`);
    }

    // Second safety pass — even a server-signed proposal gets re-checked,
    // because the safety rules are the authoritative policy and could
    // have been updated between sign and apply.
    const valueSafety = checkProposedValueSafety(req.proposal.payload.proposedChange.newValue);
    if (!valueSafety.allowed) {
      this.logger.warn(`[apply] proposal blocked by safety user=${userId} category=${valueSafety.category}`);
      throw new BadRequestException(valueSafety.reason || 'proposal blocked by safety rules');
    }

    let writeResult;
    try {
      writeResult = await applyProposal(this.prisma, userId, req.proposal);
    } catch (err: any) {
      if (err?.message === 'account_not_found') {
        throw new NotFoundException('Account not found');
      }
      throw err;
    }

    // conflictOverride flows verbatim from the signed payload — only the
    // server-minted "Add anyway" resolution carries this flag. Tampering
    // is impossible because the HMAC signature covers the whole payload.
    const conflictOverride = req.proposal.payload.proposedChange.conflictOverride === true;

    const audit = await this.prisma.settingsChangeAuditLog.create({
      data: {
        userId,
        savedAccountId: req.proposal.payload.savedAccountId,
        area: req.proposal.payload.target.area,
        target: writeResult.storageKey,
        operation: req.proposal.payload.proposedChange.operation,
        userMessage: req.proposal.payload.userMessage,
        proposalSummary: req.proposal.payload.summary,
        beforeValue: writeResult.beforeValue,
        afterValue: writeResult.afterValue,
        conflictOverride: conflictOverride ? true : null,
      },
    });

    this.logger.log(
      `[apply] user=${userId} area=${req.proposal.payload.target.area} storageKey=${writeResult.storageKey} ` +
      `auditId=${audit.id}${conflictOverride ? ' conflictOverride=true' : ''}`,
    );

    return {
      success: true,
      appliedAt: audit.createdAt.toISOString(),
      auditLogId: audit.id,
    };
  }

  private buildConflictResponse(args: {
    userId: string;
    message: string;
    target: AssistantTarget;
    currentValue: string;
    newRuleText: string;
    excerpt: string;
    explanation: string;
    savedAccountId: string | null;
  }): InterpretResponse {
    const { userId, message, target, currentValue, newRuleText, excerpt, explanation, savedAccountId } = args;

    // Build the "replace conflicting rule" newValue by literal substring
    // swap. detectConflict guarantees the excerpt is a verbatim substring
    // of currentValue. If after swap the result is empty / whitespace
    // (i.e. the excerpt was the entire section), the replacement is just
    // the new rule.
    let replacedText = currentValue.split(excerpt).join(newRuleText).trim();
    if (!replacedText) replacedText = newRuleText;
    // Collapse the double-blank-line artifact that can show up when the
    // excerpt was surrounded by paragraph breaks and the swap left them.
    replacedText = replacedText.replace(/\n{3,}/g, '\n\n');

    const replaceProposal = signProposal(userId, {
      target,
      proposedChange: {
        operation: 'replace',
        currentValue,
        newValue: replacedText,
      },
      userMessage: message,
      summary: `Replace conflicting rule in ${AREA_LABELS[target.area]}`,
      savedAccountId,
    });

    const addAnywayProposal = signProposal(userId, {
      target,
      proposedChange: {
        operation: 'append',
        currentValue,
        newValue: newRuleText,
        conflictOverride: true,
      },
      userMessage: message,
      summary: `Add to ${AREA_LABELS[target.area]} despite conflict`,
      savedAccountId,
    });

    const resolutionOptions: ConflictResolutionOption[] = [
      { resolution: 'keep_existing', label: 'Keep existing rule' },
      { resolution: 'replace_conflicting_rule', label: 'Replace existing rule', proposal: replaceProposal },
      { resolution: 'add_anyway', label: 'Add anyway', proposal: addAnywayProposal },
    ];

    return {
      status: 'conflict',
      summary: 'This conflicts with an existing rule.',
      reason: explanation,
      conflict: {
        existingRule: excerpt,
        newRule: newRuleText,
        reason: explanation,
      },
      resolutionOptions,
    };
  }

  /**
   * Effective text the conflict detector and noop check should compare
   * against: typed `customInstructions` (or `globalAiPrompt`) followed
   * by every chat entry, joined by paragraph breaks. That mirrors what
   * the runtime AI prompt sees.
   */
  private async readCurrentValue(
    userId: string,
    savedAccountId: string | null,
    area: AssistantArea,
  ): Promise<string | null> {
    if (area === 'global_custom_instructions') {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { globalAiPrompt: true, globalAiChatInstructionsJson: true },
      });
      return combineForArea(user?.globalAiPrompt, user?.globalAiChatInstructionsJson);
    }
    if (!savedAccountId) return null;
    if (area === 'faq') {
      const acct = await this.prisma.savedAccount.findFirst({
        where: { id: savedAccountId, userId },
        select: { faqJson: true },
      });
      return acct?.faqJson ?? null;
    }
    const acct = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
      select: { followUpSettingsJson: true },
    });
    if (!acct?.followUpSettingsJson) return null;
    try {
      const settings = JSON.parse(acct.followUpSettingsJson);
      const sectionKey =
        area === 'business_information' ? 'business_information' :
        area === 'pricing_guidance' ? 'pricing_guidance' :
        area === 'brand_voice' ? 'personality_brand_voice' : null;
      if (!sectionKey) return null;
      const section = settings?.aiPlaybookV2?.[sectionKey];
      return combineForArea(section?.customInstructions, section?.chatInstructions);
    } catch { return null; }
  }

  private storageKeyFor(area: AssistantArea): string {
    switch (area) {
      case 'global_custom_instructions': return 'globalAiChatInstructionsJson';
      case 'faq': return 'faqJson';
      case 'business_information': return 'aiPlaybookV2.business_information.chatInstructions';
      case 'pricing_guidance': return 'aiPlaybookV2.pricing_guidance.chatInstructions';
      case 'brand_voice': return 'aiPlaybookV2.personality_brand_voice.chatInstructions';
    }
  }

  private buildSummary(
    area: AssistantArea,
    operation: AssistantOperation,
    newValue: string,
    faqQuestion: string | undefined,
  ): string {
    const label = AREA_LABELS[area];
    if (area === 'faq' && faqQuestion) {
      return `Add FAQ: "${truncate(faqQuestion, 60)}" → "${truncate(newValue, 80)}"`;
    }
    const verb = operation === 'set' || operation === 'replace' ? 'Replace' : 'Add to';
    return `${verb} ${label}: "${truncate(newValue, 100)}"`;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

/**
 * Defensive read of a chat-instructions list — drops malformed entries.
 * Mirrors the renderer's tolerance so corrupt JSON never crashes a
 * controller response.
 */
function safeChatListShape(
  raw: unknown,
): Array<{ id: string; text: string; userMessage?: string; createdAt: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (e: any) =>
        !!e && typeof e === 'object' &&
        typeof e.id === 'string' &&
        typeof e.text === 'string' &&
        e.text.trim().length > 0,
    )
    .map((e: any) => ({
      id: e.id,
      text: e.text,
      userMessage: typeof e.userMessage === 'string' ? e.userMessage : undefined,
      createdAt: typeof e.createdAt === 'string' ? e.createdAt : new Date(0).toISOString(),
    }));
}

/**
 * Combined effective text for an area = typed blob (`globalAiPrompt` or
 * `customInstructions`) followed by every chat entry, joined by blank
 * lines. Returns null when the result is empty so callers can short-
 * circuit conflict detection.
 */
function combineForArea(
  typed: string | null | undefined,
  chatList: unknown,
): string | null {
  const t = (typed ?? '').trim();
  const chat = Array.isArray(chatList)
    ? chatList
        .filter((e: any) => e && typeof e.text === 'string')
        .map((e: any) => (e.text as string).trim())
        .filter(Boolean)
    : [];
  const combined = [t, ...chat].filter(s => s.length > 0).join('\n\n');
  return combined.length > 0 ? combined : null;
}
