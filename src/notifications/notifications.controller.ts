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
  HttpException,
  HttpStatus,
  Logger,
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
  private readonly logger = new Logger(NotificationsController.name);

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
   * Provision a Sigcore tenant workspace for a saved account.
   * Idempotent — safe to call multiple times; returns existing tenant key if already provisioned.
   * POST /v1/notifications/sigcore/provision/:savedAccountId
   */
  @Post('sigcore/provision/:savedAccountId')
  async provisionSigcoreWorkspace(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    try {
      const result = await this.notificationsService.ensureSigcoreTenantProvisioned(
        user.id,
        savedAccountId,
      );
      return {
        success: true,
        data: { provisioned: true, tenantId: result.tenantId },
      };
    } catch (err: any) {
      this.logger.error(`[provisionSigcoreWorkspace] Failed: ${err.message}`, err.stack);
      throw new HttpException(
        err.message || 'Failed to provision Sigcore workspace',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  /**
   * Search available Twilio phone numbers via Sigcore
   * GET /v1/notifications/sigcore/available-numbers/:savedAccountId?country=US&areaCode=415
   */
  @Get('sigcore/available-numbers/:savedAccountId')
  async searchAvailableNumbers(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
    @Query('country') country: string = 'US',
    @Query('areaCode') areaCode?: string,
    @Query('locality') locality?: string,
  ) {
    try {
      const numbers = await this.notificationsService.searchSigcoreAvailableNumbers(
        user.id, savedAccountId, country, areaCode, locality,
      );
      return { success: true, data: numbers };
    } catch (err: any) {
      throw new HttpException(err.message || 'Failed to search phone numbers', HttpStatus.BAD_GATEWAY);
    }
  }

  /**
   * Purchase a Twilio phone number for a tenant via Sigcore
   * POST /v1/notifications/sigcore/purchase-number/:savedAccountId
   */
  @Post('sigcore/purchase-number/:savedAccountId')
  async purchasePhoneNumber(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
    @Body() dto: { phoneNumber: string; friendlyName?: string },
  ) {
    try {
      const result = await this.notificationsService.purchaseSigcorePhoneNumber(
        user.id, savedAccountId, dto.phoneNumber, dto.friendlyName,
      );
      return { success: true, data: result };
    } catch (err: any) {
      this.logger.error(`[purchasePhoneNumber] ${err.message}`, err.stack);
      throw new HttpException(err.message || 'Failed to purchase phone number', HttpStatus.BAD_GATEWAY);
    }
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
   * Get notification logs for a specific lead (used by unified timeline)
   */
  @Get('logs/lead/:leadId')
  async getLogsByLead(
    @CurrentUser() user: any,
    @Param('leadId') leadId: string,
    @Query('limit') limit?: string,
  ) {
    const logs = await this.notificationsService.getLogsByLead(
      user.id,
      leadId,
      limit ? parseInt(limit, 10) : 50,
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
    @Body() body?: { ruleId?: string; toPhone?: string; template?: string },
  ) {
    const result = await this.notificationsService.sendTestNotification(
      user.id,
      savedAccountId,
      body?.ruleId,
      body?.toPhone,
      body?.template,
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
   * Send an ad-hoc SMS to a lead's customer phone
   * Used by the Messages page channel dropdown when SMS is selected
   */
  @Post('send-sms')
  async sendAdHocSms(
    @CurrentUser() user: any,
    @Body() body: { leadId: string; message: string; savedAccountId: string },
  ) {
    const result = await this.notificationsService.sendAdHocSms(
      user.id,
      body.savedAccountId,
      body.leadId,
      body.message,
    );

    return {
      success: result.success,
      message: result.success ? 'SMS sent successfully' : (result.error || 'Failed to send SMS'),
      logId: result.logId,
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

  // ==========================================
  // Customer Texting Settings
  // ==========================================

  /**
   * Get customer texting settings for an account
   */
  @Get('customer-texting/:savedAccountId')
  async getCustomerTextingSettings(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    const settings = await this.notificationsService.getCustomerTextingSettings(
      user.id,
      savedAccountId,
    );
    return { success: true, ...settings };
  }

  /**
   * Save customer texting settings for an account
   */
  @Put('customer-texting/:savedAccountId')
  async saveCustomerTextingSettings(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
    @Body() body: {
      enabled: boolean;
      fromPhone?: string;
      autoReplyTemplate: string;
      followUps: Array<{ enabled: boolean; delayMinutes: number; template: string }>;
      stopOnCustomerReply: boolean;
    },
  ) {
    const result = await this.notificationsService.saveCustomerTextingSettings(
      user.id,
      savedAccountId,
      body,
    );
    return { success: result.success };
  }

  /**
   * Validate Sigcore API key and get available phone numbers
   */
  @Post('sigcore/validate')
  async validateSigcoreApiKey(@Body() body: { apiKey: string }) {
    const result = await this.notificationsService.validateSigcoreApiKey(
      body.apiKey,
    );

    return {
      success: true,
      valid: result.valid,
    };
  }

  /**
   * Get phone numbers from Sigcore for a saved account
   */
  @Get('sigcore/phone-numbers/:savedAccountId')
  async getSigcorePhoneNumbers(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    const phoneNumbers = await this.notificationsService.getSigcorePhoneNumbers(
      user.id,
      savedAccountId,
    );

    return {
      success: true,
      phoneNumbers,
    };
  }

  /**
   * Save/update the LeadBridge API key for an account (separate from provider connect)
   */
  @Post('sigcore/api-key/:savedAccountId')
  async saveApiKey(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
    @Body() body: { apiKey: string },
  ) {
    const account = await this.notificationsService['prisma'].savedAccount.findFirst({
      where: { id: savedAccountId, userId: user.id },
    });

    if (!account) {
      return { success: false, error: 'Account not found' };
    }

    const result = await this.notificationsService.saveApiKey(savedAccountId, body.apiKey);
    return result;
  }

  /**
   * Connect provider via Sigcore - uses stored API key, connects provider, creates webhook
   */
  @Post('sigcore/connect/:savedAccountId')
  async connectSigcore(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
    @Body() body: {
      apiKey?: string;
      provider?: 'openphone' | 'twilio';
      providerCredentials?: {
        apiKey?: string; // OpenPhone API key
        accountSid?: string; // Twilio
        authToken?: string; // Twilio
        phoneNumber?: string; // Twilio phone number
      };
    },
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
    const result = await this.notificationsService.connectSigcore(
      savedAccountId,
      body.apiKey || null,
      webhookBaseUrl,
      body.provider,
      body.providerCredentials,
    );

    return {
      success: result.success,
      phoneNumbers: result.phoneNumbers,
      error: result.error,
    };
  }

  /**
   * Disconnect from Sigcore - deletes webhook, clears settings
   */
  @Delete('sigcore/disconnect/:savedAccountId')
  async disconnectSigcore(
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

    const result = await this.notificationsService.disconnectSigcore(savedAccountId);

    return {
      success: result.success,
      error: result.error,
    };
  }

  // ==========================================
  // Tenant Phone Numbers (Dedicated Numbers)
  // ==========================================

  @Get('phone-pricing')
  async getPhonePricing() {
    const pricing = await this.notificationsService.getPhonePricing();
    return { success: true, data: pricing };
  }

  @Get('tenant-phones')
  async listTenantPhones(@CurrentUser() user: any) {
    const phones = await this.notificationsService.listTenantPhoneNumbers(user.id);
    return { success: true, data: phones };
  }

  @Post('tenant-phones/purchase')
  async purchaseTenantPhone(
    @CurrentUser() user: any,
    @Body() body: { savedAccountId: string; phoneNumber: string; friendlyName?: string },
  ) {
    const result = await this.notificationsService.purchaseTenantPhoneNumber(
      user.id,
      body.savedAccountId,
      body.phoneNumber,
      body.friendlyName,
    );
    return result;
  }

  @Post('tenant-phones/:id/cancel')
  async cancelTenantPhone(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    const result = await this.notificationsService.cancelTenantPhoneNumber(user.id, id);
    return result;
  }
}
