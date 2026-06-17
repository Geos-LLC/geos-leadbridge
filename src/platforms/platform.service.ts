/**
 * Platform Service
 * Manages platform connections and credentials
 */

import { Injectable, NotFoundException, BadRequestException, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../common/utils/prisma.service';
import { withCronLock } from '../common/utils/cron-lock';
import { EncryptionUtil } from '../common/utils/encryption.util';
import { PlatformFactory } from './platform.factory';
import { PlatformCredentials } from '../common/interfaces/platform.interface';
import { NotificationsService } from '../notifications/notifications.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { TrialService } from '../trial/trial.service';
import { CacheService } from '../common/cache/cache.service';
import { CacheKeys } from '../common/cache/cache-keys';
import { LeadCacheService } from '../common/cache/lead-cache.service';

const SAVED_ACCOUNTS_TTL_SECONDS = 60;

/**
 * Whitelist of SavedAccount fields safe to return from the API and cache in Redis.
 *
 * CRITICAL SAFETY RULE:
 *   NEVER add `credentialsJson`, raw tokens, refresh tokens, or any provider
 *   secret to this type. Encrypted credentials must only leave the database
 *   via the dedicated `getAccountCredentials*` / `getValidAccessToken` paths,
 *   never through the list endpoint.
 *
 * Using a whitelist (not a blacklist strip) means future additions to the
 * Prisma `SavedAccount` model do not silently leak into the cache.
 */
export interface SafeSavedAccount {
  id: string;
  userId: string;
  platform: string;
  businessId: string;
  businessName: string;
  emailHint: string | null;
  imageUrl: string | null;
  webhookId: string | null;
  agentPhoneOverride: string | null;
  followUpMode: string | null;
  aiConversationEnabled: boolean;
  followUpPreset: string | null;
  followUpReplyType: string | null;
  followUpActiveHoursStart: string | null;
  followUpActiveHoursEnd: string | null;
  followUpTimezone: string | null;
  followUpSettingsJson: string | null;
  servicePricingJson: string | null;
  organizationId: string | null;
  lastUsedAt: Date;
  createdAt: Date;
  tokenDead: boolean;
}

function sanitizeSavedAccount(raw: any, tokenDead: boolean): SafeSavedAccount {
  return {
    id: raw.id,
    userId: raw.userId,
    platform: raw.platform,
    businessId: raw.businessId,
    businessName: raw.businessName,
    emailHint: raw.emailHint ?? null,
    imageUrl: raw.imageUrl ?? null,
    webhookId: raw.webhookId ?? null,
    agentPhoneOverride: raw.agentPhoneOverride ?? null,
    followUpMode: raw.followUpMode ?? null,
    aiConversationEnabled: Boolean(raw.aiConversationEnabled),
    followUpPreset: raw.followUpPreset ?? null,
    followUpReplyType: raw.followUpReplyType ?? null,
    followUpActiveHoursStart: raw.followUpActiveHoursStart ?? null,
    followUpActiveHoursEnd: raw.followUpActiveHoursEnd ?? null,
    followUpTimezone: raw.followUpTimezone ?? null,
    followUpSettingsJson: raw.followUpSettingsJson ?? null,
    servicePricingJson: raw.servicePricingJson ?? null,
    organizationId: raw.organizationId ?? null,
    lastUsedAt: raw.lastUsedAt,
    createdAt: raw.createdAt,
    tokenDead,
  };
}

function normalizeE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return null;
}

