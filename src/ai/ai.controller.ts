import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AiService } from './ai.service';
import { PrismaService } from '../common/utils/prisma.service';

@Controller('v1/ai')
@UseGuards(JwtAuthGuard)
export class AiController {
  constructor(
    private aiService: AiService,
    private prisma: PrismaService,
  ) {}

  /**
   * Generate an AI reply preview for any lead.
   * Uses the account's AI automation rule settings if one exists.
   * Nothing is sent — purely for preview/testing.
   */
  @Post('preview-for-lead')
  async previewForLead(
    @CurrentUser() user: any,
    @Body('leadId') leadId: string,
  ) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, userId: user.id },
    });
    if (!lead) throw new Error('Lead not found');

    // Look up the AI automation rule for this lead's account (if any)
    const aiRule = await this.prisma.automationRule.findFirst({
      where: { userId: user.id, useAi: true, triggerType: 'new_lead' },
    });

    // Get account name for context
    const account = await this.prisma.savedAccount.findFirst({
      where: { userId: user.id },
      select: { businessName: true },
    });

    const reply = await this.aiService.generateReply({
      customerName: lead.customerName,
      customerMessage: lead.message || '',
      category: lead.category ?? undefined,
      city: lead.city ?? undefined,
      state: lead.state ?? undefined,
      budget: lead.budget ? Number(lead.budget) : undefined,
      accountName: account?.businessName ?? undefined,
      systemPrompt: aiRule?.aiSystemPrompt ?? undefined,
    });

    return { reply };
  }
}
