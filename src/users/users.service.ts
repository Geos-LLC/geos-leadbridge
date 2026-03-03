import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { SigcoreService, SigcoreSearchResult } from '../sigcore/sigcore.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private sigcoreService: SigcoreService,
    private notificationsService: NotificationsService,
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

  /**
   * Claim an available pool number as a dedicated number for the user
   */
  async claimPoolAsDedicated(userId: string, phonePoolId: string) {
    const poolPhone = await this.prisma.phonePool.findUnique({ where: { id: phonePoolId } });
    if (!poolPhone) throw new NotFoundException('Pool phone not found');
    if (poolPhone.status !== 'AVAILABLE') throw new BadRequestException('This number is not available for claiming');

    // Check no active tenant number already exists with this phone
    const existing = await this.prisma.tenantPhoneNumber.findUnique({
      where: { phoneNumber: poolPhone.phoneNumber },
    });
    if (existing && existing.status !== 'RELEASED') {
      throw new BadRequestException('This number is already assigned as a dedicated number');
    }

    // Create tenant number
    const tenantPhone = await this.prisma.tenantPhoneNumber.create({
      data: {
        userId,
        phoneNumber: poolPhone.phoneNumber,
        friendlyName: poolPhone.friendlyName,
        areaCode: poolPhone.areaCode,
        sigcoreAllocationId: poolPhone.sigcoreAllocationId,
        status: 'ACTIVE',
      },
    });

    // Remove pool assignments and mark as released
    await this.prisma.phonePoolAssignment.deleteMany({ where: { phonePoolId } });
    await this.prisma.phonePool.update({
      where: { id: phonePoolId },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });

    return { success: true, tenantPhone };
  }

  /**
   * Get all phone options for the user: dedicated, pool, and OpenPhone numbers
   */
  async getAllPhoneOptions(userId: string) {
    // 1. Dedicated numbers
    const dedicated = await this.prisma.tenantPhoneNumber.findMany({
      where: { userId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    // 2. Pool phones assigned to user
    const assignments = await this.prisma.phonePoolAssignment.findMany({
      where: { userId, phonePool: { status: { not: 'RELEASED' } } },
      include: { phonePool: true },
      orderBy: { assignedAt: 'desc' },
    });

    const pool = assignments.map(a => ({
      id: a.phonePool.id,
      phoneNumber: a.phonePool.phoneNumber,
      provider: a.phonePool.provider,
      friendlyName: a.phonePool.friendlyName,
      smsApproved: a.phonePool.smsApproved,
    }));

    // 3. OpenPhone numbers from user's connected accounts
    const openphone: { phoneNumber: string; friendlyName?: string; provider: string; id: string }[] = [];
    try {
      const accounts = await this.prisma.savedAccount.findMany({
        where: { userId },
        include: { notificationSettings: true },
      });

      const seenKeys = new Set<string>();
      for (const account of accounts) {
        const ns = account.notificationSettings;
        if (!ns || ns.sigcoreProvider !== 'openphone' || !ns.sigcoreTenantId) continue;

        // Use sigcoreTenantId as the API key for Sigcore
        const apiKey = ns.sigcoreTenantId;
        if (seenKeys.has(apiKey)) continue;
        seenKeys.add(apiKey);

        const numbers = await this.notificationsService.fetchOpenPhoneNumbers(apiKey);
        for (const num of numbers) {
          openphone.push({
            id: num.id,
            phoneNumber: num.phoneNumber,
            friendlyName: num.friendlyName,
            provider: 'openphone',
          });
        }
      }
    } catch {
      // OpenPhone fetch failures shouldn't break the endpoint
    }

    return {
      success: true,
      dedicated: dedicated.map(d => ({
        id: d.id,
        phoneNumber: d.phoneNumber,
        friendlyName: d.friendlyName,
        provider: 'twilio',
        type: 'dedicated' as const,
      })),
      pool,
      openphone,
    };
  }
}
