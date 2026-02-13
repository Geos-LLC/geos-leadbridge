import { Injectable, Logger, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { PrismaService } from '../common/utils/prisma.service';
import { firstValueFrom } from 'rxjs';

export interface SigcorePhoneNumber {
  phoneNumber: string;
  friendlyName: string;
  capabilities: {
    voice: boolean;
    sms: boolean;
    mms: boolean;
  };
}

export interface SigcoreSearchResult {
  phoneNumber: string;
  locality: string;
  region: string;
  capabilities: {
    voice: boolean;
    sms: boolean;
    mms: boolean;
  };
}

interface SigcoreProvisionResponse {
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
export class SigcoreService {
  private readonly logger = new Logger(SigcoreService.name);
  private readonly sigcoreApiUrl: string;
  private readonly sigcoreApiKey: string | undefined;

  constructor(
    private configService: ConfigService,
    private httpService: HttpService,
    private prisma: PrismaService,
  ) {
    this.sigcoreApiUrl = this.configService.get<string>('SIGCORE_API_URL') || 'https://sigcore-production.up.railway.app';
    this.sigcoreApiKey = this.configService.get<string>('SIGCORE_API_KEY');

    this.logger.log(`Sigcore API URL: ${this.sigcoreApiUrl}`);

    if (!this.sigcoreApiKey) {
      this.logger.warn('Sigcore API key not configured. Phone provisioning will be disabled.');
    }
  }

  /**
   * Build headers for Sigcore API requests
   */
  private buildHeaders(): Record<string, string> {
    return {
      'X-Sigcore-Key': this.sigcoreApiKey!,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Build full API URL
   */
  private buildUrl(path: string): string {
    return `${this.sigcoreApiUrl}${path}`;
  }

  /**
   * Check if Sigcore is properly configured
   */
  isConfigured(): boolean {
    return !!this.sigcoreApiKey;
  }

  /**
   * Search for available phone numbers
   */
  async searchAvailableNumbers(country: string = 'US', areaCode?: string, limit: number = 10): Promise<SigcoreSearchResult[]> {
    if (!this.isConfigured()) {
      throw new InternalServerErrorException('Sigcore phone provisioning is not configured');
    }

    try {
      const params: any = { country, limit };
      if (areaCode) {
        params.areaCode = areaCode;
      }

      const url = this.buildUrl(`/api/v1/tenants/phone-numbers/search`);
      this.logger.log(`Searching numbers at: ${url}`);

      const response = await firstValueFrom(
        this.httpService.get(url, {
          headers: this.buildHeaders(),
          params,
        })
      );

      this.logger.log(`Search response status: ${response.status}`);

      // Detect HTML response (wrong URL or SPA fallback)
      const data = response.data;
      if (typeof data === 'string' && data.includes('<!DOCTYPE html>')) {
        this.logger.error(`Sigcore API returned HTML instead of JSON. The API URL is likely incorrect: ${this.sigcoreApiUrl}`);
        throw new BadRequestException('Sigcore API returned HTML - check SIGCORE_API_URL configuration');
      }

      this.logger.log(`Search response data: ${JSON.stringify(data)}`);

      return data.numbers || [];
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
      throw new InternalServerErrorException('Sigcore phone provisioning is not configured');
    }

    try {
      const url = this.buildUrl(`/api/v1/tenants/phone-numbers/pricing`);
      this.logger.log(`Getting pricing at: ${url}`);

      const response = await firstValueFrom(
        this.httpService.get(url, {
          headers: this.buildHeaders(),
        })
      );

      if (typeof response.data === 'string' && response.data.includes('<!DOCTYPE html>')) {
        this.logger.error(`Sigcore API returned HTML instead of JSON for pricing endpoint`);
        throw new BadRequestException('Sigcore API returned HTML - check SIGCORE_API_URL configuration');
      }

      return response.data;
    } catch (error) {
      this.logger.error('Failed to get pricing:', error.response?.data || error.message);
      throw new BadRequestException('Failed to get phone number pricing');
    }
  }

  /**
   * Provision a new phone number for a user
   * This is called automatically during user registration
   * @param throwOnError - If true, throws errors instead of returning null (for manual provisioning)
   */
  async provisionNumberForUser(
    userId: string,
    areaCode?: string,
    specificPhoneNumber?: string,
    throwOnError: boolean = false,
  ): Promise<{ phoneNumber: string; allocationId: string } | null> {
    if (!this.isConfigured()) {
      const msg = `Sigcore not configured - skipping phone provisioning for user ${userId}`;
      this.logger.warn(msg);
      if (throwOnError) {
        throw new InternalServerErrorException('Phone provisioning is not configured. Missing SIGCORE_API_KEY.');
      }
      return null;
    }

    try {
      this.logger.log(`Provisioning phone number for user ${userId} (areaCode: ${areaCode || 'auto'})`);

      // Determine which phone number to provision
      let phoneNumberToProvision = specificPhoneNumber;

      if (!phoneNumberToProvision) {
        // Search for available numbers first
        this.logger.log(`Searching for available numbers (areaCode: ${areaCode || 'any'})...`);
        const availableNumbers = await this.searchAvailableNumbers('US', areaCode, 1);

        if (!availableNumbers || availableNumbers.length === 0) {
          const errorMsg = `No phone numbers available${areaCode ? ` in area code ${areaCode}` : ''}`;
          this.logger.error(errorMsg);
          if (throwOnError) {
            throw new BadRequestException(errorMsg);
          }
          return null;
        }

        phoneNumberToProvision = availableNumbers[0].phoneNumber;
        this.logger.log(`Found available number: ${phoneNumberToProvision}`);
      }

      this.logger.log(`Sigcore API URL: ${this.sigcoreApiUrl}/api/v1/phone-numbers/provision`);

      // Build request body
      const requestBody: any = {
        phoneNumber: phoneNumberToProvision,
        friendlyName: `User ${userId}`,
      };

      this.logger.log(`Sigcore request body: ${JSON.stringify(requestBody)}`);

      // Provision phone number via Sigcore API
      const url = this.buildUrl(`/api/v1/phone-numbers/provision`);
      this.logger.log(`Full URL with bypass: ${url}`);

      const response = await firstValueFrom(
        this.httpService.post(
          url,
          requestBody,
          {
            headers: this.buildHeaders(),
          }
        )
      );

      this.logger.log(`Sigcore response status: ${response.status}`);
      this.logger.log(`Sigcore response data: ${JSON.stringify(response.data)}`);

      const data: SigcoreProvisionResponse = response.data;

      if (!data.success || !data.allocation) {
        const errorMsg = `Phone number provisioning failed - no allocation returned. Response: ${JSON.stringify(data)}`;
        this.logger.error(errorMsg);
        if (throwOnError) {
          throw new BadRequestException(errorMsg);
        }
        return null;
      }

      const phoneNumber = data.allocation.phoneNumber;
      const allocationId = data.allocation.id;

      this.logger.log(`Successfully provisioned ${phoneNumber} for user ${userId} (allocation: ${allocationId})`);

      // Update user record with phone number
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          phoneNumber,
          sigcoreAllocationId: allocationId,
        },
      });

      return {
        phoneNumber,
        allocationId,
      };
    } catch (error) {
      const errorDetail = error.response?.data || error.message;
      const errorStatus = error.response?.status;
      this.logger.error(`Failed to provision phone number for user ${userId}:`);
      this.logger.error(`  Status: ${errorStatus}`);
      this.logger.error(`  Error: ${JSON.stringify(errorDetail)}`);

      if (throwOnError) {
        const message = typeof errorDetail === 'object'
          ? errorDetail.message || errorDetail.error || JSON.stringify(errorDetail)
          : errorDetail;
        throw new BadRequestException(`Failed to provision phone number: ${message}`);
      }
      // Don't throw - allow user registration to succeed even if phone provisioning fails
      return null;
    }
  }

  /**
   * Release a phone number (when user cancels subscription or deletes account)
   */
  async releaseUserNumber(userId: string): Promise<void> {
    if (!this.isConfigured()) {
      this.logger.warn('Sigcore not configured - skipping phone release');
      return;
    }

    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { phoneNumber: true, sigcoreAllocationId: true },
      });

      if (!user?.phoneNumber || !user?.sigcoreAllocationId) {
        this.logger.warn(`No phone number to release for user ${userId}`);
        return;
      }

      this.logger.log(`Releasing phone number ${user.phoneNumber} for user ${userId}`);

      // Release number via Sigcore API
      await firstValueFrom(
        this.httpService.post(
          this.buildUrl(`/api/v1/phone-numbers/release`),
          { allocationId: user.sigcoreAllocationId },
          {
            headers: this.buildHeaders(),
          }
        )
      );

      // Update user record
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          phoneNumber: null,
          sigcoreAllocationId: null,
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
  async getUserNumber(userId: string): Promise<SigcorePhoneNumber | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phoneNumber: true, sigcoreAllocationId: true },
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
          this.buildUrl(`/api/v1/tenants/phone-numbers/orders`),
          {
            headers: this.buildHeaders(),
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
