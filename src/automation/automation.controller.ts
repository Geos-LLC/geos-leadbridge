/**
 * Automation Controller
 * REST endpoints for managing automation rules
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AutomationService, CreateAutomationRuleDto, UpdateAutomationRuleDto } from './automation.service';
import { AiService } from '../ai/ai.service';
import { PrismaService } from '../common/utils/prisma.service';

@Controller('v1/automation')
@UseGuards(JwtAuthGuard)
export class AutomationController {
  constructor(
    private automationService: AutomationService,
    private aiService: AiService,
    private prisma: PrismaService,
  ) {}

  /**
   * Get all automation rules for the current user
   */
  @Get('rules')
  async getRules(@CurrentUser() user: any) {
    const rules = await this.automationService.getRules(user.id);
    return { rules };
  }

  /**
   * Get automation rules for a specific saved account
   */
  @Get('rules/account/:accountId')
  async getRulesForAccount(
    @CurrentUser() user: any,
    @Param('accountId') accountId: string,
  ) {
    const rules = await this.automationService.getRulesForAccount(user.id, accountId);
    return { rules };
  }

  /**
   * Get a single automation rule by ID
   */
  @Get('rules/:ruleId')
  async getRule(
    @CurrentUser() user: any,
    @Param('ruleId') ruleId: string,
  ) {
    return this.automationService.getRule(user.id, ruleId);
  }

  /**
   * Create a new automation rule
   */
  @Post('rules')
  async createRule(
    @CurrentUser() user: any,
    @Body() data: CreateAutomationRuleDto,
  ) {
    const rule = await this.automationService.createRule(user.id, data);
    return {
      success: true,
      message: 'Automation rule created',
      rule,
    };
  }

  /**
   * Update an existing automation rule
   */
  @Patch('rules/:ruleId')
  async updateRule(
    @CurrentUser() user: any,
    @Param('ruleId') ruleId: string,
    @Body() data: UpdateAutomationRuleDto,
  ) {
    const rule = await this.automationService.updateRule(user.id, ruleId, data);
    return {
      success: true,
      message: 'Automation rule updated',
      rule,
    };
  }

  /**
   * Delete an automation rule
   */
  @Delete('rules/:ruleId')
  async deleteRule(
    @CurrentUser() user: any,
    @Param('ruleId') ruleId: string,
  ) {
    await this.automationService.deleteRule(user.id, ruleId);
    return {
      success: true,
      message: 'Automation rule deleted',
    };
  }

  /**
   * Get pending messages for a rule
   */
  @Get('rules/:ruleId/pending')
  async getPendingMessages(
    @CurrentUser() user: any,
    @Param('ruleId') ruleId: string,
  ) {
    const pending = await this.automationService.getPendingMessages(user.id, ruleId);
    return { pending };
  }

  /**
   * Preview AI reply for a specific lead (no message sent)
   */
  @Post('rules/:ruleId/preview-ai')
  async previewAiReply(
    @CurrentUser() user: any,
    @Param('ruleId') ruleId: string,
    @Body('leadId') leadId: string,
  ) {
    const rule = await this.automationService.getRule(user.id, ruleId);
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, userId: user.id },
    });
    if (!lead) throw new Error('Lead not found');

    const reply = await this.aiService.generateReply({
      customerName: lead.customerName,
      customerMessage: lead.message || '',
      category: lead.category ?? undefined,
      city: lead.city ?? undefined,
      state: lead.state ?? undefined,
      budget: lead.budget ? Number(lead.budget) : undefined,
      accountName: rule.savedAccount?.businessName ?? undefined,
      systemPrompt: rule.aiSystemPrompt ?? undefined,
    });

    return { reply, leadId, ruleId };
  }

  /**
   * Cancel a pending automated message
   */
  @Post('pending/:pendingId/cancel')
  async cancelPendingMessage(
    @CurrentUser() user: any,
    @Param('pendingId') pendingId: string,
  ) {
    await this.automationService.cancelPendingMessage(user.id, pendingId);
    return {
      success: true,
      message: 'Pending message cancelled',
    };
  }
}
