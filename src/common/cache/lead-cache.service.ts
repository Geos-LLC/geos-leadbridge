import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { CacheService } from './cache.service';
import { CacheKeys } from './cache-keys';

/**
 * Centralized invalidation helpers for the leads cache.
 *
 * Feature code must go through these 5 helpers — never reach for `CacheService`
 * directly for lead-related keys. The helper names are the contract documented
 * in `docs/LEADS_CACHE_INVALIDATION.md`.
 *
 * All methods are safe when caching is disabled: `CacheService.isLive()` returns
 * false, and every helper short-circuits to a no-op. See the matching spec.
 */
@Injectable()
export class LeadCacheService {
  private readonly logger = new Logger(LeadCacheService.name);

  /**
   * `eventEmitter` is `@Optional()` so unit tests that construct this service
   * with `new LeadCacheService(cache)` still work — production wiring always
   * provides one via the AppModule's EventEmitterModule.
   */
  constructor(
    private readonly cache: CacheService,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  /** Invalidate the per-user leads list (all `businessId` partitions). */
  async invalidateLeadList(userId: string): Promise<void> {
    if (!userId) return;
    await this.cache.delPattern(CacheKeys.leadsListPattern(userId));
  }

  /**
   * Invalidate a single lead detail.
   * Pass both `userId` and `leadId` — the cache key is `lead:user:{userId}:{leadId}`
   * to prevent cross-tenant leakage.
   */
  async invalidateLeadDetail(userId: string, leadId: string): Promise<void> {
    if (!userId || !leadId) return;
    await this.cache.del(CacheKeys.leadDetail(userId, leadId));
  }

  /**
   * Invalidate the cached message thread for a lead.
   * Key includes userId (see `invalidateLeadDetail` for rationale).
   */
  async invalidateLeadMessages(userId: string, leadId: string): Promise<void> {
    if (!userId || !leadId) return;
    await this.cache.del(CacheKeys.leadMessages(userId, leadId));
  }

  /** Combined: list + detail. Most status/update paths use this. */
  async invalidateLeadAndList(userId: string, leadId: string): Promise<void> {
    if (!userId && !leadId) return;
    await Promise.all([
      userId ? this.cache.delPattern(CacheKeys.leadsListPattern(userId)) : Promise.resolve(),
      userId && leadId ? this.cache.del(CacheKeys.leadDetail(userId, leadId)) : Promise.resolve(),
    ]);
  }

  /**
   * Combined: list + detail + messages. Inbound/outbound message paths use this.
   *
   * Also emits `lead.messages.changed.${userId}` so the SSE stream can push the
   * change to any browser currently viewing the lead. Without this, a tab open
   * on the lead would wait until the user reopens it (or the 5-min Redis TTL
   * elapses) before showing the new message. The emit is non-blocking and only
   * fires when both userId and leadId are present.
   */
  async invalidateLeadMessagesAndList(userId: string, leadId: string): Promise<void> {
    if (!userId && !leadId) return;
    await Promise.all([
      userId ? this.cache.delPattern(CacheKeys.leadsListPattern(userId)) : Promise.resolve(),
      userId && leadId ? this.cache.del(CacheKeys.leadDetail(userId, leadId)) : Promise.resolve(),
      userId && leadId ? this.cache.del(CacheKeys.leadMessages(userId, leadId)) : Promise.resolve(),
    ]);
    if (this.eventEmitter && userId && leadId) {
      this.eventEmitter.emit(`lead.messages.changed.${userId}`, { userId, leadId });
    }
  }

  // ==========================================================================
  // Central event listeners — see docs/LEADS_CACHE_INVALIDATION.md §1, §3, §7.
  //
  // Wildcards are enabled in AppModule:
  //   `EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })`.
  //
  // In EventEmitter2 with `.` as delimiter, a single `*` matches EXACTLY ONE
  // segment between dots. So:
  //   `lead.created.*`         matches `lead.created.{userId}`   (3 segments)
  //   `lead.status.conflict.*` matches `lead.status.conflict.{userId}` (4 segments)
  //   `sms.inbound.*`          matches `sms.inbound.{userId}`    (3 segments)
  //   `followup.suggested.*`   matches `followup.suggested.{userId}` (3 segments)
  //
  // These patterns do NOT match:
  //   - `trial.ended`               (2 segments, different root)
  //   - `sms.status.{userId}`       (different middle segment — sibling of `sms.inbound.*`)
  //   - `lead.updated.{userId}`     (different middle segment)
  //   - `lead.created`              (only 2 segments — no userId tail)
  //   - `lead.created.a.b`          (4 segments — too many)
  //
  // Every handler also re-validates the event name with a hard prefix check
  // before invoking any cache method — defense-in-depth against a future
  // emit that accidentally collides with one of these patterns.
  // ==========================================================================

  /** `lead.created.${userId}` — Thumbtack + Yelp webhook lead upserts. */
  @OnEvent('lead.created.*')
  async onLeadCreated(payload: any, eventName?: string): Promise<void> {
    if (!this.eventMatches(eventName, 'lead.created.')) return;
    const userId = payload?.userId;
    const leadId = payload?.id;
    if (!userId) return;
    await this.invalidateLeadAndList(userId, leadId);
  }

  /** `lead.status.conflict.${userId}` — conflict resolution in lead-status.service. */
  @OnEvent('lead.status.conflict.*')
  async onLeadStatusConflict(payload: any, eventName?: string): Promise<void> {
    if (!this.eventMatches(eventName, 'lead.status.conflict.')) return;
    const userId = payload?.userId;
    const leadId = payload?.leadId ?? payload?.id;
    if (!userId) return;
    await this.invalidateLeadAndList(userId, leadId);
  }

  /**
   * `sms.inbound.${userId}` — Twilio inbound SMS stored as Message.
   * Payload has `leadId` but not `userId` — extract userId from event name.
   *
   * Explicitly DOES NOT catch `sms.status.*` (sibling event for delivery
   * receipts) because that's a different middle segment; see class header.
   */
  @OnEvent('sms.inbound.*')
  async onSmsInbound(payload: any, eventName?: string): Promise<void> {
    if (!this.eventMatches(eventName, 'sms.inbound.')) return;
    const userId = payload?.userId ?? this.parseUserIdFromEvent(eventName, 'sms.inbound.');
    const leadId = payload?.leadId ?? payload?.id;
    if (!userId) return;
    await this.invalidateLeadMessagesAndList(userId, leadId);
  }

  /**
   * `followup.suggested.${userId}` — scheduler created a suggestion.
   *
   * Payload fields: `enrollmentId`, `conversationId`, `executionId`, `objective`,
   * `message`. No `leadId` or `userId` in the payload — we extract `userId` from
   * the event name.
   *
   * We can only invalidate the per-user list (suggestion badges) without a leadId.
   * Lead detail TTL-stales up to 60s — acceptable since follow-up suggestions rarely
   * change the detail view directly; the list is the primary surface.
   */
  @OnEvent('followup.suggested.*')
  async onFollowUpSuggested(_payload: any, eventName?: string): Promise<void> {
    if (!this.eventMatches(eventName, 'followup.suggested.')) return;
    const userId = this.parseUserIdFromEvent(eventName, 'followup.suggested.');
    if (!userId) return;
    await this.invalidateLeadList(userId);
  }

  /**
   * Strict event-name check: event MUST start with the expected prefix AND
   * contribute exactly one additional segment (the userId) — no empty tail,
   * no further dots.
   */
  private eventMatches(eventName: string | undefined, prefix: string): boolean {
    if (!eventName || !eventName.startsWith(prefix)) return false;
    const tail = eventName.slice(prefix.length);
    // Reject empty tail, reject tails that contain another `.` (would mean
    // a fourth/fifth segment wildcard subscribers should NOT claim).
    return tail.length > 0 && !tail.includes('.');
  }

  /** Extract `${userId}` tail from a dynamic event name like `lead.created.abc-123`. */
  private parseUserIdFromEvent(eventName: string | undefined, prefix: string): string | null {
    if (!this.eventMatches(eventName, prefix)) return null;
    return eventName!.slice(prefix.length);
  }
}
