import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { ListUsersDto } from './dto/list-users.dto';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from './guards/admin.guard';

@Controller('v1/admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('users')
  async listUsers(@Query() query: ListUsersDto) {
    const result = await this.adminService.listUsers(query);
    return {
      success: true,
      data: result,
    };
  }

  @Get('users/:userId')
  async getUserDetails(@Param('userId') userId: string) {
    const result = await this.adminService.getUserDetails(userId);
    return {
      success: true,
      data: result,
    };
  }

  @Patch('users/:userId/subscription')
  async updateUserSubscription(
    @Req() req: any,
    @Param('userId') userId: string,
    @Body() dto: UpdateSubscriptionDto,
  ) {
    const adminId = req.user.id;
    const result = await this.adminService.updateUserSubscription(
      adminId,
      userId,
      dto,
    );
    return {
      success: true,
      data: result,
    };
  }

  @Post('users/:userId/cancel-subscription')
  async cancelUserSubscription(
    @Req() req: any,
    @Param('userId') userId: string,
    @Body() body: { immediate?: boolean },
  ) {
    const adminId = req.user.id;
    const immediate = body.immediate !== false; // Default to true
    const result = await this.adminService.cancelUserSubscription(
      adminId,
      userId,
      immediate,
    );
    return {
      success: true,
      data: result,
    };
  }

  @Patch('users/:userId/trial-leads')
  async updateTrialLeads(
    @Req() req: any,
    @Param('userId') userId: string,
    @Body() body: { trialLeadsHandled?: number; trialLeadsLimit?: number },
  ) {
    const adminId = req.user.id;
    const result = await this.adminService.updateTrialLeads(adminId, userId, body);
    return {
      success: true,
      data: result,
    };
  }

  @Delete('users/:userId')
  async deleteUser(@Req() req: any, @Param('userId') userId: string) {
    const adminId = req.user.id;
    const result = await this.adminService.deleteUser(adminId, userId);
    return {
      success: true,
      data: result,
    };
  }

  @Get('stats')
  async getStats() {
    const result = await this.adminService.getStats();
    return {
      success: true,
      data: result,
    };
  }

  @Get('logs')
  async getAdminLogs(@Query() query: { limit?: number; offset?: number }) {
    const result = await this.adminService.getAdminLogs(query);
    return {
      success: true,
      data: result,
    };
  }

  @Get('notification-logs')
  async getNotificationLogs(@Query() query: { limit?: number }) {
    const result = await this.adminService.getNotificationLogs(query);
    return {
      success: true,
      ...result,
    };
  }

  @Get('tenant-errors')
  async getTenantErrorFeed(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const result = await this.adminService.getTenantErrorFeed({
      status,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    return { success: true, data: result };
  }
}
