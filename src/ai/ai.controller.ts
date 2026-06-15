import { Controller, Post, Body, UseGuards, NotFoundException, Logger } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AiService, ConversationMessage } from './ai.service';
import { PrismaService } from '../common/utils/prisma.service';
import { ConversationContextService } from '../conversation-context/conversation-context.service';
import { buildPriceRangeInstruction } from './price-range';
import { buildBusinessContextBlock } from './business-context';
import { buildFaqBlock, parseAccountFaq } from './faq-context';
import { buildPricingGuardRules } from './pricing-guards';
import { hydratePricing, parseAndHydratePricing } from '../users/pricing-hydrate';
import { computeQuoteAndIntent, QuoteAndIntent } from '../pricing/pricing-engine';
import { ServiceProfileService } from '../service-profile/service-profile.service';
import { resolveGlobalPrompt } from './global-prompt-resolver';
import { extractLeadDetails } from '../leads/extract-lead-details';

@Controller('v1/ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(
    private aiService: AiService,
    private prisma: PrismaService,
    private contextService: ConversationContextService,
    private serviceProfile: ServiceProfileService,
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
    this.logger.log(`[AI preview-for-lead] user=${user?.id} lead=${leadId} historyLen=${conversationHistory?.length ?? 0}`);
    if (!leadId) throw new NotFoundException('Missing leadId');
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, userId: user.id },
    });
    if (!lead) {
      this.logger.warn(`[AI preview-for-lead] Lead ${leadId} not found for user ${user?.id}`);
      throw new NotFoundException('Lead not found');
    }

    const [userRecord, account] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: user.id }, select: { globalAiPrompt: true, globalAiChatInstructionsJson: true, name: true } }),
      lead.businessId
        ? this.prisma.savedAccount.findFirst({ where: { userId: user.id, businessId: lead.businessId }, select: { id: true, businessName: true, servicePricingJson: true, faqJson: true, serviceOverridesJson: true, followUpTimezone: true, followUpSettingsJson: true, followUpActiveHoursStart: true, followUpActiveHoursEnd: true } })
        : this.prisma.savedAccount.findFirst({ where: { userId: user.id }, select: { id: true, businessName: true, servicePricingJson: true, faqJson: true, serviceOverridesJson: true, followUpTimezone: true, followUpSettingsJson: true, followUpActiveHoursStart: true, followUpActiveHoursEnd: true } }),
    ]);

    // Dual-read seam — resolve a ServiceProfile for this lead and
    // return its effective pricing/FAQ. If no profile matches (legacy
    // tenant, Yelp lead with no default, etc), falls through to the
    // SavedAccount columns. Source field is logged but the assembler
    // below treats both sources identically.
    const profileInputs = await this.serviceProfile.resolveEffectivePromptInputs(
      { id: lead.id, userId: lead.userId, category: lead.category, categoryId: (lead as any).categoryId ?? null },
      account
        ? {
            id: account.id,
            servicePricingJson: account.servicePricingJson,
            faqJson: account.faqJson,
            serviceOverridesJson: account.serviceOverridesJson,
            // Resolver needs this for the aiInstructionsJson per-field
            // fallback — extracts aiPlaybookV2 when the profile column
            // is empty. Already selected for buildPricingPrompt /
            // businessBlock below, no extra Prisma round trip.
            followUpSettingsJson: account.followUpSettingsJson,
          }
        : null,
    );

    const details = extractLeadDetails(lead.rawJson);
    const pricingBlock = this.buildPricingPrompt(profileInputs.pricingJson, account?.followUpSettingsJson);
    const faqBlock = buildFaqBlock(parseAccountFaq(profileInputs.faqJson));
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

    // Deterministic quote + price-intent guard — compute base + add-ons
    // in code so the LLM doesn't infer prices, and add a top-priority
    // override when the customer explicitly asked for price. See
    // src/pricing/pricing-engine.ts + src/pricing/price-intent.ts.
    const { quoteBlock, priceIntentBlock } = this.computeQuote({
      pricingJson: profileInputs.pricingJson,
      leadDetails: details,
      customerMessage: customerMessage || lead.message || '',
      conversationHistory: conversationHistory ?? null,
      additionalInfo: details?.['Additional details'] ?? null,
    });

    let reply: string;
    try {
      reply = await this.aiService.generateReply({
        customerName: lead.customerName,
        customerMessage: customerMessage || lead.message || '',
        category: lead.category ?? undefined,
        city: lead.city ?? undefined,
        state: lead.state ?? undefined,
        budget: lead.budget ? Number(lead.budget) : undefined,
        accountName: account?.businessName ?? undefined,
        globalPrompt: resolveGlobalPrompt(userRecord),
        strategyPrompt,
        businessBlock,
        pricingBlock: pricingBlock ?? undefined,
        quoteBlock: quoteBlock ?? undefined,
        priceIntentBlock: priceIntentBlock ?? undefined,
        faqBlock: faqBlock ?? undefined,
        conversationHistory: conversationHistory ?? [],
        leadDetails: details,
        currentTime: new Date(),
        timezone: account?.followUpTimezone ?? undefined,
      });
    } catch (err: any) {
      this.logger.error(`[AI preview-for-lead] generateReply failed for lead=${leadId}: ${err?.message}`, err?.stack);
      throw err;
    }

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
    this.logger.log(`[AI preview-with-context] user=${user?.id} lead=${leadId} conv=${conversationId} mode=${contextMode ?? 'full'}`);
    if (!leadId) throw new NotFoundException('Missing leadId');
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, userId: user.id },
    });
    if (!lead) {
      this.logger.warn(`[AI preview-with-context] Lead ${leadId} not found for user ${user?.id}`);
      throw new NotFoundException('Lead not found');
    }

    const [userRecord, account] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: user.id }, select: { globalAiPrompt: true, globalAiChatInstructionsJson: true, name: true } }),
      lead.businessId
        ? this.prisma.savedAccount.findFirst({ where: { userId: user.id, businessId: lead.businessId }, select: { id: true, businessName: true, servicePricingJson: true, faqJson: true, serviceOverridesJson: true, followUpSettingsJson: true, followUpTimezone: true, followUpActiveHoursStart: true, followUpActiveHoursEnd: true } })
        : this.prisma.savedAccount.findFirst({ where: { userId: user.id }, select: { id: true, businessName: true, servicePricingJson: true, faqJson: true, serviceOverridesJson: true, followUpSettingsJson: true, followUpTimezone: true, followUpActiveHoursStart: true, followUpActiveHoursEnd: true } }),
    ]);

    // Dual-read seam — same call as preview-for-lead. Returns the
    // effective pricing/FAQ for the matched ServiceProfile, or falls
    // through to legacy SavedAccount columns when no profile applies.
    const profileInputs = await this.serviceProfile.resolveEffectivePromptInputs(
      { id: lead.id, userId: lead.userId, category: lead.category, categoryId: (lead as any).categoryId ?? null },
      account
        ? {
            id: account.id,
            servicePricingJson: account.servicePricingJson,
            faqJson: account.faqJson,
            serviceOverridesJson: account.serviceOverridesJson,
            // Resolver needs this for the aiInstructionsJson per-field
            // fallback — extracts aiPlaybookV2 when the profile column
            // is empty. Already selected for buildPricingPrompt /
            // businessBlock below, no extra Prisma round trip.
            followUpSettingsJson: account.followUpSettingsJson,
          }
        : null,
    );

    const details = extractLeadDetails(lead.rawJson);
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
    const pricingBlock = this.buildPricingPrompt(profileInputs.pricingJson, account?.followUpSettingsJson);
    const faqBlock = buildFaqBlock(parseAccountFaq(profileInputs.faqJson));
    const urgencyBlock = await this.buildUrgencyPrompt(conversationId, account?.followUpSettingsJson);

    // Deterministic quote + price-intent guard — same engine the AI
    // conversation, follow-ups, and Instant Text use. Conversation
    // history flows in so add-on mentions and price asks earlier in
    // the thread are still picked up.
    const { quoteBlock, priceIntentBlock } = this.computeQuote({
      pricingJson: profileInputs.pricingJson,
      leadDetails: details,
      customerMessage: customerMessage || lead.message || '',
      conversationHistory,
      additionalInfo: details?.['Additional details'] ?? null,
    });

    let reply: string;
    try {
      reply = await this.aiService.generateReply({
        customerName: lead.customerName,
        customerMessage: customerMessage || lead.message || '',
        category: lead.category ?? undefined,
        city: lead.city ?? undefined,
        state: lead.state ?? undefined,
        budget: lead.budget ? Number(lead.budget) : undefined,
        accountName: account?.businessName ?? undefined,
        globalPrompt: resolveGlobalPrompt(userRecord),
        strategyPrompt,
        threadContextBlock: threadContextPrompt,
        businessBlock,
        pricingBlock: pricingBlock ?? undefined,
        quoteBlock: quoteBlock ?? undefined,
        priceIntentBlock: priceIntentBlock ?? undefined,
        faqBlock: faqBlock ?? undefined,
        urgencyBlock: urgencyBlock ?? undefined,
        conversationHistory,
        leadDetails: details,
        currentTime: new Date(),
        timezone: account?.followUpTimezone ?? undefined,
      });
    } catch (err: any) {
      this.logger.error(`[AI preview-with-context] generateReply failed for lead=${leadId} conv=${conversationId}: ${err?.message}`, err?.stack);
      throw err;
    }

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
      // Hydrate up-front so legacy JSON missing cleaningTypes still emits
      // Deep Cleaning columns (and so explicit 0 prices survive). The
      // legacy `enabled` flag is intentionally ignored — a service is
      // "not offered" when its row prices are all 0, which pricing-guards
      // surfaces as a defer-to-team instruction.
      const p = hydratePricing(JSON.parse(pricingJson));
      const parts: string[] = ['--- Your Pricing Guide (use these EXACT prices when quoting) ---'];

      // Resolve quote mode from AI strategy settings (per-account toggle).
      let priceQuoteMode: 'range' | 'exact' | undefined;
      if (followUpSettingsJson) {
        try {
          const s = JSON.parse(followUpSettingsJson);
          if (s?.priceQuoteMode === 'range' || s?.priceQuoteMode === 'exact') priceQuoteMode = s.priceQuoteMode;
        } catch { /* invalid JSON — fall back to legacy inference */ }
      }
      const sqftAdjustEnabled = p.sqftAdjustEnabled !== false; // default ON

      // Price table — emit each row with its sqft range (min/max) and the
      // derived $/sqft per cleaning type (at the midpoint), so the AI scales
      // up only when the lead's sqft exceeds the row's sqftMax.
      const allTypes = p.cleaningTypes;
      if (p.priceTable.length > 0 && allTypes.length > 0) {
        parts.push('Base prices by property size (each row covers a sqft range; price applies within that range):');
        for (const row of p.priceTable) {
          // Back-compat: rows saved before the min/max split carry a single `sqft` field.
          const legacy = Number(row.sqft) || 0;
          const sqftMin = Number(row.sqftMin) || legacy;
          const sqftMax = Number(row.sqftMax) || legacy;
          const midpoint = sqftMin && sqftMax ? (sqftMin + sqftMax) / 2 : (sqftMin || sqftMax);
          const prices = allTypes.map((t) => {
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
      // Hard guards: no quote without bed+bath, no silent service-type
      // substitution, no closest-row interpolation. See pricing-guards.ts
      // for the FargiPro incident this closes.
      parts.push(buildPricingGuardRules(p));
      parts.push('Mention applicable discounts (recurring, order amount) when relevant. If you are not quoting, do not mention price.');

      return parts.join('\n');
    } catch {
      return null;
    }
  }

  /**
   * Thin wrapper around the deterministic pricing engine. Hydrates the
   * pricing JSON, then asks pricing-engine.computeQuoteAndIntent to
   * extract add-ons + facts and produce BOTH the authoritative quote
   * block AND the runtime price-intent enforcement block (when the
   * latest customer message asks for a price). Returns nulls when
   * there's nothing meaningful to inject.
   */
  private computeQuote(opts: {
    pricingJson: string | null | undefined;
    leadDetails: Record<string, string>;
    customerMessage: string;
    conversationHistory: ConversationMessage[] | null;
    additionalInfo: string | null;
  }): QuoteAndIntent {
    const pricing = parseAndHydratePricing(opts.pricingJson ?? null);
    if (!pricing) return { quoteBlock: null, priceIntentBlock: null };
    try {
      return computeQuoteAndIntent({
        pricing,
        leadDetails: opts.leadDetails,
        customerMessage: opts.customerMessage,
        conversationHistory: opts.conversationHistory,
        additionalInfo: opts.additionalInfo,
      });
    } catch (err: any) {
      // Engine is pure — failures here are programming bugs, not data
      // bugs. Log and degrade gracefully so the AI reply still goes out
      // using only the PRICING TABLE reference.
      this.logger.warn(`[AI computeQuote] engine threw: ${err?.message}`);
      return { quoteBlock: null, priceIntentBlock: null };
    }
  }

}
