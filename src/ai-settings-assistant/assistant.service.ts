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
  InterpretRequest,
  InterpretResponse,
  ProposedChange,
  SignedProposal,
} from './assistant.types';
import { checkUserMessageSafety, checkProposedValueSafety } from './safety-rules';
import { signProposal, verifyProposal } from './proposal-signer';
import { ClassifierResult, classifyByLlm, classifyByRules } from './classifier';
import { applyProposal } from './writer';

const AREA_LABELS: Record<AssistantArea, string> = {
  business_information: 'Business Information',
  pricing_guidance: 'Pricing Guidance',
  brand_voice: 'Brand Voice',
  faq: 'FAQ',
  global_custom_instructions: 'Global Custom Instructions',
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
      },
    });

    this.logger.log(
      `[apply] user=${userId} area=${req.proposal.payload.target.area} storageKey=${writeResult.storageKey} auditId=${audit.id}`,
    );

    return {
      success: true,
      appliedAt: audit.createdAt.toISOString(),
      auditLogId: audit.id,
    };
  }

  private async readCurrentValue(
    userId: string,
    savedAccountId: string | null,
    area: AssistantArea,
  ): Promise<string | null> {
    if (area === 'global_custom_instructions') {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { globalAiPrompt: true },
      });
      return user?.globalAiPrompt ?? null;
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
      return settings?.aiPlaybookV2?.[sectionKey]?.customInstructions ?? null;
    } catch { return null; }
  }

  private storageKeyFor(area: AssistantArea): string {
    switch (area) {
      case 'global_custom_instructions': return 'globalAiPrompt';
      case 'faq': return 'faqJson';
      case 'business_information': return 'aiPlaybookV2.business_information.customInstructions';
      case 'pricing_guidance': return 'aiPlaybookV2.pricing_guidance.customInstructions';
      case 'brand_voice': return 'aiPlaybookV2.personality_brand_voice.customInstructions';
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
