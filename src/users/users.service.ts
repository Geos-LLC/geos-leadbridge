import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { SigcoreService, SigcoreSearchResult } from '../sigcore/sigcore.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StripeService } from '../stripe/stripe.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private prisma: PrismaService,
    private sigcoreService: SigcoreService,
    private notificationsService: NotificationsService,
    private stripeService: StripeService,
  ) {}

  async updateProfile(userId: string, updates: { name?: string; businessPhone?: string }) {
    const data: Record<string, any> = {};
    if (updates.name !== undefined) data.name = updates.name;
    if (updates.businessPhone !== undefined) {
      const digits = updates.businessPhone.replace(/\D/g, '');
      if (digits.length === 10) data.businessPhone = `+1${digits}`;
      else if (digits.length === 11 && digits.startsWith('1')) data.businessPhone = `+${digits}`;
      else if (digits.length > 10) data.businessPhone = `+${digits}`;
      else data.businessPhone = updates.businessPhone || null;
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      select: { id: true, name: true, email: true, businessPhone: true },
      data,
    });

    // Sync businessPhone to all existing agent phone fields
    if (data.businessPhone) {
      await this.syncBusinessPhoneToAccounts(userId, data.businessPhone);
    }

    return { success: true, user };
  }

  private async syncBusinessPhoneToAccounts(userId: string, phone: string) {
    const accounts = await this.prisma.savedAccount.findMany({
      where: { userId },
      select: { id: true },
    });
    for (const account of accounts) {
      await this.prisma.notificationSettings.updateMany({
        where: { savedAccountId: account.id },
        data: { destinationPhone: phone },
      });
      await this.prisma.callConnectSettings.updateMany({
        where: { savedAccountId: account.id },
        data: { agentPhoneE164: phone },
      });
    }
  }

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
    // Pool numbers are shared across all tenants — show all non-released numbers.
    // "assigned" flag indicates whether this user has an explicit assignment (informational only).
    const [allPool, userAssignments] = await Promise.all([
      this.prisma.phonePool.findMany({
        where: { status: { not: 'RELEASED' } },
        orderBy: { provisionedAt: 'desc' },
      }),
      this.prisma.phonePoolAssignment.findMany({
        where: { userId },
        select: { phonePoolId: true },
      }),
    ]);

    const assignedIds = new Set(userAssignments.map(a => a.phonePoolId));

    return {
      success: true,
      phoneNumbers: allPool.map(p => ({
        id: p.id,
        phoneNumber: p.phoneNumber,
        provider: p.provider,
        friendlyName: p.friendlyName,
        assigned: assignedIds.has(p.id),
        smsApproved: p.smsApproved,
      })),
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

    // 2. Pool phones — shared across all tenants, show all non-released numbers
    const poolPhones = await this.prisma.phonePool.findMany({
      where: { status: { not: 'RELEASED' } },
      orderBy: { provisionedAt: 'desc' },
    });

    const pool = poolPhones.map(p => ({
      id: p.id,
      phoneNumber: p.phoneNumber,
      provider: p.provider,
      friendlyName: p.friendlyName,
      smsApproved: p.smsApproved,
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

  /**
   * Delete the current user's own account
   */
  async deleteOwnAccount(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { savedAccounts: { select: { id: true } } },
    });
    if (!user) throw new NotFoundException('User not found');

    // Cancel Stripe subscription if active
    if (user.stripeSubscriptionId) {
      try {
        await this.stripeService.cancelSubscription(userId, true);
      } catch (err: any) {
        this.logger.warn(`[deleteOwnAccount] Stripe cancel failed: ${err.message}`);
      }
    }

    // Clean up Sigcore tenants for each saved account
    for (const account of user.savedAccounts) {
      try {
        await this.notificationsService.deleteSigcoreTenant(account.id);
      } catch (err: any) {
        this.logger.warn(`[deleteOwnAccount] Sigcore cleanup failed for ${account.id}: ${err.message}`);
      }
    }

    // Unlink tenant phone numbers (nullify savedAccountId) before cascade
    await this.prisma.tenantPhoneNumber.updateMany({
      where: { userId },
      data: { savedAccountId: null },
    });

    // Delete user — cascade handles all related records
    await this.prisma.user.delete({ where: { id: userId } });

    this.logger.log(`[deleteOwnAccount] User ${user.email} deleted their account`);
    return { success: true };
  }
}
