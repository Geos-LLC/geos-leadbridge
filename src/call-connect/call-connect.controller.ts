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
  NotFoundException,
} from '@nestjs/common';

import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CallConnectService, SaveCallConnectSettingsDto } from './call-connect.service';
import { PrismaService } from '../common/utils/prisma.service';
import { TenancyService } from '../common/tenancy/tenancy.service';

@UseGuards(JwtAuthGuard)
@Controller('v1/call-connect')
export class CallConnectController {
  constructor(
    private callConnectService: CallConnectService,
    private prisma: PrismaService,
    private tenancyService: TenancyService,
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

    // Verify the saved account belongs to the requesting user. NotFoundException
    // (not Forbidden) so we don't leak that the record exists for another tenant.
    await this.tenancyService.requireTenantAccess('savedAccount', accountId, req.user.id);

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

    await this.tenancyService.requireTenantAccess('savedAccount', savedAccountId, req.user.id);

    if (!this.callConnectService.canUseCallConnect(req.user.id)) {
      // Tier gate is a true authorization decision (not a tenancy boundary), so 403 is correct.
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
    await this.tenancyService.requireTenantAccess('lead', leadId, req.user.id);

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
    await this.tenancyService.requireTenantAccess('savedAccount', body.savedAccountId, req.user.id);

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
    // Verify the saved account belongs to the user AND the session belongs to one of
    // the user's leads — otherwise an attacker could cancel another tenant's call.
    await this.tenancyService.requireTenantAccess('savedAccount', body.savedAccountId, req.user.id);
    await this.tenancyService.requireCallConnectSessionAccess(body.sessionId, req.user.id);

    await this.callConnectService.cancelSession(body.sessionId, body.savedAccountId);
    return { cancelled: true };
  }

}
