/**
 * Leads Service
 * Manages lead retrieval and synchronization across platforms
 */

import { Injectable, NotFoundException, BadRequestException, Logger, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/utils/prisma.service';
import { PlatformService } from '../platforms/platform.service';
import { PlatformFactory } from '../platforms/platform.factory';
import { EncryptionUtil } from '../common/utils/encryption.util';
import { NormalizedLead } from '../common/dto/normalized.dto';
import { TemplatesService } from '../templates/templates.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { ConversationContextService } from '../conversation-context/conversation-context.service';
import { ConversationRuntimeService } from '../conversation-context/conversation-runtime.service';
import {
  AI_STATUS_REASONS,
  CONVERSATION_STATE_REASONS,
} from '../conversation-context/conversation-runtime';
import { FollowUpEngineService } from '../follow-up-engine/follow-up-engine.service';
import { CrmWebhookService } from '../crm-webhooks/crm-webhook.service';
import { LeadStatusService } from './lead-status.service';
import { isSfLinkedLead } from './sf-link';
import { mapThumbtackToLbStatus } from '../integrations/thumbtack-status-map';
import { mapYelpToLbStatus } from '../integrations/yelp-status-map';
import { TrialService } from '../trial/trial.service';
import { LeadCacheService } from '../common/cache/lead-cache.service';
import { CacheService } from '../common/cache/cache.service';
import { CacheKeys } from '../common/cache/cache-keys';
import { extractYelpEventContent, isDisplayableYelpEvent, yelpEventSender } from '../platforms/yelp/yelp-event-content.util';
import { activityBucketFromThreadContext } from '../conversation-context/activity-bucket';

const LEAD_LIST_TTL_SECONDS = 30;
const LEAD_DETAIL_TTL_SECONDS = 60;
const LEAD_MESSAGES_TTL_SECONDS = 300; // 5 min — DB is authoritative; invalidated on every inbound/outbound write

// Phase 0 reservation for the DB-first / hot-window cache rollout. Exported for
// later phases (recurring sync, prewarm) to consume; not wired into this file
// yet so behavior is unchanged.
export const LEAD_MESSAGES_HOT_TTL_SECONDS = 600; // 10 min — recently opened conversation
export const LEAD_MESSAGES_WARM_TTL_SECONDS = 1800; // 30 min — active 7d / unread / follow-up-enrolled

/**
 * Strict whitelist of cache-eligible filter shapes for the leads list.
 *
 * Exported for direct unit testing — the function has no LeadsService-specific
 * dependencies and exercising it through the full service constructor is overkill.
 *
 * Returns true only when `filters` matches one of the two supported shapes:
 *   1. undefined / `{}` / all fields empty  → key `leads:user:{userId}`
 *   2. `{ businessId: string }` only         → key `leads:user:{userId}:biz:{businessId}`
 *
 * ANY other key (`platform`, `status`, `limit`, or a future field) → false.
 * Filter keys are WHITELISTED: adding a new field to the filter type will
 * automatically bypass the cache instead of silently poisoning an existing key.
 */
export function isCacheableLeadFilter(
  filters?: { platform?: string; status?: string; businessId?: string; limit?: number } & Record<string, unknown>,
): boolean {
  if (!filters) return true;

  const ALLOWED_KEYS = new Set(['businessId']);
  const setKeys = Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key]) => key);

  for (const key of setKeys) {
    if (!ALLOWED_KEYS.has(key)) return false;
  }

  // businessId, when set, must be a non-empty string — defensive against `0`,
  // `false`, or other truthy-but-invalid inputs.
  if (setKeys.includes('businessId') && typeof filters.businessId !== 'string') {
    return false;
  }

  return true;
}

/**
 * Map a platform-native status string to the LB canonical pipeline value. Returns
 * `null` for raw values that have no canonical equivalent (e.g. Thumbtack Partner
 * API "Open"/"Picked" — the granular UI states are extension-scraped separately).
 * Callers pair this with `LeadStatusService.writeStatus({ source: 'platform_sync' })`,
 * which writes platformStatus unconditionally and only updates Lead.status when
 * a canonical value is supplied.
 */
