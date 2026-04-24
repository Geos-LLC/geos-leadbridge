# Redis Cache Rollout Guide

Deployment order + manual smoke tests for the cache layer.

---

## Phase 1 — Deploy with CACHE_ENABLED=false

Ship the code with caching disabled first. All code paths run as before, invalidation helpers become no-ops, and `getOrSet` falls through to the database loader.

### Railway env vars (staging + production)

```
CACHE_ENABLED=false
# REDIS_URL intentionally unset
```

### Verify

1. Deploy succeeds with no Redis connection attempted.
2. `GET /v1/admin/cache/status` (admin auth) returns:
   ```json
   { "success": true, "data": { "connected": false, "enabled": false, "keyPrefix": "lb:v1:production:", "hits": 0, "misses": 0, "errors": 0, "sets": 0, "dels": 0 } }
   ```
3. Boot logs contain:
   - `Cache disabled via CACHE_ENABLED=false — using no-op fallback.`
4. Regression: existing pages still load (Messages, Dashboard, Settings). Lead writes + reads behave identically to pre-change.

Keep Phase 1 live long enough to catch any invalidation-path regressions from the 40+ write-site changes. Any unexpected behavior → rollback is a revert of the PR; no Redis state to clean up.

---

## Phase 2 — Provision Railway Redis

1. In the Railway dashboard for the `thumbtack-bridge-production` service, click **New → Database → Redis** (free tier is enough — 256 MB handles the current key volume).
2. Confirm Railway auto-injected `REDIS_URL` into the service's **Variables** tab. The value looks like `redis://default:<password>@<host>.railway.internal:6379`.
3. Repeat on staging if it's a separate Railway service.
4. Leave `CACHE_ENABLED=false` for now — you want the Redis plugin live but not yet wired.

### Verify

- `GET /v1/admin/cache/status` still reports `enabled: false, connected: false` — caching is off until the flag flips.

---

## Phase 3 — Enable caching

Flip the kill switch:

```
CACHE_ENABLED=true
```

Railway auto-redeploys on env var change. Boot logs should show:

```
Redis connected (keyPrefix="lb:v1:production:")
```

`GET /v1/admin/cache/status` should report `enabled: true, connected: true`.

### Kill-switch rollback

If anything goes wrong, set `CACHE_ENABLED=false` and redeploy (~30s on Railway). The service restarts, `CacheService.isLive()` returns false, and every read falls back to the loader — zero code revert needed.

### Nuclear flush

Every key is prefixed with `lb:v1:{NODE_ENV}:` so a SCAN-based wipe is safe even on a shared Redis:

```bash
# Authenticated Railway shell session:
redis-cli --scan --pattern 'lb:v1:production:*' | xargs -L 100 redis-cli DEL
```

Or call `POST /v1/admin/cache/invalidate-user/:userId` per affected user.

---

## Smoke test checklist (run after Phase 3)

Use two test accounts when practical: `userA` (hits cache) and `userB` (verifies cross-tenant isolation).

### 1. `/auth/me`

- [ ] Call `GET /auth/me` → returns `{ok: true, account: {...}, stats: {collectedLeads: N}}`
- [ ] Call it again within 60s → same payload (cache hit); `stats.misses` unchanged in admin status
- [ ] `GET /v1/admin/cache/status` → `hits` counter incremented
- [ ] `PATCH /v1/users/me` with `{name: "New Name"}` → succeeds
- [ ] Call `GET /auth/me` again → returns the new name immediately (cache invalidated on write)

### 2. Saved accounts

- [ ] Call `GET /v1/platforms/saved-accounts` → returns account list with `tokenDead` flags
- [ ] Verify response does **NOT** contain `credentialsJson` or any token strings (whitelist sanitizer — see `src/platforms/platform.service.ts` `sanitizeSavedAccount`)
- [ ] Call again within 60s → cached response (check admin status: hits incremented)
- [ ] Connect or disconnect a platform (e.g. Yelp) → `GET /v1/platforms/saved-accounts` returns updated list immediately
- [ ] Token refresh event (either wait for proactive cron or manually trigger) → `tokenDead` reflects live state on next call

### 3. Lead list — no filter

- [ ] `GET /v1/leads` → all leads for the user
- [ ] Second call within 30s → cache hit (hits counter up)
- [ ] Confirm key shape via `redis-cli --scan --pattern 'lb:v1:production:leads:user:*'` — should see `leads:user:{userId}` (no `:biz:` suffix). **Never use `KEYS` on Railway Redis — it is O(N) blocking and can stall the instance. Always `--scan`.**

### 4. Lead list — with businessId

- [ ] `GET /v1/leads?businessId=<id>` → leads for that business only
- [ ] Second call within 30s → cache hit (separate key from no-filter)
- [ ] Confirm both keys coexist (use `redis-cli --scan --pattern 'lb:v1:production:leads:user:{userId}*'`): `leads:user:{userId}` and `leads:user:{userId}:biz:{businessId}`
- [ ] `GET /v1/leads?businessId=<id>&status=new` → **does NOT** hit the cache (filter shape unsupported, bypasses cache entirely — unit tested in `src/leads/leads.service.spec.ts`)

