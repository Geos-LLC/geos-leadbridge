import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { SigcoreService, SigcoreSearchResult } from '../sigcore/sigcore.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StripeService } from '../stripe/stripe.service';
import { CacheService } from '../common/cache/cache.service';
import { CacheKeys } from '../common/cache/cache-keys';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private prisma: PrismaService,
    private sigcoreService: SigcoreService,
    private notificationsService: NotificationsService,
    private stripeService: StripeService,
    private cache: CacheService,
  ) {}

  async updateProfile(userId: string, updates: { name?: string; businessPhone?: string; website?: string | null }) {
    const data: Record<string, any> = {};
    if (updates.name !== undefined) data.name = updates.name;
    if (updates.businessPhone !== undefined) {
      const digits = updates.businessPhone.replace(/\D/g, '');
      if (digits.length === 10) data.businessPhone = `+1${digits}`;
      else if (digits.length === 11 && digits.startsWith('1')) data.businessPhone = `+${digits}`;
      else if (digits.length > 10) data.businessPhone = `+${digits}`;
      else data.businessPhone = updates.businessPhone || null;
    }
    if (updates.website !== undefined) {
      // Free-text, just trim — onboarding wizard accepts "myco.com",
      // "https://myco.com", etc. Empty string normalizes to null so the
      // "I don't have a website" skip path clears the field rather than
      // storing whitespace.
      const trimmed = (updates.website ?? '').trim();
      data.website = trimmed.length === 0 ? null : trimmed;
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      select: { id: true, name: true, email: true, businessPhone: true, website: true },
      data,
    });

    // Sync businessPhone to all existing agent phone fields
    if (data.businessPhone) {
      await this.syncBusinessPhoneToAccounts(userId, data.businessPhone);
    }

    // Invalidate cached /auth/me AFTER the DB write commits so readers cannot
    // repopulate the cache from pre-commit state.
    await this.cache.del(CacheKeys.me(userId));

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
   * Get all phone options for the user — dedicated numbers only
   */
  async getAllPhoneOptions(userId: string) {
    const dedicated = await this.prisma.tenantPhoneNumber.findMany({
      where: { userId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    return {
      success: true,
      dedicated: dedicated.map(d => ({
        id: d.id,
        phoneNumber: d.phoneNumber,
        friendlyName: d.friendlyName,
        provider: 'twilio',
        type: 'dedicated' as const,
      })),
    };
  }

  /**
   * Get the user's global AI prompt (returns default if not set)
   */
  async getGlobalAiPrompt(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { globalAiPrompt: true },
    });
    const { TemplatesService } = require('../templates/templates.service');
    return {
      prompt: user?.globalAiPrompt || TemplatesService.DEFAULT_GLOBAL_AI_PROMPT,
      isDefault: !user?.globalAiPrompt,
    };
  }

  /**
   * Update the user's global AI prompt
   */
  async updateGlobalAiPrompt(userId: string, prompt: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { globalAiPrompt: prompt || null },
    });
    return { success: true };
  }

  // ──────────────────────────────────────────────────────────────────────
  // Business Hours (master, in Settings → General)
  // Per-card behavior toggles live on SavedAccount (see getAccountHoursSettings).
  // ──────────────────────────────────────────────────────────────────────

  async getBusinessHours(userId: string) {
    const { BusinessHoursService, DEFAULT_BUSINESS_SCHEDULE } = await import('../common/utils/business-hours.service');
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        businessHoursTimezone: true,
        businessHoursDays: true, // now holds per-day schedule JSON
      },
    });
    const schedule = user?.businessHoursDays
      ? BusinessHoursService.normalizeSchedule(user.businessHoursDays)
      : DEFAULT_BUSINESS_SCHEDULE;
    return {
      timezone: user?.businessHoursTimezone ?? 'America/New_York',
      schedule,
    };
  }

  async getQuietHours(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        quietHoursEnabled: true,
        quietHoursStart: true,
        quietHoursEnd: true,
        quietHoursTimezone: true,
      },
    });
    return {
      enabled: user?.quietHoursEnabled ?? false,
      start: user?.quietHoursStart ?? '22:00',
      end: user?.quietHoursEnd ?? '08:00',
      timezone: user?.quietHoursTimezone ?? 'America/New_York',
    };
  }

  async updateQuietHours(
    userId: string,
    dto: { enabled?: boolean; start?: string; end?: string; timezone?: string },
  ) {
    const data: Record<string, any> = {};
    if (dto.enabled !== undefined) data.quietHoursEnabled = !!dto.enabled;
    if (dto.start !== undefined) data.quietHoursStart = dto.start || null;
    if (dto.end !== undefined) data.quietHoursEnd = dto.end || null;
    // Dual-write: canonical `User.timezone` + legacy `quietHoursTimezone`.
    // The legacy column is read-fallback-only after the canonical-timezone
    // migration; keeping the write keeps both columns in sync for one
    // deploy cycle so a rollback doesn't strand data. Drop the legacy
    // assignment in the same PR that drops the column.
    if (dto.timezone !== undefined) {
      data.quietHoursTimezone = dto.timezone || null;
      data.timezone = dto.timezone || null;
    }
    await this.prisma.user.update({ where: { id: userId }, data });
    return this.getQuietHours(userId);
  }

  async updateBusinessHours(
    userId: string,
    dto: { timezone?: string; schedule?: Record<string, { start: string; end: string } | null> },
  ) {
    const { BusinessHoursService } = await import('../common/utils/business-hours.service');
    const data: Record<string, any> = {};
    // Dual-write: canonical `User.timezone` + legacy `businessHoursTimezone`.
    // (See updateQuietHours for the rationale.)
    if (dto.timezone !== undefined) {
      data.businessHoursTimezone = dto.timezone || null;
      data.timezone = dto.timezone || null;
    }
    if (dto.schedule !== undefined) {
      data.businessHoursDays = BusinessHoursService.normalizeSchedule(dto.schedule);
    }
    // Set enabled=true defensively — the flag is no longer read but stays true
    // so legacy clients/queries still see the master as on.
    data.businessHoursEnabled = true;
    await this.prisma.user.update({ where: { id: userId }, data });
    return this.getBusinessHours(userId);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Per-account behavior toggles + optional override window
  // ──────────────────────────────────────────────────────────────────────

  async getAccountHoursSettings(userId: string, savedAccountId: string) {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
      select: {
        id: true,
        businessHoursOverride: true,
        callDuringBusinessHours: true,
        firstMsgDuringBusinessHours: true,
        followUpsApplyQuietHours: true,
        aiConversationMode: true,
      },
    });
    if (!account) throw new NotFoundException('Account not found');
    return {
      override: (account.businessHoursOverride as any) ?? null,
      callDuringBusinessHours: account.callDuringBusinessHours,
      firstMsgDuringBusinessHours: account.firstMsgDuringBusinessHours,
      followUpsApplyQuietHours: account.followUpsApplyQuietHours,
      aiConversationMode: account.aiConversationMode ?? 'when_dispatcher_unavailable',
    };
  }

  async updateAccountHoursSettings(
    userId: string,
    savedAccountId: string,
    dto: {
      override?: { start?: string; end?: string; timezone?: string; days?: string[] } | null;
      callDuringBusinessHours?: boolean;
      firstMsgDuringBusinessHours?: boolean;
      followUpsApplyQuietHours?: boolean;
      aiConversationMode?: 'always' | 'when_dispatcher_unavailable' | 'business_hours_only';
    },
  ) {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('Account not found');

    const data: Record<string, any> = {};
    if (dto.override !== undefined) data.businessHoursOverride = dto.override;
    if (dto.callDuringBusinessHours !== undefined) data.callDuringBusinessHours = !!dto.callDuringBusinessHours;
    if (dto.firstMsgDuringBusinessHours !== undefined) data.firstMsgDuringBusinessHours = !!dto.firstMsgDuringBusinessHours;
    if (dto.followUpsApplyQuietHours !== undefined) data.followUpsApplyQuietHours = !!dto.followUpsApplyQuietHours;
    if (dto.aiConversationMode !== undefined) {
      const valid = ['always', 'when_dispatcher_unavailable', 'business_hours_only'];
      if (!valid.includes(dto.aiConversationMode)) {
        throw new NotFoundException(`Invalid aiConversationMode: ${dto.aiConversationMode}`);
      }
      data.aiConversationMode = dto.aiConversationMode;
    }
    await this.prisma.savedAccount.update({ where: { id: savedAccountId }, data });
    return this.getAccountHoursSettings(userId, savedAccountId);
  }

  /**
   * Resolve pricing for an account, falling back to any sibling account with pricing
   * when the account itself has none. Used by both the UI preview and AI execution
   * so pricing set on one account is effectively shared until the user configures
   * per-account overrides.
   */
  async resolveServicePricing(userId: string, accountId: string): Promise<{ pricing: any; sourceAccountId: string | null }> {
    const own = await this.prisma.savedAccount.findFirst({
      where: { id: accountId, userId },
      select: { servicePricingJson: true },
    });
    if (own?.servicePricingJson) {
      try { return { pricing: JSON.parse(own.servicePricingJson), sourceAccountId: accountId }; } catch { /* fall through */ }
    }
    const sibling = await this.prisma.savedAccount.findFirst({
      where: { userId, servicePricingJson: { not: null }, id: { not: accountId } },
      select: { id: true, servicePricingJson: true },
      orderBy: { createdAt: 'asc' },
    });
    if (sibling?.servicePricingJson) {
      try { return { pricing: JSON.parse(sibling.servicePricingJson), sourceAccountId: sibling.id }; } catch { /* ignore */ }
    }
    return { pricing: null, sourceAccountId: null };
  }

  /**
   * Get service pricing config for a saved account (with sibling fallback).
   * `inherited` is true when the returned pricing was borrowed from a sibling account.
   */
  async getServicePricing(userId: string, accountId: string) {
    // Verify the account belongs to the user before resolving
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: accountId, userId },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('Account not found');
    const { pricing, sourceAccountId } = await this.resolveServicePricing(userId, accountId);
    return {
      success: true,
      pricing,
      inherited: sourceAccountId !== null && sourceAccountId !== accountId,
      sourceAccountId,
    };
  }

  /**
   * Save service pricing config for a saved account
   */
  async updateServicePricing(userId: string, accountId: string, pricing: any) {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: accountId, userId },
    });
    if (!account) throw new NotFoundException('Account not found');
    await this.prisma.savedAccount.update({
      where: { id: accountId },
      data: { servicePricingJson: JSON.stringify(pricing) },
    });
    await this.cache.delPattern(CacheKeys.savedAccountsPattern(userId));
    return { success: true };
  }

  /**
   * Copy an account's pricing to every other account owned by the same user.
   */
  async copyServicePricingToAll(userId: string, sourceAccountId: string) {
    const source = await this.prisma.savedAccount.findFirst({
      where: { id: sourceAccountId, userId },
      select: { servicePricingJson: true },
    });
    if (!source) throw new NotFoundException('Source account not found');
    if (!source.servicePricingJson) throw new NotFoundException('Source account has no pricing to copy');
    const result = await this.prisma.savedAccount.updateMany({
      where: { userId, id: { not: sourceAccountId } },
      data: { servicePricingJson: source.servicePricingJson },
    });
    await this.cache.delPattern(CacheKeys.savedAccountsPattern(userId));
    return { success: true, updated: result.count };
  }

  /**
   * Get the per-account FAQ JSON. Falls back to a sibling account's FAQ when
   * this account hasn't been configured yet, so a multi-account user only
   * has to fill it in once.
   */
  async getAccountFaq(userId: string, accountId: string) {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: accountId, userId },
      select: { id: true, faqJson: true },
    });
    if (!account) throw new NotFoundException('Account not found');

    let faq: any = null;
    let inherited = false;
    let sourceAccountId: string | null = null;

    if (account.faqJson) {
      try { faq = JSON.parse(account.faqJson); sourceAccountId = accountId; }
      catch { faq = null; }
    }

    if (!faq) {
      const sibling = await this.prisma.savedAccount.findFirst({
        where: { userId, id: { not: accountId }, faqJson: { not: null } },
        select: { id: true, faqJson: true },
        orderBy: { createdAt: 'asc' },
      });
      if (sibling?.faqJson) {
        try { faq = JSON.parse(sibling.faqJson); inherited = true; sourceAccountId = sibling.id; }
        catch { faq = null; }
      }
    }

    return { success: true, faq, inherited, sourceAccountId };
  }

  /**
   * Save the per-account FAQ JSON.
   */
  async updateAccountFaq(userId: string, accountId: string, faq: any) {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: accountId, userId },
    });
    if (!account) throw new NotFoundException('Account not found');
    await this.prisma.savedAccount.update({
      where: { id: accountId },
      data: { faqJson: faq == null ? null : JSON.stringify(faq) },
    });
    await this.cache.delPattern(CacheKeys.savedAccountsPattern(userId));
    return { success: true };
  }

  /**
   * Copy an account's FAQ to every other account owned by the same user.
   */
  async copyAccountFaqToAll(userId: string, sourceAccountId: string) {
    const source = await this.prisma.savedAccount.findFirst({
      where: { id: sourceAccountId, userId },
      select: { faqJson: true },
    });
    if (!source) throw new NotFoundException('Source account not found');
    if (!source.faqJson) throw new NotFoundException('Source account has no FAQ to copy');
    const result = await this.prisma.savedAccount.updateMany({
      where: { userId, id: { not: sourceAccountId } },
      data: { faqJson: source.faqJson },
    });
    await this.cache.delPattern(CacheKeys.savedAccountsPattern(userId));
    return { success: true, updated: result.count };
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

    // SECURITY: invalidate the JwtStrategy auth cache so the still-valid JWT
    // can't be used to make authed requests up to the TTL after self-delete.
    await this.cache.del(CacheKeys.authUser(userId));

    this.logger.log(`[deleteOwnAccount] User ${user.email} deleted their account`);
    return { success: true };
  }
}
