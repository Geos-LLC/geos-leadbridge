import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
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
    private configService: ConfigService,
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
        { assignments: { some: { user: { email: { contains: search, mode: 'insensitive' } } } } },
      ];
    }

    const [phones, total] = await Promise.all([
      this.prisma.phonePool.findMany({
        where,
        include: {
          assignments: {
            include: { user: { select: { id: true, email: true, name: true } } },
            orderBy: { assignedAt: 'desc' },
          },
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
    const [total, available, reserved, assignmentCount] = await Promise.all([
      this.prisma.phonePool.count({ where: { status: { not: 'RELEASED' } } }),
      this.prisma.phonePool.count({ where: { status: 'AVAILABLE' } }),
      this.prisma.phonePool.count({ where: { status: 'RESERVED' } }),
      // Count phones that have at least one assignment
      this.prisma.phonePool.count({ where: { status: { not: 'RELEASED' }, assignments: { some: {} } } }),
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
      assigned: assignmentCount,
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
   * Check Twilio connection health by fetching numbers from Sigcore
   */
  async checkTwilioHealth(): Promise<{
    status: 'connected' | 'disconnected' | 'error';
    phoneCount: number;
    message: string;
    checkedAt: string;
  }> {
    const checkedAt = new Date().toISOString();

    if (!this.sigcoreService.isConfigured()) {
      return { status: 'disconnected', phoneCount: 0, message: 'SIGCORE_API_KEY not configured', checkedAt };
    }

    try {
      const numbers = await this.sigcoreService.adminFetchTwilioNumbers();
      return {
        status: 'connected',
        phoneCount: numbers.length,
        message: `Twilio connected with ${numbers.length} phone number(s)`,
        checkedAt,
      };
    } catch (error: any) {
      const httpStatus = error.response?.status || error.status;
      const errorMsg = error.response?.data?.message || error.message || 'Unknown error';
      const lowerMsg = errorMsg.toLowerCase();

      // Sigcore returns 404 when Twilio isn't connected, but adminFetchTwilioNumbers
      // wraps it into a BadRequestException — so also check the error message text
      if (httpStatus === 404 || lowerMsg.includes('not found') || lowerMsg.includes('not connected')) {
        return { status: 'disconnected', phoneCount: 0, message: 'Twilio integration not connected in Sigcore', checkedAt };
      }
      if (httpStatus === 401) {
        return { status: 'error', phoneCount: 0, message: 'Sigcore API key invalid or expired', checkedAt };
      }
      return { status: 'error', phoneCount: 0, message: `Connection check failed: ${errorMsg}`, checkedAt };
    }
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

      // Auto-setup delivery webhook
      const webhookResult = await this.setupDeliveryWebhook(adminId);
      if (webhookResult.success) {
        this.logger.log(`Auto-created delivery webhook: ${webhookResult.webhookId}`);
      } else {
        this.logger.warn(`Failed to auto-create delivery webhook: ${webhookResult.error}`);
      }
    }

    return result;
  }

  /**
   * Disconnect admin's provider account via Sigcore
   */
  async disconnectProvider(adminId: string, provider: 'openphone' | 'twilio') {
    const result = await this.sigcoreService.adminDisconnectProvider(provider);

    if (result.success) {
      // Delete all assignments for phones from this provider
      const phonesToRelease = await this.prisma.phonePool.findMany({
        where: { provider, status: { not: 'RELEASED' } },
        select: { id: true },
      });
      if (phonesToRelease.length > 0) {
        await this.prisma.phonePoolAssignment.deleteMany({
          where: { phonePoolId: { in: phonesToRelease.map(p => p.id) } },
        });
      }
      // Mark pool phones from this provider as RELEASED
      await this.prisma.phonePool.updateMany({
        where: { provider, status: { not: 'RELEASED' } },
        data: { status: 'RELEASED', releasedAt: new Date() },
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

    // Only sync Twilio numbers into the shared pool.
    // OpenPhone numbers belong to tenants and route through OpenPhone's infrastructure,
    // so they should NOT be in the admin shared pool.
    for (const provider of ['twilio'] as const) {
      const providerResult = { provider, synced: 0, errors: [] as string[] };

      try {
        const numbers = await this.sigcoreService.adminFetchTwilioNumbers();

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
   * Toggle SMS Approved (A2P 10DLC) status for a pool phone
   */
  async updateSmsApproved(phonePoolId: string, smsApproved: boolean) {
    const phone = await this.prisma.phonePool.findUnique({ where: { id: phonePoolId } });
    if (!phone) throw new NotFoundException('Pool phone not found');

    return this.prisma.phonePool.update({
      where: { id: phonePoolId },
      data: { smsApproved },
    });
  }

  /**
   * Assign a pool phone to a user (many-to-many: same phone can be assigned to multiple users)
   */
  async assignToUser(adminId: string, phonePoolId: string, userId: string) {
    const phone = await this.prisma.phonePool.findUnique({ where: { id: phonePoolId } });
    if (!phone) throw new NotFoundException('Pool phone not found');
    if (phone.status === 'RELEASED') {
      throw new BadRequestException('Phone has been released from pool');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    // Check if already assigned to this user
    const existing = await this.prisma.phonePoolAssignment.findUnique({
      where: { phonePoolId_userId: { phonePoolId, userId } },
    });
    if (existing) {
      throw new BadRequestException('Phone is already assigned to this user');
    }

    // Create assignment (phone stays AVAILABLE for other assignments)
    await this.prisma.phonePoolAssignment.create({
      data: { phonePoolId, userId },
    });

    // Return the phone with all assignments
    const updated = await this.prisma.phonePool.findUnique({
      where: { id: phonePoolId },
      include: {
        assignments: {
          include: { user: { select: { id: true, email: true, name: true } } },
          orderBy: { assignedAt: 'desc' },
        },
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
   * Assign a pool phone to ALL users at once
   */
  async assignToAllUsers(adminId: string, phonePoolId: string) {
    const phone = await this.prisma.phonePool.findUnique({ where: { id: phonePoolId } });
    if (!phone) throw new NotFoundException('Pool phone not found');
    if (phone.status === 'RELEASED') {
      throw new BadRequestException('Phone has been released from pool');
    }

    // Get all users
    const allUsers = await this.prisma.user.findMany({
      select: { id: true, email: true },
    });

    // Get existing assignments for this phone
    const existingAssignments = await this.prisma.phonePoolAssignment.findMany({
      where: { phonePoolId },
      select: { userId: true },
    });
    const assignedUserIds = new Set(existingAssignments.map(a => a.userId));

    // Create assignments for users that don't already have one
    const newAssignments = allUsers
      .filter(u => !assignedUserIds.has(u.id))
      .map(u => ({ phonePoolId, userId: u.id }));

    if (newAssignments.length > 0) {
      await this.prisma.phonePoolAssignment.createMany({ data: newAssignments });
    }

    // Return the phone with all assignments
    const updated = await this.prisma.phonePool.findUnique({
      where: { id: phonePoolId },
      include: {
        assignments: {
          include: { user: { select: { id: true, email: true, name: true } } },
          orderBy: { assignedAt: 'desc' },
        },
      },
    });

    await this.adminService.logAdminAction(adminId, 'ASSIGN_POOL_PHONE_ALL', null, {
      phoneNumber: phone.phoneNumber,
      phonePoolId,
      newAssignments: newAssignments.length,
      totalUsers: allUsers.length,
    });

    this.logger.log(`Assigned pool phone ${phone.phoneNumber} to all ${newAssignments.length} users`);
    return updated;
  }

  /**
   * Unassign a pool phone from a specific user
   */
  async unassignFromUser(adminId: string, phonePoolId: string, userId: string) {
    const phone = await this.prisma.phonePool.findUnique({ where: { id: phonePoolId } });
    if (!phone) throw new NotFoundException('Pool phone not found');

    const assignment = await this.prisma.phonePoolAssignment.findUnique({
      where: { phonePoolId_userId: { phonePoolId, userId } },
    });
    if (!assignment) {
      throw new BadRequestException('Phone is not assigned to this user');
    }

    await this.prisma.phonePoolAssignment.delete({
      where: { id: assignment.id },
    });

    await this.adminService.logAdminAction(adminId, 'UNASSIGN_POOL_PHONE', userId, {
      phoneNumber: phone.phoneNumber,
      phonePoolId,
    });

    this.logger.log(`Unassigned pool phone ${phone.phoneNumber} from user ${userId}`);
    return phone;
  }

  /**
   * Remove a phone from the pool
   */
  async removeFromPool(adminId: string, phonePoolId: string) {
    const phone = await this.prisma.phonePool.findUnique({ where: { id: phonePoolId } });
    if (!phone) throw new NotFoundException('Pool phone not found');

    // Delete all assignments first
    await this.prisma.phonePoolAssignment.deleteMany({
      where: { phonePoolId },
    });

    await this.prisma.phonePool.update({
      where: { id: phonePoolId },
      data: {
        status: 'RELEASED',
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
   * Phone stays AVAILABLE since it can be shared across tenants.
   */
  async autoAssign(userId: string, preferredAreaCode?: string): Promise<any | null> {
    // Find an available phone (prefer fewest assignments for round-robin)
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

    // Create assignment (phone stays AVAILABLE)
    await this.prisma.phonePoolAssignment.create({
      data: { phonePoolId: phone.id, userId },
    });

    this.logger.log(`Auto-assigned pool phone ${phone.phoneNumber} to user ${userId}`);
    return phone;
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
   * Register webhook subscription with Sigcore for delivery status notifications
   */
  async setupDeliveryWebhook(adminId: string): Promise<{ success: boolean; webhookId?: string; error?: string }> {
    const apiKey = this.configService.get<string>('SIGCORE_API_KEY');
    if (!apiKey) {
      return { success: false, error: 'SIGCORE_API_KEY not configured' };
    }

    const appUrl = this.configService.get<string>('FRONTEND_URL', '') || this.configService.get<string>('RAILWAY_PUBLIC_DOMAIN', '');
    if (!appUrl) {
      return { success: false, error: 'No public URL configured (FRONTEND_URL or RAILWAY_PUBLIC_DOMAIN)' };
    }

    // Build webhook URL - the handler is at /api/webhooks/sigcore/delivery-status
    const baseUrl = appUrl.startsWith('http') ? appUrl : `https://${appUrl}`;
    const webhookUrl = `${baseUrl}/api/webhooks/sigcore/delivery-status`;

    const sigcoreUrl = this.configService.get<string>('SIGCORE_API_URL', 'https://sigcore-production.up.railway.app/api');
    const endpoint = `${sigcoreUrl}/v1/webhook-subscriptions`;

    this.logger.log(`[setupDeliveryWebhook] Creating subscription at ${endpoint}`);
    this.logger.log(`[setupDeliveryWebhook] Webhook URL: ${webhookUrl}`);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'LeadBridge Delivery Notifications',
          webhookUrl,
          events: ['message.sent', 'message.delivered', 'message.failed'],
        }),
      });

      this.logger.log(`[setupDeliveryWebhook] Response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`[setupDeliveryWebhook] Failed: ${response.status} - ${errorText}`);
        return { success: false, error: `Sigcore API error: ${response.status} - ${errorText}` };
      }

      const result = await response.json();
      const webhookId = result.data?.id || result.id;

      this.logger.log(`[setupDeliveryWebhook] Created webhook: ${webhookId}`);
      await this.adminService.logAdminAction(adminId, 'SETUP_DELIVERY_WEBHOOK', null, { webhookId, webhookUrl });

      return { success: true, webhookId };
    } catch (error: any) {
      this.logger.error(`[setupDeliveryWebhook] Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Extract area code from E.164 phone number
   */
  private extractAreaCode(phoneNumber: string): string | null {
    const match = phoneNumber.replace(/\D/g, '').match(/^1?(\d{3})/);
    return match ? match[1] : null;
  }

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Global Admin Config (singleton row — id = 'global')
  // ---------------------------------------------------------------------------

  static readonly DEFAULT_TEST_DATA: Record<string, string> = {
    customerName:       'Test Customer',
    firstName:          'Test',
    accountName:        'Test Business',
    category:           'House Cleaning',
    city:               'Tampa',
    state:              'FL',
    location:           'Tampa, FL',
    zip:                '33601',
    message:            'Looking for reliable cleaning services',
    serviceDescription: 'Standard home cleaning',
    addons:             '',
    frequency:          'Weekly',
    bedrooms:           '3',
    bathrooms:          '2',
    price:              '$120',
    pets:               'None',
    estimate:           '$120',
    dates:              'Flexible',
  };

  async getAdminConfig(): Promise<{ id: string; testData: Record<string, string> }> {
    const config = await this.prisma.adminConfig.findUnique({ where: { id: 'global' } });
    const saved = (config?.testData as Record<string, string> | null) ?? {};
    // Merge: defaults → old individual columns → new testData JSON
    const testData: Record<string, string> = {
      ...AdminPhonePoolService.DEFAULT_TEST_DATA,
      ...(config?.testCustomerName ? { customerName: config.testCustomerName } : {}),
      ...(config?.testCategory     ? { category:      config.testCategory }     : {}),
      ...(config?.testLocation     ? { location:      config.testLocation }     : {}),
      ...saved,
    };
    return { id: 'global', testData };
  }

  async updateAdminConfig(testData: Record<string, string>) {
    return this.prisma.adminConfig.upsert({
      where: { id: 'global' },
      create: { id: 'global', testData },
      update: { testData },
    });
  }

  // ==========================================
  // Phone Number Pricing
  // ==========================================

  async getPhonePricing(): Promise<{
    priceMonthly: number | null;
    gracePeriodDays: number;
    stripePriceId: string | null;
  }> {
    const config = await this.prisma.adminConfig.findUnique({ where: { id: 'global' } });
    return {
      priceMonthly: config?.phonePriceMonthly ? Number(config.phonePriceMonthly) : null,
      gracePeriodDays: config?.phoneGracePeriodDays ?? 30,
      stripePriceId: config?.stripePriceId ?? null,
    };
  }

  async updatePhonePricing(priceMonthly: number, gracePeriodDays: number): Promise<{
    priceMonthly: number;
    gracePeriodDays: number;
    stripePriceId: string;
  }> {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY');
    if (!secretKey) throw new BadRequestException('STRIPE_SECRET_KEY not configured');

    const stripe = new Stripe(secretKey, { apiVersion: '2026-01-28.clover' });

    // Check if we already have a Stripe product for phone numbers
    const config = await this.prisma.adminConfig.findUnique({ where: { id: 'global' } });
    let stripePriceId = config?.stripePriceId;

    // Always create a new Price (Stripe prices are immutable — archive old one)
    // First, find or create the product
    const productName = 'Dedicated Phone Number';
    const products = await stripe.products.search({ query: `name:'${productName}' active:'true'` });
    let productId: string;

    if (products.data.length > 0) {
      productId = products.data[0].id;
    } else {
      const product = await stripe.products.create({
        name: productName,
        description: 'Dedicated Twilio phone number for SMS and voice',
      });
      productId = product.id;
    }

    // Archive old price if it exists
    if (stripePriceId) {
      try {
        await stripe.prices.update(stripePriceId, { active: false });
      } catch (e) {
        this.logger.warn(`Failed to archive old price ${stripePriceId}: ${e.message}`);
      }
    }

    // Create new recurring price
    const price = await stripe.prices.create({
      product: productId,
      unit_amount: Math.round(priceMonthly * 100), // Convert dollars to cents
      currency: 'usd',
      recurring: { interval: 'month' },
    });

    stripePriceId = price.id;

    // Save to AdminConfig
    await this.prisma.adminConfig.upsert({
      where: { id: 'global' },
      create: {
        id: 'global',
        phonePriceMonthly: priceMonthly,
        phoneGracePeriodDays: gracePeriodDays,
        stripePriceId,
      },
      update: {
        phonePriceMonthly: priceMonthly,
        phoneGracePeriodDays: gracePeriodDays,
        stripePriceId,
      },
    });

    this.logger.log(`[updatePhonePricing] Price: $${priceMonthly}/mo, Grace: ${gracePeriodDays}d, Stripe Price: ${stripePriceId}`);

    return { priceMonthly, gracePeriodDays, stripePriceId };
  }
}
