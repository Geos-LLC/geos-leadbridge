import { Controller, Get, Post, Patch, Param, Body, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { AdminPhonePoolService } from './admin-phone-pool.service';

@Controller('v1/admin/phone-pool')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminPhonePoolController {
  constructor(private phonePoolService: AdminPhonePoolService) {}

  /**
   * Check if SIGCORE_TENANT_KEY is configured
   */
  @Get('config')
  async getConfig() {
    const status = this.phonePoolService.getTenantKeyStatus();
    return { success: true, data: status };
  }

  /**
   * Get global admin config (test customer data, etc.)
   */
  @Get('admin-config')
  async getAdminConfig() {
    const config = await this.phonePoolService.getAdminConfig();
    return { success: true, data: config };
  }

  /**
   * Update global admin config — body is { testData, yelpTestData }
   */
  @Patch('admin-config')
  async updateAdminConfig(@Body() body: { testData?: Record<string, string>; yelpTestData?: Record<string, string> }) {
    const config = await this.phonePoolService.updateAdminConfig(body.testData ?? {}, body.yelpTestData);
    return { success: true, data: config };
  }

  /**
   * Get phone number pricing config
   */
  @Get('phone-pricing')
  async getPhonePricing() {
    const pricing = await this.phonePoolService.getPhonePricing();
    return { success: true, data: pricing };
  }

  /**
   * Update phone number pricing config (creates/updates Stripe Price)
   */
  @Patch('phone-pricing')
  async updatePhonePricing(@Body() body: { priceMonthly: number; gracePeriodDays: number }) {
    const pricing = await this.phonePoolService.updatePhonePricing(
      body.priceMonthly,
      body.gracePeriodDays,
    );
    return { success: true, data: pricing };
  }

  /**
   * Update Messaging Service SID (A2P 10DLC) — saves locally and syncs to Sigcore
   */
  @Patch('messaging-service')
  async updateMessagingService(@Body() body: { messagingServiceSid: string }) {
    const result = await this.phonePoolService.updateMessagingServiceSid(body.messagingServiceSid);
    return { success: true, data: result };
  }

  /**
   * Check Twilio connection health
   */
  @Get('twilio-health')
  async checkTwilioHealth() {
    const result = await this.phonePoolService.checkTwilioHealth();
    return { success: true, data: result };
  }

  /**
   * Reassign a dedicated tenant number to a different user
   */
  @Patch('tenant/:tenantPhoneId/reassign')
  async reassignTenantPhone(
    @Req() req: any,
    @Param('tenantPhoneId') tenantPhoneId: string,
    @Body() body: { userId: string },
  ) {
    const result = await this.phonePoolService.reassignTenantPhone(req.user.id, tenantPhoneId, body.userId);
    return { success: true, data: result };
  }
}
