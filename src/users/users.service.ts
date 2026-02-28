import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { SigcoreService, SigcoreSearchResult } from '../sigcore/sigcore.service';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private sigcoreService: SigcoreService,
  ) {}

  /**
   * Get user's phone number
   */
  async getUserPhoneNumber(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        phoneNumber: true,
        sigcoreAllocationId: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      phoneNumber: user.phoneNumber,
      allocationId: user.sigcoreAllocationId,
      hasPhoneNumber: !!user.phoneNumber,
    };
  }

  /**
   * Provision a new phone number for user
   * This is called manually by users, so we throw errors to show them what went wrong
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

    // throwOnError=true so users see what went wrong when manually provisioning
    const result = await this.sigcoreService.provisionNumberForUser(userId, areaCode, undefined, true);

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
  async searchAvailableNumbers(country: string = 'US', areaCode?: string): Promise<SigcoreSearchResult[]> {
    return this.sigcoreService.searchAvailableNumbers(country, areaCode, 10);
  }

  /**
   * Get user's assigned pool phones (via assignments join table)
   */
  async getUserPoolPhone(userId: string) {
    const assignments = await this.prisma.phonePoolAssignment.findMany({
      where: { userId },
      include: { phonePool: true },
      orderBy: { assignedAt: 'desc' },
    });

    const poolPhones = assignments
      .filter(a => a.phonePool.status !== 'RELEASED')
      .map(a => a.phonePool);

    return { success: true, poolPhone: poolPhones[0] || null, poolPhones };
  }

  /**
   * Get pool phones available for SMS sending
   * Returns: user's assigned phones first, then all available pool phones
   */
  async getPoolPhonesForSms(userId: string) {
    const [assignments, available] = await Promise.all([
      this.prisma.phonePoolAssignment.findMany({
        where: { userId, phonePool: { status: { not: 'RELEASED' } } },
        include: { phonePool: true },
        orderBy: { assignedAt: 'desc' },
      }),
      this.prisma.phonePool.findMany({
        where: { status: 'AVAILABLE' },
        orderBy: { provisionedAt: 'desc' },
      }),
    ]);

    const assignedIds = new Set(assignments.map(a => a.phonePool.id));

    return {
      success: true,
      phoneNumbers: [
        ...assignments.map(a => ({ id: a.phonePool.id, phoneNumber: a.phonePool.phoneNumber, provider: a.phonePool.provider, friendlyName: a.phonePool.friendlyName, assigned: true, smsApproved: a.phonePool.smsApproved })),
        ...available.filter(p => !assignedIds.has(p.id)).map(p => ({ id: p.id, phoneNumber: p.phoneNumber, provider: p.provider, friendlyName: p.friendlyName, assigned: false, smsApproved: p.smsApproved })),
      ],
    };
  }
}
