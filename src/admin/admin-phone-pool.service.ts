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

    const availableByAreaCode = await this.prisma.phonePool.groupBy({
      by: ['areaCode'],
      where: { status: 'AVAILABLE' },
      _count: { id: true },
    });

    const availableMap = new Map(
      availableByAreaCode.map((a) => [a.areaCode, a._count.id]),
    );

    return {
      total,
      available,
      assigned,
      reserved,
      byAreaCode: byAreaCode.map((a) => ({
        areaCode: a.areaCode || 'unknown',
        total: a._count.id,
        available: availableMap.get(a.areaCode) || 0,
      })),
    };
  }

  /**
   * Search available phone numbers from Sigcore
   */
  async searchAvailableNumbers(country: string = 'US', areaCode?: string, limit: number = 10) {
    return this.sigcoreService.searchAvailableNumbers(country, areaCode, limit);
  }

  /**
   * Provision phone number(s) into the pool
   */
  async provisionToPool(
    adminId: string,
    params: { areaCode?: string; specificPhoneNumber?: string; count?: number },
  ) {
    const count = params.count || 1;
    const results: any[] = [];

    for (let i = 0; i < count; i++) {
      const result = await this.sigcoreService.provisionNumber(
        params.areaCode,
        i === 0 ? params.specificPhoneNumber : undefined,
        params.areaCode ? `Pool ${params.areaCode}` : 'Pool Number',
        true,
      );

      if (!result) continue;

      // Extract area code from phone number (e.g. +18135551234 -> 813)
      const extractedAreaCode = this.extractAreaCode(result.phoneNumber);

      const poolEntry = await this.prisma.phonePool.create({
        data: {
          phoneNumber: result.phoneNumber,
          provider: 'twilio',
          areaCode: extractedAreaCode,
          sigcoreAllocationId: result.allocationId,
          status: 'AVAILABLE',
        },
      });

      results.push(poolEntry);
    }

    await this.adminService.logAdminAction(adminId, 'PROVISION_POOL_PHONE', null, {
      count: results.length,
      areaCode: params.areaCode,
      phones: results.map((r) => r.phoneNumber),
    });

    this.logger.log(`Provisioned ${results.length} phone(s) to pool`);
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
   * Release a phone from the pool (returns it to Sigcore)
   */
  async releaseFromPool(adminId: string, phonePoolId: string) {
    const phone = await this.prisma.phonePool.findUnique({ where: { id: phonePoolId } });
    if (!phone) throw new NotFoundException('Pool phone not found');

    // Release via Sigcore if we have an allocation ID
    if (phone.sigcoreAllocationId) {
      try {
        await this.sigcoreService.releaseNumber(phone.sigcoreAllocationId);
      } catch (error) {
        this.logger.error(`Failed to release via Sigcore: ${error.message}`);
      }
    }

    await this.prisma.phonePool.update({
      where: { id: phonePoolId },
      data: {
        status: 'RELEASED',
        assignedToUserId: null,
        assignedAt: null,
        releasedAt: new Date(),
      },
    });

    await this.adminService.logAdminAction(adminId, 'RELEASE_POOL_PHONE', null, {
      phoneNumber: phone.phoneNumber,
      phonePoolId,
    });

    this.logger.log(`Released pool phone ${phone.phoneNumber}`);
  }

  /**
   * Auto-assign a phone from the pool to a user
   * Round-robin with area code preference
   */
  async autoAssign(userId: string, preferredAreaCode?: string): Promise<any | null> {
    // Try matching area code first
    let phone = null;
    if (preferredAreaCode) {
      phone = await this.prisma.phonePool.findFirst({
        where: { status: 'AVAILABLE', areaCode: preferredAreaCode },
        orderBy: { provisionedAt: 'asc' },
      });
    }

    // Fall back to any available phone
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
   * Extract area code from E.164 phone number
   */
  private extractAreaCode(phoneNumber: string): string | null {
    // +1XXXNNNNNNN -> XXX
    const match = phoneNumber.replace(/\D/g, '').match(/^1?(\d{3})/);
    return match ? match[1] : null;
  }
}
