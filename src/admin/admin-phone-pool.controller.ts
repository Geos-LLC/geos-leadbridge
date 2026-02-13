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

  @Get('search')
  async searchAvailableNumbers(
    @Query('country') country?: string,
    @Query('areaCode') areaCode?: string,
    @Query('limit') limit?: string,
  ) {
    const numbers = await this.phonePoolService.searchAvailableNumbers(
      country || 'US',
      areaCode,
      limit ? parseInt(limit, 10) : 10,
    );
    return { success: true, data: { numbers } };
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

  @Post('provision')
  async provisionToPool(
    @Req() req: any,
    @Body() body: { areaCode?: string; specificPhoneNumber?: string; count?: number },
  ) {
    const phones = await this.phonePoolService.provisionToPool(req.user.id, body);
    return { success: true, data: { phones } };
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

  @Post(':phonePoolId/unassign')
  async unassignFromUser(
    @Req() req: any,
    @Param('phonePoolId') phonePoolId: string,
  ) {
    const phone = await this.phonePoolService.unassignFromUser(req.user.id, phonePoolId);
    return { success: true, data: phone };
  }

  @Delete(':phonePoolId')
  async releaseFromPool(
    @Req() req: any,
    @Param('phonePoolId') phonePoolId: string,
  ) {
    await this.phonePoolService.releaseFromPool(req.user.id, phonePoolId);
    return { success: true, message: 'Phone released from pool' };
  }
}
