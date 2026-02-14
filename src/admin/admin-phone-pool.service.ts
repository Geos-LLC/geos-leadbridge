import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { SigcoreService } from '../sigcore/sigcore.service';
import { AdminService } from './admin.service';
import { PhonePoolStatus } from '../../generated/prisma';

@Injectable()
export class AdminPhonePoolService {
  private readonly logger = new Logger(AdminPhonePoolService.name);

  constructor(
    private prisma: PrismaService,
    private sigcoreService: SigcoreService,
    private adminService: AdminService,
  ) {}

  /**
   * List pool phones with filtering and pagination
   */
  async listPoolPhones(query: {
    status?: PhonePoolStatus;
    areaCode?: string;
    search?: string;
    offset?: number;
    limit?: number;
  }) {
    const { status, areaCode, search, offset = 0, limit = 50 } = query;

    const where: any = {};
    if (status) where.status = status;
    if (areaCode) where.areaCode = areaCode;
    if (search) {
      where.OR = [
        { phoneNumber: { contains: search } },
        { friendlyName: { contains: search, mode: 'insensitive' } },
        { assignedToUser: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [phones, total] = await Promise.all([
      this.prisma.phonePool.findMany({
        where,
        include: {
          assignedToUser: { select: { id: true, email: true, name: true } },
        },
        orderBy: { provisionedAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.phonePool.count({ where }),
    ]);

    return { phones, total };
  }

  /**
   * Get pool statistics
   */
  async getPoolStats() {
    const [total, available, assigned, reserved] = await Promise.all([
      this.prisma.phonePool.count({ where: { status: { not: 'RELEASED' } } }),
      this.prisma.phonePool.count({ where: { status: 'AVAILABLE' } }),
      this.prisma.phonePool.count({ where: { status: 'ASSIGNED' } }),
      this.prisma.phonePool.count({ where: { status: 'RESERVED' } }),
    ]);

    // Breakdown by area code
    const byAreaCode = await this.prisma.phonePool.groupBy({
      by: ['areaCode'],
      where: { status: { not: 'RELEASED' } },
      _count: { id: true },
    });

    return {
      total,
      available,
      assigned,
      reserved,
      byAreaCode: byAreaCode.map((a) => ({
        areaCode: a.areaCode || 'unknown',
        count: a._count.id,
      })),
    };
  }

  /**
   * Check if SIGCORE_TENANT_KEY is configured
   */
  getTenantKeyStatus(): { configured: boolean } {
    return { configured: this.sigcoreService.hasTenantKey() };
  }

  /**
   * Connect admin's provider account (OpenPhone or Twilio) via Sigcore
   */
  async connectProvider(
    adminId: string,
    provider: 'openphone' | 'twilio',
    credentials: {
      apiKey?: string;
      accountSid?: string;
      authToken?: string;
      phoneNumber?: string;
    },
  ) {
    const result = await this.sigcoreService.adminConnectProvider(provider, credentials);

    if (result.success) {
      await this.adminService.logAdminAction(adminId, 'CONNECT_PROVIDER', null, { provider });
      this.logger.log(`Admin ${adminId} connected ${provider}`);
    }

    return result;
  }

  /**
   * Disconnect admin's provider account via Sigcore
   */
  async disconnectProvider(adminId: string, provider: 'openphone' | 'twilio') {
    const result = await this.sigcoreService.adminDisconnectProvider(provider);

    if (result.success) {
      // Mark pool phones from this provider as RELEASED
      await this.prisma.phonePool.updateMany({
        where: { provider, status: { not: 'RELEASED' } },
        data: { status: 'RELEASED', assignedToUserId: null, assignedAt: null, releasedAt: new Date() },
      });

      await this.adminService.logAdminAction(adminId, 'DISCONNECT_PROVIDER', null, { provider });
      this.logger.log(`Admin ${adminId} disconnected ${provider}`);
    }

    return result;
  }

  /**
   * Sync phone numbers from connected providers into the pool
   * Fetches numbers from OpenPhone and/or Twilio via Sigcore, upserts into PhonePool
   */
  async syncProviderNumbers(adminId: string) {
    const results: { provider: string; synced: number; errors: string[] }[] = [];

    for (const provider of ['openphone', 'twilio'] as const) {
      const providerResult = { provider, synced: 0, errors: [] as string[] };

      try {
        const numbers = provider === 'openphone'
          ? await this.sigcoreService.adminFetchOpenPhoneNumbers()
          : await this.sigcoreService.adminFetchTwilioNumbers();

        this.logger.log(`[syncProviderNumbers] Fetched ${numbers.length} numbers from ${provider}`);
        if (numbers.length > 0) {
          this.logger.log(`[syncProviderNumbers] Sample number object keys: ${JSON.stringify(Object.keys(numbers[0]))}`);
          this.logger.log(`[syncProviderNumbers] Sample number object: ${JSON.stringify(numbers[0]).substring(0, 500)}`);
        }

        for (const num of numbers) {
          const phoneNumber = num.phoneNumber || num.phone_number || num.number || num.e164 || num.phone;
          if (!phoneNumber) {
            this.logger.warn(`[syncProviderNumbers] Skipping number with no recognized phone field: ${JSON.stringify(num).substring(0, 200)}`);
            continue;
          }

          const friendlyName = num.friendlyName || num.friendly_name || num.name || num.label || null;

          // Upsert: create if new, skip if already exists (don't overwrite assignment)
          const existing = await this.prisma.phonePool.findUnique({
            where: { phoneNumber },
          });

          if (!existing) {
            await this.prisma.phonePool.create({
              data: {
                phoneNumber,
                provider,
                areaCode: this.extractAreaCode(phoneNumber),
                friendlyName,
                status: 'AVAILABLE',
              },
            });
            providerResult.synced++;
          } else if (existing.status === 'RELEASED') {
            // Re-activate released numbers
            await this.prisma.phonePool.update({
              where: { id: existing.id },
              data: { status: 'AVAILABLE', friendlyName, releasedAt: null },
            });
            providerResult.synced++;
          }
          // If AVAILABLE or ASSIGNED, keep as-is (don't disturb assignments)
        }
      } catch (err: any) {
        const msg = err.message || 'Unknown error';
        this.logger.warn(`[syncProviderNumbers] Failed to fetch ${provider} numbers: ${msg}`);
        providerResult.errors.push(msg);
      }

      results.push(providerResult);
    }

    const totalSynced = results.reduce((sum, r) => sum + r.synced, 0);

    await this.adminService.logAdminAction(adminId, 'SYNC_POOL_NUMBERS', null, {
      results,
      totalSynced,
    });

    this.logger.log(`Synced ${totalSynced} phone number(s) to pool`);
    return results;
  }

  /**
   * Assign a pool phone to a user
   */
  async assignToUser(adminId: string, phonePoolId: string, userId: string) {
    const phone = await this.prisma.phonePool.findUnique({ where: { id: phonePoolId } });
    if (!phone) throw new NotFoundException('Pool phone not found');
    if (phone.status !== 'AVAILABLE') {
      throw new BadRequestException(`Phone is ${phone.status}, not AVAILABLE`);
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const updated = await this.prisma.phonePool.update({
      where: { id: phonePoolId },
      data: {
        status: 'ASSIGNED',
        assignedToUserId: userId,
        assignedAt: new Date(),
      },
      include: {
        assignedToUser: { select: { id: true, email: true, name: true } },
      },
    });

    await this.adminService.logAdminAction(adminId, 'ASSIGN_POOL_PHONE', userId, {
      phoneNumber: phone.phoneNumber,
      phonePoolId,
    });

    this.logger.log(`Assigned pool phone ${phone.phoneNumber} to user ${user.email}`);
    return updated;
  }

  /**
   * Unassign a pool phone from a user
   */
  async unassignFromUser(adminId: string, phonePoolId: string) {
    const phone = await this.prisma.phonePool.findUnique({ where: { id: phonePoolId } });
    if (!phone) throw new NotFoundException('Pool phone not found');
    if (phone.status !== 'ASSIGNED') {
      throw new BadRequestException(`Phone is ${phone.status}, not ASSIGNED`);
    }

    const updated = await this.prisma.phonePool.update({
      where: { id: phonePoolId },
      data: {
        status: 'AVAILABLE',
        assignedToUserId: null,
        assignedAt: null,
      },
    });

    await this.adminService.logAdminAction(adminId, 'UNASSIGN_POOL_PHONE', phone.assignedToUserId, {
      phoneNumber: phone.phoneNumber,
      phonePoolId,
    });

    this.logger.log(`Unassigned pool phone ${phone.phoneNumber}`);
    return updated;
  }

  /**
   * Remove a phone from the pool
   */
  async removeFromPool(adminId: string, phonePoolId: string) {
    const phone = await this.prisma.phonePool.findUnique({ where: { id: phonePoolId } });
    if (!phone) throw new NotFoundException('Pool phone not found');

    await this.prisma.phonePool.update({
      where: { id: phonePoolId },
      data: {
        status: 'RELEASED',
        assignedToUserId: null,
        assignedAt: null,
        releasedAt: new Date(),
      },
    });

    await this.adminService.logAdminAction(adminId, 'REMOVE_POOL_PHONE', null, {
      phoneNumber: phone.phoneNumber,
      phonePoolId,
    });

    this.logger.log(`Removed pool phone ${phone.phoneNumber}`);
  }

  /**
   * Auto-assign a phone from the pool to a user (round-robin with area code preference)
   */
  async autoAssign(userId: string, preferredAreaCode?: string): Promise<any | null> {
    let phone = null;
    if (preferredAreaCode) {
      phone = await this.prisma.phonePool.findFirst({
        where: { status: 'AVAILABLE', areaCode: preferredAreaCode },
        orderBy: { provisionedAt: 'asc' },
      });
    }

    if (!phone) {
      phone = await this.prisma.phonePool.findFirst({
        where: { status: 'AVAILABLE' },
        orderBy: { provisionedAt: 'asc' },
      });
    }

    if (!phone) {
      this.logger.log(`No available pool phones for user ${userId}`);
      return null;
    }

    const assigned = await this.prisma.phonePool.update({
      where: { id: phone.id },
      data: {
        status: 'ASSIGNED',
        assignedToUserId: userId,
        assignedAt: new Date(),
      },
    });

    this.logger.log(`Auto-assigned pool phone ${assigned.phoneNumber} to user ${userId}`);
    return assigned;
  }

  /**
   * List users for assignment dropdown
   */
  async listUsersForAssignment(search?: string) {
    const where: any = {};
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }

    return this.prisma.user.findMany({
      where,
      select: { id: true, email: true, name: true },
      take: 20,
      orderBy: { email: 'asc' },
    });
  }

  /**
   * Extract area code from E.164 phone number
   */
  private extractAreaCode(phoneNumber: string): string | null {
    const match = phoneNumber.replace(/\D/g, '').match(/^1?(\d{3})/);
    return match ? match[1] : null;
  }
}
