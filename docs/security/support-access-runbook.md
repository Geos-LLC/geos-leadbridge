# Support Access Runbook

Operational guide for using the SupportGrant system to access customer data as an admin.

---

## When you need this

You're an admin (`User.role = 'ADMIN'`) and you need to:

- Look at a specific tenant's account, leads, conversations, or settings (e.g., reproducing a customer-reported bug)
- Read platform-wide bulk data (notification logs, tenant phone numbers, system error feed, all-users list)
- Modify a tenant's subscription/trial state
- Run a destructive operation (delete user, reset trials, invalidate cache, run a backfill)

Plain admin role is **not enough** for any of the above. You must first issue yourself a SupportGrant. The guard returns 404 (not 403) on missing/wrong-scope grants — by design, no existence leak.

---

## How to issue a grant

`POST /v1/me/support-grants`. Auth: your admin JWT.

### Request body

```json
{
  "tenantId": "<targetUserId | __platform__>",
  "scopes": ["<scope1>", "<scope2>", ...],
  "reason": "human-readable why this grant exists",
  "durationMinutes": 60
}
```

| Field | Required | Notes |
|---|---|---|
| `tenantId` | yes | The User id you intend to read/mutate. Use `__platform__` for bulk endpoints that span tenants. |
| `scopes` | yes | Non-empty array of strings. See scope catalogue below. |
| `reason` | yes | Surfaces in `data_access_logs.reason` after PII sanitization (truncated to 500 chars). |
| `durationMinutes` | no | Default 60. Hard cap 7 days (10080). Service silently clamps anything higher. |

### Response (201)

```json
{
  "success": true,
  "grant": {
    "id": "cmoj5cad9...",
    "tenantId": "__platform__",
    "scopes": ["user:list"],
    "reason": "Phase 3/4 final verification",
    "expiresAt": "2026-04-28T21:51:54.852Z",
    "createdAt": "2026-04-28T21:36:54.852Z"
  }
}
```

### Once issued

The grant is immediately effective. Subsequent calls to scope-matching customer-data endpoints will pass the guard, and each call writes a `support_read` row to `data_access_logs`.

---

## Scope catalogue

Each scope authorizes a specific set of routes. A grant can carry multiple scopes; the guard only checks "is the required scope present?"

### Per-tenant scopes (require a real `tenantId`)

| Scope | Authorizes |
|---|---|
| `user:read` | `GET /v1/admin/users/:userId` — full tenant detail |
| `user:write` | `PATCH /v1/admin/users/:userId/subscription`, `POST /v1/admin/users/:userId/cancel-subscription`, `PATCH /v1/admin/users/:userId/trial-leads` |
| `user:delete` | `DELETE /v1/admin/users/:userId` — separate from `user:write` so a write grant cannot escalate to deletion |
| `cache:invalidate` | `POST /v1/admin/cache/invalidate-user/:userId`, `POST /v1/admin/cache/invalidate-lead/:leadId` (the lead one resolves to `__platform__`) |

### Platform-wide scopes (require `tenantId="__platform__"`)

| Scope | Authorizes |
|---|---|
| `user:list` | `GET /v1/admin/users` — bulk tenant list |
| `notifications:read` | `GET /v1/admin/notification-logs` |
| `phones:read` | `GET /v1/admin/tenant-numbers` |
| `errors:read` | `GET /v1/admin/tenant-errors` |
| `trials:reset` | `POST /v1/admin/trials/reset-all` — fleet-wide trial reset |
| `backfill:yelp` | `POST /v1/admin/backfill/yelp` |

### Tenant resolution

The guard reads `request.params.userId`, then `request.params.tenantId`, then falls back to `__platform__`. The grant's `tenantId` must match the resolved value (or be `__platform__`, which authorizes any target). Examples:

- `GET /v1/admin/users/abc-123` — guard looks for a grant with scope `user:read` AND (`tenantId=abc-123` OR `tenantId=__platform__`).
- `GET /v1/admin/users` — no path params → guard looks for `tenantId=__platform__`.
- `POST /v1/admin/cache/invalidate-lead/lead-789` — leadId is not a tenant id → guard falls back to `__platform__`.

---

## Recipes

### Recipe 1 — investigate one tenant's leads/conversations

```bash
# 1. Issue grant
curl -s -X POST https://thumbtack-bridge-production.up.railway.app/api/v1/me/support-grants \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "<targetUserId>",
    "scopes": ["user:read"],
    "reason": "Customer ticket #4521 — missing leads investigation",
    "durationMinutes": 30
  }'

# 2. Read the user (audit row written automatically)
curl -s "https://thumbtack-bridge-production.up.railway.app/api/v1/admin/users/<targetUserId>" \
  -H "Authorization: Bearer $ADMIN_JWT"
```

