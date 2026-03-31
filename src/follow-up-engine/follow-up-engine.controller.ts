/**
 * Follow-Up Engine Controller
 *
 * REST endpoints for follow-up management.
 * Phase 1: list templates, enrollments, manual enroll/stop.
 * Phase 3: approve/skip/pause suggestions.
 */

import { Controller, Get, Post, Param, Body, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../common/utils/prisma.service';
import { FollowUpEngineService } from './follow-up-engine.service';

@Controller('v1/follow-ups')
@UseGuards(JwtAuthGuard)
export class FollowUpEngineController {
  constructor(
    private readonly engineService: FollowUpEngineService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * List sequence templates for current user.
   */
  @Get('templates')
  async listTemplates(
    @CurrentUser() user: any,
    @Query('platform') platform?: string,
    @Query('triggerState') triggerState?: string,
  ) {
    const templates = await this.prisma.followUpSequenceTemplate.findMany({
      where: {
        userId: user.id,
        ...(platform && { platform }),
        ...(triggerState && { triggerState }),
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return { success: true, count: templates.length, templates };
  }

  /**
   * List active enrollments for current user.
   */
  @Get('enrollments')
  async listEnrollments(
    @CurrentUser() user: any,
    @Query('status') status?: string,
  ) {
    const enrollments = await this.prisma.followUpEnrollment.findMany({
      where: {
        conversation: { userId: user.id },
        ...(status && { status }),
      },
      include: {
        sequenceTemplate: { select: { name: true, triggerState: true, preset: true } },
        lead: { select: { customerName: true, category: true } },
      },
      orderBy: { nextStepDueAt: 'asc' },
    });
    return { success: true, count: enrollments.length, enrollments };
  }

  /**
   * Get enrollment details with step executions.
   */
  @Get('enrollments/:id')
  async getEnrollment(@Param('id') id: string) {
    const enrollment = await this.prisma.followUpEnrollment.findUnique({
      where: { id },
      include: {
        sequenceTemplate: true,
        stepExecutions: { orderBy: { stepIndex: 'asc' } },
        lead: { select: { customerName: true, category: true, city: true, state: true } },
      },
    });
    return { success: true, enrollment };
  }

  /**
   * Manually enroll a conversation in a sequence.
   */
  @Post('enroll')
  async enroll(
    @Body() body: { conversationId: string; templateId: string; platform: string; leadId?: string },
  ) {
    const enrollmentId = await this.engineService.enrollInSequence(
      body.conversationId,
      body.templateId,
      body.platform,
      body.leadId,
    );
    return { success: true, enrollmentId };
  }

  /**
   * Stop an enrollment.
   */
  @Post('enrollments/:id/stop')
  async stop(@Param('id') id: string, @Body('reason') reason?: string) {
    await this.engineService.stopEnrollment(id, reason || 'manual');
    return { success: true };
  }

  /**
   * Pause an enrollment.
   */
  @Post('enrollments/:id/pause')
  async pause(@Param('id') id: string) {
    await this.engineService.pauseEnrollment(id);
    return { success: true };
  }

  /**
   * Resume a paused enrollment.
   */
  @Post('enrollments/:id/resume')
  async resume(@Param('id') id: string) {
    await this.engineService.resumeEnrollment(id);
    return { success: true };
  }

  /**
   * Get pending suggestions for current user (Phase 3: full implementation).
   */
  @Get('suggestions')
  async listSuggestions(@CurrentUser() user: any) {
    const suggestions = await this.prisma.followUpStepExecution.findMany({
      where: {
        status: 'suggested',
        enrollment: { conversation: { userId: user.id } },
      },
      include: {
        enrollment: {
          select: {
            conversationId: true,
            lead: { select: { customerName: true } },
            sequenceTemplate: { select: { name: true } },
          },
        },
      },
      orderBy: { scheduledAt: 'asc' },
    });
    return { success: true, count: suggestions.length, suggestions };
  }
}
