/**
 * Conversation Context Controller
 *
 * API endpoints for thread context inspection and management.
 * Used by frontend debug panel and admin tools.
 *
 * Every `:conversationId` route validates ownership via TenancyService
 * before reaching the service layer — see SECURITY_CONTROL_DATA.md Phase 0.
 */

import { Controller, Get, Post, Param, Query, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TenancyService } from '../common/tenancy/tenancy.service';
import { ConversationContextService } from './conversation-context.service';

@Controller('v1/conversation-context')
@UseGuards(JwtAuthGuard)
export class ConversationContextController {
  constructor(
    private readonly contextService: ConversationContextService,
    private readonly tenancyService: TenancyService,
  ) {}

  /**
   * Get full thread context for a conversation (AI-ready).
   */
  @Get(':conversationId')
  async getContext(
    @CurrentUser() user: any,
    @Param('conversationId') conversationId: string,
    @Query('recentMessages') recentMessages?: string,
  ) {
    await this.tenancyService.requireConversationAccess(conversationId, user.id);
    const limit = recentMessages ? parseInt(recentMessages, 10) : 10;
    const context = await this.contextService.getContext(conversationId, limit);
    return { success: true, context };
  }

  /**
   * Get quick thread state (no messages loaded).
   */
  @Get(':conversationId/state')
  async getState(
    @CurrentUser() user: any,
    @Param('conversationId') conversationId: string,
  ) {
    await this.tenancyService.requireConversationAccess(conversationId, user.id);
    const state = await this.contextService.getThreadState(conversationId);
    return { success: true, state };
  }

  /**
   * Get AI-ready built context (summary + state + recent messages).
   */
  @Get(':conversationId/ai-context')
  async getAiContext(
    @CurrentUser() user: any,
    @Param('conversationId') conversationId: string,
  ) {
    await this.tenancyService.requireConversationAccess(conversationId, user.id);
    const context = await this.contextService.buildContext(conversationId);
    return { success: true, context };
  }

  /**
   * List all thread contexts for the current user.
   * Supports filtering by platform and stage.
   */
  @Get()
  async listContexts(
    @CurrentUser() user: any,
    @Query('platform') platform?: string,
    @Query('stage') stage?: string,
  ) {
    const contexts = await this.contextService.getThreadContextsForUser(user.id, { platform, stage });
    return { success: true, count: contexts.length, contexts };
  }

  /**
   * Manually update thread stage.
   */
  @Post(':conversationId/stage')
  async updateStage(
    @CurrentUser() user: any,
    @Param('conversationId') conversationId: string,
    @Body('stage') stage: string,
  ) {
    await this.tenancyService.requireConversationAccess(conversationId, user.id);
    await this.contextService.updateStage(conversationId, stage);
    return { success: true };
  }

  /**
   * Manually update thread strategy.
   */
  @Post(':conversationId/strategy')
  async updateStrategy(
    @CurrentUser() user: any,
    @Param('conversationId') conversationId: string,
    @Body('activeStrategy') activeStrategy: string,
    @Body('suggestedStrategy') suggestedStrategy?: string,
  ) {
    await this.tenancyService.requireConversationAccess(conversationId, user.id);
    await this.contextService.updateStrategy(conversationId, activeStrategy, suggestedStrategy);
    return { success: true };
  }

  /**
   * Suggest best strategy for a conversation based on thread state.
   */
  @Get(':conversationId/suggest-strategy')
  async suggestStrategy(
    @CurrentUser() user: any,
    @Param('conversationId') conversationId: string,
  ) {
    await this.tenancyService.requireConversationAccess(conversationId, user.id);
    const suggestion = await this.contextService.suggestStrategy(conversationId);
    if (!suggestion) return { success: false, error: 'No thread context found' };
    return { success: true, ...suggestion };
  }

  /**
   * Force summary regeneration for a thread.
   */
  @Post(':conversationId/regenerate-summary')
  async regenerateSummary(
    @CurrentUser() user: any,
    @Param('conversationId') conversationId: string,
  ) {
    await this.tenancyService.requireConversationAccess(conversationId, user.id);
    await this.contextService.forceSummaryUpdate(conversationId);
    const ctx = await this.contextService.getContext(conversationId);
    return { success: true, summary: ctx?.summary || null };
  }
}