function mapPlatformRawToLb(platform: string, raw: string): string | null {
  if (platform === 'thumbtack') return mapThumbtackToLbStatus(raw);
  if (platform === 'yelp') return mapYelpToLbStatus(raw);
  return null;
}

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  // Lazy message sync — see `tryLazyMessageSync`. Per-process state, intentionally
  // not in Redis: cross-instance dedup is unnecessary because the upserts are
  // idempotent on (platform, externalMessageId), so duplicate runs cost nothing
  // beyond a wasted API call. Each instance enforces its own 60s rate limit.
  // Applies to Yelp (papers over webhook gaps) and Thumbtack (Pro-side messages
  // never webhook at all — backfill-on-customer-reply is the only other path).
  private readonly bgSyncLastAt = new Map<string, number>();
  private readonly bgSyncInflight = new Map<string, Promise<void>>();
  private static readonly BG_SYNC_RATE_LIMIT_MS = 60_000;
  private static readonly BG_SYNC_PLATFORMS = new Set(['yelp', 'thumbtack']);

  constructor(
    private prisma: PrismaService,
    private platformService: PlatformService,
    private platformFactory: PlatformFactory,
    private configService: ConfigService,
    private templatesService: TemplatesService,
    private analyticsService: AnalyticsService,
    private conversationContext: ConversationContextService,
    private conversationRuntime: ConversationRuntimeService,
    @Optional() @Inject(FollowUpEngineService) private followUpEngine: FollowUpEngineService | null,
    @Optional() @Inject(CrmWebhookService) private crmWebhookService: CrmWebhookService | null,
    private trialService: TrialService,
    private leadCache: LeadCacheService,
    private cache: CacheService,
    private leadStatusService: LeadStatusService,
  ) {}

  /**
   * Get businesses for a user from a specific platform (Thumbtack)
   */
  async getBusinesses(userId: string, platformName: string): Promise<any[]> {
    const credentials = await this.platformService.getCredentials(userId, platformName);
    const adapter = this.platformFactory.getAdapter(platformName) as any;

    if (typeof adapter.getBusinesses === 'function') {
      return await adapter.getBusinesses(credentials);
    }

    return [];
  }

  /**
   * Get leads for a user from a specific platform.
   *
   * Account-scope contract (see `src/common/account-scope/account-scope.util.ts`):
   *   - `options.businessId` set    → filter by (userId, platform, businessId)
   *   - `options.scope === 'all'`   → unified across all of the user's accounts
   *   - both omitted (legacy)       → unified, but caller is expected to be in
   *     transition mode (controller emits a warning header). Internal callers
   *     should always pass one of the two.
   */
  async getLeads(
    userId: string,
    platformName: string,
    options?: { businessId?: string; scope?: 'all'; limit?: number; since?: Date } & Record<string, any>,
  ): Promise<NormalizedLead[]> {
    const { businessId, scope, limit } = options || {};
    const isUnified = scope === 'all' || (!businessId && !scope);

    // For webhook-based platforms (Thumbtack, Yelp), query local database
    if (platformName === 'thumbtack' || platformName === 'yelp') {
      const leads = await this.getCachedLeads(userId, {
        platform: platformName,
        businessId: isUnified ? undefined : businessId,
        limit,
      });
      return leads;
    }

    // For API-based platforms, fetch from adapter and cache
    const credentials = await this.platformService.getCredentials(userId, platformName);
    const adapter = this.platformFactory.getAdapter(platformName);

    const leads = await adapter.getLeads(credentials, options);

    // Store/update leads in database
    for (const lead of leads) {
      await this.upsertLead(userId, lead);
    }

    return leads;
  }

  /**
   * Get all leads for a user from all connected platforms.
   *
   * Account-scope contract: `options.businessId` is forwarded to each per-platform
   * `getLeads` call. Because a Thumbtack businessId can never match a Yelp lead's
   * businessId column, passing `businessId` here naturally narrows the result to
   * the one platform that owns that account — no extra platform filter needed.
   */
  async getAllLeads(
    userId: string,
    options?: { businessId?: string; scope?: 'all'; limit?: number } & Record<string, any>,
  ): Promise<NormalizedLead[]> {
    const platforms = await this.platformService.getUserPlatforms(userId);
    const connectedPlatforms = platforms.filter((p) => p.connected);

    const allLeads: NormalizedLead[] = [];

    for (const platform of connectedPlatforms) {
      try {
        const leads = await this.getLeads(userId, platform.platformName, options);
        allLeads.push(...leads);
      } catch (error) {
        console.error(`Error fetching leads from ${platform.platformName}:`, error.message);
      }
    }

    // Sort by creation date, newest first
    return allLeads.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Get a single lead by ID
   */
  async getLead(userId: string, leadId: string): Promise<NormalizedLead> {
    return this.cache.getOrSet<NormalizedLead>(
      // Key is scoped to userId to prevent cross-tenant leakage of cached leads.
      CacheKeys.leadDetail(userId, leadId),
      LEAD_DETAIL_TTL_SECONDS,
      async () => {
        const lead = await this.prisma.lead.findFirst({
          where: {
            id: leadId,
            userId,
          },
        });

        if (!lead) {
          throw new NotFoundException('Lead not found');
        }

        const normalized = this.convertToNormalizedLead(lead);
        // Single-lead path: resolve activityBucket via a focused TC lookup.
        // Loads the same signal fields as the batched list path so the badge
        // freshness/handoff guards apply consistently.
        if (lead.threadId) {
          const tc = await this.prisma.threadContext.findUnique({
            where: { conversationId: lead.threadId },
            select: {
              conversationState: true,
              lastCustomerMessageAt: true,
              lastBusinessMessageAt: true,
              lastAiMessageAt: true,
              handoffRequestedAt: true,
              handoffResolvedAt: true,
            },
          });
          normalized.activityBucket = activityBucketFromThreadContext(
            tc?.conversationState ?? null,
            lead.status,
            tc ? {
              lastCustomerMessageAt: tc.lastCustomerMessageAt,
              lastBusinessMessageAt: tc.lastBusinessMessageAt,
              lastAiMessageAt: tc.lastAiMessageAt,
              handoffRequestedAt: tc.handoffRequestedAt,
              handoffResolvedAt: tc.handoffResolvedAt,
            } : undefined,
          );
        } else {
          normalized.activityBucket = activityBucketFromThreadContext(null, lead.status);
        }
        return normalized;
      },
    );
  }

  /**
   * Get lead from cached database
   * Returns all leads (no limit) to support date filtering across full history
   */
  async getCachedLeads(
    userId: string,
    filters?: { platform?: string; status?: string; businessId?: string; limit?: number },
  ) {
    // STRICT cache eligibility — the filter object must exactly match one of
    // the two supported shapes. This protects against a future field being
    // added to the filter type: if someone later adds e.g. `dateRange`, it
    // will automatically bypass the cache instead of silently poisoning the
    // no-filter key.
    const isCacheable = this.isCacheableLeadFilter(filters);

    const loader = async () => {
      const queryOptions: any = {
        where: {
          userId,
          ...(filters?.platform && { platform: filters.platform }),
          ...(filters?.status && { status: filters.status }),
          ...(filters?.businessId && { businessId: filters.businessId }),
        },
        include: {
          conversation: {
            select: {
              id: true,
              lastMessageAt: true,
              // Latest message on the conversation. Cache invalidates whenever
              // a webhook stores a new message (see invalidateLeadMessagesAndList),
              // so this stays fresh without extra plumbing.
              messages: {
                orderBy: { sentAt: 'desc' },
                take: 1,
                select: { content: true, sender: true, sentAt: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      };

      // Only apply limit if explicitly specified
      // Note: We don't use a default limit to allow date filtering across all leads
      if (filters?.limit) {
        queryOptions.take = filters.limit;
      }

      const leads = await this.prisma.lead.findMany(queryOptions);

      const convIds = leads.map((l: any) => l.conversation?.id).filter(Boolean);

      // Compute isAutoHandled per conversation in a single distinct query —
      // far cheaper than expanding the messages include. We only need the set
      // of (sender, senderType) tuples that exist per conversation.
      const autoHandledByConv = await this.computeAutoHandledFlags(convIds);

      // Batched ThreadContext lookup for activity-bucket derivation. Loads
      // conversationState + freshness/handoff signal fields. Done as a separate
      // query (not Prisma include) so the existing leads-list cache contract
      // stays unchanged.
      const tcSignalsByConvId = await this.loadTcSignalsByConvId(convIds);

      return leads.map((lead: any) => {
        const normalized = this.convertToNormalizedLead(lead);
        const convId = lead.conversation?.id;
        normalized.isAutoHandled = convId ? autoHandledByConv.get(convId) ?? false : false;
        const tcSignals = convId ? tcSignalsByConvId.get(convId) : undefined;
        normalized.activityBucket = activityBucketFromThreadContext(
          tcSignals?.conversationState ?? null,
          lead.status,
          tcSignals ? {
            lastCustomerMessageAt: tcSignals.lastCustomerMessageAt,
            lastBusinessMessageAt: tcSignals.lastBusinessMessageAt,
            lastAiMessageAt: tcSignals.lastAiMessageAt,
            handoffRequestedAt: tcSignals.handoffRequestedAt,
            handoffResolvedAt: tcSignals.handoffResolvedAt,
          } : undefined,
        );
        return normalized;
      });
    };

    if (!isCacheable) return loader();

    return this.cache.getOrSet<NormalizedLead[]>(
      CacheKeys.leadsList(userId, filters?.businessId),
      LEAD_LIST_TTL_SECONDS,
      loader,
    );
  }

  /** See `isCacheableLeadFilter` standalone export below. */
  private isCacheableLeadFilter(
    filters?: { platform?: string; status?: string; businessId?: string; limit?: number },
  ): boolean {
    return isCacheableLeadFilter(filters);
  }

  /**
   * Post-cache enrichment: attach `businessName` (from SavedAccount) to every
   * lead in the array. Runs a single batched query over the unique
   * (platform, businessId) pairs and joins in memory — does not mutate or
   * pollute the leads list cache (which is keyed off filters, not enrichment).
   *
   * Why platform+businessId, not just businessId: Thumbtack and Yelp
   * businessIds occupy independent namespaces; collisions across platforms are
   * theoretically possible. Always key by both.
   *
   * Safe to call on already-enriched results — re-assigns the same value.
   * Leads with no businessId are returned unchanged. SavedAccount lookups
   * are scoped to `userId` so cross-tenant names cannot leak.
   */
  async enrichLeadsWithAccountInfo(
    userId: string,
    leads: NormalizedLead[],
  ): Promise<NormalizedLead[]> {
    if (!leads.length) return leads;

    const pairs = new Map<string, { platform: string; businessId: string }>();
    for (const lead of leads) {
      if (lead.businessId && lead.platform) {
        const key = `${lead.platform}:${lead.businessId}`;
        if (!pairs.has(key)) pairs.set(key, { platform: lead.platform, businessId: lead.businessId });
      }
    }
    if (pairs.size === 0) return leads;

    const businessIds = [...new Set([...pairs.values()].map((p) => p.businessId))];
    const accounts = await this.prisma.savedAccount.findMany({
      where: { userId, businessId: { in: businessIds } },
      select: { platform: true, businessId: true, businessName: true },
    });

    const nameMap = new Map<string, string>();
    for (const a of accounts) {
      if (a.businessId) nameMap.set(`${a.platform}:${a.businessId}`, a.businessName);
    }

    return leads.map((lead) => {
      if (!lead.businessId || !lead.platform) return lead;
      const name = nameMap.get(`${lead.platform}:${lead.businessId}`);
      return name ? { ...lead, businessName: name } : lead;
    });
  }

  /**
   * Get messages for a lead/negotiation.
   *
   * Wrapped in Redis (5-min TTL, userId-scoped key). Cache is invalidated on:
   *   - outbound send (`sendMessage`, `sendQuote`)
   *   - inbound SMS (event listener `onSmsInbound`)
   *   - Yelp NEW_EVENT webhook (explicit `invalidateLeadMessages` in webhooks.service)
   *   - resync / refetch paths
   *
   * Keeps the existing read strategy: Yelp → live Yelp API (authoritative for
   * customer replies; the webhook path records to ThreadContext but does NOT
   * persist Message rows), Thumbtack/SMS → local DB (webhook-persisted).
   *
   * `skipCache` bypasses Redis for this call (loader runs and result is still
   * written back to the cache on success). Used by the lead-click path so the
   * first paint after opening a lead is never served from a 5-min-stale snapshot.
   */
  async getMessages(userId: string, leadId: string, skipCache = false): Promise<any[]> {
    const t0 = Date.now();
    const shortLead = leadId.slice(0, 8);
    let wasCacheHit = true; // flipped to false inside the loader

    // Fire-and-forget: keep the read path on DB→Redis (cheap, instant) and let a
    // rate-limited background sync fill any gaps webhooks missed. When the sync
    // finds new rows, it invalidates the messages cache → emits `lead.messages.changed`
    // → the SSE handler in the frontend refetches → user sees the new messages
    // without clicking Refresh. Awaiting here would defeat the point.
    this.tryLazyMessageSync(userId, leadId);

    const result = await this.cache.getOrSet<any[]>(
      CacheKeys.leadMessages(userId, leadId),
      LEAD_MESSAGES_TTL_SECONDS,
      async () => {
        wasCacheHit = false;
        const loaderT0 = Date.now();

        // Single SQL statement: fetch lead + its conversation + all messages in one
        // DB round-trip via Prisma's relationLoadStrategy='join'. Without this opt-in,
        // Prisma's default findFirst({include:…}) emits 3 separate SELECTs (lead +
        // conversation + messages) — each its own round-trip. On Railway us-east4 →
        // Supabase us-west-2 (~200ms RTT) that compounds to ~600ms. Joining collapses
        // to one statement, ~200ms wire time. Server-side compute is sub-ms either way
        // (verified via EXPLAIN ANALYZE: messages bitmap heap scan + index sort = 0.1ms).
        const tDbStart = Date.now();
        const leadWithMessages = await this.prisma.lead.findFirst({
          relationLoadStrategy: 'join',
          where: { id: leadId, userId },
          include: {
            conversation: {
              include: {
                messages: { orderBy: { sentAt: 'asc' } },
              },
            },
          },
        });
        const tDbEnd = Date.now();

        if (!leadWithMessages) {
          this.logger.log(`[getMessages] MISS lead=${shortLead} NOT_FOUND db=${tDbEnd - tDbStart}ms`);
          throw new NotFoundException('Lead not found');
        }

        let messages: any[];
        let source: string;
        const dbMessages = leadWithMessages.conversation?.messages || [];

        if (dbMessages.length > 0) {
          messages = dbMessages.map(msg => this.formatMessageRow(msg));
          source = `db-combined(${tDbEnd - tDbStart}ms)`;
        } else if (leadWithMessages.platform === 'yelp') {
          // DB empty — fall back to live Yelp API (historical lead never webhook-synced,
          // or brand-new thread whose first message hasn't landed yet).
          const tYelpStart = Date.now();
          const yelpMessages = await this.getYelpMessages(userId, leadWithMessages);
          const tYelpEnd = Date.now();
          messages = yelpMessages;
          source = `yelp-api-fallback(db-${tDbEnd - tDbStart}ms-empty,api-${tYelpEnd - tYelpStart}ms)`;
        } else {
          messages = [];
          source = `db-combined(${tDbEnd - tDbStart}ms)-empty`;
        }

        this.logger.log(
          `[getMessages] MISS lead=${shortLead} platform=${leadWithMessages.platform} source=${source} loader-total=${Date.now() - loaderT0}ms count=${messages.length}${skipCache ? ' (cache-skipped)' : ''}`,
        );
        return messages;
      },
      { enabled: !skipCache },
    );

    const totalMs = Date.now() - t0;
    if (wasCacheHit && !skipCache) {
      this.logger.log(`[getMessages] HIT  lead=${shortLead} total=${totalMs}ms count=${result.length}`);
    } else {
      this.logger.log(`[getMessages] DONE lead=${shortLead} total=${totalMs}ms (see MISS line above)`);
    }
    return result;
  }

  private async getYelpMessages(userId: string, lead: any): Promise<any[]> {
    try {
      // Get OAuth credentials for this business
      const savedAccount = await this.prisma.savedAccount.findFirst({
        where: { userId, platform: 'yelp', businessId: lead.businessId },
      });

      if (!savedAccount?.credentialsJson) {
        console.log(`[LeadsService] No Yelp credentials for business ${lead.businessId}`);
        return [];
      }

      const encryptionKey = this.configService.get<string>('encryption.key') || '';
      let creds = EncryptionUtil.decryptObject<any>(savedAccount.credentialsJson, encryptionKey);
      const yelpAdapter = this.platformFactory.getAdapter('yelp') as any;
      let events: any[];
      try {
        events = await yelpAdapter.getLeadEvents({ accessToken: creds.accessToken }, lead.externalRequestId);
      } catch (fetchErr: any) {
        const is401 = fetchErr.message?.includes('401') || fetchErr.response?.status === 401;
        if (is401 && creds.refreshToken) {
          this.logger.log(`[Yelp Messages] Token 401 for ${lead.businessId}, refreshing via platformService...`);
          // Use platformService which syncs refreshed token to all sibling Yelp accounts
          const freshCreds = await this.platformService.getAccountCredentialsByBusinessId(userId, 'yelp', lead.businessId);
          if (freshCreds) {
            creds = { ...creds, accessToken: freshCreds.accessToken, refreshToken: freshCreds.refreshToken || creds.refreshToken };
            events = await yelpAdapter.getLeadEvents({ accessToken: freshCreds.accessToken }, lead.externalRequestId);
          } else {
            throw fetchErr;
          }
        } else {
          throw fetchErr;
        }
      }

      // Log event types for debugging
      const eventTypes = events.map((e: any) => `${e.event_type}(${e.user_type})`).join(', ');
      this.logger.log(`[Yelp] Events for ${lead.externalRequestId}: ${events.length} events — ${eventTypes}`);
      // Log non-TEXT events in detail
      events.filter((e: any) => e.event_type !== 'TEXT' && e.event_type !== 'RAQ_SUBMIT').forEach((e: any) => {
        this.logger.log(`[Yelp] Non-text event: type=${e.event_type} content=${JSON.stringify(e.event_content || {}).substring(0, 500)}`);
      });

      // Convert Yelp events to message format expected by frontend.
      // Display filter + content extraction live in yelp-event-content.util so the
      // webhook write path produces identical content (no drift).
      const displayEvents = events.filter(isDisplayableYelpEvent);
      const messages = displayEvents.map((e: any) => ({
        id: e.id,
        conversationId: lead.externalRequestId,
        platform: 'yelp',
        externalMessageId: e.id,
        sender: yelpEventSender(e),
        senderType: null as string | null, // Will be enriched from local DB below
        content: extractYelpEventContent(e),
        isRead: true,
        sentAt: e.time_created,
      })).filter((m: any) => m.content);

      // Enrich with senderType from local Message records (AI vs user distinction)
      if (lead.threadId) {
        const localMessages = await this.prisma.message.findMany({
          where: { conversationId: lead.threadId, sender: 'pro', senderType: { not: null } },
          select: { externalMessageId: true, senderType: true, content: true, sentAt: true },
        });
        const normalize = (s: string | null | undefined) =>
          (s || '')
            .trim()
            .replace(/\s+/g, ' ')
            .replace(/[—–]/g, '--')
            .replace(/[‘’]/g, "'")
            .replace(/[“”]/g, '"');
        const senderTypeMap = new Map(
          localMessages.filter(m => m.externalMessageId).map(m => [m.externalMessageId, m.senderType]),
        );
        let matchedByContent = 0;
        for (const msg of messages) {
          if (msg.sender !== 'pro') continue;
          // Primary match: externalMessageId
          let st = senderTypeMap.get(msg.externalMessageId);
          // Fallback 1: match by normalized content (for messages where Yelp returned
          // empty response and externalMessageId wasn't captured)
          if (!st) {
            const normalizedApi = normalize(msg.content);
            const match = localMessages.find(m => normalize(m.content) === normalizedApi);
            if (match) {
              st = match.senderType;
              matchedByContent++;
            }
          }
          if (st) msg.senderType = st;
        }
        if (matchedByContent > 0) {
          this.logger.log(`[getYelpMessages] Enriched ${matchedByContent} messages via content fallback for ${lead.threadId}`);
        }
      }

      // Sync Yelp messages to local Message table (non-blocking)
      // This enables buildContext() to find conversation history for AI previews
      if (messages.length > 0 && lead.threadId) {
        this.syncYelpMessagesToLocal(userId, lead, messages).catch(err =>
          console.error(`[LeadsService] Yelp message sync failed: ${err.message}`),
        );
      }

      return messages;
    } catch (err: any) {
      console.error(`[LeadsService] Failed to fetch Yelp messages: ${err.message}`);
      return [];
    }
  }

  /**
   * Lazy data-freshness for Yelp.
   *
   * Webhooks alone are not a reliable feed: events sent before LB connected the
   * Yelp account never arrived; events that landed during a deploy or Yelp
   * outage are gone; BIZ replies sent from biz.yelp.com only land if the
   * echo-path persist runs (and only on instances that have it). The result is
   * a DB that's "mostly" right with intermittent gaps.
   *
   * On every `getMessages(...)` for a Yelp lead we kick this off in the
   * background — non-blocking, rate-limited per leadId. The read path returns
   * whatever's in DB right now (instant). If the Yelp API turns up new events,
   * we upsert and call `invalidateLeadMessagesAndList`, which busts Redis AND
   * fires `lead.messages.changed.${userId}` on the SSE channel. The frontend
   * listener refetches and the user sees the new messages without clicking
   * Refresh.
   *
   * The 60s rate limit is per-process; cross-instance dedup is intentionally
   * absent because `ensureMessagePersisted` upserts on
   * `(platform, externalMessageId)` — duplicate runs across staging+prod cost
   * one wasted API call, no data corruption.
   */
  private tryLazyMessageSync(userId: string, leadId: string): void {
    const now = Date.now();
    const last = this.bgSyncLastAt.get(leadId);
    if (last !== undefined && now - last < LeadsService.BG_SYNC_RATE_LIMIT_MS) return;
    if (this.bgSyncInflight.has(leadId)) return;

    this.bgSyncLastAt.set(leadId, now);

    const promise = this.runLazyMessageSync(userId, leadId)
      .catch(err => this.logger.warn(`[bg_sync] failed lead=${leadId.slice(0, 8)}: ${err?.message || err}`))
      .finally(() => {
        this.bgSyncInflight.delete(leadId);
      });

    this.bgSyncInflight.set(leadId, promise);
  }

  private async runLazyMessageSync(userId: string, leadId: string): Promise<void> {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, userId },
      select: {
        id: true,
        platform: true,
        businessId: true,
        externalRequestId: true,
        threadId: true,
      },
    });
    if (!lead || !LeadsService.BG_SYNC_PLATFORMS.has(lead.platform)) return;
    if (!lead.threadId || !lead.businessId || !lead.externalRequestId) return;

    const platform = lead.platform;
    const tag = `[bg_sync platform=${platform}]`;

    // PlatformService.getAccountCredentialsByBusinessId returns auto-refreshed
    // tokens; `null` means no account is connected for this business.
    const credentials = await this.platformService
      .getAccountCredentialsByBusinessId(userId, platform, lead.businessId)
      .catch(() => null);
    if (!credentials?.accessToken) return;

    const adapter = this.platformFactory.getAdapter(platform) as any;
    if (typeof adapter.getConversation !== 'function') return;

    const tApiStart = Date.now();
    const messages: any[] = await adapter.getConversation(credentials, lead.externalRequestId).catch((err: any) => {
      this.logger.warn(`${tag} api failed lead=${leadId.slice(0, 8)}: ${err?.message || err}`);
      return [];
    });
    const apiMs = Date.now() - tApiStart;
    if (!Array.isArray(messages) || messages.length === 0) {
      this.logger.log(`${tag} lead=${leadId.slice(0, 8)} api=${apiMs}ms no_events`);
      return;
    }

    let created = 0;
    for (const msg of messages) {
      if (!msg?.externalMessageId) continue;
      const senderLc = String(msg.sender || '').toLowerCase();
      const sender: 'pro' | 'customer' = senderLc === 'pro' ? 'pro' : 'customer';
      try {
        const result = await this.conversationContext.ensureMessagePersisted({
          conversationId: lead.threadId,
          leadId: lead.id,
          userId,
          platform,
          externalMessageId: msg.externalMessageId,
          sender,
          senderType: sender === 'customer' ? 'customer' : undefined,
          content: msg.content || '',
          sentAt: msg.sentAt instanceof Date ? msg.sentAt : new Date(msg.sentAt),
          rawJson: msg.raw ? JSON.stringify(msg.raw) : undefined,
        });
        if (result?.created) created++;
      } catch (err: any) {
        this.logger.warn(`${tag} persist failed eventId=${msg.externalMessageId} lead=${leadId.slice(0, 8)}: ${err?.message || err}`);
      }
    }

    if (created > 0) {
      this.logger.log(`${tag} lead=${leadId.slice(0, 8)} api=${apiMs}ms created=${created} → invalidate+SSE`);
      await this.leadCache.invalidateLeadMessagesAndList(userId, leadId);
    } else {
      this.logger.log(`${tag} lead=${leadId.slice(0, 8)} api=${apiMs}ms scanned=${messages.length} no_new_rows`);
    }
  }

  /**
   * Sync Yelp API messages to local Message table + ThreadContext.
   *
   * Delegates to ConversationContextService.ensureMessagePersisted, which:
   *   - Dedups on (platform, externalMessageId) - re-runs are no-ops.
   *   - Backfills externalMessageId onto pre-existing synthetic rows
   *     (externalMessageId=null, senderType='ai'/'user' from sendMessage)
   *     when normalized content matches inside the backfill window. This is
   *     what prevents the AI-row + Platform-row duplicate in the UI when Yelp's
   *     POST /events response didn't return an event_id.
   *   - Calls recordMessage on first insert; backfills do NOT re-record (the
   *     original send already updated ThreadContext stats).
   */
  private async syncYelpMessagesToLocal(userId: string, lead: any, messages: any[]): Promise<void> {
    const conversationId = lead.threadId;
    if (!conversationId) return;

    for (const msg of messages) {
      const sender: 'pro' | 'customer' = msg.sender === 'customer' ? 'customer' : 'pro';
      try {
        await this.conversationContext.ensureMessagePersisted({
          conversationId,
          leadId: lead.id,
          userId,
          platform: 'yelp',
          externalMessageId: msg.externalMessageId,
          sender,
          // Don't pass senderType for outbound - the Yelp API can't distinguish
          // AI vs manual sends. If a synthetic row exists, ensureMessagePersisted
          // backfills it (preserving the original senderType). Fresh inserts get
          // senderType=null, which surfaces as "Platform" in the UI.
          senderType: sender === 'customer' ? 'customer' : undefined,
          content: msg.content,
          sentAt: new Date(msg.sentAt),
          rawJson: JSON.stringify(msg),
        });
      } catch (err: any) {
        this.logger.warn(
          `[syncYelpMessagesToLocal] persist failed eventId=${msg.externalMessageId}: ${err?.message || err}`,
        );
      }
    }
  }

  /**
   * Get messages from local database (stored via webhooks).
   * Kept for callers outside getMessages (e.g. legacy fallbacks). Uses two
   * round-trips — prefer the combined query inside `getMessages` for hot paths.
   */
  private async getLocalMessages(userId: string, platform: string, negotiationId: string): Promise<any[]> {
    // Find conversation by negotiationId (stored as externalThreadId)
    const conversation = await this.prisma.conversation.findUnique({
      where: {
        platform_externalThreadId: {
          platform,
          externalThreadId: negotiationId,
        },
      },
    });

    if (!conversation) {
      return [];
    }

    const messages = await this.prisma.message.findMany({
      where: {
        conversationId: conversation.id,
      },
      orderBy: { sentAt: 'asc' },
    });

    return messages.map(msg => this.formatMessageRow(msg));
  }

  /** Shape a raw Message row for the frontend contract. */
  private formatMessageRow(msg: any) {
    let raw: Record<string, any> = {};
    try {
      raw = msg.rawJson ? JSON.parse(msg.rawJson) : {};
    } catch (_e) {
      // Ignore parse errors
    }
    return {
      id: msg.id,
      conversationId: msg.conversationId,
      platform: msg.platform,
      externalMessageId: msg.externalMessageId,
      sender: msg.sender,
      senderType: msg.senderType || null,
      content: msg.content,
      isRead: msg.isRead,
      sentAt: msg.sentAt.toISOString(),
      deliveredAt: msg.deliveredAt?.toISOString(),
      notificationLogId: msg.notificationLogId || null,
      attachments: raw.attachments || [],
      raw,
    };
  }

  /**
   * Send a message to a lead
   * Also stores the sent message locally to ensure it appears even if webhook is delayed
   * Uses account-specific credentials when available for multi-account support
   */
  async sendMessage(
    userId: string,
    leadId: string,
    message: string,
    senderType: 'user' | 'ai' = 'user',
  ): Promise<any> {
    // Read lead from DB directly — do NOT call getLead() which triggers
    // getYelpMessages() → API calls → token refresh → chain revocation
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, userId } });
    if (!lead) throw new NotFoundException('Lead not found');

    // Trial paywall: pass lead.threadId so existing conversations get the 24h
    // grace; otherwise block. Applies to both manual ('user') and AI sends.
    const access = await this.trialService.canProcessLead(userId, lead.threadId ?? undefined);
    if (!access.allowed) {
      this.logger.log(`[sendMessage] BLOCKED user=${userId} lead=${leadId} reason=${access.reason}`);
      throw new BadRequestException('Your free trial has ended. Subscribe to a plan to keep messaging leads.');
    }

    // Get account-specific credentials first, then fall back to platform credentials
    let credentials: { accessToken: string; refreshToken?: string };
    if (lead.businessId) {
      const accountCreds = await this.platformService.getAccountCredentialsByBusinessId(userId, lead.platform, lead.businessId);
      if (accountCreds) {
        console.log(`[LeadsService] Using account-specific credentials for sending message (business: ${lead.businessId})`);
        credentials = accountCreds;
      } else {
        credentials = await this.platformService.getCredentials(userId, lead.platform);
      }
    } else {
      credentials = await this.platformService.getCredentials(userId, lead.platform);
    }
    const adapter = this.platformFactory.getAdapter(lead.platform);

    // Send message via platform adapter (with 401 retry for Yelp token refresh)
    let sentMessage;
    try {
      sentMessage = await adapter.sendMessage(credentials, lead.externalRequestId, message);
    } catch (err: any) {
      // Per-lead terminal state (e.g. customer archived) — not an auth failure. Don't try to refresh.
      if (err.message?.includes('archived')) {
        // Yelp's response on send-to-archived: HTTP 403 NOT_AUTHORIZED
        // `{description:"This customer has archived this project."}`. The
        // adapter normalizes this into an error message containing "archived".
        // That 403 is decisive ground truth — until now LB only learned about
        // Yelp archives via the Chrome extension scrape, leaving stale rows
        // (e.g. Allison C.: `engaged` in LB while archived on Yelp because
        // the extension hadn't run since 2026-05-06).
        //
        // Fire a platform_sync write so the next render shows "No hire" and
        // automation (follow-ups, AI replies, instant text) immediately
        // respects the terminal state. SF-link guard inside applyPlatformSync
        // still protects SF-managed leads; the deterministic sourceEventId
        // makes retries idempotent.
        if (lead.platform === 'yelp') {
          try {
            await this.leadStatusService.writeStatus({
              leadId,
              source: 'platform_sync',
              newStatus: 'lost',
              platformStatus: 'Archived',
              lostReason: 'hired_someone',
              actorType: 'system',
              actorName: 'yelp-send-403-archived',
              sourceEventId: `yelp_send_403_archived_${lead.externalRequestId}`,
              reason: 'yelp_send_403_archived',
            });
          } catch (statusErr: any) {
            // Never let a status-write failure mask the original send error.
            this.logger.warn(
              `[sendMessage] yelp archived-detected status write failed lead=${leadId} msg=${statusErr?.message ?? statusErr}`,
            );
          }
        }
        throw new BadRequestException(`Cannot send to ${lead.platform} lead: ${err.message}`);
      }
      const is403 = err.message?.includes('403') || err.message?.includes('NO_BUSINESS_ACCESS') || err.message?.includes('no_business_access') || err.message?.includes('NOT_AUTHORIZED');
      const is401 = err.message?.includes('401') || err.message?.includes('expired') || err.message?.includes('TOKEN_INVALID');

      // On 401/403: try refreshing token and retry once (Yelp tokens can be invalidated by sibling refreshes)
      if ((is401 || is403) && lead.businessId) {
        this.logger.log(`[sendMessage] 401 on ${lead.platform} send, attempting token refresh & retry...`);
        try {
          const freshCreds = await this.platformService.getAccountCredentialsByBusinessId(userId, lead.platform, lead.businessId, true);
          if (freshCreds) {
            sentMessage = await adapter.sendMessage(freshCreds, lead.externalRequestId, message);
            this.logger.log(`[sendMessage] Retry succeeded after token refresh`);
          } else {
            throw new BadRequestException(`${lead.platform} access denied — reconnect your account to re-authorize (${err.message})`);
          }
        } catch (retryErr: any) {
          if (retryErr instanceof BadRequestException) throw retryErr;
          throw new BadRequestException(`${lead.platform} access denied — reconnect your account to re-authorize (${retryErr.message})`);
        }
      } else if (is403 || is401) {
        throw new BadRequestException(`${lead.platform} access denied — reconnect your account to re-authorize (${err.message})`);
      } else {
        throw new BadRequestException(`Failed to send message: ${err.message}`);
      }
    }

    // Store the sent message locally
    // This ensures it appears immediately even if webhook is delayed
    try {
      // Find or create conversation
      let conversation = await this.prisma.conversation.findUnique({
        where: {
          platform_externalThreadId: {
            platform: lead.platform,
            externalThreadId: lead.externalRequestId,
          },
        },
      });

      if (!conversation) {
        conversation = await this.prisma.conversation.create({
          data: {
            userId,
            platform: lead.platform,
            externalThreadId: lead.externalRequestId,
            customerName: lead.customerName,
            lastMessageAt: new Date(),
            status: 'active',
          },
        });
      }

      // Link lead to conversation if not already linked (needed for Yelp leads
      // created before conversation support, and for lastMessageAt sorting)
      if (!lead.threadId) {
        await this.prisma.lead.update({
          where: { id: leadId },
          data: { threadId: conversation.id },
        }).catch(() => {}); // non-critical
      }

      // Atomic upsert — always stamps senderType ('ai' or 'user') regardless of
      // whether the row was created fresh or racing with another writer (webhook
      // echo, Yelp message sync, etc.). If senderType was already 'ai' or 'user',
      // we preserve it; null rows get stamped. This is what makes the UI badge
      // correctly distinguish AI from manual sends.
      if (sentMessage.externalMessageId) {
        await this.prisma.message.upsert({
          where: {
            platform_externalMessageId: {
              platform: lead.platform,
              externalMessageId: sentMessage.externalMessageId,
            },
          },
          create: {
            conversationId: conversation.id,
            userId,
            platform: lead.platform,
            externalMessageId: sentMessage.externalMessageId,
            sender: 'pro',
            senderType,
            content: message,
            isRead: true,
            sentAt: new Date(sentMessage.sentAt),
            rawJson: JSON.stringify(sentMessage),
          },
          update: {
            // Stamp senderType on existing rows only if they don't already have one.
            // Prisma doesn't support conditional updates natively, so we use raw
            // COALESCE via a separate updateMany below — this update() is a no-op
            // placeholder to make upsert idempotent.
          },
        });
        // COALESCE-style stamp: only overwrite when the column is NULL or
        // when the inbound webhook handler optimistically tagged it
        // 'manual' before our send-stamp landed (race: TT echoed the
        // message back to us before sendMessage's first upsert wrote
        // 'ai'/'user'). The manual stamp is a "we didn't write this"
        // heuristic — our send path is the authoritative source, so it
        // wins. Verified senderType 'ai'/'user' never gets clobbered.
        await this.prisma.message.updateMany({
          where: {
            platform: lead.platform,
            externalMessageId: sentMessage.externalMessageId,
            OR: [{ senderType: null }, { senderType: 'manual' }],
          },
          data: { senderType },
        });
      } else {
        // Yelp returned no event_id — fall back to plain create with a synthetic id.
        // Fine-grained deduplication via content match happens later in syncYelpMessagesToLocal.
        await this.prisma.message.create({
          data: {
            conversationId: conversation.id,
            userId,
            platform: lead.platform,
            externalMessageId: null,
            sender: 'pro',
            senderType,
            content: message,
            isRead: true,
            sentAt: new Date(sentMessage.sentAt),
            rawJson: JSON.stringify(sentMessage),
          },
        });
      }

      // Update thread context so AI previews have conversation history.
      // Pass the actual senderType ('ai' for follow-ups / auto-replies, 'user' for manual sends)
      // so downstream consumers can tell the two apart.
      this.conversationContext.recordMessage({
        conversationId: conversation.id,
        leadId: leadId,
        platform: lead.platform,
        sender: 'pro',
        senderType,
        content: message,
      }).catch(err => console.error(`[LeadsService] recordMessage failed: ${err.message}`));

      // Update conversation's lastMessageAt
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });

      // Every outbound send transitions conversationState because TC.state
      // is the source of truth that drives the Active sub-bucket badge
      // (engagement / ai_conversation / follow_up / human_handoff). Without
      // these writes the state stayed stuck at customer_replied or
      // human_handling and ~30% of "Human Handoff" badges in production
      // were stale (operator replied days ago, badge still red).
      //
      // user/manual sends:
      //   - Resolve any open handoff (mirrors Jessica Beasley 2026-06-08 fix).
      //   - aiStatus = paused_human (human is on the case; pause AI auto-reply).
      //   - conversationState = awaiting_customer  ← NOT human_handling.
      //     human_handling means "customer wants a human, no reply yet"; once
      //     the human has SENT a reply we are waiting for the customer, not
      //     the other way around.
      //
      // ai sends:
      //   - conversationState = ai_engaging (AI is actively replying;
      //     awaiting customer). Without this the state stayed customer_replied
      //     forever and badges read "Handoff ⚠" on a thread the AI is
      //     happily handling.
      if (senderType === 'user') {
        try {
          await this.conversationRuntime.resolveHandoff(conversation.id);
          await this.conversationRuntime.setState(conversation.id, {
            aiStatus: 'paused_human',
            aiStatusReason: AI_STATUS_REASONS.MANUAL_REPLY_WINDOW,
            conversationState: 'awaiting_customer',
            conversationStateReason: CONVERSATION_STATE_REASONS.MANUAL_REPLY,
          });
        } catch (err: any) {
          this.logger.warn(`[LeadsService] resolveHandoff/setState failed for conversation ${conversation.id}: ${err.message}`);
        }
      } else if (senderType === 'ai') {
        try {
          await this.conversationRuntime.setState(conversation.id, {
            conversationState: 'ai_engaging',
            conversationStateReason: CONVERSATION_STATE_REASONS.AI_REPLIED,
          });
        } catch (err: any) {
          this.logger.warn(`[LeadsService] AI setState failed for conversation ${conversation.id}: ${err.message}`);
        }
      }

      // Trial meter lives at the inbound webhook layer now — see
      // WebhooksService.handleNegotiationCreated / handleMessageCreated /
      // handleYelpNewEventInner. The counter measures inbound lead delivery,
      // not AI replies, so the simplest-plan tenants (alerts only, no AI)
      // also consume quota correctly.

      // Pro-reply pause: stop any active follow-up enrollment for this
      // conversation when a pro/user sent the message. Without this, a
      // manually-typed reply (SF Inbox click, LB operator action, bulk
      // message) is recorded as sender='pro' but the scheduler's stop
      // signal only fires on customer-replied events — so a previously
      // scheduled step would still fire later, producing a duplicate
      // message to the customer.
      //
      // Hard rule: skip for senderType='ai'. AI sends are the scheduler
      // firing a step inside its own active enrollment; stopping it
      // mid-step would kill the in-flight sequence. The same skip applies
      // to ALL AI senders that route through this method:
      //   - follow-up-scheduler.service.ts (drip steps)
      //   - automation.service.ts (rule.useAi === true)
      //   - follow-up-engine.controller.ts (preview-then-send AI branch)
      //
      // The auto-enroll block below still runs and may create a fresh
      // enrollment with a clock that starts now — i.e. "follow up only if
      // the customer goes silent from this point forward." That matches
      // operator expectation for SF Inbox sends.
      if (senderType !== 'ai' && conversation?.id && this.followUpEngine) {
        try {
          // sourceEventId dedup: when the same outbound send produces a
          // platform echo webhook that our webhook handler re-processes,
          // the second call no-ops. externalMessageId is the platform's
          // immutable id; fall back to leadId+timestamp when missing
          // (Yelp's POST response sometimes omits event_id).
          const dedupKey = sentMessage?.externalMessageId
            ? `proreply:msg:${sentMessage.externalMessageId}`
            : `proreply:lead:${leadId}:${Date.now()}`;
          await this.followUpEngine.handleProReply(conversation.id, {
            sourceEventId: dedupKey,
            actorType: 'sendMessage',
            actorId: senderType, // 'user' — distinguishes from 'webhook' / 'cron' etc.
          });
        } catch (err: any) {
          // Surface but don't fail the send — a stale/cancelled follow-up
          // step is recoverable; a failed outbound send already finished
          // by this point and the customer received the message.
          this.logger.warn(`[LeadsService] handleProReply failed for conversation ${conversation.id}: ${err.message}`);
        }
      }

      // After sending a business message, ensure a follow-up enrollment exists.
      // If the customer doesn't reply, the scheduler will send follow-ups.
      //
      // Interaction with the pro-reply pause above:
      //   - user sends: pause stopped the prior enrollment (if any), then
      //     this block creates a NEW enrollment whose clock starts now.
      //     Net effect: "follow-up only if customer goes silent from here."
      //   - ai sends:   pause is skipped, prior enrollment stays active,
      //     this block returns early (activeEnrollment found). Net effect:
      //     scheduler continues advancing its own sequence — unchanged.
      if (conversation?.id && this.followUpEngine) {
        (async () => {
          try {
            const activeEnrollment = await this.prisma.followUpEnrollment.findFirst({
              where: { conversationId: conversation!.id, status: 'active' },
            });
            if (activeEnrollment) return; // Already enrolled

            // Check if re-enroll on silence is enabled for this account
            if (lead.businessId) {
              const acct = await this.prisma.savedAccount.findFirst({
                where: { userId, businessId: lead.businessId },
                select: { followUpSettingsJson: true },
              });
              if (acct?.followUpSettingsJson) {
                try {
                  const s = JSON.parse(acct.followUpSettingsJson);
                  if (s.fuReEnrollOnSilence === false) return; // User disabled re-enrollment
                } catch {}
              }
            }

            // Check terminal lead status
            const s = (lead.status || '').toLowerCase();
            const ts = ((lead as any).thumbtackStatus || '').toLowerCase();
            const terminal = ['done', 'scheduled', 'in_progress', 'in progress', 'booked', 'hired', 'completed', 'archived', 'lost'];
            if (terminal.includes(s) || terminal.includes(ts)) return;

            const template = await this.prisma.followUpSequenceTemplate.findFirst({
              where: { userId, platform: lead.platform, enabled: true },
              orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
            });
            if (!template) return;

            await this.followUpEngine!.enrollInSequence(conversation!.id, template.id, lead.platform, leadId);
          } catch (err: any) {
            // Surfacing the error instead of silently swallowing — we had
            // an incident where a missing column silently broke every enrollment.
            this.logger.error(`[LeadsService] enrollInSequence failed for conversation ${conversation?.id}: ${err.message}`);
          }
        })();
      }

      // Emit CRM webhook for outbound message
      this.crmWebhookService?.emit(userId, 'message.sent', {
        userId, platform: lead.platform, businessId: lead.businessId,
        leadId, conversationId: conversation?.id,
        messageDirection: 'outbound', messageBody: message,
        messageSentAt: new Date(), messageSenderType: senderType,
      }).catch(() => {});
    } catch (err) {
      // Log but don't fail - message was sent successfully
      console.error('[LeadsService] Failed to store sent message locally:', err.message);
    }

    // Outbound send changes: Message row, Conversation.lastMessageAt, and possibly
    // Lead.threadId. Invalidate the list (order shifts by lastMessageAt), the
    // detail, and the messages thread.
    await this.leadCache.invalidateLeadMessagesAndList(userId, leadId);

    return sentMessage;
  }

  /**
   * Send a quote to a lead
   * Uses account-specific credentials when available for multi-account support
   */
  async sendQuote(
    userId: string,
    leadId: string,
    amount: number,
    description?: string,
  ): Promise<any> {
    const lead = await this.getLead(userId, leadId);

    // Get account-specific credentials first, then fall back to platform credentials
    let credentials: { accessToken: string; refreshToken?: string };
    if (lead.businessId) {
      const accountCreds = await this.platformService.getAccountCredentialsByBusinessId(userId, lead.platform, lead.businessId);
      if (accountCreds) {
        console.log(`[LeadsService] Using account-specific credentials for sending quote (business: ${lead.businessId})`);
        credentials = accountCreds;
      } else {
        credentials = await this.platformService.getCredentials(userId, lead.platform);
      }
    } else {
      credentials = await this.platformService.getCredentials(userId, lead.platform);
    }
    const adapter = this.platformFactory.getAdapter(lead.platform);

    const quote = await adapter.sendQuote(credentials, lead.externalRequestId, {
      amount,
      description,
    });

    // Update lead status to quoted via the central service so the transition
    // is audit-logged and goes through the canonical guard set.
    await this.leadStatusService.writeStatus({
      leadId,
      source: 'lb_automation',
      newStatus: 'quoted',
      reason: 'price_quoted',
      sourceEventId: `quote_${quote?.id ?? leadId}_${Date.now()}`,
      actorType: 'system',
    });
    await this.leadCache.invalidateLeadAndList(userId, leadId);

    return quote;
  }

  /**
   * Update lead status
   */
  async updateLeadStatus(userId: string, leadId: string, status: string): Promise<NormalizedLead> {
    const lead = await this.prisma.lead.updateMany({
      where: {
        id: leadId,
        userId,
      },
      data: { status },
    });

    if (lead.count === 0) {
      throw new NotFoundException('Lead not found');
    }

    await this.leadCache.invalidateLeadAndList(userId, leadId);

    return this.getLead(userId, leadId);
  }

  /**
   * Sync lead status from Thumbtack API
   * Fetches fresh data from Thumbtack and updates local database
   * Uses account-specific credentials when available for multi-account support
   */
  async syncLeadStatus(userId: string, leadId: string): Promise<NormalizedLead> {
    const lead = await this.getLead(userId, leadId);
    console.log(`[LeadsService] syncLeadStatus - leadId: ${leadId}, negotiationId: ${lead.externalRequestId}`);

    // Get account-specific credentials first, then fall back to platform credentials
    let credentials: { accessToken: string; refreshToken?: string } | null = null;
    if (lead.businessId) {
      credentials = await this.platformService.getAccountCredentialsByBusinessId(userId, lead.platform, lead.businessId);
      if (credentials) {
        console.log(`[LeadsService] Using account-specific credentials for sync (business: ${lead.businessId})`);
      }
    }

    // Fall back to platform credentials
    if (!credentials) {
      // Check if current connection matches the lead's business
      const platform = await this.prisma.platform.findFirst({
        where: {
          userId,
          platformName: lead.platform,
          connected: true,
        },
      });

      const isConnectedToRightAccount = platform?.externalBusinessId === lead.businessId;

      if (!isConnectedToRightAccount) {
        console.log(`[LeadsService] No credentials available for lead's account, cannot sync status`);
        return lead; // Return existing lead without sync
      }

      credentials = await this.platformService.getCredentials(userId, lead.platform);
    }

    try {
      const adapter = this.platformFactory.getAdapter(lead.platform) as any;

      if (typeof adapter.getLead !== 'function') {
        console.log(`[LeadsService] Adapter does not support getLead`);
        return lead;
      }

      // Fetch fresh negotiation data from Thumbtack
      const freshLead = await adapter.getLead(credentials, lead.externalRequestId);
      console.log(`[LeadsService] Fresh lead status from Thumbtack: ${freshLead.status}`);

      // Sync platform-native + canonical status through LeadStatusService so
      // every transition is audit-logged and gated by SF_STATUS_WINS / canonical
      // / dedup / stale-event guards.
      if (freshLead.status) {
        const mapped = mapPlatformRawToLb(lead.platform, freshLead.status);
        const result = await this.leadStatusService.writeStatus({
          leadId,
          source: 'platform_sync',
          platformStatus: freshLead.status,
          newStatus: mapped ?? undefined,
          actorType: 'platform_api',
        });
        if (result.applied) {
          await this.leadCache.invalidateLeadAndList(userId, leadId);
          console.log(`[LeadsService] Updated lead status via platform_sync: ${lead.status} -> ${result.status}`);
        } else if (result.skipReason && result.skipReason !== 'no_change') {
          console.log(`[LeadsService] syncLeadStatus skipReason=${result.skipReason} for lead ${leadId}`);
        }
      }

      return this.getLead(userId, leadId);
    } catch (error) {
      console.error(`[LeadsService] Error syncing lead status:`, error.message);
      return lead; // Return existing lead on error
    }
  }

  /**
   * Store/update lead in database
   * Note: threadId is NOT set here because it references Conversation.id (foreign key)
   * The negotiationID is stored in externalRequestId instead
   * Uses the original createdAt from the platform (Thumbtack) if available
   */
  private async upsertLead(userId: string, lead: NormalizedLead): Promise<void> {
    // Phone routing: this path comes from adapter.getLead (GET /negotiations/{id}).
    // For Thumbtack, that endpoint returns a substitute/forwarding number — never
    // the real one — so it must NOT overwrite Lead.customerPhone (owned by the
    // LEADS_V4 webhook). For other platforms (e.g. Yelp), GET returns the real
    // unmasked phone after opt-in, so behavior stays as it was.
    const isThumbtack = lead.platform === 'thumbtack';
    const phoneCreate = isThumbtack
      ? { customerPhone: null, customerPhoneSubstitute: lead.customerPhone ?? null }
      : { customerPhone: lead.customerPhone };
    const phoneUpdate = isThumbtack
      ? { customerPhoneSubstitute: lead.customerPhone ?? undefined }
      : { customerPhone: lead.customerPhone };

    // Lead.status is intentionally NOT set in this upsert. New rows default to
    // "new" via the Prisma schema; canonical status writes flow through
    // LeadStatusService.writeStatus below so every transition is audit-logged
    // and gated by SF_STATUS_WINS / canonical / dedup / stale-event guards.
    const stored = await this.prisma.lead.upsert({
      where: {
        platform_externalRequestId: {
          platform: lead.platform,
          externalRequestId: lead.externalRequestId,
        },
      },
      create: {
        userId,
        platform: lead.platform,
        businessId: lead.businessId,
        externalRequestId: lead.externalRequestId,
        customerName: lead.customerName,
        ...phoneCreate,
        customerEmail: lead.customerEmail,
        message: lead.message,
        budget: lead.budget,
        postcode: lead.postcode,
        city: lead.city,
        state: lead.state,
        category: lead.category,
        // status omitted — Prisma schema default 'new'; routed via writeStatus below.
        // threadId intentionally NOT set - it's a FK to Conversation table
        rawJson: JSON.stringify(lead.raw),
        // Use original createdAt from platform if available
        createdAt: lead.createdAt || new Date(),
      },
      update: {
        userId, // Update userId in case lead was imported by different user before
        businessId: lead.businessId,
        customerName: lead.customerName,
        ...phoneUpdate,
        customerEmail: lead.customerEmail,
        message: lead.message,
        budget: lead.budget,
        postcode: lead.postcode,
        city: lead.city,
        state: lead.state,
        category: lead.category,
        // status omitted — routed via writeStatus below.
        // threadId intentionally NOT updated - it's a FK to Conversation table
        rawJson: JSON.stringify(lead.raw),
        // Update createdAt to use original platform date (in case it was imported with wrong date before)
        createdAt: lead.createdAt || undefined,
      },
      select: { id: true },
    });

    if (lead.status) {
      const mapped = mapPlatformRawToLb(lead.platform, lead.status);
      await this.leadStatusService.writeStatus({
        leadId: stored.id,
        source: 'platform_sync',
        platformStatus: lead.status,
        newStatus: mapped ?? undefined,
        actorType: 'platform_api',
      });
    }
  }

  /**
   * Import a single Thumbtack negotiation by ID
   * Returns { lead, isNew } to indicate if this was a new import or update
   * Also imports and stores all messages for the negotiation
   * @param accountId - Optional saved account ID to associate the lead with the correct business
   */
  async importThumbtackNegotiation(userId: string, negotiationId: string, accountId?: string, opts?: { skipCacheInvalidate?: boolean }): Promise<{ lead: NormalizedLead; isNew: boolean }> {
    console.log(`[LeadsService] importThumbtackNegotiation - userId: ${userId}, negotiationId: ${negotiationId}, accountId: ${accountId}`);

    // If accountId provided, verify it belongs to this user and get the businessId and credentials
    let targetBusinessId: string | undefined;
    let accountCredentials: { accessToken: string; refreshToken?: string } | null = null;
    if (accountId) {
      const savedAccount = await this.prisma.savedAccount.findFirst({
        where: {
          id: accountId,
          userId,
          platform: 'thumbtack',
        },
      });
      if (savedAccount) {
        targetBusinessId = savedAccount.businessId;
        console.log(`[LeadsService] Using saved account: ${savedAccount.businessName} (businessId: ${targetBusinessId})`);

        // Get account-specific credentials with automatic token refresh
        try {
          accountCredentials = await this.platformService.getAccountCredentialsByBusinessId(userId, 'thumbtack', savedAccount.businessId);
          if (accountCredentials) {
            console.log(`[LeadsService] Using account-specific credentials for import (auto-refreshed if needed)`);
          }
        } catch (err) {
          console.warn(`[LeadsService] Failed to get account credentials:`, err.message);
        }
      } else {
        console.warn(`[LeadsService] Account ${accountId} not found for user ${userId}`);
      }
    }

    // Check if lead already exists in DB (regardless of userId - could be from webhook or different user)
    const existingLead = await this.prisma.lead.findFirst({
      where: {
        platform: 'thumbtack',
        externalRequestId: negotiationId,
      },
    });

    const isNew = !existingLead;
    console.log(`[LeadsService] Lead ${isNew ? 'is new' : 'already exists in DB'}${existingLead ? ` (owner: ${existingLead.userId})` : ''}`);

    // Cross-account guard: if the lead is already in our DB under a businessId
    // that doesn't match the operator-selected SavedAccount, skip the Partner
    // API fetch entirely. Hitting `/negotiations/:id` with the wrong account's
    // token would 403 and look like a generic failure to the operator, even
    // though we already have the lead. Mark the ThumbtackLeadId row
    // imported=true so it stops appearing in "pending from extension" and
    // throw a typed error so the controller can surface a soft-success.
    if (
      existingLead &&
      targetBusinessId &&
      existingLead.businessId &&
      existingLead.businessId !== targetBusinessId
    ) {
      const owner = await this.prisma.savedAccount.findFirst({
        where: { userId, platform: 'thumbtack', businessId: existingLead.businessId },
        select: { businessName: true },
      });
      await this.prisma.thumbtackLeadId.updateMany({
        where: { userId, thumbtackId: negotiationId },
        data: { imported: true, importedAt: new Date(), needsRefetch: false },
      });
      const ownerLabel = owner?.businessName ? `"${owner.businessName}"` : 'another connected Thumbtack account';
      const e: any = new Error(`THUMBTACK_OTHER_ACCOUNT: This lead is already imported under ${ownerLabel}.`);
      e.code = 'THUMBTACK_OTHER_ACCOUNT';
      e.ownerBusinessId = existingLead.businessId;
      e.ownerBusinessName = owner?.businessName ?? null;
      throw e;
    }

    // Use account-specific credentials if available, otherwise fall back to platform credentials
    let credentials: { accessToken: string; refreshToken?: string };
    if (accountCredentials) {
      credentials = accountCredentials;
    } else {
      credentials = await this.platformService.getCredentials(userId, 'thumbtack');
    }
    const adapter = this.platformFactory.getAdapter('thumbtack') as any;

    // Fetch negotiation from Thumbtack API
    let lead;
    try {
      lead = await adapter.getLead(credentials, negotiationId);
      console.log(`[LeadsService] Fetched lead from Thumbtack:`, JSON.stringify(lead));
    } catch (err: any) {
      // Wrong-scope (403): the token is valid but the negotiation belongs to
      // a different business. Mark the ThumbtackLeadId row imported=true so we
      // don't keep retrying and re-spamming /negotiations/:id with 403s, then
      // re-throw so the caller (controller / batch import) can record it.
      if (err?.code === 'THUMBTACK_WRONG_SCOPE') {
        await this.prisma.thumbtackLeadId.updateMany({
          where: { userId, thumbtackId: negotiationId },
          data: { imported: true, importedAt: new Date(), needsRefetch: false },
        });
        throw err;
      }

      const errMsg = err.message?.toLowerCase() || '';
      // Check if it's a token/auth error - re-throw with the message from adapter
      if (errMsg.includes('login required') || errMsg.includes('session') ||
          errMsg.includes('token') || errMsg.includes('unauthorized') || errMsg.includes('invalid') ||
          errMsg.includes('expired') || errMsg.includes('not active') || err.response?.status === 401) {
        throw err; // Re-throw the error from adapter which has a clear message
      }

      // When Thumbtack service is deleted, try to recover lead data from local sources
      if (err.message?.startsWith('THUMBTACK_SERVICE_DELETED')) {
        console.log(`[LeadsService] Service deleted for ${negotiationId} — attempting recovery from local sources`);

        // Source 1: ThumbtackLeadId — extension-scraped data includes customerName
        const capturedData = await this.prisma.thumbtackLeadId.findFirst({
          where: { userId, thumbtackId: negotiationId },
        });

        // Source 2: WebhookEvent — full payload if Thumbtack delivered this lead via webhook
        const webhookEvent = await this.prisma.webhookEvent.findFirst({
          where: { platform: 'thumbtack', eventType: 'NegotiationCreatedV4', payload: { contains: negotiationId } },
          orderBy: { receivedAt: 'desc' },
        });

        if (capturedData?.customerName || webhookEvent) {
          let customerName = capturedData?.customerName || 'Unknown';
          let createdAt = capturedData?.capturedAt || new Date();
          let message = '';
          let raw: any = null;
          let recoveredBusinessId = targetBusinessId;

          if (webhookEvent) {
            try {
              const wPayload = JSON.parse(webhookEvent.payload);
              const wData = wPayload.data || {};
              const cust = wData.customer || {};
              const req = wData.request || {};
              customerName = `${cust.firstName || ''} ${cust.lastName || ''}`.trim() || customerName;
              message = req.description || '';
              recoveredBusinessId = wData.business?.businessID || recoveredBusinessId;
              createdAt = wData.createdAt ? new Date(wData.createdAt) : createdAt;
              raw = wData;
            } catch { /* ignore parse errors */ }
          }

          lead = {
            id: '',
            platform: 'thumbtack',
            businessId: recoveredBusinessId,
            externalRequestId: negotiationId,
            customerName,
            message,
            status: capturedData?.thumbtackStatus || 'Unknown',
            createdAt,
            updatedAt: new Date(),
            raw,
          } as NormalizedLead;

          console.log(`[LeadsService] Recovered lead from local data: ${customerName} (${negotiationId})`);
          // Mark as needing page scrape — full details unavailable from API
          await this.prisma.thumbtackLeadId.updateMany({
            where: { userId, thumbtackId: negotiationId },
            data: { needsRefetch: true },
          });
          // Fall through — upsertLead below will store this recovered lead
        } else {
          throw err; // No local data to recover from — let controller skip gracefully
        }
      } else {
        // Re-throw other errors as-is
        throw err;
      }
    }

    // If we have a target businessId, verify the lead belongs to that business
    if (targetBusinessId && lead.businessId && lead.businessId !== targetBusinessId) {
      console.warn(`[LeadsService] Lead businessId (${lead.businessId}) doesn't match selected account (${targetBusinessId})`);
      // Still proceed - the API response tells us the actual businessId
    }

    // Store in database (upsert will update userId if different)
    await this.upsertLead(userId, lead);
    console.log(`[LeadsService] Lead upserted to database`);

    // Return the stored lead with DB ID
    const storedLead = await this.prisma.lead.findFirst({
      where: {
        platform: 'thumbtack',
        externalRequestId: negotiationId,
      },
    });

    if (!storedLead) {
      throw new NotFoundException('Lead not found after import');
    }

    // Copy thumbtackStatus from the extension-collected ThumbtackLeadId record
    // through LeadStatusService. Single writeStatus call carries both fields;
    // applyPlatformSync owns the SF_STATUS_WINS / completed-lock / pipeline-
    // downgrade guards and returns skipReason so we can log greppably.
    const collectedLead = await this.prisma.thumbtackLeadId.findFirst({
      where: { userId, thumbtackId: negotiationId },
    });
    const rawScraped = collectedLead?.thumbtackStatus;
    if (rawScraped) {
      const platformChanged =
        (storedLead.platformStatus ?? storedLead.thumbtackStatus) !== rawScraped;
      const mapped = mapThumbtackToLbStatus(rawScraped);
      const canonicalChanged = mapped !== null && mapped !== storedLead.status;

      if (platformChanged || canonicalChanged) {
        const normalized = (mapped ?? rawScraped)
          .toLowerCase()
          .trim()
          .replace(/\s+/g, '_');
        const sourceEventId = `tt_import_${storedLead.id}_${normalized}`;

        const result = await this.leadStatusService.writeStatus({
          leadId: storedLead.id,
          source: 'platform_sync',
          platformStatus: platformChanged ? rawScraped : undefined,
          newStatus: canonicalChanged ? mapped! : undefined,
          actorType: 'extension',
          sourceEventId,
        });

        if (result.skipReason) {
          console.log(
            `[LeadsService] TT import status sync lead=${storedLead.id} skipReason=${result.skipReason}`,
          );
        }
      }
    }

    // Also import messages for this negotiation using account-specific credentials if available
    await this.importMessagesForNegotiation(userId, 'thumbtack', negotiationId, storedLead.customerName, accountCredentials || undefined);

    // Invalidate analytics cache so insights reflects the new lead immediately
    if (isNew) {
      await this.analyticsService.invalidateCache(userId);
    }

    // Bulk caller (`importThumbtackNegotiations`) sets skipCacheInvalidate and
    // calls `invalidateLeadList(userId)` once after the loop — cheaper than
    // N delPatterns for large imports.
    if (!opts?.skipCacheInvalidate) {
      await this.leadCache.invalidateLeadAndList(userId, storedLead.id);
    }

    return { lead: this.convertToNormalizedLead(storedLead), isNew };
  }

  /**
   * Import and store messages for a negotiation from the API
   * @param accountCredentials - Optional account-specific credentials (for multi-login support)
   */
  private async importMessagesForNegotiation(
    userId: string,
    platform: string,
    negotiationId: string,
    customerName: string,
    accountCredentials?: { accessToken: string; refreshToken?: string },
  ): Promise<number> {
    console.log(`[LeadsService] Importing messages for negotiation: ${negotiationId}`);

    try {
      // Use account-specific credentials if provided, otherwise fall back to platform credentials
      let credentials: { accessToken: string; refreshToken?: string };
      if (accountCredentials) {
        console.log(`[LeadsService] Using account-specific credentials`);
        credentials = accountCredentials;
      } else {
        console.log(`[LeadsService] Getting credentials for user: ${userId}, platform: ${platform}`);
        credentials = await this.platformService.getCredentials(userId, platform);
      }
      console.log(`[LeadsService] Got credentials, accessToken present: ${!!credentials.accessToken}`);

      const adapter = this.platformFactory.getAdapter(platform) as any;

      if (typeof adapter.getConversation !== 'function') {
        console.log(`[LeadsService] Adapter does not support getConversation`);
        return 0;
      }

      console.log(`[LeadsService] Calling adapter.getConversation for negotiation: ${negotiationId}`);
      const messages = await adapter.getConversation(credentials, negotiationId);
      console.log(`[LeadsService] Fetched ${messages.length} messages from API`);

      if (messages.length === 0) {
        console.log(`[LeadsService] No messages found for negotiation ${negotiationId}`);
        return 0;
      }

      // Ensure conversation exists
      let conversation = await this.prisma.conversation.findUnique({
        where: {
          platform_externalThreadId: {
            platform,
            externalThreadId: negotiationId,
          },
        },
      });

      if (!conversation) {
        conversation = await this.prisma.conversation.create({
          data: {
            userId,
            platform,
            externalThreadId: negotiationId,
            customerName: customerName || 'Unknown',
            lastMessageAt: new Date(),
            status: 'active',
          },
        });
        console.log(`[LeadsService] Created conversation: ${conversation.id}`);

        // Link lead to conversation
        await this.prisma.lead.updateMany({
          where: {
            platform,
            externalRequestId: negotiationId,
          },
          data: { threadId: conversation.id },
        });
      }

      // Store each message using upsert to handle race conditions.
      // TC freshness fix 2026-06-11: track the MAX sentAt per sender bucket
      // so we can fan a single recordMessage call per bucket at end-of-loop.
      // Previously this loop wrote Message rows but bypassed recordMessage,
      // leaving TC.lastCustomerMessageAt / lastBusinessMessageAt stale on
      // every Yelp full-thread sync.
      let importedCount = 0;
      let maxCustomerAt: Date | null = null;
      let maxBusinessAt: Date | null = null;
      for (const msg of messages) {
        try {
          await this.prisma.message.upsert({
            where: {
              platform_externalMessageId: {
                platform,
                externalMessageId: msg.externalMessageId,
              },
            },
            create: {
              conversationId: conversation.id,
              userId,
              platform,
              externalMessageId: msg.externalMessageId,
              sender: msg.sender?.toLowerCase() || 'customer',
              content: msg.content || '',
              isRead: true, // Imported messages are considered read
              sentAt: new Date(msg.sentAt),
              rawJson: JSON.stringify(msg.raw || msg), // Include full raw data with attachments
            },
            update: {
              // Update rawJson to include latest data (attachments, etc)
              rawJson: JSON.stringify(msg.raw || msg),
            },
          });
          importedCount++;
          const ts = new Date(msg.sentAt);
          const senderLower = msg.sender?.toLowerCase() || 'customer';
          if (senderLower === 'customer') {
            if (!maxCustomerAt || ts > maxCustomerAt) maxCustomerAt = ts;
          } else if (senderLower === 'pro') {
            if (!maxBusinessAt || ts > maxBusinessAt) maxBusinessAt = ts;
          }
        } catch (error) {
          console.error(`[LeadsService] Error upserting message ${msg.externalMessageId}:`, error.message);
        }
      }
      if (maxCustomerAt) {
        await this.conversationContext.recordMessage({
          conversationId: conversation.id,
          leadId: undefined,
          platform,
          sender: 'customer',
          content: '[yelp-sync]',
          timestamp: maxCustomerAt,
        }).catch(err => console.warn(`[LeadsService] yelp-sync recordMessage(customer) failed for ${conversation.id}: ${err.message}`));
      }
      if (maxBusinessAt) {
        await this.conversationContext.recordMessage({
          conversationId: conversation.id,
          leadId: undefined,
          platform,
          sender: 'pro',
          // Synced pro messages are external (sent on Yelp by manager/bridge,
          // not via our send path). Stamp manual so isBusiness=true.
          senderType: 'manual',
          content: '[yelp-sync]',
          timestamp: maxBusinessAt,
        }).catch(err => console.warn(`[LeadsService] yelp-sync recordMessage(pro) failed for ${conversation.id}: ${err.message}`));
      }

      // Update conversation's lastMessageAt
      const lastMsg = messages[messages.length - 1];
      if (lastMsg) {
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: { lastMessageAt: new Date(lastMsg.sentAt) },
        });
      }

      console.log(`[LeadsService] Imported ${importedCount} messages for negotiation ${negotiationId}`);
      return importedCount;
    } catch (error) {
      console.error(`[LeadsService] Error importing messages:`, error.message);
      console.error(`[LeadsService] Full error:`, error);

      // Check if this is a 403 error (wrong account credentials)
      if (error.message?.includes('403') || error.message?.includes('Forbidden')) {
        throw new BadRequestException(
          'Cannot resync - this lead belongs to a different account. New messages still arrive via webhooks automatically.'
        );
      }

      // For other errors, don't throw - lead import succeeded, messages are optional
      return 0;
    }
  }

  /**
   * Patch a lead's details with data scraped from the Thumbtack page.
   * Used when the API was unavailable (service deleted) and the extension
   * scraped the individual lead page to fill in missing fields.
   */
  async patchLeadDetails(
    userId: string,
    thumbtackId: string,
    details: {
      budget?: number;
      city?: string;
      state?: string;
      postcode?: string;
      message?: string;
    },
  ) {
    const lead = await this.prisma.lead.findFirst({
      where: { platform: 'thumbtack', externalRequestId: thumbtackId, userId },
    });

    if (!lead) throw new NotFoundException(`Lead not found for thumbtackId ${thumbtackId}`);

    const updateData: any = {};
    if (details.budget != null) updateData.budget = details.budget;
    if (details.city) updateData.city = details.city;
    if (details.state) updateData.state = details.state;
    if (details.postcode) updateData.postcode = details.postcode;
    if (details.message) updateData.message = details.message;

    if (Object.keys(updateData).length > 0) {
      await this.prisma.lead.update({ where: { id: lead.id }, data: updateData });
      await this.leadCache.invalidateLeadAndList(userId, lead.id);
    }

    // Mark as no longer needing scrape
    await this.prisma.thumbtackLeadId.updateMany({
      where: { userId, thumbtackId },
      data: { needsRefetch: false },
    });

    return { ok: true, leadId: lead.id };
  }

  /**
   * Import multiple Thumbtack negotiations.
   *
   * Distinguishes three outcomes:
   *  - imported: lead row created or updated.
   *  - skipped:  THUMBTACK_OTHER_ACCOUNT (already in our DB under a different
   *              SavedAccount) or THUMBTACK_WRONG_SCOPE (Partner API 403 — lead
   *              belongs to a business not associated with the chosen token).
   *              Already marked imported=true on the ThumbtackLeadId row by the
   *              singular call so they stop appearing as pending.
   *  - failed:   anything else (auth required, unknown errors, etc.).
   */
  async importThumbtackNegotiations(
    userId: string,
    negotiationIds: string[],
    accountId?: string,
  ): Promise<{
    imported: number;
    failed: number;
    errors: string[];
    skipped: Array<{ id: string; reason: string; ownerBusinessName: string | null; message: string }>;
  }> {
    const results = {
      imported: 0,
      failed: 0,
      errors: [] as string[],
      skipped: [] as Array<{ id: string; reason: string; ownerBusinessName: string | null; message: string }>,
    };

    for (const negotiationId of negotiationIds) {
      try {
        await this.importThumbtackNegotiation(userId, negotiationId, accountId, { skipCacheInvalidate: true });
        results.imported++;
      } catch (error: any) {
        if (error?.code === 'THUMBTACK_OTHER_ACCOUNT' || error?.code === 'THUMBTACK_WRONG_SCOPE') {
          results.skipped.push({
            id: negotiationId,
            reason: error.code,
            ownerBusinessName: error.ownerBusinessName ?? null,
            message: error.message,
          });
          continue;
        }
        results.failed++;
        results.errors.push(`${negotiationId}: ${error.message}`);
      }
    }

    // One list-level invalidation for the whole batch. Do NOT invalidate each
    // lead detail — cold-miss is acceptable; the list is the hot path.
    if (results.imported > 0) {
      await this.leadCache.invalidateLeadList(userId);
    }

    return results;
  }

  /**
   * Convert database lead to normalized format
   */
  // Given a list of conversation IDs, return a map<convId, isAutoHandled>.
  //
  // Rule: AI sent the LATEST message in the conversation. Anything else
  // (customer reply, human reply, or no AI at all) means the lead needs the
  // user's attention.
  //
  //   HIDE: pure AI thread, OR human acted then AI followed up
  //   SHOW: customer just replied, human just replied (no AI follow-up yet),
  //         or a new lead awaiting first response
  //
  // Past human/customer activity doesn't matter — only what's most recent.
  // The earlier presence-based rule hid almost nothing because every TT/Yelp
  // lead has a customer initial-inquiry message that disqualified it.
  /**
   * Batched lookup of ThreadContext fields needed for activity-bucket derivation,
   * keyed by conversationId. Returns `conversationState` plus the freshness +
   * handoff signals the new (2026-06-11) human_handoff guards consume:
   *   - lastCustomerMessageAt vs lastBusinessMessageAt/lastAiMessageAt:
   *     suppress the Handoff badge once an outbound passes the customer's
   *     last message.
   *   - handoffRequestedAt vs handoffResolvedAt: suppress when resolved.
   *
   * Done as a separate query (not a Prisma include) so the existing leads-list
   * cache contract stays unchanged.
   */
  private async loadTcSignalsByConvId(
    conversationIds: string[],
  ): Promise<Map<string, {
    conversationState: string | null;
    lastCustomerMessageAt: Date | null;
    lastBusinessMessageAt: Date | null;
    lastAiMessageAt: Date | null;
    handoffRequestedAt: Date | null;
    handoffResolvedAt: Date | null;
  }>> {
    const map = new Map<string, {
      conversationState: string | null;
      lastCustomerMessageAt: Date | null;
      lastBusinessMessageAt: Date | null;
      lastAiMessageAt: Date | null;
      handoffRequestedAt: Date | null;
      handoffResolvedAt: Date | null;
    }>();
    if (conversationIds.length === 0) return map;
    const rows = await this.prisma.threadContext.findMany({
      where: { conversationId: { in: conversationIds } },
      select: {
        conversationId: true,
        conversationState: true,
        lastCustomerMessageAt: true,
        lastBusinessMessageAt: true,
        lastAiMessageAt: true,
        handoffRequestedAt: true,
        handoffResolvedAt: true,
      },
    });
    for (const r of rows) {
      map.set(r.conversationId, {
        conversationState: r.conversationState ?? null,
        lastCustomerMessageAt: r.lastCustomerMessageAt ?? null,
        lastBusinessMessageAt: r.lastBusinessMessageAt ?? null,
        lastAiMessageAt: r.lastAiMessageAt ?? null,
        handoffRequestedAt: r.handoffRequestedAt ?? null,
        handoffResolvedAt: r.handoffResolvedAt ?? null,
      });
    }
    return map;
  }

  private async computeAutoHandledFlags(
    conversationIds: string[],
  ): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    if (conversationIds.length === 0) return result;

    const rows = await this.prisma.message.findMany({
      where: { conversationId: { in: conversationIds } },
      select: { conversationId: true, sender: true, senderType: true, sentAt: true, createdAt: true },
    });

    type Slot = {
      lastAi: number | null;
      lastHuman: number | null;
      lastCustomer: number | null;
    };
    const presence = new Map<string, Slot>();
    for (const row of rows) {
      if (!row.conversationId) continue;
      const ts = (row.sentAt ?? row.createdAt)?.getTime() ?? null;
      if (ts === null) continue;
      const slot = presence.get(row.conversationId) ?? {
        lastAi: null,
        lastHuman: null,
        lastCustomer: null,
      };
      if (row.sender === 'customer') {
        if (slot.lastCustomer === null || ts > slot.lastCustomer) slot.lastCustomer = ts;
      } else if (row.sender === 'pro') {
        // senderType: 'ai' → AI send; 'user'/null/other → human send (matches
        // the UI convention in Messages.tsx where senderType !== 'ai' is
        // rendered as human/business).
        if (row.senderType === 'ai') {
          if (slot.lastAi === null || ts > slot.lastAi) slot.lastAi = ts;
        } else {
          if (slot.lastHuman === null || ts > slot.lastHuman) slot.lastHuman = ts;
        }
      }
      presence.set(row.conversationId, slot);
    }

    for (const [convId, slot] of presence) {
      // AI sent the latest message — its timestamp is strictly greater than
      // any human pro send and any customer message. nulls are treated as
      // -Infinity so they don't block the comparison.
      const isAuto =
        slot.lastAi !== null &&
        (slot.lastHuman === null || slot.lastAi > slot.lastHuman) &&
        (slot.lastCustomer === null || slot.lastAi > slot.lastCustomer);
      result.set(convId, isAuto);
    }
    return result;
  }

  private convertToNormalizedLead(lead: any): NormalizedLead {
    // Get lastMessageAt from conversation if available, otherwise use lead's createdAt
    const lastMessageAt = lead.conversation?.lastMessageAt || lead.createdAt;

    // Latest message on the conversation, when the include shape provides it.
    // getCachedLeads requests this (take:1, sentAt desc); single-lead reads
    // (getLead → cache.getOrSet) currently don't, so guard the access.
    const latestMsg = lead.conversation?.messages?.[0];
    const lastMessage = latestMsg
      ? { content: latestMsg.content, sender: latestMsg.sender, sentAt: latestMsg.sentAt }
      : undefined;

    return {
      id: lead.id,
      platform: lead.platform,
      businessId: lead.businessId, // Include businessId for multi-account filtering
      externalRequestId: lead.externalRequestId,
      customerName: lead.customerName,
      customerPhone: lead.customerPhone,
      customerPhoneSubstitute: lead.customerPhoneSubstitute ?? null,
      customerEmail: lead.customerEmail,
      message: lead.message,
      budget: lead.budget ? parseFloat(lead.budget.toString()) : undefined,
      postcode: lead.postcode,
      city: lead.city,
      state: lead.state,
      category: lead.category,
      status: lead.status as any,
      thumbtackStatus: lead.thumbtackStatus,
      threadId: lead.threadId,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      lastMessageAt: lastMessageAt, // Include lastMessageAt for sorting and display
      lastMessage,
      // SF-connected mode signals. `isSfLinked` uses the same predicate as the
      // status-write guards in LeadStatusService so the UI can't drift from
      // server-side rules. The raw link/outcome fields are exposed so the UI
      // can render badges (SF Customer, SF outcome) without a second round-trip.
      isSfLinked: isSfLinkedLead({
        sfJobId: lead.sfJobId,
        sfCustomerId: lead.sfCustomerId,
        syncStatus: lead.syncStatus,
      }),
      sfJobId: lead.sfJobId ?? null,
      sfCustomerId: lead.sfCustomerId ?? null,
      syncStatus: lead.syncStatus ?? null,
      sfJobOutcome: lead.sfJobOutcome ?? null,
      sfJobOutcomeAt: lead.sfJobOutcomeAt ?? null,
      // SF Lead identity (PR B). Surfaced for the SF Lead badge in the UI.
      // Deliberately excluded from `isSfLinked` — lead-only matches are
      // operationally LB-managed (status editor stays enabled, follow-ups
      // continue, AI/classifier unchanged). The badge is informational only.
      sfLeadId: lead.sfLeadId ?? null,
      sfLeadStageName: lead.sfLeadStageName ?? null,
      sfLeadMatchedAt: lead.sfLeadMatchedAt ?? null,
      raw: lead.rawJson ? JSON.parse(lead.rawJson) : undefined,
    };
  }

  /**
   * Clean up duplicate messages in a conversation
   * Keeps only the first message for each unique content+timestamp combo
   */
  async cleanupDuplicateMessages(conversationId: string): Promise<{ deleted: number }> {
    console.log(`[LeadsService] Cleaning up duplicate messages for conversation: ${conversationId}`);

    const messages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { sentAt: 'asc' },
    });

    const seen = new Map<string, string>(); // content+timestamp -> message id
    const toDelete: string[] = [];

    for (const msg of messages) {
      // Create a key from content and approximate timestamp (within 1 second)
      const timestamp = Math.floor(new Date(msg.sentAt).getTime() / 1000);
      const key = `${msg.content}:${timestamp}`;

      if (seen.has(key)) {
        // This is a duplicate, mark for deletion
        toDelete.push(msg.id);
      } else {
        seen.set(key, msg.id);
      }
    }

    if (toDelete.length > 0) {
      await this.prisma.message.deleteMany({
        where: { id: { in: toDelete } },
      });
      console.log(`[LeadsService] Deleted ${toDelete.length} duplicate messages`);
    }

    return { deleted: toDelete.length };
  }

  /**
   * Re-sync messages for a lead
   * If connected to the correct account, imports messages from Thumbtack API.
   * Also cleans up old synthetic messages.
   */

  /**
   * Re-fetch lead data from platform API (fixes "Unknown" leads from token failures)
   */
  async refetchLeadFromPlatform(userId: string, leadId: string): Promise<{ updated: boolean; customerName?: string }> {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, userId } });
    if (!lead) throw new Error('Lead not found');

    const credentials = lead.businessId
      ? await this.platformService.getAccountCredentialsByBusinessId(userId, lead.platform, lead.businessId)
      : await this.platformService.getCredentials(userId, lead.platform);

    if (!credentials) return { updated: false, customerName: lead.customerName };

    const adapter = this.platformFactory.getAdapter(lead.platform) as any;
    if (typeof adapter.getLead !== 'function') return { updated: false };

    this.logger.log(`Refetching lead ${leadId} (${lead.platform}/${lead.externalRequestId}) from API...`);
    const freshLead = await adapter.getLead(credentials, lead.externalRequestId);
    this.logger.log(`Refetch result: name=${freshLead.customerName}, category=${freshLead.category}, msg=${(freshLead.message || '').substring(0, 50)}`);

    // Phone routing: same rule as upsertLead — for Thumbtack the GET endpoint
    // returns a substitute number, never the real one. Route it to
    // customerPhoneSubstitute and leave customerPhone (webhook-owned) alone.
    const isThumbtack = lead.platform === 'thumbtack';
    const phonePatch = isThumbtack
      ? { customerPhoneSubstitute: freshLead.customerPhone || lead.customerPhoneSubstitute || undefined }
      : { customerPhone: freshLead.customerPhone || lead.customerPhone || undefined };

    // Non-status fields go through a plain update; status is routed below
    // through LeadStatusService so SF_STATUS_WINS / canonical / dedup guards
    // apply consistently.
    await this.prisma.lead.update({
      where: { id: leadId },
      data: {
        customerName: freshLead.customerName || lead.customerName,
        ...phonePatch,
        customerEmail: freshLead.customerEmail || lead.customerEmail || undefined,
        message: freshLead.message || lead.message || undefined,
        category: freshLead.category || lead.category || undefined,
        city: freshLead.city || lead.city || undefined,
        state: freshLead.state || lead.state || undefined,
        postcode: freshLead.postcode || lead.postcode || undefined,
        rawJson: JSON.stringify(freshLead.raw || {}),
      },
    });

    if (freshLead.status) {
      const mapped = mapPlatformRawToLb(lead.platform, freshLead.status);
      await this.leadStatusService.writeStatus({
        leadId,
        source: 'platform_sync',
        platformStatus: freshLead.status,
        newStatus: mapped ?? undefined,
        actorType: 'platform_api',
      });
    }

    this.logger.log(`Refetched lead ${leadId}: ${lead.customerName} → ${freshLead.customerName}`);
    await this.leadCache.invalidateLeadAndList(userId, leadId);
    return { updated: true, customerName: freshLead.customerName };
  }

  async resyncMessages(userId: string, leadId: string): Promise<{ cleaned: number; imported: number; statusUpdated: boolean }> {
    console.log(`[LeadsService] resyncMessages called - leadId: ${leadId}, userId: ${userId}`);

    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, userId },
    });

    if (!lead) {
      console.log(`[LeadsService] Lead not found: ${leadId}`);
      throw new NotFoundException('Lead not found');
    }

    // Re-fetch lead data if it's broken (Unknown name or missing data)
    if (lead.customerName === 'Unknown' || !lead.message || !lead.category) {
      try {
        const result = await this.refetchLeadFromPlatform(userId, leadId);
        this.logger.log(`Lead refetched during resync: updated=${result.updated}, name=${result.customerName}`);
      } catch (err: any) {
        this.logger.error(`Lead refetch FAILED during resync: ${err.message}`, err.stack);
      }
    }

    console.log(`[LeadsService] Found lead: ${lead.externalRequestId}, platform: ${lead.platform}, businessId: ${lead.businessId}`);

    // Get or create conversation
    let conversation = await this.prisma.conversation.findFirst({
      where: {
        platform: lead.platform,
        externalThreadId: lead.externalRequestId,
      },
    });

    if (!conversation) {
      // Create conversation if it doesn't exist
      conversation = await this.prisma.conversation.create({
        data: {
          userId,
          platform: lead.platform,
          externalThreadId: lead.externalRequestId,
          customerName: lead.customerName,
          lastMessageAt: new Date(),
          status: 'active',
        },
      });
      console.log(`[LeadsService] Created conversation: ${conversation.id}`);
    }

    // Clean up old synthetic messages (those with _initial suffix)
    const cleanedCount = await this.cleanupSyntheticMessages(conversation.id, lead.externalRequestId);

    // Try to get account-specific credentials first (with automatic token refresh)
    // Using PlatformService methods ensures expired tokens are refreshed automatically
    let accountCredentials: { accessToken: string; refreshToken?: string } | null = null;

    if (lead.businessId) {
      try {
        // This method handles token refresh automatically
        accountCredentials = await this.platformService.getAccountCredentialsByBusinessId(userId, lead.platform, lead.businessId);
        if (accountCredentials) {
          console.log(`[LeadsService] Using account-specific credentials for business ${lead.businessId}`);
        }
      } catch (err: any) {
        console.warn(`[LeadsService] Failed to get account credentials:`, err.message);
      }
    }

    // If no account credentials, try platform credentials as fallback (also with token refresh)
    if (!accountCredentials) {
      try {
        // getCredentials handles token refresh automatically
        accountCredentials = await this.platformService.getCredentials(userId, lead.platform);
        console.log(`[LeadsService] Using platform credentials as fallback`);
      } catch (err: any) {
        console.warn(`[LeadsService] Failed to get platform credentials:`, err.message);
      }
    }

    const hasCredentials = !!accountCredentials;
    console.log(`[LeadsService] Has credentials: ${hasCredentials} for business ${lead.businessId || 'unknown'}`);

    let importedCount = 0;
    let statusUpdated = false;

    // If we have credentials, import messages and sync lead status from API
    if (hasCredentials && accountCredentials) {
      try {
        importedCount = await this.importMessagesForNegotiation(
          userId,
          lead.platform,
          lead.externalRequestId,
          lead.customerName,
          accountCredentials,
        );
        console.log(`[LeadsService] Imported ${importedCount} messages from API`);
      } catch (error) {
        console.error(`[LeadsService] Error importing messages:`, error.message);
        // Don't throw - return what we have
      }

      // Also sync lead status from API
      try {
        const adapter = this.platformFactory.getAdapter(lead.platform) as any;
        if (typeof adapter.getLead === 'function') {
          const freshLead = await adapter.getLead(accountCredentials, lead.externalRequestId);
          console.log(`[LeadsService] Fresh lead status from Thumbtack: ${freshLead.status}`);

          if (freshLead.status) {
            const mapped = mapPlatformRawToLb(lead.platform, freshLead.status);
            const result = await this.leadStatusService.writeStatus({
              leadId,
              source: 'platform_sync',
              platformStatus: freshLead.status,
              newStatus: mapped ?? undefined,
              actorType: 'platform_api',
            });
            if (result.applied) {
              console.log(`[LeadsService] Updated lead status via platform_sync: ${lead.status} -> ${result.status}`);
              statusUpdated = true;
            } else if (result.skipReason && result.skipReason !== 'no_change') {
              console.log(`[LeadsService] resyncMessages skipReason=${result.skipReason} for lead ${leadId}`);
            }
          }
        }
      } catch (error) {
        console.error(`[LeadsService] Error syncing lead status:`, error.message);
        // Don't throw - messages imported successfully
      }
    } else {
      // No credentials available - just return current message count
      const messageCount = await this.prisma.message.count({
        where: { conversationId: conversation.id },
      });
      console.log(`[LeadsService] No credentials available. Current messages in DB: ${messageCount}`);
      importedCount = messageCount;
    }

    if (cleanedCount > 0 || importedCount > 0 || statusUpdated) {
      await this.leadCache.invalidateLeadMessagesAndList(userId, leadId);
    }

    return { cleaned: cleanedCount, imported: importedCount, statusUpdated };
  }

  /**
   * Clean up old synthetic messages that were created before MessageCreatedV4 webhook
   * These have externalMessageId ending with '_initial' and duplicate the real first message
   */
  private async cleanupSyntheticMessages(conversationId: string, negotiationId: string): Promise<number> {
    // Find and delete synthetic messages (those with _initial suffix in externalMessageId)
    const syntheticMessageId = `${negotiationId}_initial`;

    const deleted = await this.prisma.message.deleteMany({
      where: {
        conversationId,
        externalMessageId: syntheticMessageId,
      },
    });

    if (deleted.count > 0) {
      console.log(`[LeadsService] Deleted ${deleted.count} synthetic message(s) for negotiation ${negotiationId}`);
    }

    return deleted.count;
  }

  /**
   * Clean up all synthetic messages across all conversations
   * One-time migration helper
   */
  async cleanupAllSyntheticMessages(): Promise<{ deleted: number }> {
    console.log(`[LeadsService] Cleaning up all synthetic messages...`);

    // Delete all messages where externalMessageId ends with '_initial'
    const deleted = await this.prisma.message.deleteMany({
      where: {
        externalMessageId: {
          endsWith: '_initial',
        },
      },
    });

    console.log(`[LeadsService] Deleted ${deleted.count} synthetic messages`);
    return { deleted: deleted.count };
  }

  /**
   * Migrate lead dates - reads createdAt from rawJson and updates the lead
   * One-time migration to fix leads that were imported with wrong dates
   */
  async migrateLeadDates(userId: string): Promise<{ updated: number; skipped: number; errors: string[] }> {
    console.log(`[LeadsService] Migrating lead dates for user: ${userId}`);

    const leads = await this.prisma.lead.findMany({
      where: { userId },
      select: { id: true, rawJson: true, createdAt: true, customerName: true },
    });

    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const lead of leads) {
      try {
        if (!lead.rawJson) {
          skipped++;
          continue;
        }

        const rawData = JSON.parse(lead.rawJson);
        const originalCreatedAt = rawData.createdAt;

        if (!originalCreatedAt) {
          skipped++;
          continue;
        }

        const newDate = new Date(originalCreatedAt);

        // Only update if the date is different (more than 1 day difference)
        const diffMs = Math.abs(lead.createdAt.getTime() - newDate.getTime());
        const diffDays = diffMs / (1000 * 60 * 60 * 24);

        if (diffDays > 1) {
          await this.prisma.lead.update({
            where: { id: lead.id },
            data: { createdAt: newDate },
          });
          console.log(`[LeadsService] Updated ${lead.customerName}: ${lead.createdAt.toISOString()} -> ${newDate.toISOString()}`);
          updated++;
        } else {
          skipped++;
        }
      } catch (err: any) {
        errors.push(`${lead.id}: ${err.message}`);
      }
    }

    console.log(`[LeadsService] Migration complete - updated: ${updated}, skipped: ${skipped}, errors: ${errors.length}`);
    if (updated > 0) {
      await this.leadCache.invalidateLeadList(userId);
    }
    return { updated, skipped, errors };
  }

  /**
   * Preview bulk message for multiple leads
   * Returns personalized messages for each lead
   */
  async previewBulkMessage(
    userId: string,
    leadIds: string[],
    templateContent: string,
  ): Promise<{
    leadId: string;
    customerName: string;
    personalizedMessage: string;
    canSend: boolean;
    error?: string;
  }[]> {
    console.log(`[LeadsService] previewBulkMessage - userId: ${userId}, leadIds: ${leadIds.length}, template: ${templateContent.substring(0, 50)}...`);

    const previews = [];

    for (const leadId of leadIds) {
      try {
        const lead = await this.prisma.lead.findFirst({
          where: { id: leadId, userId },
        });

        if (!lead) {
          previews.push({
            leadId,
            customerName: 'Unknown',
            personalizedMessage: '',
            canSend: false,
            error: 'Lead not found',
          });
          continue;
        }

        // Check if lead has a conversation thread
        const hasThread = !!lead.threadId;

        const personalizedMessage = this.templatesService.personalizeMessage(templateContent, {
          customerName: lead.customerName,
          category: lead.category,
          city: lead.city,
          state: lead.state,
        });

        previews.push({
          leadId,
          customerName: lead.customerName,
          personalizedMessage,
          canSend: hasThread,
          error: hasThread ? undefined : 'No conversation thread - cannot send message',
        });
      } catch (error) {
        previews.push({
          leadId,
          customerName: 'Unknown',
          personalizedMessage: '',
          canSend: false,
          error: error.message,
        });
      }
    }

    return previews;
  }

  /**
   * Send bulk messages to multiple leads
   * Uses throttling (500ms delay) to avoid rate limits
   */
  async sendBulkMessages(
    userId: string,
    leadIds: string[],
    templateContent: string,
    templateId?: string,
  ): Promise<{
    total: number;
    successful: number;
    failed: number;
    results: { leadId: string; success: boolean; error?: string }[];
  }> {
    console.log(`[LeadsService] sendBulkMessages - userId: ${userId}, leadIds: ${leadIds.length}`);

    const results: { leadId: string; success: boolean; error?: string }[] = [];
    let successful = 0;
    let failed = 0;

    for (let i = 0; i < leadIds.length; i++) {
      const leadId = leadIds[i];

      try {
        const lead = await this.prisma.lead.findFirst({
          where: { id: leadId, userId },
        });

        if (!lead) {
          results.push({ leadId, success: false, error: 'Lead not found' });
          failed++;
          continue;
        }

        if (!lead.threadId) {
          results.push({ leadId, success: false, error: 'No conversation thread' });
          failed++;
          continue;
        }

        // Personalize the message for this lead
        const personalizedMessage = this.templatesService.personalizeMessage(templateContent, {
          customerName: lead.customerName,
          category: lead.category,
          city: lead.city,
          state: lead.state,
        });

        // Send the message
        await this.sendMessage(userId, leadId, personalizedMessage);

        results.push({ leadId, success: true });
        successful++;

        // Throttle: wait 500ms between sends (except for last one)
        if (i < leadIds.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error) {
        results.push({ leadId, success: false, error: error.message });
        failed++;
      }
    }

    // Record template usage if a template ID was provided
    if (templateId) {
      await this.templatesService.recordUsage(userId, templateId);
    }

    console.log(`[LeadsService] Bulk send complete: ${successful} successful, ${failed} failed`);

    return {
      total: leadIds.length,
      successful,
      failed,
      results,
    };
  }
}
