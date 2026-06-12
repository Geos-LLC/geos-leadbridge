import { Injectable, NotFoundException, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import OpenAI from 'openai';
import { PrismaService } from '../common/utils/prisma.service';
import { SigcoreService, SigcoreSearchResult } from '../sigcore/sigcore.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StripeService } from '../stripe/stripe.service';
import { CacheService } from '../common/cache/cache.service';
import { CacheKeys } from '../common/cache/cache-keys';
import { PlatformService } from '../platforms/platform.service';
import type { SupportedPlaybookSectionKey } from './playbook-seed-applier';

/**
 * Structured facts extracted from the homepage, organized by the 8 Playbook
 * V2 section keys so a later auto-fill pass can drop fields straight into
 * `aiPlaybookV2.{section}.customInstructions` without re-parsing prose.
 *
 * Every field is optional — only what the model finds on the page is
 * populated. Empty objects ("nothing extracted for this section") are
 * dropped before storage to keep the JSON column lean.
 */
export interface PlaybookSeed {
  businessInformation?: {
    serviceArea?: string;
    teamSize?: string;
    yearsInBusiness?: string;
    ownerName?: string;
    suppliesPolicy?: string;
    petsPolicy?: string;
    paymentMethods?: string[];
    officeLocations?: string[];
    insurance?: string;
    bonding?: string;
    licensing?: string;
    guarantees?: string;
    ecoFriendly?: string;
  };
  pricingGuidance?: {
    pricingModel?: string;
    startingPrices?: Array<{ service: string; price: string }>;
    whatsIncluded?: string;
    discounts?: string;
  };
  bookingGuidance?: {
    bookingChannels?: string[];
    leadTime?: string;
    schedulingNotes?: string;
  };
  objectionHandling?: {
    trustSignals?: string[];
  };
  humanHandoffGuidance?: {
    phones?: string[];
    emails?: string[];
    addresses?: string[];
  };
  personalityBrandVoice?: {
    toneNotes?: string;
  };
}

export interface VerifyWebsiteResult {
  reachable: boolean;
  normalizedUrl: string;
  metadata?: {
    title?: string;
    description?: string;
    phone?: string;
    /** og:image URL resolved to absolute form. Rendered as the wizard's site preview thumbnail. */
    imageUrl?: string;
    /** AI-generated prose summary of the homepage for the preview card. */
    summary?: string;
    /** Structured facts keyed by Playbook V2 section. Source for later auto-fill. */
    playbookSeed?: PlaybookSeed;
  };
  errorCode?:
    | 'invalid_url'
    | 'private_host'
    | 'dns_not_found'
    | 'connection_refused'
    | 'timeout'
    | 'http_error'
    | 'unreachable';
  errorMessage?: string;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private _openai: OpenAI | null = null;

  constructor(
    private prisma: PrismaService,
    private sigcoreService: SigcoreService,
    private notificationsService: NotificationsService,
    private stripeService: StripeService,
    private cache: CacheService,
    @Inject(forwardRef(() => PlatformService))
    private platformService: PlatformService,
    private configService: ConfigService,
  ) {}

  private get openai(): OpenAI | null {
    if (this._openai) return this._openai;
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) return null;
    this._openai = new OpenAI({ apiKey });
    return this._openai;
  }

  async updateProfile(userId: string, updates: {
    name?: string;
    businessPhone?: string;
    website?: string | null;
    websiteMetadata?: VerifyWebsiteResult['metadata'] | null;
  }) {
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
      // Clearing the URL also clears the cached metadata so we don't
      // hand back a title that belongs to the previous site.
      if (trimmed.length === 0) data.websiteMetadataJson = null;
    }
    if (updates.websiteMetadata !== undefined) {
      data.websiteMetadataJson = updates.websiteMetadata ?? null;
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      select: { id: true, name: true, email: true, businessPhone: true, website: true, websiteMetadataJson: true },
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
   * Get user's LeadBridge dedicated phone number.
   *
   * Sourced from TenantPhoneNumber (the post-2026-04-24 source of truth for
   * dedicated numbers, per the phone-spec refactor). Falls back to the legacy
   * `User.phoneNumber` column for users whose number predates the refactor and
   * was never migrated.
   *
   * TenantPhoneNumber selection order: unassigned-first (the "user-level"
   * shared number, if any), then most recently purchased. Per-account scoping
   * happens elsewhere via `resolveBotPhone`; this endpoint is the user-level
   * Settings → Communication "Leadbridge number" widget, so it should surface
   * any active number the user owns even if it's currently linked to one
   * savedAccount.
   */
  async getUserPhoneNumber(userId: string) {
    const tpn = await this.prisma.tenantPhoneNumber.findFirst({
      where: { userId, status: 'ACTIVE' },
      orderBy: [{ savedAccountId: 'asc' }, { purchasedAt: 'desc' }],
      select: { phoneNumber: true, sigcoreAllocationId: true },
    });

    if (tpn) {
      return {
        phoneNumber: tpn.phoneNumber,
        allocationId: tpn.sigcoreAllocationId,
        hasPhoneNumber: true,
      };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phoneNumber: true, sigcoreAllocationId: true },
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
      aiConversationMode?: 'always' | 'when_dispatcher_unavailable';
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
      const valid = ['always', 'when_dispatcher_unavailable'];
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

    // Deregister platform-side webhooks BEFORE we lose the
    // SavedAccount rows in the cascade delete. disconnectAccountWebhook
    // calls adapter.deleteWebhook (Thumbtack DELETE /businesses/.../
    // webhooks/..., Yelp unsubscribe) so the platform stops sending
    // events to LeadBridge for these businesses. Best-effort: failures
    // shouldn't block the user's explicit account-deletion request.
    for (const account of user.savedAccounts) {
      try {
        await this.platformService.disconnectAccountWebhook(userId, account.id);
      } catch (err: any) {
        this.logger.warn(`[deleteOwnAccount] Platform webhook cleanup failed for ${account.id}: ${err.message}`);
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

  /**
   * Apply the user's stored Playbook seed to every SavedAccount they own.
   * For each supported section the seed produced an instruction string for:
   *   - fill_empty: only set when the existing customInstructions is empty/blank
   *   - replace:    always set, regardless of existing content
   *
   * Returns aggregate counts plus a per-account result so the UI can show
   * "4 sections filled across 2 accounts".
   *
   * Does NOT touch: FAQ, pricing table (servicePricingJson), qualification
   * guidance, follow-up tone, phone-call guidance — per product decision,
   * those need their own dedicated flows or aren't derivable from a site.
   */
  async applyPlaybookSeedToAccounts(
    userId: string,
    mode: 'fill_empty' | 'replace',
  ): Promise<{
    success: boolean;
    accountsAffected: number;
    filled: number;
    skipped: number;
    overwritten: number;
    perSection: Partial<Record<SupportedPlaybookSectionKey, { filled: number; skipped: number; overwritten: number }>>;
    warning?: string;
  }> {
    const { seedToCustomInstructions, SUPPORTED_SECTIONS } = await import('./playbook-seed-applier');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { websiteMetadataJson: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const metadata = (user.websiteMetadataJson as any) || null;
    const seed = metadata?.playbookSeed as PlaybookSeed | undefined;
    if (!seed) {
      return {
        success: false,
        accountsAffected: 0,
        filled: 0,
        skipped: 0,
        overwritten: 0,
        perSection: {},
        warning: 'No playbook seed on file. Verify your website first.',
      };
    }

    const instructionsBySection = seedToCustomInstructions(seed);
    const sectionsWithContent = (Object.keys(instructionsBySection) as SupportedPlaybookSectionKey[])
      .filter((k) => !!instructionsBySection[k]);
    if (sectionsWithContent.length === 0) {
      return {
        success: false,
        accountsAffected: 0,
        filled: 0,
        skipped: 0,
        overwritten: 0,
        perSection: {},
        warning: 'Playbook seed has no fields to apply.',
      };
    }

    const accounts = await this.prisma.savedAccount.findMany({
      where: { userId },
      select: { id: true, followUpSettingsJson: true },
    });
    if (accounts.length === 0) {
      return {
        success: false,
        accountsAffected: 0,
        filled: 0,
        skipped: 0,
        overwritten: 0,
        perSection: {},
        warning: 'Connect an account first — the Playbook is stored per account.',
      };
    }

    const perSection: Partial<Record<SupportedPlaybookSectionKey, { filled: number; skipped: number; overwritten: number }>> = {};
    for (const k of SUPPORTED_SECTIONS) perSection[k] = { filled: 0, skipped: 0, overwritten: 0 };

    let totalFilled = 0;
    let totalSkipped = 0;
    let totalOverwritten = 0;
    let accountsAffected = 0;

    // One transaction per account — cheaper than one global transaction
    // (account writes are independent) and any single account failure
    // doesn't roll back the others.
    for (const account of accounts) {
      const existing = (account.followUpSettingsJson as any) || {};
      const aiPlaybookV2: Record<string, { customInstructions?: string }> = existing.aiPlaybookV2 || {};

      let changedThisAccount = false;

      for (const sectionKey of sectionsWithContent) {
        const text = instructionsBySection[sectionKey]!;
        const current = aiPlaybookV2[sectionKey]?.customInstructions;
        const hasExisting = typeof current === 'string' && current.trim().length > 0;

        if (mode === 'fill_empty' && hasExisting) {
          perSection[sectionKey]!.skipped++;
          totalSkipped++;
          continue;
        }

        if (hasExisting) {
          perSection[sectionKey]!.overwritten++;
          totalOverwritten++;
        } else {
          perSection[sectionKey]!.filled++;
          totalFilled++;
        }

        aiPlaybookV2[sectionKey] = { ...(aiPlaybookV2[sectionKey] || {}), customInstructions: text };
        changedThisAccount = true;
      }

      if (changedThisAccount) {
        await this.prisma.savedAccount.update({
          where: { id: account.id },
          data: {
            followUpSettingsJson: { ...existing, aiPlaybookV2 },
          },
        });
        accountsAffected++;
      }
    }

    this.logger.log(
      `[applyPlaybookSeed] userId=${userId} mode=${mode} accounts=${accountsAffected}/${accounts.length} ` +
      `filled=${totalFilled} skipped=${totalSkipped} overwritten=${totalOverwritten}`,
    );

    return {
      success: true,
      accountsAffected,
      filled: totalFilled,
      skipped: totalSkipped,
      overwritten: totalOverwritten,
      perSection,
    };
  }

  // ---------------------------------------------------------------------
  // verifyWebsite: lightweight check the onboarding wizard runs before
  // accepting the Business step. Goals:
  //   1. Reject typos/garbage URLs up front
  //   2. Confirm the site actually serves something (no DNS / 5xx)
  //   3. Pull a tiny amount of metadata (title, description, phone) so
  //      later wizard steps can pre-fill answers without re-parsing
  // We deliberately keep this self-contained — no external library,
  // no SSR pipeline — because the parsing only needs to handle the
  // first few bytes of a marketing site's <head>.
  // ---------------------------------------------------------------------
  async verifyWebsite(input: string): Promise<VerifyWebsiteResult> {
    const normalized = this.normalizeWebsiteUrl(input);
    if (!normalized) {
      return {
        reachable: false,
        normalizedUrl: (input ?? '').trim(),
        errorCode: 'invalid_url',
        errorMessage: "That doesn't look like a valid website URL.",
      };
    }

    // SSRF guard — refuse to fetch internal hosts. The normalize step
    // already strips obvious "localhost"/RFC1918 cases; this is a
    // belt-and-suspenders check after URL parsing so a future change
    // can't accidentally let one slip through.
    try {
      const u = new URL(normalized);
      const host = u.hostname.toLowerCase();
      if (this.isPrivateHost(host)) {
        return {
          reachable: false,
          normalizedUrl: normalized,
          errorCode: 'private_host',
          errorMessage: 'Internal addresses are not allowed.',
        };
      }
    } catch {
      return { reachable: false, normalizedUrl: normalized, errorCode: 'invalid_url' };
    }

    // Try the URL as given. If it fails with a DNS / connection error
    // AND the hostname doesn't already start with "www.", retry with
    // the www-prefixed hostname. Several common hosting setups
    // (Wix / Squarespace / Webflow) only respond on the www subdomain
    // and the apex isn't even DNS-resolvable.
    let result = await this.tryFetchWebsite(normalized);
    if (!result.reachable && this.shouldRetryWithWww(result, normalized)) {
      try {
        const u = new URL(normalized);
        const wwwHost = `www.${u.hostname}`;
        const wwwUrl = `${u.protocol}//${wwwHost}${u.pathname}${u.search}`;
        const wwwResult = await this.tryFetchWebsite(wwwUrl);
        if (wwwResult.reachable) return wwwResult;
      } catch { /* fall through to original failure */ }
    }
    return result;
  }

  // Inner fetch — kept separate so verifyWebsite can transparently
  // retry with a www. prefix on DNS / connection failure.
  private async tryFetchWebsite(url: string): Promise<VerifyWebsiteResult> {
    try {
      const response = await axios.get(url, {
        timeout: 6000,
        maxRedirects: 3,
        // 5 MB ceiling — most marketing sites are well under 1 MB but
        // Wix / Squarespace / Webflow pages routinely ship 2-3 MB of
        // initial HTML. Earlier 500 KB cap rejected those as failures.
        maxContentLength: 5 * 1024 * 1024,
        responseType: 'text',
        // Some hosts refuse non-browser User-Agents; identify ourselves
        // but pretend to be a Mozilla so anti-bot filters don't 403.
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LeadBridgeWebsiteCheck/1.0; +https://leadbridge360.com)',
          Accept: 'text/html,application/xhtml+xml',
        },
        // Accept everything below 400 — we already handle redirects via
        // maxRedirects.
        validateStatus: (s) => s < 400,
      });
      const html: string = typeof response.data === 'string' ? response.data : '';
      // Capture the final URL after redirect-following so we save the
      // canonical form ("https://spotless.homes" → save
      // "https://www.spotless.homes/").
      const finalUrl: string = (response.request?.res?.responseUrl as string) || url;
      const metadata = this.extractWebsiteMetadata(html, finalUrl);

      // Real homepage screenshot via Microlink — overrides the og:image when
      // it succeeds. og:image is often the brand logo (Wix in particular),
      // which doesn't visually identify the page; a real rendered screenshot
      // is what the user expects from "site preview".
      const screenshot = await this.fetchHomepageScreenshot(finalUrl).catch((e) => {
        this.logger.warn(`[verifyWebsite] screenshot failed for ${finalUrl}: ${e?.message || e}`);
        return undefined;
      });
      if (screenshot) metadata.imageUrl = screenshot;

      // AI summary + structured Playbook seed — non-blocking failure. We
      // don't want the entire verify flow to fail if OpenAI is down or the
      // key is missing; the wizard can still show the title/description/
      // phone we already pulled.
      const ai = await this.summarizeWebsite(html, metadata).catch((e) => {
        this.logger.warn(`[verifyWebsite] summary failed for ${finalUrl}: ${e?.message || e}`);
        return undefined;
      });
      if (ai?.summary) metadata.summary = ai.summary;
      if (ai?.playbookSeed) metadata.playbookSeed = ai.playbookSeed;

      return { reachable: true, normalizedUrl: finalUrl, metadata };
    } catch (err: any) {
      const code = err.code || '';
      const status = err.response?.status;
      const msg = err.message || '';
      // maxContentLength exceeded — the site IS reachable, we just
      // can't ingest its HTML for parsing. Treat as success without
      // metadata; the user shouldn't be blocked by a heavy SPA bundle.
      if (/maxContentLength/i.test(msg)) {
        this.logger.log(`[verifyWebsite] ${url} oversize body — treating as reachable without metadata`);
        return { reachable: true, normalizedUrl: url, metadata: {} };
      }
      let errorCode: VerifyWebsiteResult['errorCode'] = 'unreachable';
      let errorMessage = 'We couldn\'t load this site.';
      if (code === 'ECONNABORTED' || /timeout/i.test(msg)) {
        errorCode = 'timeout';
        errorMessage = 'The site took too long to respond.';
      } else if (code === 'ENOTFOUND' || /enotfound|getaddrinfo/i.test(msg)) {
        errorCode = 'dns_not_found';
        errorMessage = 'We couldn\'t find that domain.';
      } else if (code === 'ECONNREFUSED') {
        errorCode = 'connection_refused';
        errorMessage = 'The site refused the connection.';
      } else if (typeof status === 'number') {
        errorCode = 'http_error';
        errorMessage = `The site returned an error (HTTP ${status}).`;
      }
      this.logger.warn(`[verifyWebsite] ${url} failed: ${errorCode} (${msg})`);
      return { reachable: false, normalizedUrl: url, errorCode, errorMessage };
    }
  }

  // Retry with www. only on transport-level failures where the apex
  // genuinely couldn't be reached. If we got an HTTP status back the
  // domain answered — don't second-guess that.
  private shouldRetryWithWww(result: VerifyWebsiteResult, originalUrl: string): boolean {
    if (!result.errorCode) return false;
    if (result.errorCode !== 'dns_not_found' && result.errorCode !== 'connection_refused' && result.errorCode !== 'unreachable' && result.errorCode !== 'timeout') {
      return false;
    }
    try {
      const u = new URL(originalUrl);
      return !u.hostname.startsWith('www.');
    } catch {
      return false;
    }
  }

  private normalizeWebsiteUrl(input: string): string | null {
    if (!input) return null;
    let raw = input.trim();
    if (raw.length === 0) return null;
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    try {
      const u = new URL(raw);
      // Hostname must have at least one dot — rejects "localhost",
      // bare TLDs, and accidental words.
      if (!u.hostname || !u.hostname.includes('.')) return null;
      // Reject obvious internal addresses early.
      if (this.isPrivateHost(u.hostname.toLowerCase())) return null;
      return u.toString();
    } catch {
      return null;
    }
  }

  private isPrivateHost(host: string): boolean {
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
    // IPv4 private ranges
    if (/^127\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    // IPv6 loopback / link-local
    if (host === '::1' || host.startsWith('fe80:')) return true;
    return false;
  }

  private extractWebsiteMetadata(html: string, pageUrl?: string): NonNullable<VerifyWebsiteResult['metadata']> {
    if (!html) return {};
    const title = this.firstMatch(html, /<title[^>]*>([\s\S]{1,500}?)<\/title>/i);
    const description =
      this.metaContent(html, 'description') ||
      this.metaContent(html, 'og:description', 'property') ||
      undefined;
    // Page preview image — try og:image / twitter:image / first <link rel=image_src>.
    // Resolve relative paths against pageUrl so the frontend can <img src=...> it directly.
    const rawImage =
      this.metaContent(html, 'og:image', 'property') ||
      this.metaContent(html, 'og:image') ||
      this.metaContent(html, 'twitter:image') ||
      this.metaContent(html, 'twitter:image:src') ||
      this.firstMatch(html, /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i) ||
      undefined;
    const imageUrl = rawImage ? this.absolutizeUrl(rawImage, pageUrl) : undefined;
    // Phone — only mine the visible body, not the entire HTML. Many marketing
    // pages embed tracking pixels / random numeric IDs in <script> blocks (e.g.
    // Wix's ad pixels) that happen to be 10 digits and were getting picked up
    // as the business's phone (saw a Waco TX area code on a Florida site).
    const visibleForPhone = this.stripToVisibleText(html).slice(0, 100_000);
    const phone = this.firstMatch(
      visibleForPhone,
      // Tolerant US phone regex — captures most "(415) 555-1234" /
      // "+1 415 555 1234" / "415.555.1234" forms.
      /(\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})/,
      0,
    );
    return {
      title: this.decodeHtmlEntities(this.trimText(title)),
      description: this.decodeHtmlEntities(this.trimText(description)),
      phone: phone ? phone.trim() : undefined,
      imageUrl,
    };
  }

  /** Strip <script>/<style>/comments and tags, then decode the few common
   *  HTML entities that show up in marketing copy. Shared by phone extraction
   *  and AI summarization so they see the same text the customer would. */
  private stripToVisibleText(html: string): string {
    if (!html) return '';
    return this.decodeHtmlEntities(
      html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    ) || '';
  }

  /** Decode the handful of HTML entities that survive marketing copy
   *  (&amp; &lt; &gt; &quot; &#39; &nbsp; &ndash; &mdash;). Anything more
   *  exotic falls through unchanged. */
  private decodeHtmlEntities(s: string | undefined): string | undefined {
    if (s == null) return s;
    return s
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&ndash;/g, '–')
      .replace(/&mdash;/g, '—');
  }

  /**
   * Real rendered screenshot of the homepage via Microlink. Free tier is
   * rate-limited per-IP (~50/day) but caches per URL, so repeat verifies
   * of the same site are instant. Set MICROLINK_API_KEY when production
   * traffic outgrows the free tier. Returns the CDN URL of the cached
   * screenshot — we don't proxy it through our backend.
   *
   * Why this over og:image: og:image is set by the site's CMS template
   * and on Wix/Squarespace it almost always points at the brand LOGO,
   * not a hero shot. A real rendered screenshot is what users mean by
   * "preview thumbnail".
   */
  private async fetchHomepageScreenshot(url: string): Promise<string | undefined> {
    const apiKey = this.configService.get<string>('MICROLINK_API_KEY');
    const params = new URLSearchParams({
      url,
      screenshot: 'true',
      meta: 'false',
      // 1280x720 viewport — produces a usable thumbnail without burning
      // bandwidth on full-page 4k captures.
      'viewport.width': '1280',
      'viewport.height': '720',
    });
    const endpoint = `https://api.microlink.io?${params.toString()}`;

    try {
      this.logger.log(`[fetchHomepageScreenshot] requesting screenshot for ${url}`);
      const response = await axios.get(endpoint, {
        timeout: 20000,
        headers: apiKey ? { 'x-api-key': apiKey } : undefined,
        // Microlink returns JSON regardless of source size.
        responseType: 'json',
        validateStatus: (s) => s < 500,
      });
      if (response.status !== 200) {
        this.logger.warn(`[fetchHomepageScreenshot] microlink HTTP ${response.status} for ${url}`);
        return undefined;
      }
      const data = response.data;
      const screenshotUrl = data?.data?.screenshot?.url;
      if (typeof screenshotUrl === 'string' && screenshotUrl.length > 0) {
        this.logger.log(`[fetchHomepageScreenshot] got screenshot for ${url}: ${screenshotUrl.substring(0, 80)}...`);
        return screenshotUrl;
      }
      this.logger.warn(`[fetchHomepageScreenshot] microlink returned no screenshot URL for ${url} (status=${data?.status})`);
      return undefined;
    } catch (err: any) {
      this.logger.warn(`[fetchHomepageScreenshot] ${url} failed: ${err?.message || err}`);
      return undefined;
    }
  }

  /** Resolve relative URLs (`/logo.png`, `images/hero.jpg`) against the page URL. */
  private absolutizeUrl(href: string, base?: string): string | undefined {
    const trimmed = (href || '').trim();
    if (!trimmed) return undefined;
    try {
      return new URL(trimmed, base).toString();
    } catch {
      return undefined;
    }
  }

  /**
   * Strip HTML to readable text and ask gpt-4o-mini for BOTH a prose summary
   * (for the preview card) AND a structured Playbook seed (for later auto-fill
   * of `aiPlaybookV2.{section}.customInstructions`). Returns undefined when
   * OPENAI_API_KEY is unset or any step fails — the caller treats that as
   * "no summary yet" and still saves the rest of the metadata.
   *
   * Uses `response_format: json_object` so the model returns a parseable
   * object instead of free prose with embedded JSON.
   */
  private async summarizeWebsite(
    html: string,
    metadata: NonNullable<VerifyWebsiteResult['metadata']>,
  ): Promise<{ summary?: string; playbookSeed?: PlaybookSeed } | undefined> {
    const client = this.openai;
    if (!client) {
      this.logger.warn('[summarizeWebsite] OPENAI_API_KEY not set — skipping summary');
      return undefined;
    }
    if (!html) return undefined;

    const visible = this.stripToVisibleText(html);

    if (visible.length < 80) {
      this.logger.warn(`[summarizeWebsite] visible text too short (${visible.length}) — skipping`);
      return undefined;
    }
    // Cap input so we don't burn tokens on multi-MB Wix bundles. 12000 chars
    // ≈ 3000 tokens — enough to capture services, coverage, hours, pricing,
    // and policies on a typical cleaning-co marketing page.
    const snippet = visible.slice(0, 12000);

    const seed = [
      metadata.title ? `Page title: ${metadata.title}` : null,
      metadata.description ? `Meta description: ${metadata.description}` : null,
    ].filter(Boolean).join('\n');

    this.logger.log(`[summarizeWebsite] requesting structured extract (visibleLen=${visible.length}, snippetLen=${snippet.length})`);
    const resp = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      max_tokens: 1800,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            // Schema is dictated in the prompt because gpt-4o-mini JSON mode
            // only enforces "valid JSON object", not a structured schema —
            // we get the shape right by being explicit and giving examples.
            'You extract structured facts from a small-business homepage that ' +
            'will be used to pre-fill an AI playbook (the AI assistant\'s ' +
            'knowledge base for talking to leads). The output feeds 6 playbook ' +
            'sections so each fact must be tagged with the section it belongs ' +
            'to.\n\n' +
            'Return ONLY a JSON object with this exact shape (omit any field, ' +
            'including whole sections, that isn\'t supported by the page — do ' +
            'NOT invent or guess):\n\n' +
            '{\n' +
            '  "summary": "5-8 sentence plain-prose summary (150-220 words). ' +
            'Open with the business name. Cover services, coverage area, ' +
            'pricing, standout claims, contact. No markdown, no preamble.",\n' +
            '  "playbookSeed": {\n' +
            '    "businessInformation": {\n' +
            '      "serviceArea": "cities/regions/radius they cover",\n' +
            '      "teamSize": "e.g. \\"family-owned\\", \\"team of 12\\"",\n' +
            '      "yearsInBusiness": "e.g. \\"since 2018\\", \\"15+ years\\"",\n' +
            '      "ownerName": "if a name appears as owner/founder",\n' +
            '      "suppliesPolicy": "do they bring their own supplies/products?",\n' +
            '      "petsPolicy": "pets-friendly? any restrictions?",\n' +
            '      "paymentMethods": ["card", "cash", "Zelle", ...],\n' +
            '      "officeLocations": ["physical addresses if listed"],\n' +
            '      "insurance": "their exact wording, e.g. \\"fully insured\\"",\n' +
            '      "bonding": "e.g. \\"bonded\\" or \\"$1M bond\\"",\n' +
            '      "licensing": "license #, state, or \\"licensed\\"",\n' +
            '      "guarantees": "e.g. \\"100% satisfaction guarantee\\"",\n' +
            '      "ecoFriendly": "green/plant-based/non-toxic claims"\n' +
            '    },\n' +
            '    "pricingGuidance": {\n' +
            '      "pricingModel": "flat / hourly / by sqft / request a quote",\n' +
            '      "startingPrices": [{"service": "Standard cleaning", "price": "from $129"}],\n' +
            '      "whatsIncluded": "what each tier includes if listed",\n' +
            '      "discounts": "recurring %, first-clean, referral, etc."\n' +
            '    },\n' +
            '    "bookingGuidance": {\n' +
            '      "bookingChannels": ["online form", "phone", "email"],\n' +
            '      "leadTime": "e.g. \\"24-hour notice\\", \\"same-day available\\"",\n' +
            '      "schedulingNotes": "hours of operation, recurring options"\n' +
            '    },\n' +
            '    "objectionHandling": {\n' +
            '      "trustSignals": ["awards", "BBB rating", "5-star reviews count", ...]\n' +
            '    },\n' +
            '    "humanHandoffGuidance": {\n' +
            '      "phones": ["+1-..."], "emails": ["x@y.com"],\n' +
            '      "addresses": ["physical addresses"]\n' +
            '    },\n' +
            '    "personalityBrandVoice": {\n' +
            '      "toneNotes": "observed brand voice on the site — 1-2 sentences"\n' +
            '    }\n' +
            '  }\n' +
            '}\n\n' +
            'Rules:\n' +
            '- Drop any field whose value would be empty, generic, or invented.\n' +
            '- Drop a whole section if nothing was extracted for it.\n' +
            '- Use the SITE\'s own wording for claims (don\'t paraphrase "fully insured" as "has insurance").\n' +
            '- "summary" is REQUIRED. The structured fields are optional.',
        },
        {
          role: 'user',
          content: `${seed ? seed + '\n\n' : ''}Homepage content:\n${snippet}`,
        },
      ],
    });

    const raw = resp.choices?.[0]?.message?.content?.trim() || '';
    if (!raw) {
      this.logger.warn('[summarizeWebsite] empty response from gpt-4o-mini');
      return undefined;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (e: any) {
      this.logger.warn(`[summarizeWebsite] JSON parse failed: ${e?.message || e}; raw=${raw.slice(0, 200)}`);
      return undefined;
    }

    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : undefined;
    // Soft cap on summary — UI can still expand, but DB shouldn't grow
    // unboundedly if the model ignores max_tokens.
    const cappedSummary = summary && summary.length > 3000 ? summary.slice(0, 3000) : summary;

    const playbookSeed = this.sanitizePlaybookSeed(parsed.playbookSeed);

    this.logger.log(
      `[summarizeWebsite] extracted summary=${cappedSummary?.length || 0}ch, ` +
      `seedSections=${playbookSeed ? Object.keys(playbookSeed).length : 0}`,
    );

    if (!cappedSummary && !playbookSeed) return undefined;
    return { summary: cappedSummary, playbookSeed };
  }

  /**
   * Drop empty / non-string fields from the model's playbookSeed output so
   * the stored JSON stays lean and downstream auto-fill doesn't have to
   * distinguish "extracted, empty" from "not on the page".
   */
  private sanitizePlaybookSeed(seed: any): PlaybookSeed | undefined {
    if (!seed || typeof seed !== 'object' || Array.isArray(seed)) return undefined;

    const cleanString = (v: any): string | undefined => {
      if (typeof v !== 'string') return undefined;
      const t = v.trim();
      return t.length === 0 ? undefined : t.slice(0, 800);
    };
    const cleanStringArr = (v: any): string[] | undefined => {
      if (!Array.isArray(v)) return undefined;
      const out = v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => x.length > 0);
      return out.length === 0 ? undefined : out.slice(0, 12);
    };
    const cleanSection = (s: any, shape: Record<string, (v: any) => any>): any => {
      if (!s || typeof s !== 'object' || Array.isArray(s)) return undefined;
      const out: Record<string, unknown> = {};
      for (const [k, fn] of Object.entries(shape)) {
        const v = fn(s[k]);
        if (v !== undefined) out[k] = v;
      }
      return Object.keys(out).length === 0 ? undefined : out;
    };

    const result: PlaybookSeed = {};

    const businessInformation = cleanSection(seed.businessInformation, {
      serviceArea: cleanString,
      teamSize: cleanString,
      yearsInBusiness: cleanString,
      ownerName: cleanString,
      suppliesPolicy: cleanString,
      petsPolicy: cleanString,
      paymentMethods: cleanStringArr,
      officeLocations: cleanStringArr,
      insurance: cleanString,
      bonding: cleanString,
      licensing: cleanString,
      guarantees: cleanString,
      ecoFriendly: cleanString,
    });
    if (businessInformation) result.businessInformation = businessInformation;

    const pricingGuidance = cleanSection(seed.pricingGuidance, {
      pricingModel: cleanString,
      startingPrices: (v: any) => {
        if (!Array.isArray(v)) return undefined;
        const out = v
          .map((x) => ({
            service: typeof x?.service === 'string' ? x.service.trim().slice(0, 200) : '',
            price: typeof x?.price === 'string' ? x.price.trim().slice(0, 100) : '',
          }))
          .filter((x) => x.service && x.price);
        return out.length === 0 ? undefined : out.slice(0, 12);
      },
      whatsIncluded: cleanString,
      discounts: cleanString,
    });
    if (pricingGuidance) result.pricingGuidance = pricingGuidance;

    const bookingGuidance = cleanSection(seed.bookingGuidance, {
      bookingChannels: cleanStringArr,
      leadTime: cleanString,
      schedulingNotes: cleanString,
    });
    if (bookingGuidance) result.bookingGuidance = bookingGuidance;

    const objectionHandling = cleanSection(seed.objectionHandling, {
      trustSignals: cleanStringArr,
    });
    if (objectionHandling) result.objectionHandling = objectionHandling;

    const humanHandoffGuidance = cleanSection(seed.humanHandoffGuidance, {
      phones: cleanStringArr,
      emails: cleanStringArr,
      addresses: cleanStringArr,
    });
    if (humanHandoffGuidance) result.humanHandoffGuidance = humanHandoffGuidance;

    const personalityBrandVoice = cleanSection(seed.personalityBrandVoice, {
      toneNotes: cleanString,
    });
    if (personalityBrandVoice) result.personalityBrandVoice = personalityBrandVoice;

    return Object.keys(result).length === 0 ? undefined : result;
  }

  private firstMatch(html: string, re: RegExp, group = 1): string | undefined {
    const m = html.match(re);
    if (!m) return undefined;
    return (m[group] ?? '').replace(/\s+/g, ' ').trim() || undefined;
  }

  private metaContent(html: string, name: string, attr: 'name' | 'property' = 'name'): string | undefined {
    const reAttrFirst = new RegExp(
      `<meta[^>]+${attr}=["']${this.escapeRegex(name)}["'][^>]*content=["']([^"']{1,500})["']`,
      'i',
    );
    const reContentFirst = new RegExp(
      `<meta[^>]+content=["']([^"']{1,500})["'][^>]*${attr}=["']${this.escapeRegex(name)}["']`,
      'i',
    );
    return this.firstMatch(html, reAttrFirst) || this.firstMatch(html, reContentFirst);
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private trimText(s: string | undefined): string | undefined {
    if (!s) return undefined;
    const cleaned = s.replace(/\s+/g, ' ').trim();
    return cleaned.length === 0 ? undefined : cleaned.slice(0, 280);
  }
}
