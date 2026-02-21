/**
 * Call Connect Controller
 * REST endpoints for Instant Call Connect settings and lead sessions
 */

import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  ForbiddenException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CallConnectService, SaveCallConnectSettingsDto } from './call-connect.service';
import { PrismaService } from '../common/utils/prisma.service';

@UseGuards(JwtAuthGuard)
@Controller('v1/call-connect')
export class CallConnectController {
  constructor(
    private callConnectService: CallConnectService,
    private prisma: PrismaService,
  ) {}

  /**
   * GET /api/v1/call-connect/settings?accountId=<savedAccountId>
   * Returns current call-connect settings for a saved account.
   */
  @Get('settings')
  async getSettings(@Query('accountId') accountId: string, @Request() req: any) {
    if (!accountId) {
      return { settings: null };
    }

    // Verify the saved account belongs to the requesting user
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: accountId, userId: req.user.id },
    });
    if (!account) throw new ForbiddenException('Account not found');

    const settings = await this.callConnectService.getSettings(accountId);
    return { settings: settings || null };
  }

  /**
   * PUT /api/v1/call-connect/settings
   * Save / update call-connect settings for an account.
   */
  @Put('settings')
  async saveSettings(
    @Body()
    body: SaveCallConnectSettingsDto & { savedAccountId: string },
    @Request() req: any,
  ) {
    const { savedAccountId, ...dto } = body;

    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId: req.user.id },
    });
    if (!account) throw new ForbiddenException('Account not found');

    if (!this.callConnectService.canUseCallConnect(req.user.id)) {
      throw new ForbiddenException('Instant Call Connect is not available on your current plan');
    }

    const settings = await this.callConnectService.saveSettings(req.user.id, savedAccountId, dto);
    return { settings };
  }

  /**
   * GET /api/v1/call-connect/lead/:leadId
   * Returns all call-connect sessions for a specific lead.
   */
  @Get('lead/:leadId')
  async getLeadSessions(@Param('leadId') leadId: string, @Request() req: any) {
    // Verify the lead belongs to the user
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, userId: req.user.id },
    });
    if (!lead) throw new ForbiddenException('Lead not found');

    const sessions = await this.callConnectService.getSessionsForLead(leadId);
    return { sessions };
  }

  /**
   * POST /api/v1/call-connect/test
   * Fire a test call to verify call-connect works end-to-end.
   */
  @Post('test')
  @HttpCode(HttpStatus.OK)
  async testCall(
    @Body() body: { savedAccountId: string; testPhone: string },
    @Request() req: any,
  ) {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: body.savedAccountId, userId: req.user.id },
    });
    if (!account) throw new ForbiddenException('Account not found');

    const result = await this.callConnectService.triggerTestCall(body.savedAccountId, body.testPhone);
    return { triggered: true, sessionId: result.sessionId };
  }

  /**
   * POST /api/v1/call-connect/cancel
   * Cancel an active call-connect session.
   */
  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  async cancelSession(
    @Body() body: { sessionId: string; savedAccountId: string },
    @Request() req: any,
  ) {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: body.savedAccountId, userId: req.user.id },
    });
    if (!account) throw new ForbiddenException('Account not found');

    await this.callConnectService.cancelSession(body.sessionId, body.savedAccountId);
    return { cancelled: true };
  }
}
