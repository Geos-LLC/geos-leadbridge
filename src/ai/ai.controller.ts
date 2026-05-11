import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AiService, ConversationMessage } from './ai.service';
import { PrismaService } from '../common/utils/prisma.service';
import { ConversationContextService } from '../conversation-context/conversation-context.service';
import { buildPriceRangeInstruction } from './price-range';
import { buildBusinessContextBlock } from './business-context';
import { buildFaqBlock, parseAccountFaq } from './faq-context';

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
      this.prisma.user.findUnique({ where: { id: user.id }, select: { globalAiPrompt: true, name: true } }),
      lead.businessId
        ? this.prisma.savedAccount.findFirst({ where: { userId: user.id, businessId: lead.businessId }, select: { businessName: true, servicePricingJson: true, faqJson: true, followUpTimezone: true, followUpSettingsJson: true, followUpActiveHoursStart: true, followUpActiveHoursEnd: true } })
        : this.prisma.savedAccount.findFirst({ where: { userId: user.id }, select: { businessName: true, servicePricingJson: true, faqJson: true, followUpTimezone: true, followUpSettingsJson: true, followUpActiveHoursStart: true, followUpActiveHoursEnd: true } }),
    ]);

    const details = this.extractLeadDetails(lead.rawJson);
    const pricingBlock = this.buildPricingPrompt(account?.servicePricingJson, account?.followUpSettingsJson);
    const faqBlock = buildFaqBlock(parseAccountFaq(account?.faqJson));
    const businessBlock = buildBusinessContextBlock({
      businessName: account?.businessName ?? null,
      ownerName: userRecord?.name ?? null,
      city: lead.city ?? null,
      state: lead.state ?? null,
      followUpSettingsJson: account?.followUpSettingsJson ?? null,
      activeHoursStart: account?.followUpActiveHoursStart ?? null,
      activeHoursEnd: account?.followUpActiveHoursEnd ?? null,
      timezone: account?.followUpTimezone ?? null,
    });

    const reply = await this.aiService.generateReply({
      customerName: lead.customerName,
      customerMessage: customerMessage || lead.message || '',
      category: lead.category ?? undefined,
      city: lead.city ?? undefined,
      state: lead.state ?? undefined,
      budget: lead.budget ? Number(lead.budget) : undefined,
      accountName: account?.businessName ?? undefined,
      globalPrompt: userRecord?.globalAiPrompt ?? undefined,
      strategyPrompt,
      businessBlock,
      pricingBlock: pricingBlock ?? undefined,
      faqBlock: faqBlock ?? undefined,
      conversationHistory: conversationHistory ?? [],
      leadDetails: details,
      currentTime: new Date(),
      timezone: account?.followUpTimezone ?? undefined,
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
      this.prisma.user.findUnique({ where: { id: user.id }, select: { globalAiPrompt: true, name: true } }),
      lead.businessId
        ? this.prisma.savedAccount.findFirst({ where: { userId: user.id, businessId: lead.businessId }, select: { businessName: true, servicePricingJson: true, faqJson: true, followUpSettingsJson: true, followUpTimezone: true, followUpActiveHoursStart: true, followUpActiveHoursEnd: true } })
        : this.prisma.savedAccount.findFirst({ where: { userId: user.id }, select: { businessName: true, servicePricingJson: true, faqJson: true, followUpSettingsJson: true, followUpTimezone: true, followUpActiveHoursStart: true, followUpActiveHoursEnd: true } }),
    ]);

    const details = this.extractLeadDetails(lead.rawJson);
    const mode = contextMode || 'full';

    let conversationHistory: ConversationMessage[] = [];
    let threadContextPrompt: string | undefined;

    if (mode !== 'none' && conversationId) {
      const context = await this.contextService.buildContext(conversationId, { recentMessageLimit: 100 });
      if (context) {
        conversationHistory = context.recentMessages;
        if (mode === 'full') {
          threadContextPrompt = context.systemContext;
        }
      }
    }

    // Build labeled section blocks. ai.service.ts joins them under explicit
    // headings (GLOBAL / PRIMARY INSTRUCTION / REFERENCE: …) so the model can
    // distinguish guardrails from goal from reference material.
    const businessBlock = buildBusinessContextBlock({
      businessName: account?.businessName ?? null,
      ownerName: userRecord?.name ?? null,
      city: lead.city ?? null,
      state: lead.state ?? null,
      followUpSettingsJson: account?.followUpSettingsJson ?? null,
      activeHoursStart: account?.followUpActiveHoursStart ?? null,
      activeHoursEnd: account?.followUpActiveHoursEnd ?? null,
      timezone: account?.followUpTimezone ?? null,
    });
    const pricingBlock = this.buildPricingPrompt(account?.servicePricingJson, account?.followUpSettingsJson);
    const faqBlock = buildFaqBlock(parseAccountFaq(account?.faqJson));
    const urgencyBlock = await this.buildUrgencyPrompt(conversationId, account?.followUpSettingsJson);

    const reply = await this.aiService.generateReply({
      customerName: lead.customerName,
      customerMessage: customerMessage || lead.message || '',
      category: lead.category ?? undefined,
      city: lead.city ?? undefined,
      state: lead.state ?? undefined,
      budget: lead.budget ? Number(lead.budget) : undefined,
      accountName: account?.businessName ?? undefined,
      globalPrompt: userRecord?.globalAiPrompt ?? undefined,
      strategyPrompt,
      threadContextBlock: threadContextPrompt,
      businessBlock,
      pricingBlock: pricingBlock ?? undefined,
      faqBlock: faqBlock ?? undefined,
      urgencyBlock: urgencyBlock ?? undefined,
      conversationHistory,
      leadDetails: details,
      currentTime: new Date(),
      timezone: account?.followUpTimezone ?? undefined,
    });

    return { reply, contextMode: mode };
  }

  private async buildUrgencyPrompt(conversationId: string | undefined, settingsJson: string | null | undefined): Promise<string | null> {
    if (!conversationId) return null;

    // Get customer urgency from thread state
    const threadState = await this.contextService.getThreadState(conversationId).catch(() => null);
    const stateJson = await this.prisma.threadContext.findUnique({
      where: { conversationId },
      select: { stateJson: true, customerIntent: true },
    }).catch(() => null);

    let customerUrgency = 'low';
    if (stateJson?.customerIntent === 'urgent') {
      customerUrgency = 'high';
    } else if (stateJson?.stateJson) {
      try {
        const state = JSON.parse(stateJson.stateJson);
        if (state.customerUrgency) customerUrgency = state.customerUrgency;
      } catch {}
    }

    // Get business urgentCapability from settings
    let urgentCapability = 'same_day';
    if (settingsJson) {
      try {
        const settings = JSON.parse(settingsJson);
        if (settings.followUpUrgentCapability) urgentCapability = settings.followUpUrgentCapability;
      } catch {}
    }

    if (customerUrgency === 'low') return null;

    const parts = ['--- Urgency Context ---'];
    parts.push(`Customer urgency: ${customerUrgency}`);
    parts.push(`Business capability: ${urgentCapability}`);

    if (urgentCapability === 'same_day') {
      parts.push('You CAN offer same-day service. Be fast and direct, move to conversion quickly.');
    } else if (urgentCapability === '24h') {
      parts.push('You can serve within 24 hours but NOT same-day. Acknowledge urgency, shift expectation to tomorrow.');
    } else if (urgentCapability === '48h') {
      parts.push('You can serve within 48 hours. Offer near-term availability without implying same-day.');
    } else {
      parts.push('You CANNOT serve urgently. Acknowledge the urgency but offer the next available slot. Do NOT imply same-day or rush availability.');
    }
    parts.push('STRICT RULE: Never imply same-day or urgent availability unless business capability is same_day.');
    parts.push('--- End Urgency Context ---');

    return parts.join('\n');
  }

  private buildPricingPrompt(
    pricingJson: string | null | undefined,
    followUpSettingsJson?: string | null,
  ): string | null {
    if (!pricingJson) return null;
    try {
      const p = JSON.parse(pricingJson);
      const parts: string[] = ['--- Your Pricing Guide (use these EXACT prices when quoting) ---'];

      // Resolve quote mode from AI strategy settings (per-account toggle).
      let priceQuoteMode: 'range' | 'exact' | undefined;
      if (followUpSettingsJson) {
        try {
          const s = JSON.parse(followUpSettingsJson);
          if (s?.priceQuoteMode === 'range' || s?.priceQuoteMode === 'exact') priceQuoteMode = s.priceQuoteMode;
        } catch { /* invalid JSON — fall back to legacy inference */ }
      }
      const sqftAdjustEnabled = p?.sqftAdjustEnabled !== false; // default ON

      // Price table — emit each row with its sqft range (min/max) and the
      // derived $/sqft per cleaning type (at the midpoint), so the AI scales
      // up only when the lead's sqft exceeds the row's sqftMax.
      const enabledTypes = (p.cleaningTypes || []).filter((t: any) => t.enabled);
      if (p.priceTable?.length > 0 && enabledTypes.length > 0) {
        parts.push('Base prices by property size (each row covers a sqft range; price applies within that range):');
        for (const row of p.priceTable) {
          // Back-compat: rows saved before the min/max split carry a single `sqft` field.
          const legacy = Number(row.sqft) || 0;
          const sqftMin = Number(row.sqftMin) || legacy;
          const sqftMax = Number(row.sqftMax) || legacy;
          const midpoint = sqftMin && sqftMax ? (sqftMin + sqftMax) / 2 : (sqftMin || sqftMax);
          const prices = enabledTypes.map((t: any) => {
            const price = Number(row[t.key]) || 0;
            const perSqft = midpoint > 0 ? (price / midpoint).toFixed(3) : null;
            return perSqft && sqftAdjustEnabled
              ? `${t.label}: $${price} ($${perSqft}/sqft)`
              : `${t.label}: $${price}`;
          }).join(', ');
          let sizeLabel = `${row.bed}BR/${row.bath}BA`;
          if (sqftMin && sqftMax && sqftMin !== sqftMax) sizeLabel += ` @ ${sqftMin}-${sqftMax} sqft`;
          else if (midpoint > 0) sizeLabel += ` @ ${midpoint} sqft`;
          parts.push(`  ${sizeLabel} — ${prices}`);
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
      parts.push(buildPriceRangeInstruction(p.priceRange, { priceQuoteMode, sqftAdjustEnabled }));
      parts.push('When you DO quote (per the GLOBAL pricing policy + PRIMARY INSTRUCTION), match bedrooms and bathrooms from the lead details to find the right row above. If the exact combination is not in the table, use the closest match. Mention applicable discounts (recurring, order amount) when relevant. If you are not quoting, do not mention price.');

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