### 5. Lead detail

- [ ] `GET /v1/leads/:id` → full normalized lead
- [ ] Second call within 60s → cache hit
- [ ] Key: `lead:user:{userId}:{leadId}` (userId-scoped — cross-tenant safe)
- [ ] Confirm userB calling `GET /v1/leads/:id` for userA's lead still gets `NotFoundException` (ownership check in the loader, distinct cache key)

### 6. Lead status change

- [ ] `PATCH /v1/leads/:id` with `{status: "quoted"}` → succeeds
- [ ] Immediately `GET /v1/leads` → list reflects new status (list cache invalidated)
- [ ] Immediately `GET /v1/leads/:id` → detail reflects new status (detail cache invalidated)

### 7. Outbound message

- [ ] `POST /v1/leads/:id/send-message` with a message body → succeeds
- [ ] `GET /v1/leads` → the lead moves to the top (lastMessageAt bumped, list invalidated)
- [ ] `GET /v1/leads/:id` → updated lastMessageAt (detail invalidated)

### 8. Inbound message (webhook)

Easiest way to exercise: send a test SMS to the account's bot number from your phone. Or use Sigcore's test webhook to POST to `/webhooks/sms/inbound`.

- [ ] Webhook processes → new `Message` row created
- [ ] Event `sms.inbound.${userId}` fires → `LeadCacheService.onSmsInbound` runs
- [ ] `GET /v1/leads` → list order updated (unread count / lastMessageAt)
- [ ] `GET /v1/leads/:id` → refreshed detail

### 9. Cross-tenant isolation check

- [ ] userA populates cache by calling `GET /v1/leads/:leadA-id`
- [ ] userB (different account) calls `GET /v1/leads/:leadA-id` → 404 NotFound (ownership check in loader)
- [ ] No leak: the cached payload for userA is at `lead:user:{userA}:{leadA-id}`, so userB never sees it

### 10. Kill-switch round-trip

- [ ] Set `CACHE_ENABLED=false`, redeploy
- [ ] `GET /v1/admin/cache/status` → `enabled: false, connected: false`
- [ ] Every endpoint above still works (slower, but correct)
- [ ] Set `CACHE_ENABLED=true`, redeploy → cache hits resume

---

## AdminGuard — production access audit

The three cache admin endpoints (`GET cache/status`, `POST cache/invalidate-user/:userId`, `POST cache/invalidate-lead/:leadId`) live under `@Controller('v1/admin')` which is guarded by `@UseGuards(JwtAuthGuard, AdminGuard)`.

**Effective checks:**

| Layer | What it does | Result for non-admin |
|---|---|---|
| `JwtAuthGuard` | Validates the Bearer token / `?token=` query param via passport-jwt | 401 Unauthorized if token missing / expired |
| `JwtStrategy.validate` | Fresh `prisma.user.findUnique` on every request — returns live `role` from DB, never trusts JWT claims | (populates `request.user`) |
| `AdminGuard` | Strict: `user.role !== UserRole.ADMIN` throws `ForbiddenException` | 403 Forbidden |

**Role-elevation surface:**

- `User.role` defaults to `USER` in Prisma schema ([prisma/schema.prisma:83](prisma/schema.prisma#L83))
- No user-facing route writes `User.role`. The `teams.service.ts:216` write targets `orgMembership.role` (OWNER / ADMIN / MEMBER scoped to an organization), **not** `User.role`
- The only paths to `User.role = 'ADMIN'` are a direct DB write (Prisma Studio / SQL) or adding a new code path — both require deploy or DB access

**Verification steps to run in production:**

- [ ] Call `GET /v1/admin/cache/status` as an authenticated **non-admin** user → expect 403 `Admin access required`
- [ ] Call it with no token → expect 401
- [ ] Call it with an expired token → expect 401
- [ ] Call it as an admin → expect 200 with stats
- [ ] `POST /v1/admin/cache/invalidate-user/:userId` as non-admin → 403

No additional hardening is required — the guards are proper. If you want defense-in-depth, consider adding a shared-secret header check on the mutation endpoints for break-glass scenarios (not necessary for current threat model).

---

## Monitoring

After Phase 3, watch:

- `GET /v1/admin/cache/status` — `errors` counter should stay near zero. Spikes indicate Redis connectivity issues.
- Grafana / Loki: `{service_name="leadbridge-api"} |= "CacheService"` shows connection + error events.
- Hit rate — healthy target for saved-accounts and `/auth/me` is >80% after warmup. If low, check for excessive write-through invalidation (e.g., a webhook storm).

## Known non-coverage (deferred)

- **Lead messages thread** (`lead-messages:*` keys) — keys reserved but NOT enabled this phase. Yelp `getYelpMessages` continues to hit the live API each time.
- **Complex filtered leads queries** (`?platform=`, `?status=`, `?limit=`) — bypass cache by design.
- **Analytics endpoints** — keep existing DB-table cache; Redis layer optional, deferred.
