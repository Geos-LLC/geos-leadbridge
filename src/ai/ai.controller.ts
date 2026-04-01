import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AiService, ConversationMessage } from './ai.service';
import { PrismaService } from '../common/utils/prisma.service';
import { ConversationContextService } from '../conversation-context/conversation-context.service';

@Controller('v1/ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(
    private aiService: AiService,
    private prisma: PrismaService,
    private contextService: ConversationContextService,
  ) {}

  /**
   * Generate an AI reply preview for a specific customer message.
   * Accepts full conversation history for context.
   * Nothing is sent — purely for preview/testing.
   */
  @Post('preview-for-lead')
  async previewForLead(
    @CurrentUser() user: any,
    @Body('leadId') leadId: string,
    @Body('customerMessage') customerMessage: string,
    @Body('conversationHistory') conversationHistory: ConversationMessage[],
    @Body('strategyPrompt') strategyPrompt?: string,
  ) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, userId: user.id },
    });
    if (!lead) throw new Error('Lead not found');

    const [userRecord, account] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: user.id }, select: { globalAiPrompt: true } }),
      lead.businessId
        ? this.prisma.savedAccount.findFirst({ where: { userId: user.id, businessId: lead.businessId }, select: { businessName: true, servicePricingJson: true } })
        : this.prisma.savedAccount.findFirst({ where: { userId: user.id }, select: { businessName: true, servicePricingJson: true } }),
    ]);

    const details = this.extractLeadDetails(lead.rawJson);
    const pricingPrompt = this.buildPricingPrompt(account?.servicePricingJson);
    let systemPrompt = strategyPrompt ?? undefined;
    if (pricingPrompt) {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${pricingPrompt}` : pricingPrompt;
    }

    const reply = await this.aiService.generateReply({
      customerName: lead.customerName,
      customerMessage: customerMessage || lead.message || '',
      category: lead.category ?? undefined,
      city: lead.city ?? undefined,
      state: lead.state ?? undefined,
      budget: lead.budget ? Number(lead.budget) : undefined,
      accountName: account?.businessName ?? undefined,
      globalPrompt: userRecord?.globalAiPrompt ?? undefined,
      systemPrompt,
      conversationHistory: conversationHistory ?? [],
      leadDetails: details,
    });

    return { reply };
  }

  /**
   * Generate an AI reply preview using thread context (buildContext) instead of raw history.
   * Accepts a contextMode: 'full' (summary + state + messages), 'light' (messages only), 'none' (no context).
   */
  @Post('preview-with-context')
  async previewWithContext(
    @CurrentUser() user: any,
    @Body('leadId') leadId: string,
    @Body('conversationId') conversationId: string,
    @Body('customerMessage') customerMessage: string,
    @Body('strategyPrompt') strategyPrompt?: string,
    @Body('contextMode') contextMode?: 'full' | 'light' | 'none',
  ) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, userId: user.id },
    });
    if (!lead) throw new Error('Lead not found');

    const [userRecord, account] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: user.id }, select: { globalAiPrompt: true } }),
      lead.businessId
        ? this.prisma.savedAccount.findFirst({ where: { userId: user.id, businessId: lead.businessId }, select: { businessName: true, servicePricingJson: true } })
        : this.prisma.savedAccount.findFirst({ where: { userId: user.id }, select: { businessName: true, servicePricingJson: true } }),
    ]);

    const details = this.extractLeadDetails(lead.rawJson);
    const mode = contextMode || 'full';

    let conversationHistory: ConversationMessage[] = [];
    let threadContextPrompt: string | undefined;

    if (mode !== 'none' && conversationId) {
      const context = await this.contextService.buildContext(conversationId, { recentMessageLimit: 10 });
      if (context) {
        conversationHistory = context.recentMessages;
        if (mode === 'full') {
          threadContextPrompt = context.systemContext;
        }
      }
    }

    // Build the system prompt: strategy + thread context + pricing
    let systemPrompt = strategyPrompt ?? undefined;
    if (threadContextPrompt) {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${threadContextPrompt}`
        : threadContextPrompt;
    }

    // Inject pricing context if configured
    const pricingPrompt = this.buildPricingPrompt(account?.servicePricingJson);
    if (pricingPrompt) {
      systemPrompt = systemPrompt
        ? `${systemPrompt}\n\n${pricingPrompt}`
        : pricingPrompt;
    }

    const reply = await this.aiService.generateReply({
      customerName: lead.customerName,
      customerMessage: customerMessage || lead.message || '',
      category: lead.category ?? undefined,
      city: lead.city ?? undefined,
      state: lead.state ?? undefined,
      budget: lead.budget ? Number(lead.budget) : undefined,
      accountName: account?.businessName ?? undefined,
      globalPrompt: userRecord?.globalAiPrompt ?? undefined,
      systemPrompt,
      conversationHistory,
      leadDetails: details,
    });

    return { reply, contextMode: mode };
  }

  private buildPricingPrompt(pricingJson: string | null | undefined): string | null {
    if (!pricingJson) return null;
    try {
      const p = JSON.parse(pricingJson);
      const parts: string[] = ['--- Your Pricing Guide (use these EXACT prices when quoting) ---'];

      // Price table
      const enabledTypes = (p.cleaningTypes || []).filter((t: any) => t.enabled);
      if (p.priceTable?.length > 0 && enabledTypes.length > 0) {
        parts.push('Base prices by property size:');
        for (const row of p.priceTable) {
          const prices = enabledTypes.map((t: any) => `${t.label}: $${row[t.key] || '?'}`).join(', ');
          parts.push(`  ${row.bed}BR/${row.bath}BA — ${prices}`);
        }
      }

      // Frequency discounts
      if (p.frequencyDiscounts?.length > 0) {
        const discounts = p.frequencyDiscounts
          .filter((fd: any) => fd.discount > 0)
          .map((fd: any) => `${fd.label}: ${fd.discount}% off`);
        if (discounts.length > 0) parts.push(`Recurring discounts: ${discounts.join(', ')}`);
      }

      // Extras
      if (p.extras?.length > 0) {
        const extrasList = p.extras.filter((e: any) => e.label && e.price > 0).map((e: any) => `${e.label}: +$${e.price}`);
        if (extrasList.length > 0) parts.push(`Add-ons available: ${extrasList.join(', ')}`);
      }

      // Condition surcharges
      if (p.conditionSurcharges?.length > 0) {
        const surcharges = p.conditionSurcharges.filter((c: any) => c.surcharge > 0).map((c: any) => `${c.label}: +$${c.surcharge}`);
        if (surcharges.length > 0) parts.push(`Condition surcharges: ${surcharges.join(', ')}`);
      }

      // Pet surcharge
      if (p.petSurcharge > 0) parts.push(`Pet surcharge: +$${p.petSurcharge}`);

      // Recurring cleaning discount
      if (p.recurringDiscount > 0) parts.push(`Recurring cleaning discount: ${p.recurringDiscount}% off for customers who book regular recurring service`);

      // Order amount discounts
      if (p.orderDiscounts?.length > 0) {
        const tiers = p.orderDiscounts
          .filter((od: any) => od.minAmount > 0 && od.discount > 0)
          .sort((a: any, b: any) => a.minAmount - b.minAmount)
          .map((od: any) => `orders over $${od.minAmount}: ${od.discount}% off`);
        if (tiers.length > 0) parts.push(`Order discounts: ${tiers.join(', ')}`);
      }

      parts.push('--- End Pricing Guide ---');
      parts.push('When the strategy requires pricing, use the EXACT prices from the table above. Match bedrooms and bathrooms from the lead details to find the right row. If the exact combination is not in the table, use the closest match. Mention applicable discounts (recurring, order amount) when relevant.');

      return parts.join('\n');
    } catch {
      return null;
    }
  }

  private extractLeadDetails(rawJson: string): Record<string, string> {
    try {
      const raw = JSON.parse(rawJson);
      const result: Record<string, string> = {};

      // Thumbtack format: request.details[].question / .answer
      const details: any[] = raw.request?.details || raw.details || [];
      for (const item of details) {
        if (item.question && item.answer) {
          result[String(item.question)] = String(item.answer);
        }
      }

      // Yelp format: project.survey_answers[].question_text / .answer_text
      const surveyAnswers: any[] = raw.project?.survey_answers || [];
      for (const q of surveyAnswers) {
        if (q.question_text && q.answer_text) {
          const answer = Array.isArray(q.answer_text) ? q.answer_text.join(', ') : String(q.answer_text);
          result[String(q.question_text)] = answer;
        }
      }

      // Yelp: availability and additional info
      if (raw.project?.availability?.status) result['Availability'] = raw.project.availability.status;
      if (raw.project?.additional_info) result['Additional details'] = raw.project.additional_info;

      // Also pull top-level fields if present
      if (raw.request?.description) result['Description'] = raw.request.description;
      if (raw.description) result['Description'] = raw.description;

      return result;
    } catch {
      return {};
    }
  }
}
