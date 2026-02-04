import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { CallioService } from '../callio/callio.service';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private callioService: CallioService,
  ) {}

  /**
   * Get user's phone number
   */
  async getUserPhoneNumber(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        phoneNumber: true,
        callioAllocationId: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      phoneNumber: user.phoneNumber,
      allocationId: user.callioAllocationId,
      hasPhoneNumber: !!user.phoneNumber,
    };
  }

  /**
   * Provision a new phone number for user
   */
  async provisionPhoneNumber(userId: string, areaCode?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phoneNumber: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.phoneNumber) {
      return {
        phoneNumber: user.phoneNumber,
        message: 'User already has a phone number',
      };
    }

    const result = await this.callioService.provisionNumberForUser(userId, areaCode);

    if (!result) {
      return {
        phoneNumber: null,
        message: 'Phone provisioning is not configured or failed',
      };
    }

    return {
      phoneNumber: result.phoneNumber,
      allocationId: result.allocationId,
      message: 'Phone number provisioned successfully',
    };
  }

  /**
   * Search available phone numbers
   */
  async searchAvailableNumbers(country: string = 'US', areaCode?: string) {
    return this.callioService.searchAvailableNumbers(country, areaCode, 10);
  }
}