### Recipe 2 — fleet-wide tenant search

```bash
curl -s -X POST https://thumbtack-bridge-production.up.railway.app/api/v1/me/support-grants \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "__platform__",
    "scopes": ["user:list"],
    "reason": "Billing reconciliation — find inactive Stripe subscriptions",
    "durationMinutes": 60
  }'

curl -s "https://thumbtack-bridge-production.up.railway.app/api/v1/admin/users?tier=PRO&limit=50" \
  -H "Authorization: Bearer $ADMIN_JWT"
```

### Recipe 3 — a single grant for several scopes (one investigation, multiple endpoints)

If you'll touch several endpoints in one session, issue one grant with all the scopes you need rather than re-issuing for each. The guard just checks "is the required scope in this grant's scopes array".

```json
{
  "tenantId": "__platform__",
  "scopes": ["user:list", "notifications:read", "errors:read"],
  "reason": "Investigating notification-delivery degradation report",
  "durationMinutes": 90
}
```

---

## How to revoke a grant

There is **no `DELETE /v1/me/support-grants/:id` endpoint** today (out of scope for Phase 3 — the spec was POST-only). Two options:

### Option A — let it expire
The shortest path. Issue grants with the smallest reasonable `durationMinutes`.

### Option B — force-expire via Prisma
For when you've finished early and want the auth window closed immediately. Requires DB access.

```bash
DATABASE_URL=$DIRECT_URL node -e "
const { PrismaClient } = require('./generated/prisma');
const p = new PrismaClient({datasources:{db:{url: process.env.DATABASE_URL}}});
p.supportGrant.update({
  where: { id: '<grantId>' },
  data: { expiresAt: new Date(Date.now() - 1000) },
}).then(g => console.log('expired', g.id)).finally(() => p.\$disconnect());
"
```

The forensic record is preserved (the row is updated, not deleted). The guard's `findActiveGrant` query filters on `expiresAt > now()`, so the auth window closes the moment the update commits.

---

## Audit trail

Every successful guarded call writes one row to `data_access_logs`. To find what an admin saw during an investigation:

```sql
SELECT "createdAt", "actorUserId", "tenantId", route, "resourceType", "resourceId", reason
FROM data_access_logs
WHERE "accessType" = 'support_read'
  AND "actorUserId" = '<adminId>'
  AND "createdAt" > now() - interval '7 days'
ORDER BY "createdAt" DESC;
```

`reason` is sanitized at write time (phones masked to last 4, emails to first-char + domain, bearer tokens redacted, query strings stripped from `route`). The full `reason` you typed into the grant body is preserved on the `support_grants` row itself, untouched.

---

## Common failure modes

### `404 Not Found` on a customer-data endpoint
Most likely: no active grant, scope mismatch, expired grant, or wrong `tenantId` on the grant. The guard returns 404 in all four cases (no existence leak). Check:

```sql
SELECT id, scopes, "tenantId", "expiresAt"
FROM support_grants
WHERE "adminUserId" = '<your admin id>'
  AND "expiresAt" > now()
ORDER BY "createdAt" DESC;
```

### `400 Bad Request` on `POST /v1/me/support-grants`
The DTO is strict (Phase 3 + DTO fix #134). Required: `tenantId` (non-empty string), `scopes` (non-empty string array), `reason` (non-empty string). Optional: `durationMinutes` (positive int). Extra properties are rejected. See [src/admin/support-grants/dto/create-support-grant.dto.ts](../../src/admin/support-grants/dto/create-support-grant.dto.ts).

### `401 Unauthorized`
You don't have an admin JWT, or it's expired. The grant endpoint requires `JwtAuthGuard + AdminGuard` first.

---

## Don't

- **Don't share grants between admins.** A grant is bound to `adminUserId`. Each admin issues their own.
- **Don't use `tenantId="__platform__"` when you're targeting one tenant.** It works (`__platform__` matches any target in the guard's `OR` clause), but you lose tenant scoping in the audit trail. Use the real `userId`.
- **Don't issue 7-day grants for routine work.** The cap is a hard limit, not a recommendation. Default to 30-60 minutes.
- **Don't put PII in `reason` if you can avoid it.** Sanitization masks phones/emails but not arbitrary identifiers (names, business names). Use ticket IDs and short context.

---

## See also
- [current-security-posture.md](current-security-posture.md) — what is and isn't protected today
- [migration-deploy-runbook.md](migration-deploy-runbook.md) — how schema changes reach production
- [src/admin/support-grants/](../../src/admin/support-grants/) — service, controller, guard, decorator, DTO
