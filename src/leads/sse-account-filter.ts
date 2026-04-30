/**
 * SSE account-scope filter helpers.
 *
 * Used by `LeadsController.leadEvents` to filter the per-user event stream
 * down to a single saved account when the subscriber asked for one
 * (`?businessId=...`) and to resolve a payload's owning businessId when the
 * emit site didn't include it directly.
 *
 * Design choices (intentionally narrow — see hotfix PR notes):
 *   - Two payload shapes resolve directly (no DB hit): a payload that already
 *     carries a top-level `businessId`, or `lead.created` whose payload IS the
 *     full lead row (so `payload.businessId` and `payload.id` are present).
 *   - Anything with a `leadId` → one Prisma lookup, cached in a connection-
 *     scoped `Map<leadId, businessId | null>`. The map's lifetime is the SSE
 *     connection; a fresh subscribe rebuilds it.
 *   - Anything else (e.g. `sms.status` payloads carrying only `messageId` /
 *     `logId`) → unresolved. By spec, unresolved events are dropped from
 *     account-scoped streams. They still pass through `scope=all`.
 *
 * The class is tiny and free of NestJS lifecycle hooks so it can be
 * instantiated directly per SSE call (closure-scoped cache) and unit-tested
 * with a hand-rolled prisma mock.
 */

export type SseAccountScope =
  | { kind: 'all' }
  | { kind: 'account'; businessId: string };

/**
 * Minimal Prisma surface needed by the resolver. Declared as an interface so
 * tests can pass a mock without pulling in the full PrismaService.
 */
export interface BusinessIdLookup {
  lead: {
    findFirst: (args: {
      where: { id: string; userId: string };
      select: { businessId: true };
    }) => Promise<{ businessId: string | null } | null>;
  };
}

/**
 * Resolves `businessId` for an SSE event payload, with a per-instance cache.
 *
 * Caches the in-flight Promise (not just the resolved value) so concurrent
 * events for the same leadId — which is the common case under a burst — share
 * one DB lookup. A connection that handles 50 messages on a single lead in
 * quick succession issues exactly one Prisma query.
 *
 * Cache lifetime is the SSE connection: a new subscribe re-instantiates the
 * resolver and rebuilds the map.
 */
export class SseBusinessIdResolver {
  private readonly leadCache = new Map<string, Promise<string | null>>();

  constructor(
    private readonly prisma: BusinessIdLookup,
    private readonly userId: string,
  ) {}

  async resolve(payload: any): Promise<string | null> {
    if (!payload || typeof payload !== 'object') return null;

    // 1. Direct businessId on the payload (some emit sites set it explicitly).
    if (typeof payload.businessId === 'string' && payload.businessId !== '') {
      return payload.businessId;
    }

    // 2. lead.created emits the lead row itself — `payload.businessId` already
    //    handled in (1) when the emit shape is `{ businessId, id, ... }`. If
    //    the row is nested under `lead`, drill in.
    if (
      payload.lead &&
      typeof payload.lead.businessId === 'string' &&
      payload.lead.businessId !== ''
    ) {
      return payload.lead.businessId;
    }

    // 3. Resolve via leadId. Look at common shapes:
    //    - sms.inbound:           { leadId, message: {...} }
    //    - lead.status.conflict:  { leadId, userId, conflict }
    //    - lead.created (defensive): payload.id when payload looks like a lead row
    const leadId = this.extractLeadId(payload);
    if (!leadId) return null;

    let pending = this.leadCache.get(leadId);
    if (!pending) {
      pending = this.prisma.lead
        .findFirst({
          where: { id: leadId, userId: this.userId },
          select: { businessId: true },
        })
        .then((lead) => lead?.businessId ?? null);
      this.leadCache.set(leadId, pending);
    }
    return pending;
  }

  /**
   * Picks the most likely leadId from an event payload. Returns null if nothing
   * looks like a leadId — which by spec means the event will be dropped from
   * account-scoped streams.
   */
  private extractLeadId(payload: any): string | null {
    if (typeof payload?.leadId === 'string' && payload.leadId !== '') return payload.leadId;
    if (typeof payload?.lead?.id === 'string' && payload.lead.id !== '') return payload.lead.id;
    // `lead.created` emits the bare lead row — distinguish from a generic event
    // with `id` by also requiring `businessId` OR `userId` on the same level
    // (both are columns on every Lead row). This avoids matching unrelated
    // payloads that happen to have an `id` field.
    if (
      typeof payload?.id === 'string' &&
      payload.id !== '' &&
      ('businessId' in payload || 'userId' in payload)
    ) {
      return payload.id;
    }
    return null;
  }
}

/**
 * Decides whether an event whose owning businessId resolved to `resolved`
 * should be forwarded to a subscriber asking for `scope`.
 *
 *   scope.kind === 'all'      → always pass (resolution skipped upstream)
 *   scope.kind === 'account'  → pass iff resolved === scope.businessId
 *
 * `null` resolved (lookup failed) → drop. By spec.
 */
export function passesAccountFilter(
  scope: SseAccountScope,
  resolved: string | null,
): boolean {
  if (scope.kind === 'all') return true;
  if (resolved === null) return false;
  return resolved === scope.businessId;
}