function normalizeAdditionalAssociatePhones(
  raw: Array<{ id?: string; phoneNumber: string; label?: string }> | undefined,
): Array<{ id: string; phoneNumber: string; label?: string }> {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Array<{ id: string; phoneNumber: string; label?: string }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry.phoneNumber !== 'string') continue;
    const phone = normalizeE164(entry.phoneNumber);
    if (!phone) continue;
    if (seen.has(phone)) continue;
    seen.add(phone);
    const id =
      typeof entry.id === 'string' && entry.id.length > 0
        ? entry.id
        : `aap_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
    const label = typeof entry.label === 'string' ? entry.label.trim().slice(0, 80) : undefined;
    out.push(label ? { id, phoneNumber: phone, label } : { id, phoneNumber: phone });
  }
  return out;
}

@Injectable()
export class PlatformService {
  private readonly logger = new Logger(PlatformService.name);
  private readonly encryptionKey: string;
  // Per-business token refresh lock: only one refresh at a time per business.
  // Concurrent callers wait for the same promise instead of racing.
  private readonly refreshLocks = new Map<string, Promise<{ accessToken: string; refreshToken?: string; expiresAt?: Date }>>();

  constructor(
    private prisma: PrismaService,
    private platformFactory: PlatformFactory,
    private configService: ConfigService,
    @Inject(forwardRef(() => NotificationsService))
    private notificationsService: NotificationsService,
    private monitoring: MonitoringService,
    private trialService: TrialService,
    private cache: CacheService,
    private leadCache: LeadCacheService,
    private eventEmitter: EventEmitter2,
  ) {
    this.encryptionKey = this.configService.get<string>('encryption.key') || 'default-32-char-encryption-key';
  }

  /**
   * Invalidate the cached saved-accounts list for a user.
   *
   * MUST be called AFTER any DB write that affects the sanitized payload:
   *   - OAuth connect / reconnect (saveAccount)
   *   - Token refresh success/failure (updateAccountCredentials, proactive cron)
   *   - Manual edits (updateSavedAccount)
   *   - Webhook registration (setupThumbtackWebhook)
   *   - Disconnect / remove (removeSavedAccount, disconnect)
   *   - Pricing / follow-up settings updates (users.service, follow-up controller)
   *   - Organization membership changes (teams.service)
   *
   * Uses delPattern because keys are partitioned by optional `platform` filter.
   */
  async invalidateSavedAccountsCache(userId: string): Promise<void> {
    await this.cache.delPattern(CacheKeys.savedAccountsPattern(userId));
  }

  /**
   * Proactive token refresh — runs every hour.
   * Checks all saved accounts and refreshes tokens expiring within 1 hour.
   * Prevents tokens from going stale between leads.
   */
  @Cron('0 */1 * * *') // every hour at :00
  async proactiveTokenRefresh(): Promise<void> {
    // Lock 7002 = proactive token refresh. Per-account refresh path goes
    // through this.serializedAccountRefresh which makes external OAuth API
    // calls — generous timeout for a worst-case batch of accounts.
    await withCronLock(
      this.prisma,
      this.logger,
      7002,
      'ProactiveRefresh',
      async tx => {
    const accounts = await tx.savedAccount.findMany({
      where: { credentialsJson: { not: null } },
      select: { id: true, platform: true, businessId: true, businessName: true, userId: true, credentialsJson: true },
    });

    const now = Date.now();
    const bufferMs = 60 * 60 * 1000; // 1 hour buffer
    let refreshed = 0;
    let failed = 0;

    // Group Yelp accounts by userId — one token per user, refreshing one invalidates others
    const yelpByUser = new Map<string, typeof accounts>();
    const nonYelp: typeof accounts = [];

    for (const account of accounts) {
      if (account.platform === 'yelp') {
        const group = yelpByUser.get(account.userId) || [];
        group.push(account);
        yelpByUser.set(account.userId, group);
      } else {
        nonYelp.push(account);
      }
    }

    // Refresh Yelp: one refresh per user, update ALL their accounts with the same token
    for (const [userId, yelpAccounts] of yelpByUser) {
      const first = yelpAccounts[0];
      if (!first.credentialsJson) continue;
      try {
        const creds = EncryptionUtil.decryptObject<any>(first.credentialsJson, this.encryptionKey);
        if (!creds.expiresAt || !creds.refreshToken) continue;
        const expiresAt = new Date(creds.expiresAt).getTime();
        if (now > (expiresAt - bufferMs)) {
          const lockKey = `yelp:${userId}`;
          try {
            const result = await this.serializedAccountRefresh(lockKey, first.id, 'yelp', creds.refreshToken, creds.email);
            // Update ALL Yelp accounts for this user with the same fresh token
            const freshCreds = EncryptionUtil.encryptObject({
              ...creds,
              accessToken: result.accessToken,
              refreshToken: result.refreshToken || creds.refreshToken,
              expiresAt: result.expiresAt,
            }, this.encryptionKey);
            for (const acc of yelpAccounts) {
              if (acc.id !== first.id) {
                await this.prisma.savedAccount.update({
                  where: { id: acc.id },
                  data: { credentialsJson: freshCreds },
                });
              }
            }
            refreshed++;
            this.logger.log(`[ProactiveRefresh] Refreshed yelp token for ${yelpAccounts.length} accounts (user ${userId})`);
          } catch (err: any) {
            failed++;
            this.logger.warn(`[ProactiveRefresh] Failed to refresh yelp for user ${userId}: ${err.message}`);
            for (const acc of yelpAccounts) {
              this.monitoring.captureError({
                category: 'token_refresh',
                code: 'token_expired',
                platform: 'yelp',
                message: `yelp token refresh failed for business ${acc.businessId} — ${err.message}`,
                userId,
                accountId: acc.id,
                accountName: acc.businessName,
                context: { platform: 'yelp', businessId: acc.businessId, source: 'proactive_cron' },
              }).catch(() => {});
            }
          }
        }
      } catch { /* decrypt failed */ }
    }

    // Refresh non-Yelp (Thumbtack) — each account independently
    for (const account of nonYelp) {
      if (!account.credentialsJson) continue;
      try {
        const creds = EncryptionUtil.decryptObject<any>(account.credentialsJson, this.encryptionKey);
        if (!creds.expiresAt || !creds.refreshToken) continue;
        const expiresAt = new Date(creds.expiresAt).getTime();
        if (now > (expiresAt - bufferMs)) {
          const lockKey = `${account.platform}:${account.businessId}`;
          try {
            await this.serializedAccountRefresh(lockKey, account.id, account.platform, creds.refreshToken, creds.email);
            refreshed++;
            this.logger.log(`[ProactiveRefresh] Refreshed ${account.platform} token for ${account.businessName}`);
          } catch (err: any) {
            failed++;
            this.logger.warn(`[ProactiveRefresh] Failed to refresh ${account.businessName}: ${err.message}`);
            this.monitoring.captureError({
              category: 'token_refresh',
              code: 'token_expired',
              platform: account.platform,
              message: `${account.platform} token refresh failed for business ${account.businessId} — ${err.message}`,
              userId: account.userId,
              accountId: account.id,
              accountName: account.businessName,
              context: { platform: account.platform, businessId: account.businessId, source: 'proactive_cron' },
            }).catch(() => {});
          }
        }
      } catch { /* decrypt failed */ }
    }

    if (refreshed > 0 || failed > 0) {
      this.logger.log(`[ProactiveRefresh] Done: ${refreshed} refreshed, ${failed} failed, ${accounts.length} total accounts`);
    }
      },
      { timeoutMs: 600_000 },
    );
  }

  /**
   * Get OAuth authorization URL
   * State is an encrypted token containing userId + expiry — survives server restarts.
   */
  async getAuthUrl(userId: string, platformName: string, forceLogin = false, callbackUrl?: string): Promise<string> {
    const adapter = this.platformFactory.getAdapter(platformName);

    // Encode userId + expiry into the state param itself (no in-memory Map needed).
    // Use base64url encoding (no +/= chars) so the state survives multi-redirect chains
    // (Yelp logout → login → authorize → callback) without double-encoding corruption.
    const statePayload = JSON.stringify({ userId, exp: Date.now() + 30 * 60 * 1000 });
    const encrypted = EncryptionUtil.encrypt(statePayload, this.encryptionKey);
    const state = encrypted.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    return adapter.getAuthUrl(userId, state, forceLogin, callbackUrl);
  }

  /**
   * Get userId from OAuth state parameter
   * Decrypts the state token — works even after server restarts/redeploys.
   */
  async getUserIdFromState(state: string): Promise<string | null> {
    try {
      // Reverse base64url encoding: restore +/= chars stripped during getAuthUrl
      let decoded = decodeURIComponent(state);
      decoded = decoded.replace(/-/g, '+').replace(/_/g, '/');
      // Re-add base64 padding
      while (decoded.length % 4 !== 0) decoded += '=';

      const payload = JSON.parse(EncryptionUtil.decrypt(decoded, this.encryptionKey));

      if (!payload.userId || !payload.exp) return null;
      if (Date.now() > payload.exp) {
        this.logger.warn('OAuth state expired');
        return null;
      }

      return payload.userId;
    } catch (err) {
      this.logger.error('Failed to decrypt OAuth state:', err.message);
      return null;
    }
  }

  /**
   * Handle OAuth callback and store credentials
   */
  async handleCallback(userId: string, platformName: string, code: string, callbackUrl?: string): Promise<void> {
    this.logger.log(`[oauth-trace] platformService.handleCallback ENTRY platform=${platformName} user=${userId} codeLen=${code?.length ?? 0}`);
    const adapter = this.platformFactory.getAdapter(platformName);

    // Exchange code for tokens
    let credentials: any;
    try {
      credentials = await adapter.handleCallback(code, userId, callbackUrl);
      this.logger.log(`[oauth-trace] platformService.handleCallback adapter.handleCallback OK platform=${platformName} user=${userId} accessTokenLen=${credentials?.accessToken?.length ?? 0} refreshTokenLen=${credentials?.refreshToken?.length ?? 0} email=${credentials?.email ? 'present' : 'absent'}`);
    } catch (err: any) {
      this.logger.error(`[oauth-trace] platformService.handleCallback adapter.handleCallback FAILED platform=${platformName} user=${userId} errName=${err?.constructor?.name ?? 'unknown'} msg=${err?.message ?? 'unknown'}`);
      throw err;
    }

    // Encrypt and store credentials
    await this.storeCredentials(userId, platformName, credentials);
    this.logger.log(`[oauth-trace] platformService.handleCallback storeCredentials OK platform=${platformName} user=${userId}`);
  }

  /**
   * Store encrypted platform credentials
   */
  async storeCredentials(
    userId: string,
    platformName: string,
    credentials: PlatformCredentials,
  ): Promise<void> {
    const encryptedCredentials = EncryptionUtil.encryptObject(credentials, this.encryptionKey);

    await this.prisma.platform.upsert({
      where: {
        userId_platformName: {
          userId,
          platformName,
        },
      },
      create: {
        userId,
        platformName,
        connected: true,
        externalUserId: credentials.externalUserId,
        credentialsJson: encryptedCredentials,
        lastSyncAt: new Date(),
      },
      update: {
        connected: true,
        externalUserId: credentials.externalUserId,
        credentialsJson: encryptedCredentials,
        lastSyncAt: new Date(),
      },
    });
  }

  /**
   * Get decrypted platform credentials
   */
  async getCredentials(userId: string, platformName: string): Promise<PlatformCredentials> {
    const platform = await this.prisma.platform.findUnique({
      where: {
        userId_platformName: {
          userId,
          platformName,
        },
      },
    });

    if (!platform || !platform.connected) {
      throw new NotFoundException(`${platformName} not connected for this user`);
    }

    // Decrypt credentials
    const credentials = EncryptionUtil.decryptObject<PlatformCredentials>(
      platform.credentialsJson,
      this.encryptionKey,
    );

    // Convert expiresAt string to Date if needed (from JSON storage)
    const expiresAt = credentials.expiresAt
      ? new Date(credentials.expiresAt)
      : null;

    // Check if token is expired and refresh if needed
    // Add 5-minute buffer to refresh before actual expiration
    const bufferMs = 5 * 60 * 1000; // 5 minutes
    const now = new Date();

    if (expiresAt && now.getTime() > (expiresAt.getTime() - bufferMs)) {
      console.log(`[PlatformService] Token expired or expiring soon for ${platformName}`);

      // First, check if serializedAccountRefresh already updated the Platform table
      // (this happens when getAccountCredentialsByBusinessId refreshed first and synced)
      try {
        const latest = await this.prisma.platform.findUnique({ where: { userId_platformName: { userId, platformName } } });
        if (latest?.credentialsJson) {
          const latestCreds = EncryptionUtil.decryptObject<PlatformCredentials>(latest.credentialsJson, this.encryptionKey);
          const latestExpiry = latestCreds.expiresAt ? new Date(latestCreds.expiresAt) : null;
          if (latestExpiry && latestExpiry.getTime() > (Date.now() + 60000)) {
            console.log(`[PlatformService] Platform token already fresh (synced from account refresh) — expires ${latestExpiry.toISOString()}`);
            return latestCreds;
          }
        }
      } catch {
        // continue to refresh
      }

      try {
        const newCredentials = await this.refreshToken(userId, platformName, credentials);
        console.log(`[PlatformService] Token refreshed successfully, new expiry: ${newCredentials.expiresAt}`);
        return newCredentials;
      } catch (error) {
        console.error(`[PlatformService] Token refresh failed: ${error.message}`);

        this.monitoring.captureError({
          category: 'token_refresh',
          message: `${platformName} token refresh failed — ${error.message}`,
          userId,
          context: { platformName },
        });

        throw error;
      }
    }

    return credentials;
  }

  /**
   * Refresh access token
   */
  private async refreshToken(
    userId: string,
    platformName: string,
    credentials: PlatformCredentials,
  ): Promise<PlatformCredentials> {
    if (!credentials.refreshToken) {
      throw new BadRequestException('No refresh token available');
    }

    const adapter = this.platformFactory.getAdapter(platformName);
    const newCredentials = await adapter.refreshAccessToken(credentials.refreshToken);

    // Store updated credentials
    await this.storeCredentials(userId, platformName, newCredentials);

    return newCredentials;
  }

  /**
   * Serialized token refresh for a saved account (per-business lock).
   * Prevents concurrent refresh calls from consuming the same rotating refresh token.
   * All concurrent callers for the same business share a single refresh promise.
   */
  private async serializedAccountRefresh(
    lockKey: string,
    accountId: string,
    platform: string,
    refreshToken: string,
    email?: string,
  ): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: Date }> {
    // If a refresh is already in flight for this business, piggyback on it
    const existing = this.refreshLocks.get(lockKey);
    if (existing) {
      console.log(`[PlatformService] Waiting for in-flight refresh: ${lockKey}`);
      return existing;
    }

    const refreshPromise = (async () => {
      try {
        const adapter = this.platformFactory.getAdapter(platform);

        // Re-read credentials from DB — another instance may have already refreshed
        // (Thumbtack refresh tokens are single-use, using a stale one kills the token)
        const freshAccount = await this.prisma.savedAccount.findUnique({
          where: { id: accountId },
          select: { credentialsJson: true },
        });
        let currentRefreshToken = refreshToken;
        if (freshAccount?.credentialsJson) {
          try {
            const freshCreds = EncryptionUtil.decryptObject<any>(freshAccount.credentialsJson, this.encryptionKey);
            if (freshCreds.refreshToken && freshCreds.refreshToken !== refreshToken) {
              // Another instance already refreshed — check if the new token is still fresh
              if (freshCreds.expiresAt && new Date(freshCreds.expiresAt).getTime() > Date.now() + 5 * 60_000) {
                // Token is still valid, no need to refresh
                return { accessToken: freshCreds.accessToken, refreshToken: freshCreds.refreshToken, expiresAt: new Date(freshCreds.expiresAt) };
              }
              currentRefreshToken = freshCreds.refreshToken;
            }
          } catch {}
        }

        const newCredentials = await adapter.refreshAccessToken(currentRefreshToken);

        // Store the new credentials (with new refresh token) immediately
        await this.updateAccountCredentials(accountId, {
          accessToken: newCredentials.accessToken,
          refreshToken: newCredentials.refreshToken || refreshToken,
          email,
          expiresAt: newCredentials.expiresAt,
        });

        // Also sync to Platform table so platform-level fallback stays fresh
        try {
          const account = await this.prisma.savedAccount.findUnique({
            where: { id: accountId },
            select: { userId: true, businessName: true, platform: true, businessId: true },
          });
          if (account) {
            await this.storeCredentials(account.userId, platform, newCredentials);
            // Auto-resolve stale token_refresh errors — token is working now
            // Match by accountId, accountName, null-accountName (legacy), or businessId in context
            await this.prisma.systemErrorLog.updateMany({
              where: {
                category: 'token_refresh',
                resolved: false,
                OR: [
                  { accountId },
                  { accountName: account.businessName, userId: account.userId },
                  { accountName: null, userId: account.userId, message: { contains: account.platform, mode: 'insensitive' } },
                  { context: { contains: account.businessId } },
                ],
              },
              data: { resolved: true },
            });
          }
        } catch {
          // Non-critical: platform table sync / error cleanup failure doesn't block the main flow
        }

        return {
          accessToken: newCredentials.accessToken,
          refreshToken: newCredentials.refreshToken || refreshToken,
          expiresAt: newCredentials.expiresAt,
        };
      } finally {
        // Release lock regardless of success/failure
        this.refreshLocks.delete(lockKey);
      }
    })();

    this.refreshLocks.set(lockKey, refreshPromise);
    return refreshPromise;
  }

  /**
   * Disconnect a platform
   */
  async disconnect(userId: string, platformName: string): Promise<void> {
    const adapter = this.platformFactory.getAdapter(platformName);

    await adapter.disconnect(userId);

    // Only set connected=false if the user has NO remaining saved accounts with webhooks.
    // Previously this always set false, breaking all other accounts for this user.
    const remainingAccounts = await this.prisma.savedAccount.count({
      where: { userId, platform: platformName, webhookId: { not: null } },
    });
    if (remainingAccounts === 0) {
      await this.prisma.platform.updateMany({
        where: { userId, platformName },
        data: { connected: false },
      });
    }

    await this.invalidateSavedAccountsCache(userId);
    await this.leadCache.invalidateLeadList(userId);
  }

  /**
   * Get all connected platforms for a user
   */
  async getUserPlatforms(userId: string) {
    return this.prisma.platform.findMany({
      where: { userId },
      select: {
        platformName: true,
        connected: true,
        lastSyncAt: true,
        createdAt: true,
      },
    });
  }

  /**
   * Get supported platforms
   */
  getSupportedPlatforms(): string[] {
    return this.platformFactory.getSupportedPlatforms();
  }

  // ==========================================
  // Thumbtack-specific Webhook Methods
  // ==========================================

  /**
   * Setup webhook for Thumbtack business
   * Registers webhook URL with Thumbtack to receive NegotiationCreatedV4 and MessageCreatedV4 events
   * Uses account-specific credentials if available, falls back to platform credentials
   * Automatically cleans up any existing webhooks before creating a new one
   */
  async setupThumbtackWebhook(userId: string, businessId: string): Promise<{ webhookId: string; businessId: string }> {
    // Try account-specific credentials first, then fall back to platform credentials
    let credentials: { accessToken: string; refreshToken?: string };
    const accountCreds = await this.getAccountCredentialsByBusinessId(userId, 'thumbtack', businessId);
    if (accountCreds) {
      console.log(`[PlatformService] Using account-specific credentials for webhook setup (business: ${businessId})`);
      credentials = accountCreds;
    } else {
      console.log(`[PlatformService] Using platform credentials for webhook setup (business: ${businessId})`);
      credentials = await this.getCredentials(userId, 'thumbtack');
    }
    const adapter = this.platformFactory.getAdapter('thumbtack') as any;

    // Get webhook URL from config
    const baseUrl = this.configService.get<string>('thumbtack.redirectUri')?.replace('/v1/thumbtack/auth/callback', '') || '';
    const webhookUrl = `${baseUrl}/webhooks/thumbtack`;

    // Clean up any existing webhooks before creating a new one
    try {
      const existingWebhooks = await adapter.getWebhooks(credentials, businessId);
      if (existingWebhooks && existingWebhooks.length > 0) {
        console.log(`[PlatformService] Found ${existingWebhooks.length} existing webhooks for business ${businessId}, cleaning up...`);
        for (const webhook of existingWebhooks) {
          try {
            await adapter.deleteWebhook(credentials, businessId, webhook.webhookID);
            console.log(`[PlatformService] Deleted old webhook ${webhook.webhookID}`);
          } catch (deleteErr: any) {
            console.warn(`[PlatformService] Failed to delete old webhook ${webhook.webhookID}: ${deleteErr.message}`);
          }
        }
      }
    } catch (err: any) {
      console.warn(`[PlatformService] Could not fetch existing webhooks for cleanup: ${err.message}`);
      // Continue with registration even if cleanup fails
    }

    // Register webhook with Thumbtack
    const result = await adapter.registerWebhook(credentials, businessId, webhookUrl);

    // Store businessId and webhookId in platform connection.
    // CRITICAL: always set connected=true here — this is the only reliable place
    // to keep Platform.connected in sync. Without this, all downstream lookups
    // that filter by connected=true silently fail (webhooks, credentials, health).
    await this.prisma.platform.upsert({
      where: {
        userId_platformName: {
          userId,
          platformName: 'thumbtack',
        },
      },
      update: {
        connected: true,
        externalBusinessId: businessId,
        webhookId: result.webhookId,
      },
      create: {
        userId,
        platformName: 'thumbtack',
        connected: true,
        externalBusinessId: businessId,
        webhookId: result.webhookId,
        credentialsJson: '',
      },
    });

    // Also update the saved account with webhookId
    await this.prisma.savedAccount.updateMany({
      where: {
        userId,
        platform: 'thumbtack',
        businessId,
      },
      data: {
        webhookId: result.webhookId,
      },
    });

    await this.invalidateSavedAccountsCache(userId);

    // Auto-register agent phone + LB number as Thumbtack associate phones
    // (allows calling without access code, and lets the LB number act as a
    // fallback sender when the customer's real phone isn't available).
    await this.syncAccountPhonesToThumbtack(userId, businessId, credentials, adapter);

    return {
      webhookId: result.webhookId,
      businessId,
    };
  }

  /**
   * Register the agent's business phone as a Thumbtack associate phone number.
   * This allows the agent to call customers through Thumbtack's proxy number
   * without needing an access code.
   */
  async registerAgentPhoneWithThumbtack(
    userId: string,
    businessId: string,
    credentials?: { accessToken: string } | null,
    adapter?: any,
  ): Promise<void> {
    // Resolve the agent's phone: account override > user default
    const account = await this.prisma.savedAccount.findFirst({
      where: { userId, platform: 'thumbtack', businessId },
      select: { agentPhoneOverride: true },
    });
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { businessPhone: true },
    });

    const agentPhone = account?.agentPhoneOverride || user?.businessPhone;
    if (!agentPhone) {
      this.logger.log(
        `[tt.associate-phone] skip-owner reason=no_agent_phone userId=${userId} businessId=${businessId}`,
      );
      return;
    }

    if (!adapter) {
      adapter = this.platformFactory.getAdapter('thumbtack') as any;
    }
    if (!credentials) {
      const creds = await this.getAccountCredentialsByBusinessId(userId, 'thumbtack', businessId);
      if (!creds) return;
      credentials = creds;
    }

    const { registered } = await adapter.ensureAssociatePhone(credentials, businessId, agentPhone, 'LeadBridge Agent');
    this.logger.log(
      `[tt.associate-phone] owner ${registered ? 'registered' : 'already_present'} businessId=${businessId} phone=${agentPhone} name="LeadBridge Agent"`,
    );
  }

  /**
   * Register the user's LeadBridge dedicated number (TenantPhoneNumber) as a
   * Thumbtack associate phone for this business. This is the substitute /
   * fallback number used when the customer's real phone isn't available — TT
   * needs it whitelisted on the business for the proxy call/text path to honor
   * it as a legitimate pro-side sender.
   *
   * Per-account fallback chain: account-scoped TPN → unassigned → any-active
   * (matches `resolveBotPhone`). Skips silently if the user has no LB number
   * provisioned yet.
   */
  async registerLeadBridgeNumberWithThumbtack(
    userId: string,
    businessId: string,
    credentials?: { accessToken: string } | null,
    adapter?: any,
  ): Promise<void> {
    const account = await this.prisma.savedAccount.findFirst({
      where: { userId, platform: 'thumbtack', businessId },
      select: { id: true },
    });
    if (!account) return;

    const lbPhone = await this.notificationsService.resolveBotPhone(userId, account.id);
    if (!lbPhone) {
      this.logger.log(
        `[tt.associate-phone] skip-lb reason=no_lb_number userId=${userId} businessId=${businessId} savedAccountId=${account.id}`,
      );
      return;
    }

    if (!adapter) {
      adapter = this.platformFactory.getAdapter('thumbtack') as any;
    }
    if (!credentials) {
      const creds = await this.getAccountCredentialsByBusinessId(userId, 'thumbtack', businessId);
      if (!creds) return;
      credentials = creds;
    }

    const { registered } = await adapter.ensureAssociatePhone(credentials, businessId, lbPhone, 'LeadBridge Number');
    this.logger.log(
      `[tt.associate-phone] lb ${registered ? 'registered' : 'already_present'} businessId=${businessId} phone=${lbPhone} name="LeadBridge Number"`,
    );
  }

  /**
   * Register both the agent's business phone and the LeadBridge dedicated
   * number as Thumbtack associate phones for this business. Each call is
   * independent — a failure of one does not block the other.
   */
  async syncAccountPhonesToThumbtack(
    userId: string,
    businessId: string,
    credentials?: { accessToken: string } | null,
    adapter?: any,
  ): Promise<void> {
    try {
      await this.registerAgentPhoneWithThumbtack(userId, businessId, credentials, adapter);
    } catch (err: any) {
      this.logger.warn(
        `[tt.associate-phone] owner failed businessId=${businessId} userId=${userId} message="${err?.message ?? err}"`,
      );
    }
    try {
      await this.registerLeadBridgeNumberWithThumbtack(userId, businessId, credentials, adapter);
    } catch (err: any) {
      this.logger.warn(
        `[tt.associate-phone] lb failed businessId=${businessId} userId=${userId} message="${err?.message ?? err}"`,
      );
    }
    try {
      await this.registerAdditionalAssociatePhonesWithThumbtack(userId, businessId, credentials, adapter);
    } catch (err: any) {
      this.logger.warn(
        `[tt.associate-phone] additional batch-failed businessId=${businessId} userId=${userId} message="${err?.message ?? err}"`,
      );
    }
  }

  /**
   * Register every entry in
   * `SavedAccount.followUpSettingsJson.additionalAssociatePhones` as a
   * Thumbtack associate phone on the given business. Idempotent via
   * ensureAssociatePhone. Skips silently when the account has none.
   *
   * Per-business scope — only reads from the SavedAccount tied to this exact
   * businessId, never from siblings. Adding a number to Jacksonville stays
   * on Jacksonville and does NOT leak to Tampa / St Pete / etc.
   *
   * Legacy User.additionalAssociatePhonesJson is NOT read here (intentional).
   * Old user-level data stays dormant; new writes go to SavedAccount.
   */
  async registerAdditionalAssociatePhonesWithThumbtack(
    userId: string,
    businessId: string,
    credentials?: { accessToken: string } | null,
    adapter?: any,
  ): Promise<void> {
    const account = await this.prisma.savedAccount.findFirst({
      where: { userId, platform: 'thumbtack', businessId },
      select: { followUpSettingsJson: true },
    });
    if (!account?.followUpSettingsJson) return;
    let parsed: any = null;
    try {
      parsed = JSON.parse(account.followUpSettingsJson);
    } catch {
      return;
    }
    const raw = parsed?.additionalAssociatePhones as
      | Array<{ id?: string; phoneNumber: string; label?: string }>
      | null
      | undefined;
    if (!Array.isArray(raw) || raw.length === 0) return;

    if (!adapter) {
      adapter = this.platformFactory.getAdapter('thumbtack') as any;
    }
    if (!credentials) {
      const creds = await this.getAccountCredentialsByBusinessId(userId, 'thumbtack', businessId);
      if (!creds) return;
      credentials = creds;
    }

    for (const entry of raw) {
      if (!entry || typeof entry.phoneNumber !== 'string') continue;
      const phone = entry.phoneNumber;
      const name = (entry.label && entry.label.trim()) || 'LeadBridge Associate';
      try {
        const { registered } = await adapter.ensureAssociatePhone(credentials, businessId, phone, name);
        this.logger.log(
          `[tt.associate-phone] additional ${registered ? 'registered' : 'already_present'} businessId=${businessId} phone=${phone} name="${name}"`,
        );
      } catch (err: any) {
        // One bad entry shouldn't stop the rest of the list.
        this.logger.warn(
          `[tt.associate-phone] additional failed businessId=${businessId} phone=${phone} name="${name}" message="${err?.message ?? err}"`,
        );
      }
    }
  }

  /**
   * Register the user's LeadBridge dedicated number on every connected
   * Thumbtack business. Used when the LB number is provisioned, reassigned,
   * or restored — at those moments the TPN row changed and we want every
   * TT business to pick up the new resolveBotPhone() result.
   */
  async syncLeadBridgeNumberToAllThumbtack(userId: string): Promise<void> {
    const accounts = await this.prisma.savedAccount.findMany({
      where: { userId, platform: 'thumbtack' },
      select: { businessId: true },
    });
    for (const account of accounts) {
      if (!account.businessId) continue;
      try {
        await this.registerLeadBridgeNumberWithThumbtack(userId, account.businessId);
      } catch (err: any) {
        this.logger.warn(
          `[tt.associate-phone] lb sync-all-failed businessId=${account.businessId} userId=${userId} message="${err?.message ?? err}"`,
        );
      }
    }
  }

  /**
   * Disconnect webhooks for a saved account
   * Returns detailed status about what happened
   */
  async disconnectAccountWebhook(userId: string, accountId: string): Promise<{
    success: boolean;
    webhookDeleted: boolean;
    warning?: string;
    errorCode?: 'token_expired' | 'token_revoked' | 'webhook_not_found' | 'network_error' | 'permission_denied' | 'unknown';
    errorMessage?: string;
  }> {
    // Get the saved account
    const account = await this.prisma.savedAccount.findFirst({
      where: {
        id: accountId,
        userId,
      },
    });

    if (!account || !account.webhookId) {
      console.log(`[PlatformService] No webhook to disconnect for account ${accountId}`);
      return { success: true, webhookDeleted: true };
    }

    let webhookDeleted = false;
    let errorCode: 'token_expired' | 'token_revoked' | 'webhook_not_found' | 'network_error' | 'permission_denied' | 'unknown' | undefined;
    let errorMessage: string | undefined;
    let warning: string | undefined;

    try {
      // Try account-specific credentials first, then fall back to platform credentials
      let credentials: { accessToken: string; refreshToken?: string };
      const accountCreds = await this.getAccountCredentials(userId, accountId);
      if (accountCreds) {
        console.log(`[PlatformService] Using account-specific credentials for webhook deletion`);
        credentials = accountCreds;
      } else {
        console.log(`[PlatformService] Using platform credentials for webhook deletion`);
        credentials = await this.getCredentials(userId, account.platform);
      }
      const adapter = this.platformFactory.getAdapter(account.platform) as any;

      // Delete the webhook from Thumbtack
      await adapter.deleteWebhook(credentials, account.businessId, account.webhookId);
      console.log(`[PlatformService] Deleted webhook ${account.webhookId} for business ${account.businessId}`);
      webhookDeleted = true;
    } catch (err: any) {
      console.warn(`[PlatformService] Could not delete webhook: ${err.message}`);

      // Categorize the error
      const errMsg = err.message?.toLowerCase() || '';
      const statusCode = err.response?.status || err.status;

      if (statusCode === 401 || errMsg.includes('unauthorized') || errMsg.includes('token') || errMsg.includes('expired')) {
        errorCode = 'token_expired';
        errorMessage = 'Your Thumbtack session has expired. The webhook may still be active on Thumbtack\'s side.';
        warning = 'Thumbtack may continue sending messages until you reconnect and disconnect again, or manually remove the webhook from Thumbtack.';
      } else if (statusCode === 403 || errMsg.includes('forbidden') || errMsg.includes('permission') || errMsg.includes('revoked')) {
        errorCode = 'permission_denied';
        errorMessage = 'Access to this account was revoked or permissions changed.';
        warning = 'You may need to reconnect your Thumbtack account to manage webhooks.';
      } else if (statusCode === 404 || errMsg.includes('not found')) {
        // Webhook already deleted - this is actually fine
        errorCode = 'webhook_not_found';
        errorMessage = 'Webhook was already removed from Thumbtack.';
        webhookDeleted = true; // It's gone, so effectively deleted
      } else if (errMsg.includes('network') || errMsg.includes('timeout') || errMsg.includes('econnrefused')) {
        errorCode = 'network_error';
        errorMessage = 'Could not connect to Thumbtack. Please check your internet connection and try again.';
        warning = 'The webhook may still be active. Try disconnecting again when the connection is restored.';
      } else {
        errorCode = 'unknown';
        errorMessage = err.message || 'An unexpected error occurred while removing the webhook.';
        warning = 'The webhook may still be active on Thumbtack\'s side.';
      }
    }

    // Clear the webhookId from saved account regardless of API result
    await this.prisma.savedAccount.update({
      where: { id: accountId },
      data: { webhookId: null },
    });

    return {
      success: true,
      webhookDeleted,
      ...(errorCode && { errorCode }),
      ...(errorMessage && { errorMessage }),
      ...(warning && { warning }),
    };
  }

  /**
   * Reconnect webhooks for a saved account
   */
  async reconnectAccountWebhook(userId: string, accountId: string): Promise<{ webhookId: string }> {
    console.log(`[reconnectAccountWebhook] Start: userId=${userId}, accountId=${accountId}`);

    // Get the saved account
    const account = await this.prisma.savedAccount.findFirst({
      where: {
        id: accountId,
        userId,
      },
    });

    if (!account) {
      console.error(`[reconnectAccountWebhook] Account not found: ${accountId}`);
      throw new Error('Account not found');
    }

    console.log(`[reconnectAccountWebhook] Found account: ${account.businessName} (businessId=${account.businessId}, current webhookId=${account.webhookId})`);

    // Setup new webhook
    const result = await this.setupThumbtackWebhook(userId, account.businessId);

    console.log(`[reconnectAccountWebhook] Done: new webhookId=${result.webhookId}`);
    return { webhookId: result.webhookId };
  }

  /**
   * Get Thumbtack webhooks for a business
   * Uses account-specific credentials if available, falls back to platform credentials
   */
  async getThumbtackWebhooks(userId: string, businessId: string): Promise<any[]> {
    // Try account-specific credentials first
    let credentials: { accessToken: string; refreshToken?: string };
    const accountCreds = await this.getAccountCredentialsByBusinessId(userId, 'thumbtack', businessId);
    if (accountCreds) {
      credentials = accountCreds;
    } else {
      credentials = await this.getCredentials(userId, 'thumbtack');
    }
    const adapter = this.platformFactory.getAdapter('thumbtack') as any;

    return adapter.getWebhooks(credentials, businessId);
  }

  /**
   * Delete a specific webhook from Thumbtack
   * Used for cleaning up duplicate webhooks
   */
  async deleteThumbtackWebhook(userId: string, businessId: string, webhookId: string): Promise<void> {
    // Try account-specific credentials first
    let credentials: { accessToken: string; refreshToken?: string };
    const accountCreds = await this.getAccountCredentialsByBusinessId(userId, 'thumbtack', businessId);
    if (accountCreds) {
      credentials = accountCreds;
    } else {
      credentials = await this.getCredentials(userId, 'thumbtack');
    }
    const adapter = this.platformFactory.getAdapter('thumbtack') as any;

    await adapter.deleteWebhook(credentials, businessId, webhookId);
  }

  // ==========================================
  // Saved Accounts Methods
  // ==========================================

  /**
   * Save account info for multi-account switching
   * Now also stores credentials per-account for multi-login support
   */
  async saveAccount(
    userId: string,
    platform: string,
    businessId: string,
    businessName: string,
    imageUrl?: string,
    emailHint?: string,
    credentials?: { accessToken: string; refreshToken?: string; email?: string; expiresAt?: Date },
  ): Promise<void> {
    // Check for trial abuse: If this Thumbtack business has been used before, invalidate trial
    // Skip this check for admin users to allow testing with same Thumbtack business
    if (platform === 'thumbtack' && businessId) {
      // Fetch user's role to check if they're an admin
      const currentUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });

      // Only apply trial restrictions to non-admin users
      if (currentUser?.role !== 'ADMIN') {
        // Check if this business ID exists on any other user
        const existingUser = await this.prisma.user.findFirst({
          where: {
            thumbtackBusinessId: businessId,
            id: { not: userId }, // Different user
          },
          select: { id: true },
        });

        if (existingUser) {
          // This Thumbtack account has been used before - invalidate current user's trial
          await this.prisma.user.update({
            where: { id: userId },
            data: {
              trialUsed: true,
              trialStartDate: null,
              trialEndDate: null,
            },
          });
          this.logger.warn(`[PlatformService] Trial invalidated for user ${userId} - Thumbtack business ${businessId} already used by another account`);
        }

        // Store Thumbtack business ID on user to track trial usage
        await this.prisma.user.update({
          where: { id: userId },
          data: {
            thumbtackBusinessId: businessId,
            thumbtackAccountEmail: emailHint,
          },
        });
      } else {
        this.logger.log(`[PlatformService] Admin user ${userId} bypassing trial restrictions for Thumbtack business ${businessId}`);
      }
    }

    // Encrypt credentials if provided
    let encryptedCredentials: string | undefined;
    if (credentials) {
      encryptedCredentials = EncryptionUtil.encryptObject(credentials, this.encryptionKey);
    }

    const savedAccount = await this.prisma.savedAccount.upsert({
      where: {
        userId_platform_businessId: {
          userId,
          platform,
          businessId,
        },
      },
      create: {
        userId,
        platform,
        businessId,
        businessName,
        imageUrl,
        emailHint,
        credentialsJson: encryptedCredentials,
        lastUsedAt: new Date(),
      },
      update: {
        businessName,
        imageUrl,
        emailHint,
        // Only update credentials if provided (don't overwrite existing with undefined)
        ...(encryptedCredentials && { credentialsJson: encryptedCredentials }),
        lastUsedAt: new Date(),
      },
    });

    // Phones are bound to their owning savedAccount at purchase time
    // (notifications.service.ts purchaseTenantPhoneNumber). An UNASSIGNED
    // (savedAccountId=null) TenantPhoneNumber is INTENTIONALLY shared: it
    // serves all of the user's accounts via resolveBotPhone's "unassigned"
    // fallback, and Sigcore's workspace-level PPAs let each tenant send
    // from it with its own API key.
    //
    // We must NOT auto-claim a null phone here: doing so makes
    // resolveApiKeyForFromPhone trigger the cross-tenant swap for every
    // sibling account, which hits the just-saved account's sc_tenant_*
    // key and Sigcore rejects with 422 INVALID_PROFILE_PHONE because the
    // phone isn't bound to that tenant on the Sigcore side. Regression
    // 2026-06-16: Spotless Tampa reconnect stole +19045778584 from the
    // shared pool and broke outbound SMS across 7 sibling accounts.

    // Auto-provision Sigcore workspace for this account (idempotent, non-blocking).
    // After provisioning, seed default notification settings (first account) or
    // inherit them from the user's existing config (additional accounts).
    this.autoProvisionSigcore(savedAccount.id, businessName)
      .then(() => this.seedOrInheritNotificationSettings(savedAccount.id, userId, businessName))
      .catch((err) => {
        this.logger.warn(`[saveAccount] Sigcore auto-provision / settings seed failed for ${savedAccount.id}: ${err.message}`);
      });

    // Initialize/upgrade adaptive trial based on connected platforms
    this.trialService.onPlatformConnected(userId, platform).catch((err) => {
      this.logger.warn(`[saveAccount] Trial init failed for ${userId}: ${err.message}`);
    });

    // Emit a domain event so UsersService can silently seed
    // businessInformation from the freshly-connected account. Decoupled to
    // avoid a Users <-> Platforms circular dep. Listener is async / fire-
    // and-forget; failures are non-fatal — the account is saved either way.
    this.eventEmitter.emit('platform.account.connected', {
      userId,
      savedAccountId: savedAccount.id,
      platform,
    });

    // Invalidate AFTER commit so a concurrent reader cannot repopulate the cache
    // from pre-commit state.
    await this.invalidateSavedAccountsCache(userId);
    // New businessId becomes visible in the leads list filter — invalidate.
    await this.leadCache.invalidateLeadList(userId);
  }

  /**
   * Auto-provision a Sigcore tenant workspace for a saved account.
   * Idempotent — skips if already provisioned.
   */
  private async autoProvisionSigcore(savedAccountId: string, displayName?: string): Promise<void> {
    // Check if already provisioned
    const existing = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      select: { sigcoreTenantId: true, sigcoreApiKey: true },
    });
    if (existing?.sigcoreTenantId && existing?.sigcoreApiKey) {
      return; // already provisioned
    }

    const sigcoreUrl = this.configService.get<string>('SIGCORE_API_URL', 'https://sigcore-production.up.railway.app/api');
    const platformKey = this.configService.get<string>('SIGCORE_API_KEY');
    if (!platformKey) {
      this.logger.warn('[autoProvisionSigcore] SIGCORE_API_KEY not configured — skipping');
      return;
    }

    const resp = await fetch(`${sigcoreUrl}/tenants/provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': platformKey },
      body: JSON.stringify({
        externalTenantId: savedAccountId,
        displayName: displayName || `Account ${savedAccountId}`,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Sigcore provision failed (${resp.status}): ${text}`);
    }

    const { data } = await resp.json();

    await this.prisma.notificationSettings.upsert({
      where: { savedAccountId },
      update: {
        sigcoreApiKey: data.apiKey,
        sigcoreTenantId: data.tenantId,
        sigcoreWorkspaceId: data.tenantId,
        sigcoreProvisionedAt: new Date(),
      },
      create: {
        savedAccountId,
        sigcoreApiKey: data.apiKey,
        sigcoreTenantId: data.tenantId,
        sigcoreWorkspaceId: data.tenantId,
        sigcoreProvisionedAt: new Date(),
        enabled: false,
      },
    });

    this.logger.log(`[autoProvisionSigcore] Provisioned tenant ${data.tenantId} for account ${savedAccountId}`);

    // Register in Sigcore business identity model (non-blocking, idempotent)
    // This creates a business + product_workspace + links phone assets
    this.registerBusinessIdentityForAccount(savedAccountId, platformKey, sigcoreUrl).catch(e => {
      this.logger.warn(`[autoProvisionSigcore] Business identity registration deferred: ${e.message}`);
    });
  }

  /**
   * Seed default notification settings on a newly connected account.
   *
   * Two paths:
   *  1) FIRST account for the user → seed sane defaults (enable settings,
   *     create owner-alert rule against User.businessPhone, create
   *     customer-texting Instant Text rule).
   *  2) ADDITIONAL account → inherit from the user-level "All Accounts"
   *     defaults (NotificationSettings.savedAccountId=null) if present,
   *     else copy rules from the most recently used sibling savedAccount
   *     that already has rules.
   *
   * Idempotent: bails immediately if the account's settings already have
   * `enabled=true` or any NotificationRule rows — so re-saves of an
   * already-configured account never clobber the user's config.
   */
  private async seedOrInheritNotificationSettings(
    savedAccountId: string,
    userId: string,
    businessName: string,
  ): Promise<void> {
    const existing = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      include: { notificationRules: { select: { id: true } } },
    });

    if (!existing) {
      // autoProvisionSigcore failed earlier — nothing to seed onto.
      return;
    }
    // Skip ONLY when there's a real rule on this account. `enabled=true` by
    // itself is unreliable — autoProvisionSigcore (or an admin tool) can flip
    // the settings row to enabled without creating any rules, which would
    // otherwise leave the account stuck in "configured but unusable" state
    // (zero rules → health check returns "No new_lead SMS rules configured").
    // Without this loosening, re-saves / reconnects on a stuck account would
    // bail before re-seeding and the account never recovers.
    if (existing.notificationRules.length > 0) {
      return;
    }

    // Inheritance source — priority: user-level defaults, then sibling account.
    const userLevel = await this.prisma.notificationSettings.findFirst({
      where: { userId, savedAccountId: null },
      include: { notificationRules: true },
    });

    let sourceSettings = userLevel && userLevel.notificationRules.length > 0 ? userLevel : null;
    let sourceLabel = sourceSettings ? 'user-level (All Accounts)' : '';

    if (!sourceSettings) {
      const sibling = await this.prisma.savedAccount.findFirst({
        where: {
          userId,
          id: { not: savedAccountId },
          notificationSettings: { notificationRules: { some: {} } },
        },
        include: { notificationSettings: { include: { notificationRules: true } } },
        orderBy: { lastUsedAt: 'desc' },
      });
      if (sibling?.notificationSettings) {
        sourceSettings = sibling.notificationSettings as typeof userLevel;
        sourceLabel = `sibling account ${sibling.id}`;
      }
    }

    if (sourceSettings) {
      await this.prisma.notificationSettings.update({
        where: { savedAccountId },
        data: {
          enabled: sourceSettings.enabled,
          userId,
          destinationPhone: sourceSettings.destinationPhone,
          senderMode: sourceSettings.senderMode,
          template: sourceSettings.template,
          quietHoursStart: sourceSettings.quietHoursStart,
          quietHoursEnd: sourceSettings.quietHoursEnd,
          quietHoursTimezone: sourceSettings.quietHoursTimezone,
          requirePhone: sourceSettings.requirePhone,
          customerTextingEnabled: sourceSettings.customerTextingEnabled,
          // Do NOT copy sigcore*, inboundSmsWebhookId, smsForwardingNumber,
          // callForwardingNumber — those are tenant-specific to THIS account
          // and were set by autoProvisionSigcore.
        },
      });

      for (const rule of sourceSettings.notificationRules) {
        await this.prisma.notificationRule.create({
          data: {
            notificationSettingsId: existing.id,
            name: rule.name,
            triggerType: rule.triggerType,
            replyTriggerMode: rule.replyTriggerMode,
            fromPhone: null, // resolved at send-time via resolveBotPhone
            toPhone: rule.toPhone,
            sendToCustomer: rule.sendToCustomer,
            template: rule.template,
            templateId: rule.templateId,
            delayMinutes: rule.delayMinutes,
            stopOnCustomerReply: rule.stopOnCustomerReply,
            stopOnLeadClosed: rule.stopOnLeadClosed,
            stopOnOptOut: rule.stopOnOptOut,
            enabled: rule.enabled,
          },
        });
      }

      this.logger.log(
        `[seedOrInheritNotificationSettings] Inherited ${sourceSettings.notificationRules.length} rule(s) from ${sourceLabel} → account ${savedAccountId}`,
      );
      return;
    }

    // First account, no source to inherit from — seed sane defaults.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { businessPhone: true },
    });

    const ownerTemplate =
      'New lead: {{lead.name}}\nPhone: {{lead.phone}}\nService: {{lead.service}}\nLocation: {{lead.location}}\nMessage: {{lead.message}}';
    const customerTemplate = `Hi {{lead.name}}, thanks for reaching out to ${businessName || '{{account.name}}'}! We got your request and we'll get back to you shortly.`;

    await this.prisma.notificationSettings.update({
      where: { savedAccountId },
      data: {
        enabled: true,
        userId,
        destinationPhone: user?.businessPhone ?? null,
        template: ownerTemplate,
        customerTextingEnabled: true,
      },
    });

    if (user?.businessPhone) {
      await this.prisma.notificationRule.create({
        data: {
          notificationSettingsId: existing.id,
          name: 'New Lead Alert',
          triggerType: 'new_lead',
          sendToCustomer: false,
          toPhone: user.businessPhone,
          template: ownerTemplate,
          delayMinutes: 0,
          enabled: true,
        },
      });
    }

    await this.prisma.notificationRule.create({
      data: {
        notificationSettingsId: existing.id,
        name: 'Auto-Reply to Customer',
        triggerType: 'new_lead',
        sendToCustomer: true,
        // `useAi` lives on AutomationRule, not NotificationRule. The
        // AI-first default for First Reply is enforced in the frontend
        // fallback (frontend/.../automation/Respond.tsx) — when no
        // AutomationRule exists for a fresh account, the page defaults
        // replyType to 'ai' instead of 'template'.
        template: customerTemplate,
        delayMinutes: 0,
        enabled: true,
      },
    });

    // V2 Instant Text AI default (2026-06-12).
    //
    // New accounts default to AI-generated SMS for Instant Text. The
    // resolver in notifications.service.resolveInstantTextMode treats a
    // missing instantTextMode key as 'template' (existing-tenant
    // back-compat), so we write 'ai' EXPLICITLY here for new tenants.
    // Existing tenants whose seedOrInherit was already called keep the
    // missing-key/'template' behavior until they save the toggle from
    // the Respond page.
    //
    // Merge-don't-replace: followUpSettingsJson may already carry other
    // keys (goal flags, qualification config) from the seed-or-inherit
    // path that ran for an earlier account on the same tenant.
    try {
      const existingAccount = await this.prisma.savedAccount.findUnique({
        where: { id: savedAccountId },
        select: { followUpSettingsJson: true },
      });
      const merged = {
        ...(existingAccount?.followUpSettingsJson
          ? JSON.parse(existingAccount.followUpSettingsJson)
          : {}),
        instantTextMode: 'ai',
      };
      await this.prisma.savedAccount.update({
        where: { id: savedAccountId },
        data: { followUpSettingsJson: JSON.stringify(merged) },
      });
    } catch (err: any) {
      this.logger.warn(
        `[seedOrInheritNotificationSettings] Failed to seed instantTextMode='ai' for ${savedAccountId}: ${err?.message ?? err}`,
      );
    }

    this.logger.log(
      `[seedOrInheritNotificationSettings] Seeded first-account defaults for ${savedAccountId} (businessPhone=${user?.businessPhone ? 'set' : 'unset'}, instantTextMode=ai)`,
    );
  }

  /**
   * Register a saved account in Sigcore's business identity model.
   * Creates/resolves: business → product_workspace → phone assets → asset links.
   * Idempotent — safe to call multiple times.
   */
  private async registerBusinessIdentityForAccount(
    savedAccountId: string,
    sigcoreApiKey: string,
    sigcoreUrl: string,
  ): Promise<void> {
    const account = await this.prisma.savedAccount.findUnique({
      where: { id: savedAccountId },
      include: { user: true },
    });
    if (!account?.user) return;

    const headers = { 'Content-Type': 'application/json', 'x-api-key': sigcoreApiKey };
    const user = account.user;

    // 1. Create/resolve business (idempotent by external_id)
    const bizResp = await fetch(`${sigcoreUrl}/v1/businesses`, {
      method: 'POST', headers,
      body: JSON.stringify({
        name: user.name || account.businessName || `LB User ${user.id}`,
        external_id: `lb-${user.id}`,
        main_email: user.email,
        main_phone: user.businessPhone || user.phoneNumber || undefined,
      }),
    });
    if (!bizResp.ok) return;
    const business = (await bizResp.json())?.data;
    if (!business?.id) return;

    // 2. Register product workspace (idempotent by product_type + external_workspace_id)
    const wsResp = await fetch(`${sigcoreUrl}/v1/businesses/${business.id}/workspaces`, {
      method: 'POST', headers,
      body: JSON.stringify({
        product_type: 'leadbridge',
        workspace_name: account.businessName || 'LeadBridge',
        external_workspace_id: user.id,
      }),
    });
    const workspace = wsResp.ok ? (await wsResp.json())?.data : null;

    // 3. Update user record if not already set
    if (business.id && (!user.sigcoreBusinessId || !user.sigcoreWorkspaceId)) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          sigcoreBusinessId: user.sigcoreBusinessId || business.id,
          sigcoreWorkspaceId: user.sigcoreWorkspaceId || workspace?.id || null,
        },
      });
    }

    // 4. Register assigned phone numbers as shared assets
    const phoneNumbers = await this.prisma.tenantPhoneNumber.findMany({
      where: { savedAccountId, status: 'ACTIVE' },
    });

    for (const pn of phoneNumbers) {
      try {
        const assetResp = await fetch(`${sigcoreUrl}/v1/assets`, {
          method: 'POST', headers,
          body: JSON.stringify({
            asset_type: 'phone',
            normalized_value: pn.phoneNumber,
            provider: 'twilio',
          }),
        });
        if (!assetResp.ok) continue;
        const asset = (await assetResp.json())?.data;
        if (!asset?.id || !workspace?.id) continue;

        await fetch(`${sigcoreUrl}/v1/assets/${asset.id}/links`, {
          method: 'POST', headers,
          body: JSON.stringify({
            workspace_id: workspace.id,
            role: 'leadbridge_assigned_number',
            purpose: 'lead_capture',
            is_primary: false,
          }),
        });
      } catch (e) {
        this.logger.warn(`[BusinessIdentity] Phone asset link failed for ${pn.phoneNumber}: ${e.message}`);
      }
    }

    this.logger.log(`[BusinessIdentity] Registered account ${savedAccountId} (business=${business.id}, workspace=${workspace?.id}, phones=${phoneNumbers.length})`);
  }

  /**
   * Get decrypted credentials for a specific saved account
   */
  async getAccountCredentials(userId: string, accountId: string): Promise<{ accessToken: string; refreshToken?: string; email?: string } | null> {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: accountId, userId },
    });

    if (!account?.credentialsJson) {
      return null;
    }

    try {
      return EncryptionUtil.decryptObject(account.credentialsJson, this.encryptionKey);
    } catch {
      return null;
    }
  }

  /**
   * Update credentials for an existing saved account (e.g., after token refresh).
   *
   * Uses `updateMany` instead of `update` on the persist path. `updateMany`
   * emits no RETURNING clause, so the write succeeds even if Prisma's model
   * has columns the DB hasn't received yet (schema/code drift after a deploy
   * where the migration step ran but the new column wasn't applied to prod).
   * The token-refresh path MUST stay write-clean because TT rotates refresh
   * tokens on use — a failed persist after a successful API refresh
   * permanently kills the account. See 2026-06-16 PR-E cascade incident.
   */
  async updateAccountCredentials(
    accountId: string,
    credentials: { accessToken: string; refreshToken?: string; email?: string; expiresAt?: Date },
  ): Promise<void> {
    const encryptedCredentials = EncryptionUtil.encryptObject(credentials, this.encryptionKey);

    const persisted = await this.prisma.savedAccount.updateMany({
      where: { id: accountId },
      data: {
        credentialsJson: encryptedCredentials,
        lastUsedAt: new Date(),
      },
    });
    if (persisted.count === 0) {
      throw new Error(`updateAccountCredentials: no SavedAccount with id ${accountId}`);
    }

    // Fetch the minimum fields we need for downstream branches via an
    // explicit `select`, which (unlike default `findUnique`) bounds the
    // SELECT projection — also schema-drift safe.
    const account = await this.prisma.savedAccount.findUnique({
      where: { id: accountId },
      select: { id: true, userId: true, platform: true },
    });
    if (!account) return;

    // For Yelp: one user has one OAuth token shared across all businesses.
    // When one account's token is refreshed, update ALL sibling Yelp accounts
    // to prevent token chain revocation (refreshing account B invalidates A's token).
    if (account.platform === 'yelp') {
      await this.prisma.savedAccount.updateMany({
        where: {
          userId: account.userId,
          platform: 'yelp',
          id: { not: accountId },
        },
        data: { credentialsJson: encryptedCredentials },
      });
    }

    // Token refresh flips tokenDead from true → false. Invalidate so the
    // sanitized list reflects the live token state.
    await this.invalidateSavedAccountsCache(account.userId);
  }

  /**
   * Get decrypted credentials for a saved account by businessId
   * Automatically refreshes expired tokens
   */
  async getAccountCredentialsByBusinessId(userId: string, platform: string, businessId: string, forceRefresh = false): Promise<{ accessToken: string; refreshToken?: string; email?: string } | null> {
    const account = await this.prisma.savedAccount.findFirst({
      where: { userId, platform, businessId },
    });

    if (!account?.credentialsJson) {
      return null;
    }

    try {
      const credentials = EncryptionUtil.decryptObject<{ accessToken: string; refreshToken?: string; email?: string; expiresAt?: string }>(
        account.credentialsJson,
        this.encryptionKey,
      );

      // Check if token is expired and refresh if needed
      if (credentials.refreshToken && (forceRefresh || credentials.expiresAt)) {
        const expiresAt = credentials.expiresAt ? new Date(credentials.expiresAt) : new Date(0);
        const bufferMs = 5 * 60 * 1000; // 5 minutes buffer
        const now = new Date();

        if (forceRefresh || now.getTime() > (expiresAt.getTime() - bufferMs)) {
          this.logger.log(`[Credentials] Token expired for ${platform}/${businessId}, refreshing...`);

          // Yelp: one token per user — lock by user to prevent chain revocation
          // Thumbtack: one token per business — lock by business
          const lockKey = platform === 'yelp' ? `yelp:user:${userId}` : `${platform}:${businessId}`;
          try {
            const refreshed = await this.serializedAccountRefresh(
              lockKey,
              account.id,
              platform,
              credentials.refreshToken,
              credentials.email,
            );

            this.logger.log(`[Credentials] Token refreshed for ${platform}/${businessId}`);
            return {
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
              email: credentials.email,
            };
          } catch (refreshError: any) {
            this.logger.error(`[Credentials] Failed to refresh ${platform}/${businessId}: ${refreshError.message}`);

            const savedAcct = await this.prisma.savedAccount.findFirst({ where: { userId, platform, businessId }, select: { id: true, businessName: true } }).catch(() => null);
            this.monitoring.captureError({
              category: 'token_refresh',
              message: `${platform} token refresh failed for business ${businessId} — ${refreshError.message}`,
              userId,
              accountId: savedAcct?.id,
              accountName: savedAcct?.businessName,
              context: { platform, businessId },
            });

            throw new Error(`${platform} token expired and could not be refreshed — please reconnect your account (${refreshError.message})`);
          }
        }
      }

      return credentials;
    } catch {
      return null;
    }
  }

  /**
   * Get all saved accounts for a user
   */
  async getSavedAccounts(userId: string, platform?: string): Promise<SafeSavedAccount[]> {
    return this.cache.getOrSet<SafeSavedAccount[]>(
      CacheKeys.savedAccounts(userId, platform),
      SAVED_ACCOUNTS_TTL_SECONDS,
      () => this.loadSavedAccounts(userId, platform),
    );
  }

  /**
   * Actual DB read + token-health computation. Never call directly — always
   * go through `getSavedAccounts` so responses flow through the sanitizer + cache.
   */
  private async loadSavedAccounts(userId: string, platform?: string): Promise<SafeSavedAccount[]> {
    const accounts = await this.prisma.savedAccount.findMany({
      where: {
        userId,
        ...(platform && { platform }),
      },
      orderBy: { lastUsedAt: 'desc' },
    });

    // Check token health via SystemErrorLog: an unresolved token_refresh error means
    // the refresh token is dead and the account needs reconnection.
    // NOTE: Do NOT use credential expiresAt — TT access tokens expire every hour and
    // are only refreshed on-demand. An expired access token is normal idle behavior,
    // not a dead token. SystemErrorLog records actual refresh failures.
    const ttAccounts = accounts.filter(a => a.platform === 'thumbtack');
    const ttAccountIds = ttAccounts.map(a => a.id);
    const ttAccountNames = ttAccounts.map(a => a.businessName).filter(Boolean);
    const deadAccountIds = new Set<string>();

    if (ttAccountIds.length > 0) {
      const tokenErrors = await this.prisma.systemErrorLog.findMany({
        where: {
          category: 'token_refresh',
          resolved: false,
          OR: [
            // New errors: matched by accountId
            { accountId: { in: ttAccountIds } },
            // Old errors (accountId null): matched by name + user + platform in message
            { accountId: null, accountName: { in: ttAccountNames }, userId, message: { contains: 'thumbtack', mode: 'insensitive' as any } },
          ],
        },
        select: { accountId: true, accountName: true, createdAt: true },
      });
      // Map errors to account IDs
      const candidateDeadIds = new Set<string>();
      for (const err of tokenErrors) {
        if (err.accountId) {
          candidateDeadIds.add(err.accountId);
        } else if (err.accountName) {
          const match = ttAccounts.find(a => a.businessName === err.accountName);
          if (match) candidateDeadIds.add(match.id);
        }
      }

      // Filter out accounts where token was refreshed/reconnected AFTER the error
      for (const accId of candidateDeadIds) {
        const acc = ttAccounts.find(a => a.id === accId);
        if (!acc) continue;
        const accErrors = tokenErrors.filter(e => e.accountId === accId || e.accountName === acc.businessName);
        const latestErrorAt = Math.max(...accErrors.map(e => new Date(e.createdAt).getTime()));

        // Check 1: credentials have fresh expiresAt after error (reconnected/refreshed)
        let credsFreshAfterError = false;
        if (acc.credentialsJson) {
          try {
            const creds = EncryptionUtil.decryptObject<any>(acc.credentialsJson, this.encryptionKey);
            const expiresAt = creds.expiresAt ? new Date(creds.expiresAt).getTime() : 0;
            // If token expires in the future or was issued after the error, creds are fresh
            credsFreshAfterError = expiresAt > latestErrorAt;
          } catch { /* decryption failed — not fresh */ }
        }
        // Check 2: lead arrived after error (token worked)
        const leadAfter = !credsFreshAfterError ? await this.prisma.lead.findFirst({
          where: { userId, platform: 'thumbtack', businessId: acc.businessId, createdAt: { gt: new Date(latestErrorAt) } },
          select: { id: true },
        }) : null;

        if (credsFreshAfterError || leadAfter) {
          // Token is alive — resolve stale errors
          await this.prisma.systemErrorLog.updateMany({
            where: { category: 'token_refresh', resolved: false, OR: [{ accountId: accId }, { accountName: acc.businessName, userId }] },
            data: { resolved: true },
          }).catch(() => {});
        } else {
          deadAccountIds.add(accId);
        }
      }
    }

    if (deadAccountIds.size > 0) {
      const deadNames = accounts.filter(a => deadAccountIds.has(a.id)).map(a => a.businessName);
      this.logger.warn(`[getSavedAccounts] Dead tokens (unresolved token_refresh errors): ${deadNames.join(', ')}`);
    }

    // Strict whitelist sanitizer: never let credentialsJson or provider tokens
    // leave this method. See `SafeSavedAccount` for the contract.
    return accounts.map((a) => sanitizeSavedAccount(a, deadAccountIds.has(a.id)));
  }

  /**
   * Update a saved account
   *
   * `additionalAssociatePhones` is per-account and merged into
   * `followUpSettingsJson.additionalAssociatePhones`. Numbers are E.164-
   * normalized and dedup'd by phone. After save, fires
   * `syncAccountPhonesToThumbtack` for this business so newly-added entries
   * land on TT — but only for THIS business (per-business scope is the whole
   * point of moving the storage from User-level to SavedAccount-level).
   */
  async updateSavedAccount(
    userId: string,
    accountId: string,
    updates: {
      emailHint?: string;
      agentPhoneOverride?: string | null;
      additionalAssociatePhones?: Array<{ id?: string; phoneNumber: string; label?: string }>;
    },
  ): Promise<void> {
    let nextFollowUpSettingsJson: string | undefined;
    if (updates.additionalAssociatePhones !== undefined) {
      const current = await this.prisma.savedAccount.findFirst({
        where: { id: accountId, userId },
        select: { followUpSettingsJson: true },
      });
      let parsed: Record<string, any> = {};
      if (current?.followUpSettingsJson) {
        try {
          parsed = JSON.parse(current.followUpSettingsJson) ?? {};
          if (typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
        } catch {
          parsed = {};
        }
      }
      parsed.additionalAssociatePhones = normalizeAdditionalAssociatePhones(updates.additionalAssociatePhones);
      nextFollowUpSettingsJson = JSON.stringify(parsed);
    }

    await this.prisma.savedAccount.updateMany({
      where: {
        id: accountId,
        userId,
      },
      data: {
        ...(updates.emailHint !== undefined && { emailHint: updates.emailHint }),
        ...(updates.agentPhoneOverride !== undefined && { agentPhoneOverride: updates.agentPhoneOverride }),
        ...(nextFollowUpSettingsJson !== undefined && { followUpSettingsJson: nextFollowUpSettingsJson }),
      },
    });

    const ttBusinessId = (await this.prisma.savedAccount.findFirst({
      where: { id: accountId, userId, platform: 'thumbtack' },
      select: { businessId: true },
    }))?.businessId;

    // Sync TT associate phones (per-business) when EITHER the override changed
    // OR the additional list changed. ensureAssociatePhone is idempotent so
    // overlapping triggers don't duplicate POSTs. Non-blocking — TT failures
    // log but don't break the profile save.
    if (ttBusinessId && (updates.agentPhoneOverride || updates.additionalAssociatePhones !== undefined)) {
      this.syncAccountPhonesToThumbtack(userId, ttBusinessId, null, null).catch((err) =>
        this.logger.warn(
          `[tt.associate-phone] post-save sync-failed businessId=${ttBusinessId} userId=${userId} message="${err?.message ?? err}"`,
        ),
      );
    }

    await this.invalidateSavedAccountsCache(userId);
  }

  /**
   * Remove a saved account and optionally its leads/messages
   */
  async removeSavedAccount(userId: string, accountId: string, deleteLeads: boolean = false): Promise<{ deletedLeads: number }> {
    // First get the account to find the businessId
    const account = await this.prisma.savedAccount.findFirst({
      where: {
        id: accountId,
        userId,
      },
    });

    if (!account) {
      return { deletedLeads: 0 };
    }

    let deletedLeadsCount = 0;

    if (deleteLeads) {
      // Delete all leads for this business (messages will cascade via conversation)
      const leads = await this.prisma.lead.findMany({
        where: {
          userId,
          businessId: account.businessId,
        },
        select: { id: true, threadId: true },
      });

      // Delete conversations and their messages for these leads
      const conversationIds = leads.map(l => l.threadId).filter(Boolean) as string[];
      if (conversationIds.length > 0) {
        // Messages cascade delete with conversation
        await this.prisma.conversation.deleteMany({
          where: { id: { in: conversationIds } },
        });
      }

      // Delete the leads
      await this.prisma.lead.deleteMany({
        where: {
          userId,
          businessId: account.businessId,
        },
      });

      deletedLeadsCount = leads.length;
      console.log(`[PlatformService] Deleted ${leads.length} leads for account ${account.businessName}`);
    }

    // Deregister the platform-side webhook before we lose the
    // accountId/businessId/webhookId we need to call the adapter.
    // Best-effort: if the call fails (token expired, network blip,
    // already-deleted on the platform side), log + continue. Leaving
    // a stale webhook is preferable to silently failing the user's
    // explicit delete request.
    if (account.webhookId) {
      try {
        const adapter = this.platformFactory.getAdapter(account.platform) as any;
        if (typeof adapter?.deleteWebhook === 'function') {
          let credentials: { accessToken: string; refreshToken?: string };
          const accountCreds = await this.getAccountCredentials(userId, accountId);
          if (accountCreds) {
            credentials = accountCreds;
          } else {
            credentials = await this.getCredentials(userId, account.platform);
          }
          await adapter.deleteWebhook(credentials, account.businessId, account.webhookId);
          this.logger.log(`[removeSavedAccount] Deregistered ${account.platform} webhook ${account.webhookId} for ${account.businessName}`);
        }
      } catch (err: any) {
        this.logger.warn(`[removeSavedAccount] Webhook deregistration failed (continuing with local delete): ${err.message}`);
      }
    }

    // Clean up Sigcore tenant before deleting locally (cascades phone numbers, integrations, API keys)
    try {
      await this.notificationsService.deleteSigcoreTenant(accountId);
    } catch (err: any) {
      this.logger.warn(`[removeSavedAccount] Sigcore tenant cleanup failed: ${err.message}`);
    }

    // Unlink any TenantPhoneNumbers that reference this saved account
    // (no FK cascade since savedAccountId is a plain string)
    await this.prisma.tenantPhoneNumber.updateMany({
      where: { savedAccountId: accountId },
      data: { savedAccountId: null },
    });

    // Delete the saved account (cascades to NotificationSettings, CallConnectSettings, etc.)
    await this.prisma.savedAccount.delete({
      where: { id: accountId },
    });

    // If this was the user's last account, drop the account-bound
    // entries from their wizard checklist. The data behind those
    // steps lived inside the deleted SavedAccount (faqJson.quickFacts,
    // servicePricingJson, followUpSettingsJson) and is gone — leaving
    // the checklist saying `done` means the next reconnection lights
    // the progress bar at 50% even though the new account has none of
    // that configuration.
    try {
      const remaining = await this.prisma.savedAccount.count({ where: { userId } });
      if (remaining === 0) {
        const op = await this.prisma.onboardingProfile.findUnique({
          where: { userId },
          select: { wizardChecklistStatus: true },
        });
        const stored = (op?.wizardChecklistStatus as Record<string, string> | null) ?? {};
        const next: Record<string, string> = { ...stored };
        let changed = false;
        for (const step of ['connect', 'ai', 'pricing', 'automation', 'ai_rules']) {
          if (next[step] === 'done') { delete next[step]; changed = true; }
        }
        if (changed) {
          await this.prisma.onboardingProfile.update({
            where: { userId },
            data: { wizardChecklistStatus: next },
          });
          this.logger.log(`[removeSavedAccount] Cleared stale wizard checklist for user ${userId} (last account removed)`);
        }
      }
    } catch (err: any) {
      this.logger.warn(`[removeSavedAccount] Wizard checklist reset failed (non-fatal): ${err.message}`);
    }

    await this.invalidateSavedAccountsCache(userId);
    // BusinessId filter disappears from leads list — invalidate.
    await this.leadCache.invalidateLeadList(userId);

    this.logger.log(`[removeSavedAccount] Removed account ${account.businessName}`);
    return { deletedLeads: deletedLeadsCount };
  }

  /**
   * Update last used time for a saved account
   */
  async updateSavedAccountLastUsed(userId: string, platform: string, businessId: string): Promise<void> {
    await this.prisma.savedAccount.updateMany({
      where: {
        userId,
        platform,
        businessId,
      },
      data: {
        lastUsedAt: new Date(),
      },
    });
  }

  /**
   * Get a saved account by businessId (across all users)
   * Used to check if a business already has webhooks set up
   */
  async getAccountByBusinessId(platform: string, businessId: string) {
    return this.prisma.savedAccount.findFirst({
      where: {
        platform,
        businessId,
      },
    });
  }

  /**
   * "Is another tenant ACTIVELY bound to this business?" — used by the
   * OAuth duplicate-business guards. Excludes rows where webhookId is null
   * (the prior owner ran Disconnect but kept their SavedAccount for
   * later reconnect). Disconnected bindings shouldn't permanently lock a
   * business out from other tenants — only live ones do.
   *
   * The original owner can still reconnect via the same-userId path in
   * autoSetupWebhooks because that one matches by userId, not webhookId.
   */
  async getAccountByBusinessIdExcludingUser(platform: string, businessId: string, excludeUserId: string) {
    return this.prisma.savedAccount.findFirst({
      where: {
        platform,
        businessId,
        userId: { not: excludeUserId },
        webhookId: { not: null },
      },
    });
  }

  /**
   * Validate token for a saved account by making a simple API call
   * Returns { valid: true } if token works, or { valid: false, reason: string } if not
   */
  async validateAccountToken(userId: string, accountId: string): Promise<{ valid: boolean; reason?: string }> {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: accountId, userId },
    });

    if (!account) {
      return { valid: false, reason: 'Account not found' };
    }

    // Get credentials for this account
    const credentials = await this.getAccountCredentials(userId, accountId);
    if (!credentials) {
      return { valid: false, reason: 'No credentials stored for this account. Please reconnect.' };
    }

    const adapter = this.platformFactory.getAdapter(account.platform) as any;

    // Helper: try API call with given credentials
    const tryCall = async (creds: typeof credentials) => adapter.getBusinesses(creds);

    // First attempt
    try {
      await tryCall(credentials);
      return { valid: true };
    } catch (firstError: any) {
      const status = firstError.response?.status;
      const errMsg = firstError.message?.toLowerCase() || '';
      const isAuthError = status === 401 || errMsg.includes('unauthorized') || errMsg.includes('token') || errMsg.includes('expired') || errMsg.includes('invalid') || errMsg.includes('not active');

      if (!isAuthError) {
        return { valid: false, reason: firstError.message || 'Failed to validate token' };
      }

      // Auth error — try silent token refresh before giving up (use serialized lock!)
      console.log(`[PlatformService] Token invalid for account ${accountId}, attempting silent refresh...`);
      if (credentials.refreshToken) {
        try {
          const lockKey = `${account.platform}:${account.businessId}`;
          const refreshed = await this.serializedAccountRefresh(
            lockKey, accountId, account.platform, credentials.refreshToken, credentials.email,
          );
          await tryCall({ ...credentials, ...refreshed });
          console.log(`[PlatformService] Silent token refresh succeeded for account ${accountId}`);
          return { valid: true };
        } catch (refreshError: any) {
          console.log(`[PlatformService] Silent refresh failed: ${refreshError.message}`);
        }
      }

      return {
        valid: false,
        reason: 'Login required to import. Please log in to Thumbtack to import old leads. (New leads still arrive automatically.)',
      };
    }
  }

  /**
   * Sync saved accounts from existing leads
   * This backfills any accounts that have leads but aren't in saved_accounts
   */
  async syncSavedAccountsFromLeads(userId: string, platform: string): Promise<{ synced: number }> {
    // Get all unique businessIds from leads for this user/platform
    const leadsWithBusinesses = await this.prisma.lead.findMany({
      where: {
        userId,
        platform,
        businessId: { not: null },
      },
      select: {
        businessId: true,
        rawJson: true, // We'll try to extract business name from raw data
      },
      distinct: ['businessId'],
    });

    // Get existing saved accounts
    const existingSavedAccounts = await this.prisma.savedAccount.findMany({
      where: {
        userId,
        platform,
      },
      select: {
        businessId: true,
      },
    });

    const existingBusinessIds = new Set(existingSavedAccounts.map(a => a.businessId));

    // Find leads with businessIds that aren't in saved_accounts
    const missingAccounts = leadsWithBusinesses.filter(
      lead => lead.businessId && !existingBusinessIds.has(lead.businessId)
    );

    // Create saved accounts for missing ones
    let synced = 0;
    for (const lead of missingAccounts) {
      if (lead.businessId) {
        // Try to extract business name from rawJson
        let businessName = `Business ${lead.businessId.slice(-6)}`;
        try {
          const rawData = JSON.parse(lead.rawJson);
          // Thumbtack stores business info in the payload
          if (rawData.business?.name) {
            businessName = rawData.business.name;
          } else if (rawData.businessName) {
            businessName = rawData.businessName;
          }
        } catch {
          // Keep default name if parsing fails
        }

        await this.saveAccount(
          userId,
          platform,
          lead.businessId,
          businessName,
          undefined,
          undefined,
        );
        synced++;
        console.log(`[PlatformService] Synced saved account from leads: ${businessName} (${lead.businessId})`);
      }
    }

    return { synced };
  }

  /**
   * Get user by ID with role information
   */
  async getUserById(userId: string): Promise<{ id: string; role: string } | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
  }
}
