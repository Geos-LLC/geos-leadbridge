/**
 * Notifications Controller
 * REST endpoints for managing SMS notification settings
 */

import {
  Controller,
  Get,
  Put,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  NotificationsService,
  UpdateNotificationSettingsDto,
} from './notifications.service';

@Controller('v1/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private notificationsService: NotificationsService) {}

  /**
   * Get notification settings for a saved account
   */
  @Get('settings/:savedAccountId')
  async getSettings(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    const settings = await this.notificationsService.getSettings(
      user.userId,
      savedAccountId,
    );

    return {
      success: true,
      settings,
    };
  }

  /**
   * Create or update notification settings for a saved account
   */
  @Put('settings/:savedAccountId')
  async updateSettings(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
    @Body() body: UpdateNotificationSettingsDto,
  ) {
    const settings = await this.notificationsService.upsertSettings(
      user.userId,
      savedAccountId,
      body,
    );

    return {
      success: true,
      message: 'Notification settings updated successfully',
      settings,
    };
  }

  /**
   * Get notification logs for a saved account
   */
  @Get('logs/:savedAccountId')
  async getLogs(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
    @Query('limit') limit?: string,
  ) {
    const logs = await this.notificationsService.getLogs(
      user.userId,
      savedAccountId,
      limit ? parseInt(limit, 10) : 50,
    );

    return {
      success: true,
      count: logs.length,
      logs,
    };
  }

  /**
   * Send test notification
   */
  @Post('test/:savedAccountId')
  async sendTestNotification(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    const result = await this.notificationsService.sendTestNotification(
      user.userId,
      savedAccountId,
    );

    if (result.success) {
      return {
        success: true,
        message: 'Test notification sent successfully',
      };
    }

    return {
      success: false,
      message: result.error || 'Failed to send test notification',
    };
  }

  /**
   * Validate Callio API key and get available phone numbers
   */
  @Post('callio/validate')
  async validateCallioApiKey(@Body() body: { apiKey: string }) {
    const result = await this.notificationsService.validateCallioApiKey(
      body.apiKey,
    );

    return {
      success: true,
      valid: result.valid,
      phoneNumbers: result.phoneNumbers,
    };
  }

  /**
   * Get phone numbers from Callio for a saved account
   */
  @Get('callio/phone-numbers/:savedAccountId')
  async getCallioPhoneNumbers(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    const phoneNumbers = await this.notificationsService.getCallioPhoneNumbers(
      user.userId,
      savedAccountId,
    );

    return {
      success: true,
      phoneNumbers,
    };
  }
}
