import { Controller, Get, Post, Delete, Param, Query, Body, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { AdminPhonePoolService } from './admin-phone-pool.service';
import { PhonePoolStatus } from '../../generated/prisma';

@Controller('v1/admin/phone-pool')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminPhonePoolController {
  constructor(private phonePoolService: AdminPhonePoolService) {}

  @Get()
  async listPoolPhones(
    @Query('status') status?: string,
    @Query('areaCode') areaCode?: string,
    @Query('search') search?: string,
    @Query('offset') offset?: string,
    @Query('limit') limit?: string,
  ) {
    const result = await this.phonePoolService.listPoolPhones({
      status: status as PhonePoolStatus | undefined,
      areaCode,
      search,
      offset: offset ? parseInt(offset, 10) : 0,
      limit: limit ? parseInt(limit, 10) : 50,
    });

    return { success: true, data: result };
  }

  @Get('stats')
  async getPoolStats() {
    const stats = await this.phonePoolService.getPoolStats();
    return { success: true, data: stats };
  }

  /**
   * Check if SIGCORE_TENANT_KEY is configured
   */
  @Get('config')
  async getConfig() {
    const status = this.phonePoolService.getTenantKeyStatus();
    return { success: true, data: status };
  }

  /**
   * List users for assignment dropdown
   * MUST be before parameterized routes to avoid NestJS matching 'users' as :phonePoolId
   */
  @Get('users')
  async listUsers(@Query('search') search?: string) {
    const users = await this.phonePoolService.listUsersForAssignment(search);
    return { success: true, data: users };
  }

  /**
   * Connect admin's provider (OpenPhone or Twilio) via Sigcore
   */
  @Post('connect-provider')
  async connectProvider(
    @Req() req: any,
    @Body() body: {
      provider: 'openphone' | 'twilio';
      credentials: {
        apiKey?: string;
        accountSid?: string;
        authToken?: string;
        phoneNumber?: string;
      };
    },
  ) {
    const result = await this.phonePoolService.connectProvider(
      req.user.id,
      body.provider,
      body.credentials,
    );
    return { success: result.success, data: result.data, error: result.error };
  }

  /**
   * Disconnect admin's provider via Sigcore
   */
  @Post('disconnect-provider')
  async disconnectProvider(
    @Req() req: any,
    @Body() body: { provider: 'openphone' | 'twilio' },
  ) {
    const result = await this.phonePoolService.disconnectProvider(req.user.id, body.provider);
    return { success: result.success, error: result.error };
  }

  /**
   * Sync numbers from connected providers into the pool
   */
  @Post('sync')
  async syncNumbers(@Req() req: any) {
    const results = await this.phonePoolService.syncProviderNumbers(req.user.id);
    return { success: true, data: { results } };
  }

  /**
   * Register webhook subscription with Sigcore for delivery notifications
   */
  @Post('setup-webhook')
  async setupWebhook(@Req() req: any) {
    const result = await this.phonePoolService.setupDeliveryWebhook(req.user.id);
    return { success: result.success, data: result, error: result.error };
  }

  @Post(':phonePoolId/assign-all')
  async assignToAllUsers(
    @Req() req: any,
    @Param('phonePoolId') phonePoolId: string,
  ) {
    const phone = await this.phonePoolService.assignToAllUsers(req.user.id, phonePoolId);
    return { success: true, data: phone };
  }

  @Post(':phonePoolId/assign/:userId')
  async assignToUser(
    @Req() req: any,
    @Param('phonePoolId') phonePoolId: string,
    @Param('userId') userId: string,
  ) {
    const phone = await this.phonePoolService.assignToUser(req.user.id, phonePoolId, userId);
    return { success: true, data: phone };
  }

  @Post(':phonePoolId/unassign/:userId')
  async unassignFromUser(
    @Req() req: any,
    @Param('phonePoolId') phonePoolId: string,
    @Param('userId') userId: string,
  ) {
    const phone = await this.phonePoolService.unassignFromUser(req.user.id, phonePoolId, userId);
    return { success: true, data: phone };
  }

  @Delete(':phonePoolId')
  async removeFromPool(
    @Req() req: any,
    @Param('phonePoolId') phonePoolId: string,
  ) {
    await this.phonePoolService.removeFromPool(req.user.id, phonePoolId);
    return { success: true, message: 'Phone removed from pool' };
  }
}
