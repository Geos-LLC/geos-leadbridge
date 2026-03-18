import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AiService, ConversationMessage } from './ai.service';
import { PrismaService } from '../common/utils/prisma.service';

@Controller('v1/ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(
    private aiService: AiService,
    private prisma: PrismaService,
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
  ) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, userId: user.id },
    });
    if (!lead) throw new Error('Lead not found');

    const aiRule = await this.prisma.automationRule.findFirst({
      where: { userId: user.id, useAi: true, triggerType: 'new_lead' },
    });

    const account = await this.prisma.savedAccount.findFirst({
      where: { userId: user.id },
      select: { businessName: true },
    });

    // Extract structured details from rawJson (bedrooms, bathrooms, pets, frequency, etc.)
    const details = this.extractLeadDetails(lead.rawJson);

    const reply = await this.aiService.generateReply({
      customerName: lead.customerName,
      customerMessage: customerMessage || lead.message || '',
      category: lead.category ?? undefined,
      city: lead.city ?? undefined,
      state: lead.state ?? undefined,
      budget: lead.budget ? Number(lead.budget) : undefined,
      accountName: account?.businessName ?? undefined,
      systemPrompt: aiRule?.aiSystemPrompt ?? undefined,
      conversationHistory: conversationHistory ?? [],
      leadDetails: details,
    });

    return { reply };
  }

  private extractLeadDetails(rawJson: string): Record<string, string> {
    try {
      const raw = JSON.parse(rawJson);
      const details: any[] = raw.request?.details || raw.details || [];
      const result: Record<string, string> = {};

      for (const item of details) {
        if (item.question && item.answer) {
          result[String(item.question)] = String(item.answer);
        }
      }

      // Also pull top-level fields if present
      if (raw.request?.description) result['Description'] = raw.request.description;
      if (raw.description) result['Description'] = raw.description;

      return result;
    } catch {
      return {};
    }
  }
}
