/**
 * Notifications Controller
 * REST endpoints for managing SMS notification settings
 */

import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  NotificationsService,
  UpdateNotificationSettingsDto,
  CreateNotificationRuleDto,
  UpdateNotificationRuleDto,
} from './notifications.service';

@Controller('v1/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private notificationsService: NotificationsService) {}

  /**
   * Get the base URL for webhooks from the request
   */
  private getWebhookBaseUrl(req: Request): string {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || req.hostname;
    return `${protocol}://${host}`;
  }

  /**
   * Get notification settings for a saved account
   */
  @Get('settings/:savedAccountId')
  async getSettings(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    const settings = await this.notificationsService.getSettings(
      user.id,
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
      user.id,
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
   * Get all notification logs across all accounts for a user
   */
  @Get('logs')
  async getAllLogs(
    @CurrentUser() user: any,
    @Query('limit') limit?: string,
  ) {
    const logs = await this.notificationsService.getAllLogs(
      user.id,
      limit ? parseInt(limit, 10) : 100,
    );

    return {
      success: true,
      count: logs.length,
      logs,
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
      user.id,
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
   * Send test notification (optionally for a specific rule)
   */
  @Post('test/:savedAccountId')
  async sendTestNotification(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
    @Body() body?: { ruleId?: string },
  ) {
    const result = await this.notificationsService.sendTestNotification(
      user.id,
      savedAccountId,
      body?.ruleId,
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

  // ==========================================
  // Notification Rules CRUD
  // ==========================================

  /**
   * Get all notification rules across all accounts for a user
   */
  @Get('rules')
  async getAllRules(@CurrentUser() user: any) {
    const rules = await this.notificationsService.getAllRules(user.id);

    return {
      success: true,
      count: rules.length,
      rules,
    };
  }

  /**
   * Get notification rules for a saved account
   */
  @Get('rules/:savedAccountId')
  async getRules(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    const rules = await this.notificationsService.getRules(
      user.id,
      savedAccountId,
    );

    return {
      success: true,
      count: rules.length,
      rules,
    };
  }

  /**
   * Create a new notification rule
   */
  @Post('rules/:savedAccountId')
  async createRule(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
    @Body() body: CreateNotificationRuleDto,
  ) {
    const rule = await this.notificationsService.createRule(
      user.id,
      savedAccountId,
      body,
    );

    return {
      success: true,
      message: 'Notification rule created successfully',
      rule,
    };
  }

  /**
   * Update an existing notification rule
   */
  @Put('rules/:savedAccountId/:ruleId')
  async updateRule(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
    @Param('ruleId') ruleId: string,
    @Body() body: UpdateNotificationRuleDto,
  ) {
    const rule = await this.notificationsService.updateRule(
      user.id,
      savedAccountId,
      ruleId,
      body,
    );

    return {
      success: true,
      message: 'Notification rule updated successfully',
      rule,
    };
  }

  /**
   * Delete a notification rule
   */
  @Delete('rules/:savedAccountId/:ruleId')
  async deleteRule(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
    @Param('ruleId') ruleId: string,
  ) {
    await this.notificationsService.deleteRule(
      user.id,
      savedAccountId,
      ruleId,
    );

    return {
      success: true,
      message: 'Notification rule deleted successfully',
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
      user.id,
      savedAccountId,
    );

    return {
      success: true,
      phoneNumbers,
    };
  }

  /**
   * Connect to Callio - validates API key, creates webhook, stores settings
   */
  @Post('callio/connect/:savedAccountId')
  async connectCallio(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
    @Body() body: { apiKey: string },
    @Req() req: Request,
  ) {
    // Verify the saved account belongs to the user
    const account = await this.notificationsService['prisma'].savedAccount.findFirst({
      where: { id: savedAccountId, userId: user.id },
    });

    if (!account) {
      return {
        success: false,
        error: 'Account not found',
      };
    }

    const webhookBaseUrl = this.getWebhookBaseUrl(req);
    const result = await this.notificationsService.connectCallio(
      savedAccountId,
      body.apiKey,
      webhookBaseUrl,
    );

    return {
      success: result.success,
      phoneNumbers: result.phoneNumbers,
      error: result.error,
    };
  }

  /**
   * Disconnect from Callio - deletes webhook, clears settings
   */
  @Delete('callio/disconnect/:savedAccountId')
  async disconnectCallio(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    // Verify the saved account belongs to the user
    const account = await this.notificationsService['prisma'].savedAccount.findFirst({
      where: { id: savedAccountId, userId: user.id },
    });

    if (!account) {
      return {
        success: false,
        error: 'Account not found',
      };
    }

    const result = await this.notificationsService.disconnectCallio(savedAccountId);

    return {
      success: result.success,
      error: result.error,
    };
  }
}
