import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../common/utils/prisma.service';
import { SigcoreService } from '../sigcore/sigcore.service';
import { AdminService } from './admin.service';

@Injectable()
export class AdminPhonePoolService {
  private readonly logger = new Logger(AdminPhonePoolService.name);

  constructor(
    private prisma: PrismaService,
    private sigcoreService: SigcoreService,
    private adminService: AdminService,
    private configService: ConfigService,
  ) {}

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

      if (httpStatus === 404 || lowerMsg.includes('not found') || lowerMsg.includes('not connected')) {
        return { status: 'disconnected', phoneCount: 0, message: 'Twilio integration not connected in Sigcore', checkedAt };
      }
      if (httpStatus === 401) {
        return { status: 'error', phoneCount: 0, message: 'Sigcore API key invalid or expired', checkedAt };
      }
      return { status: 'error', phoneCount: 0, message: `Connection check failed: ${errorMsg}`, checkedAt };
    }
  }

  async reassignTenantPhone(adminId: string, tenantPhoneId: string, newUserId: string) {
    const tenantPhone = await this.prisma.tenantPhoneNumber.findUnique({ where: { id: tenantPhoneId } });
    if (!tenantPhone) throw new NotFoundException('Tenant phone not found');
    if (tenantPhone.status !== 'ACTIVE') throw new BadRequestException('Only active tenant numbers can be reassigned');

    const newUser = await this.prisma.user.findUnique({ where: { id: newUserId } });
    if (!newUser) throw new NotFoundException('User not found');

    const updated = await this.prisma.tenantPhoneNumber.update({
      where: { id: tenantPhoneId },
      data: { userId: newUserId },
      include: { user: { select: { id: true, email: true, name: true } } },
    });

    await this.adminService.logAdminAction(adminId, 'REASSIGN_TENANT_PHONE', newUserId, {
      phoneNumber: tenantPhone.phoneNumber,
      tenantPhoneId,
      previousUserId: tenantPhone.userId,
    });

    this.logger.log(`Reassigned tenant phone ${tenantPhone.phoneNumber} from user ${tenantPhone.userId} to ${newUser.email}`);

    const newSavedAccount = await this.prisma.savedAccount.findFirst({
      where: { userId: newUserId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (newSavedAccount?.id) {
      this.reallocateSigcorePhone(newSavedAccount.id, tenantPhone.phoneNumber).catch((err) =>
        this.logger.warn(`[reassignTenantPhone] Sigcore reallocate failed for ${tenantPhone.phoneNumber}: ${err.message}`),
      );
      this.refreshWebhooksForAccount(newSavedAccount.id, tenantPhone.phoneNumber).catch((err) =>
        this.logger.warn(`[reassignTenantPhone] Sigcore webhook refresh failed for ${tenantPhone.phoneNumber}: ${err.message}`),
      );
    } else {
      this.logger.warn(`[reassignTenantPhone] New user ${newUserId} has no savedAccount — Sigcore not updated for ${tenantPhone.phoneNumber}`);
    }

    return updated;
  }

  private async refreshWebhooksForAccount(savedAccountId: string, phoneNumber: string): Promise<void> {
    const ns = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      select: { sigcoreTenantId: true },
    });
    if (!ns?.sigcoreTenantId) {
      this.logger.warn(`[refreshWebhooks] No sigcoreTenantId for account ${savedAccountId} (${phoneNumber}) — skipping`);
      return;
    }

    const platformKey = this.configService.get<string>('SIGCORE_API_KEY');
    if (!platformKey) return;

    const rawUrl =
      this.configService.get<string>('SIGCORE_CALL_CONNECT_URL') ||
      this.configService.get<string>('SIGCORE_API_URL') ||
      'https://sigcore-production.up.railway.app/api';
    const sigcoreBase = rawUrl.replace(/\/api\/?$/, '');

    const resp = await fetch(`${sigcoreBase}/api/tenants/${ns.sigcoreTenantId}/phone-numbers/refresh-webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': platformKey },
      body: '{}',
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Sigcore refresh-webhooks failed (${resp.status}): ${text}`);
    }

    this.logger.log(`[refreshWebhooks] Updated Twilio webhooks for ${phoneNumber} (tenant ${ns.sigcoreTenantId})`);
  }

  private async reallocateSigcorePhone(savedAccountId: string, phoneNumber: string): Promise<void> {
    const ns = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      select: { sigcoreTenantId: true },
    });
    if (!ns?.sigcoreTenantId) {
      this.logger.warn(`[reallocateSigcorePhone] No sigcoreTenantId for account ${savedAccountId} (${phoneNumber}) — skipping`);
      return;
    }

    const platformKey = this.configService.get<string>('SIGCORE_API_KEY');
    if (!platformKey) return;

    const rawUrl =
      this.configService.get<string>('SIGCORE_CALL_CONNECT_URL') ||
      this.configService.get<string>('SIGCORE_API_URL') ||
      'https://sigcore-production.up.railway.app/api';
    const sigcoreBase = rawUrl.replace(/\/api\/?$/, '');

    const resp = await fetch(
      `${sigcoreBase}/api/tenants/phone-numbers/${encodeURIComponent(phoneNumber)}/reallocate`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-api-key': platformKey },
        body: JSON.stringify({ tenantId: ns.sigcoreTenantId }),
      },
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Sigcore reallocate failed (${resp.status}): ${text}`);
    }

    this.logger.log(`[reallocateSigcorePhone] ${phoneNumber} re-homed to tenant ${ns.sigcoreTenantId}`);
  }

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

  async getAdminConfig(): Promise<{ id: string; testData: Record<string, string>; yelpTestData: Record<string, string> }> {
    const config = await this.prisma.adminConfig.findUnique({ where: { id: 'global' } });
    const saved = (config?.testData as Record<string, string> | null) ?? {};
    const testData: Record<string, string> = {
      ...AdminPhonePoolService.DEFAULT_TEST_DATA,
      ...(config?.testCustomerName ? { customerName: config.testCustomerName } : {}),
      ...(config?.testCategory     ? { category:      config.testCategory }     : {}),
      ...(config?.testLocation     ? { location:      config.testLocation }     : {}),
      ...saved,
    };
    const yelpTestData = ((config as any)?.yelpTestData as Record<string, string> | null) ?? {};
    return { id: 'global', testData, yelpTestData };
  }

  async updateAdminConfig(testData: Record<string, string>, yelpTestData?: Record<string, string>) {
    return this.prisma.adminConfig.upsert({
      where: { id: 'global' },
      create: { id: 'global', testData, ...(yelpTestData && { yelpTestData }) },
      update: { testData, ...(yelpTestData && { yelpTestData }) },
    });
  }

  async getPhonePricing(): Promise<{
    priceMonthly: number | null;
    gracePeriodDays: number;
    stripePriceId: string | null;
    messagingServiceSid: string | null;
  }> {
    const config = await this.prisma.adminConfig.findUnique({ where: { id: 'global' } });
    return {
      priceMonthly: config?.phonePriceMonthly ? Number(config.phonePriceMonthly) : null,
      gracePeriodDays: config?.phoneGracePeriodDays ?? 30,
      stripePriceId: config?.stripePriceId ?? null,
      messagingServiceSid: config?.messagingServiceSid ?? null,
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

    const config = await this.prisma.adminConfig.findUnique({ where: { id: 'global' } });
    let stripePriceId = config?.stripePriceId;

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

    if (stripePriceId) {
      try {
        await stripe.prices.update(stripePriceId, { active: false });
      } catch (e) {
        this.logger.warn(`Failed to archive old price ${stripePriceId}: ${e.message}`);
      }
    }

    const price = await stripe.prices.create({
      product: productId,
      unit_amount: Math.round(priceMonthly * 100),
      currency: 'usd',
      recurring: { interval: 'month' },
    });

    stripePriceId = price.id;

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

  /**
   * Save Messaging Service SID locally and sync to Sigcore pricing config
   */
  async updateMessagingServiceSid(messagingServiceSid: string): Promise<{ messagingServiceSid: string; synced: boolean }> {
    await this.prisma.adminConfig.upsert({
      where: { id: 'global' },
      create: { id: 'global', messagingServiceSid },
      update: { messagingServiceSid },
    });

    let synced = false;
    const platformKey = this.configService.get<string>('SIGCORE_API_KEY');
    const sigcoreUrl = this.configService.get<string>('SIGCORE_API_URL', 'https://sigcore-production.up.railway.app/api');

    if (platformKey) {
      try {
        const resp = await fetch(`${sigcoreUrl}/v1/tenants/phone-numbers/pricing`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': platformKey,
          },
          body: JSON.stringify({ messagingServiceSid }),
        });
        synced = resp.ok;
        if (!synced) {
          this.logger.warn(`[updateMessagingServiceSid] Sigcore sync failed: ${resp.status} ${await resp.text()}`);
        } else {
          this.logger.log(`[updateMessagingServiceSid] Synced to Sigcore: ${messagingServiceSid}`);
        }
      } catch (err) {
        this.logger.error(`[updateMessagingServiceSid] Sigcore sync error: ${err.message}`);
      }
    } else {
      this.logger.warn('[updateMessagingServiceSid] SIGCORE_API_KEY not configured, skipped sync');
    }

    return { messagingServiceSid, synced };
  }
}
