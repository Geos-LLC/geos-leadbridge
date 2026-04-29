/**
 * Centralized cache-key builders.
 *
 * Keys are unprefixed here — `CacheService` automatically prepends the
 * env-scoped `keyPrefix` (e.g. `lb:v1:production:`) from configuration.
 *
 * Resource names MUST stay stable. Changing a resource name invalidates
 * all existing values for that resource until their TTL expires.
 */
export const CacheKeys = {
  me: (userId: string) => `me:user:${userId}`,

  savedAccounts: (userId: string, platform?: string) =>
    platform ? `saved-accounts:user:${userId}:platform:${platform}` : `saved-accounts:user:${userId}`,

  savedAccountsPattern: (userId: string) => `saved-accounts:user:${userId}*`,

  // Leads. The list key is partitioned by optional businessId filter; `leadsListPattern`
  // covers all variants for a user so invalidation is a single `delPattern` call.
  //
  // The `v2:` prefix was introduced with the account-boundary fix
  // (hotfix/account-boundary-lead-filtering). Pre-fix, `leads:user:{userId}`
  // could hold a cross-account list because callers omitted businessId. Bumping
  // the prefix once guarantees no v1 cached list survives the deploy. Old keys
  // age out within their 30s TTL.
  leadsList: (userId: string, businessId?: string) =>
    businessId ? `leads:v2:user:${userId}:biz:${businessId}` : `leads:v2:user:${userId}`,
  leadsListPattern: (userId: string) => `leads:v2:user:${userId}*`,
  // Lead detail + messages keys include userId to prevent cross-tenant leakage:
  // if two users ever share a leadId (they don't today, but the Prisma `findFirst`
  // filter is { id, userId } — skipping that check with a tenant-agnostic key
  // would return cached data to the wrong tenant). Always include userId here.
  leadDetail: (userId: string, leadId: string) => `lead:user:${userId}:${leadId}`,
  leadMessages: (userId: string, leadId: string) => `lead-messages:user:${userId}:${leadId}`,

  // Notification logs scoped to one lead. Same userId-in-key invariant as
  // leadMessages — getLogsByLead enforces ownership via Prisma but a
  // tenant-agnostic key would risk leaking cached results across users.
  notificationLogsByLead: (userId: string, leadId: string) =>
    `notification-logs:user:${userId}:${leadId}`,

  // JwtStrategy.validate caches the per-request user lookup here.
  // Cache value: minimal AuthUser shape (id, email, name, role, subscription*,
  // hasOwnNumber) — never the full User row. TTL ~120s keeps role/subscription
  // staleness bounded; explicit invalidation runs on user delete + subscription
  // change. Key includes userId; never share across users.
  authUser: (userId: string) => `auth:user:${userId}`,

  // Admin: wipe everything we know about a user (saved-accounts + leads + me).
  userAllPattern: (userId: string) => [
    `me:user:${userId}`,
    `saved-accounts:user:${userId}*`,
    `leads:v2:user:${userId}*`,
  ],
} as const;
