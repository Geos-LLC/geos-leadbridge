import { Injectable, Logger, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { PrismaService } from '../common/utils/prisma.service';
import { firstValueFrom } from 'rxjs';

interface CallioPhoneNumber {
  phoneNumber: string;
  friendlyName: string;
  capabilities: {
    voice: boolean;
    sms: boolean;
    mms: boolean;
  };
}

interface CallioSearchResult {
  phoneNumber: string;
  locality: string;
  region: string;
  capabilities: {
    voice: boolean;
    sms: boolean;
    mms: boolean;
  };
}

interface CallioPurchaseResponse {
  success: boolean;
  allocation: {
    id: string;
    phoneNumber: string;
    tenantId: string;
    capabilities: {
      voice: boolean;
      sms: boolean;
      mms: boolean;
    };
  };
  order: {
    id: string;
    status: string;
  };
}

@Injectable()
export class CallioService {
  private readonly logger = new Logger(CallioService.name);
  private readonly callioApiUrl: string;
  private readonly callioApiKey: string;
  private readonly callioTenantId: string;

  constructor(
    private configService: ConfigService,
    private httpService: HttpService,
    private prisma: PrismaService,
  ) {
    this.callioApiUrl = this.configService.get<string>('CALLIO_API_URL') || 'https://callio-git-api-george-says-projects.vercel.app';
    this.callioApiKey = this.configService.get<string>('CALLIO_API_KEY');
    this.callioTenantId = this.configService.get<string>('CALLIO_TENANT_ID');

    if (!this.callioApiKey || !this.callioTenantId) {
      this.logger.warn('Callio API credentials not configured. Phone provisioning will be disabled.');
    }
  }

  /**
   * Check if Callio is properly configured
   */
  isConfigured(): boolean {
    return !!(this.callioApiKey && this.callioTenantId);
  }

  /**
   * Search for available phone numbers
   */
  async searchAvailableNumbers(country: string = 'US', areaCode?: string, limit: number = 10): Promise<CallioSearchResult[]> {
    if (!this.isConfigured()) {
      throw new InternalServerErrorException('Callio phone provisioning is not configured');
    }

    try {
      const params: any = { country, limit };
      if (areaCode) {
        params.areaCode = areaCode;
      }

      const response = await firstValueFrom(
        this.httpService.get(`${this.callioApiUrl}/api/v1/tenants/phone-numbers/search`, {
          headers: {
            'Authorization': `Bearer ${this.callioApiKey}`,
            'Content-Type': 'application/json',
          },
          params,
        })
      );

      return response.data.numbers || [];
    } catch (error) {
      this.logger.error('Failed to search available numbers:', error.response?.data || error.message);
      throw new BadRequestException('Failed to search available phone numbers');
    }
  }

  /**
   * Get pricing information for phone numbers
   */
  async getPricing(): Promise<any> {
    if (!this.isConfigured()) {
      throw new InternalServerErrorException('Callio phone provisioning is not configured');
    }

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.callioApiUrl}/api/v1/tenants/phone-numbers/pricing`, {
          headers: {
            'Authorization': `Bearer ${this.callioApiKey}`,
            'Content-Type': 'application/json',
          },
        })
      );

      return response.data;
    } catch (error) {
      this.logger.error('Failed to get pricing:', error.response?.data || error.message);
      throw new BadRequestException('Failed to get phone number pricing');
    }
  }

  /**
   * Provision a new phone number for a user
   * This is called automatically during user registration
   */
  async provisionNumberForUser(
    userId: string,
    areaCode?: string,
    specificPhoneNumber?: string,
  ): Promise<{ phoneNumber: string; allocationId: string }> {
    if (!this.isConfigured()) {
      this.logger.warn(`Callio not configured - skipping phone provisioning for user ${userId}`);
      return null;
    }

    try {
      this.logger.log(`Provisioning phone number for user ${userId} (areaCode: ${areaCode || 'auto'})`);

      // Build request body
      const requestBody: any = {
        country: 'US',
        userId, // Pass user ID for tracking in Callio
      };

      if (specificPhoneNumber) {
        requestBody.phoneNumber = specificPhoneNumber;
      } else if (areaCode) {
        requestBody.areaCode = areaCode;
      }

      // Purchase phone number via Callio API
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.callioApiUrl}/api/v1/tenants/${this.callioTenantId}/phone-numbers/purchase`,
          requestBody,
          {
            headers: {
              'Authorization': `Bearer ${this.callioApiKey}`,
              'Content-Type': 'application/json',
            },
          }
        )
      );

      const data: CallioPurchaseResponse = response.data;

      if (!data.success || !data.allocation) {
        throw new Error('Phone number provisioning failed - no allocation returned');
      }

      const phoneNumber = data.allocation.phoneNumber;
      const allocationId = data.allocation.id;

      this.logger.log(`Successfully provisioned ${phoneNumber} for user ${userId} (allocation: ${allocationId})`);

      // Update user record with phone number
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          phoneNumber,
          callioAllocationId: allocationId,
        },
      });

      return {
        phoneNumber,
        allocationId,
      };
    } catch (error) {
      this.logger.error(`Failed to provision phone number for user ${userId}:`, error.response?.data || error.message);
      // Don't throw - allow user registration to succeed even if phone provisioning fails
      return null;
    }
  }

  /**
   * Release a phone number (when user cancels subscription or deletes account)
   */
  async releaseUserNumber(userId: string): Promise<void> {
    if (!this.isConfigured()) {
      this.logger.warn('Callio not configured - skipping phone release');
      return;
    }

    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { phoneNumber: true, callioAllocationId: true },
      });

      if (!user?.phoneNumber || !user?.callioAllocationId) {
        this.logger.warn(`No phone number to release for user ${userId}`);
        return;
      }

      this.logger.log(`Releasing phone number ${user.phoneNumber} for user ${userId}`);

      // Release number via Callio API
      await firstValueFrom(
        this.httpService.post(
          `${this.callioApiUrl}/api/v1/tenants/${this.callioTenantId}/phone-numbers/${user.callioAllocationId}/release`,
          {},
          {
            headers: {
              'Authorization': `Bearer ${this.callioApiKey}`,
              'Content-Type': 'application/json',
            },
          }
        )
      );

      // Update user record
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          phoneNumber: null,
          callioAllocationId: null,
        },
      });

      this.logger.log(`Successfully released phone number ${user.phoneNumber} for user ${userId}`);
    } catch (error) {
      this.logger.error(`Failed to release phone number for user ${userId}:`, error.response?.data || error.message);
      // Don't throw - log error but continue
    }
  }

  /**
   * Get user's current phone number
   */
  async getUserNumber(userId: string): Promise<CallioPhoneNumber | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phoneNumber: true, callioAllocationId: true },
    });

    if (!user?.phoneNumber) {
      return null;
    }

    return {
      phoneNumber: user.phoneNumber,
      friendlyName: user.phoneNumber,
      capabilities: {
        voice: true,
        sms: true,
        mms: true,
      },
    };
  }

  /**
   * Get order history for a user (for admin/debugging)
   */
  async getUserOrders(userId: string): Promise<any[]> {
    if (!this.isConfigured()) {
      return [];
    }

    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `${this.callioApiUrl}/api/v1/tenants/${this.callioTenantId}/phone-numbers/orders`,
          {
            headers: {
              'Authorization': `Bearer ${this.callioApiKey}`,
              'Content-Type': 'application/json',
            },
            params: { userId },
          }
        )
      );

      return response.data.orders || [];
    } catch (error) {
      this.logger.error('Failed to get user orders:', error.response?.data || error.message);
      return [];
    }
  }
}
