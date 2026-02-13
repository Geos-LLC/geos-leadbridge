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
   * Provision a phone number via Sigcore API (does NOT update User model)
   * Used by phone pool and direct provisioning
   */
  async provisionNumber(
    areaCode?: string,
    specificPhoneNumber?: string,
    friendlyName?: string,
    throwOnError: boolean = false,
  ): Promise<{ phoneNumber: string; allocationId: string } | null> {
    if (!this.isConfigured()) {
      const msg = 'Sigcore not configured - cannot provision phone number';
      this.logger.warn(msg);
      if (throwOnError) {
        throw new InternalServerErrorException('Phone provisioning is not configured. Missing SIGCORE_API_KEY.');
      }
      return null;
    }

    try {
      let phoneNumberToProvision = specificPhoneNumber;

      if (!phoneNumberToProvision) {
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

      const requestBody: any = {
        phoneNumber: phoneNumberToProvision,
        friendlyName: friendlyName || phoneNumberToProvision,
      };

      this.logger.log(`Provisioning number: ${JSON.stringify(requestBody)}`);

      const url = this.buildUrl(`/api/v1/phone-numbers/provision`);
      const response = await firstValueFrom(
        this.httpService.post(url, requestBody, { headers: this.buildHeaders() })
      );

      this.logger.log(`Sigcore response status: ${response.status}`);

      const data: SigcoreProvisionResponse = response.data;

      if (!data.success || !data.allocation) {
        const errorMsg = `Provisioning failed - no allocation returned. Response: ${JSON.stringify(data)}`;
        this.logger.error(errorMsg);
        if (throwOnError) {
          throw new BadRequestException(errorMsg);
        }
        return null;
      }

      this.logger.log(`Provisioned ${data.allocation.phoneNumber} (allocation: ${data.allocation.id})`);

      return {
        phoneNumber: data.allocation.phoneNumber,
        allocationId: data.allocation.id,
      };
    } catch (error) {
      const errorDetail = error.response?.data || error.message;
      const errorStatus = error.response?.status;
      this.logger.error(`Failed to provision phone number: Status ${errorStatus}, Error: ${JSON.stringify(errorDetail)}`);

      if (throwOnError) {
        const message = typeof errorDetail === 'object'
          ? errorDetail.message || errorDetail.error || JSON.stringify(errorDetail)
          : errorDetail;
        throw new BadRequestException(`Failed to provision phone number: ${message}`);
      }
      return null;
    }
  }

  /**
   * Release a phone number via Sigcore API (does NOT update User model)
   */
  async releaseNumber(allocationId: string): Promise<void> {
    if (!this.isConfigured()) {
      this.logger.warn('Sigcore not configured - skipping phone release');
      return;
    }

    this.logger.log(`Releasing allocation: ${allocationId}`);
    await firstValueFrom(
      this.httpService.post(
        this.buildUrl(`/api/v1/phone-numbers/release`),
        { allocationId },
        { headers: this.buildHeaders() }
      )
    );
    this.logger.log(`Released allocation: ${allocationId}`);
  }

  /**
   * Provision a new phone number for a user (updates User model)
   * This is called automatically during user registration
   */
  async provisionNumberForUser(
    userId: string,
    areaCode?: string,
    specificPhoneNumber?: string,
    throwOnError: boolean = false,
  ): Promise<{ phoneNumber: string; allocationId: string } | null> {
    this.logger.log(`Provisioning phone number for user ${userId} (areaCode: ${areaCode || 'auto'})`);

    const result = await this.provisionNumber(areaCode, specificPhoneNumber, `User ${userId}`, throwOnError);
    if (!result) return null;

    // Update user record with phone number
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        phoneNumber: result.phoneNumber,
        sigcoreAllocationId: result.allocationId,
      },
    });

    this.logger.log(`Assigned ${result.phoneNumber} to user ${userId}`);
    return result;
  }

  /**
   * Release a phone number for a user (clears User model fields)
   */
  async releaseUserNumber(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phoneNumber: true, sigcoreAllocationId: true },
    });

    if (!user?.phoneNumber || !user?.sigcoreAllocationId) {
      this.logger.warn(`No phone number to release for user ${userId}`);
      return;
    }

    this.logger.log(`Releasing phone number ${user.phoneNumber} for user ${userId}`);

    try {
      await this.releaseNumber(user.sigcoreAllocationId);
    } catch (error) {
      this.logger.error(`Failed to release phone number for user ${userId}:`, error.response?.data || error.message);
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { phoneNumber: null, sigcoreAllocationId: null },
    });

    this.logger.log(`Released phone number ${user.phoneNumber} for user ${userId}`);
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
