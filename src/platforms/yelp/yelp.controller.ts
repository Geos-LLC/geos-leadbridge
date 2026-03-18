/**
 * Yelp Controller
 * Manages Yelp-specific API endpoints: business subscriptions, account setup
 */

import {
  Controller,
  Post,
  Delete,
  Get,
  Body,
  Param,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/utils/prisma.service';
import { YelpAdapter } from './yelp.adapter';
import { PlatformName } from '../../common/interfaces/platform.interface';

@Controller('v1/yelp')
@UseGuards(JwtAuthGuard)
export class YelpController {
  constructor(
    private yelpAdapter: YelpAdapter,
    private prisma: PrismaService,
  ) {}

  /**
   * Save a Yelp business and subscribe it to lead webhooks.
   * Call this once per business after receiving the Yelp business_id from your Yelp rep.
   */
  @Post('businesses')
  async addBusiness(
    @CurrentUser() user: any,
    @Body('businessId') businessId: string,
    @Body('businessName') businessName: string,
    @Body('imageUrl') imageUrl?: string,
  ) {
    if (!businessId || !businessName) {
      throw new BadRequestException('businessId and businessName are required');
    }

    // Save as SavedAccount (same pattern as Thumbtack)
    await this.prisma.savedAccount.upsert({
      where: { userId_platform_businessId: { userId: user.id, platform: PlatformName.YELP, businessId } },
      create: {
        userId: user.id,
        platform: PlatformName.YELP,
        businessId,
        businessName,
        imageUrl,
      },
      update: { businessName, imageUrl },
    });

    // Subscribe to Yelp lead webhooks for this business
    await this.yelpAdapter.subscribeToBusinesses([businessId]);

    return {
      success: true,
      message: `Yelp business "${businessName}" saved and subscribed to lead webhooks`,
    };
  }

  /**
   * List all Yelp businesses for this user.
   */
  @Get('businesses')
  async getBusinesses(@CurrentUser() user: any) {
    const accounts = await this.prisma.savedAccount.findMany({
      where: { userId: user.id, platform: PlatformName.YELP },
      orderBy: { lastUsedAt: 'desc' },
    });

    return {
      platform: PlatformName.YELP,
      count: accounts.length,
      businesses: accounts,
    };
  }

  /**
   * Remove a Yelp business and unsubscribe from webhooks.
   */
  @Delete('businesses/:id')
  async removeBusiness(@CurrentUser() user: any, @Param('id') id: string) {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id, userId: user.id, platform: PlatformName.YELP },
    });

    if (!account) throw new BadRequestException('Business not found');

    await this.yelpAdapter.unsubscribeFromBusinesses([account.businessId]);

    await this.prisma.savedAccount.delete({ where: { id } });

    return { success: true, message: 'Business removed and unsubscribed from Yelp webhooks' };
  }

  /**
   * Re-subscribe all Yelp businesses to webhooks.
   * Yelp requires subscriptions to be refreshed at least every 24h.
   * Call this on a schedule or on-demand if webhooks stop arriving.
   */
  @Post('businesses/resubscribe')
  async resubscribeAll(@CurrentUser() user: any) {
    const accounts = await this.prisma.savedAccount.findMany({
      where: { userId: user.id, platform: PlatformName.YELP },
    });

    if (accounts.length === 0) {
      return { success: true, message: 'No Yelp businesses to resubscribe', subscribed: 0 };
    }

    const businessIds = accounts.map((a: any) => a.businessId);
    await this.yelpAdapter.subscribeToBusinesses(businessIds);

    return {
      success: true,
      message: `Resubscribed ${accounts.length} businesses to Yelp lead webhooks`,
      subscribed: accounts.length,
    };
  }

  /**
   * Get Yelp leads for this user (from local DB — delivered via webhooks).
   */
  @Get('leads')
  async getLeads(@CurrentUser() user: any) {
    const leads = await this.prisma.lead.findMany({
      where: { userId: user.id, platform: PlatformName.YELP },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return {
      platform: PlatformName.YELP,
      count: leads.length,
      leads,
    };
  }
}
