# LeadBridge — Current Security Posture

Last updated: **2026-04-28**, after Phase 4 + DTO fix went live (PRs #110, #113, #116, #119, #131, #133, #134).

This is a snapshot of what is and isn't protected today, and where the boundaries are. It is not a security spec — it is a reference for "if I'm about to touch X, what invariant am I responsible for keeping?"

---

## Overview

LeadBridge is a multi-tenant SaaS. Every customer-data row is owned by a `User` (the tenant) — `userId` is the tenant identifier across the schema. There are also four ADMIN users today who can act outside their own tenant for support purposes.

**The four security primitives currently in place**:

| # | Primitive | What it does | Where it lives |
|---|---|---|---|
| 1 | `TenancyService` | Cross-tenant row access — every "fetch by id" passes through `requireConversationAccess`/`requireEnrollmentAccess`/`requireTenantAccess`/`scopeQueryToTenant` so tenant A cannot see tenant B's row | [src/common/tenancy/tenancy.service.ts](../../src/common/tenancy/tenancy.service.ts) |
| 2 | `AuditService` | Records customer-data reads (and impersonation writes) into `data_access_logs` with PII sanitization | [src/common/audit/audit.service.ts](../../src/common/audit/audit.service.ts) |
| 3 | `ImpersonationGuard` | Detects an admin acting *as* a tenant via `?actAsUserId=` and audits the call | [src/common/guards/impersonation.guard.ts](../../src/common/guards/impersonation.guard.ts) |
| 4 | `SupportGrant` + `@RequiresSupportGrant(scope)` | An ADMIN cannot read/mutate customer data without first issuing themselves a time-bound, scope-limited, tenant-scoped grant | [src/admin/support-grants/](../../src/admin/support-grants/) |

---

## What's protected, by phase

### Phase 0 — Tenant hotfix (PR #110, live)
- `TenancyService` introduced.
- Cross-tenant access points fixed in **conversation-context** and **follow-up-engine** (the two places where the fetch was previously by id without a userId scope).
- Convention established: **`NotFoundException` (404), never `ForbiddenException` (403)**, on cross-tenant access. We don't leak existence.

### Phase 1A — Tier A controller sweep (PR #113, live)
Five modules audited and tightened: `automation`, `templates`, `notifications`, `call-connect`, `monitoring`. Every "fetch by id" call now scopes by `userId` (or chains through a parent that does).

### Phase 1B — Tier B controller sweep (PR #116, live)
Six more: `integrations`, `platforms`, `analytics`, `crm-webhook`, `service-flow-inbound`, `conversation-sync`.

### Phase 2 — Audit foundation (PR #119, live)
- `DataAccessLog` Prisma model + `AuditService.logAccess()` with strict 13-field schema. No JSON metadata blob — every field is named, indexed, and validatable.
- PII sanitization on the only free-text field (`reason`): `maskPhone` (last 4), `maskEmail` (first char + domain), bearer tokens redacted, 40+ alphanumeric strings redacted as tokens, query strings stripped from `route`. See [src/common/audit/sanitize.ts](../../src/common/audit/sanitize.ts).
- `ImpersonationGuard` wired to log every impersonated request (read/write classified).

### Phase 3 — SupportGrant (PR #131, live)
- `SupportGrant` model: `(adminUserId, tenantId, scopes[], reason, expiresAt)`. Default 60 min, hard cap 7 days. No FKs to User — rows must outlive admin/tenant deletion as a forensic record.
- `@RequiresSupportGrant('scope')` decorator + `SupportGrantGuard`. The guard runs after `JwtAuthGuard` + `AdminGuard`: caller must be an admin, hold an unexpired grant whose scopes include the required one, and whose tenantId matches the targeted resource (or is the `__platform__` sentinel for bulk endpoints).
- Phase 3 protected four read endpoints (`user:read`, `notifications:read`, `phones:read`, `errors:read`) with `accessType=support_read` audit rows.

### Phase 4 — Admin endpoint split (PR #133, live)
Every remaining admin endpoint classified as `platform_metadata` or `customer_data`. Customer-data endpoints now require a grant. Three endpoints stay AdminGuard-only because they expose only aggregate/operational metadata: `GET /v1/admin/stats`, `GET /v1/admin/logs`, `GET /v1/admin/cache/status`.

Six new scopes were added: `user:list`, `user:write`, `user:delete`, `trials:reset`, `cache:invalidate`, `backfill:yelp`. `user:delete` is intentionally separate from `user:write` so a write grant can't be escalated to deletion.

### Migration deploy (PR #128, #130, #132, fully live)
Auto-migrate runs on every Railway deploy. Production startCommand:
```
DATABASE_URL="$DIRECT_URL" npx prisma migrate deploy && node dist/main.js
```
Set in the Railway dashboard (railway.json is ignored — see [migration-deploy-runbook.md](migration-deploy-runbook.md)). `prisma` is in `dependencies` so the runtime image carries the pinned 6.19.1 CLI; without that, `npx` auto-installed prisma 7.x and silently no-op'd 6.x migrations.

---

## What's NOT protected (yet)

### Database-level isolation (RLS)
**Not implemented.** Every cross-tenant guard above lives in application code. A bug in a `findFirst` (forgotten `userId`), a raw SQL query, or a Prisma `findUnique({ where: { id } })` without a tenant scope can still leak. This is the planned **Phase 5 (RLS)** — held until application-level coverage is complete and stable, since RLS adds operational complexity and migration risk.

### Tenant-issued grants
Today admins **issue grants to themselves**. Tenants do not consent. This is a deliberate tradeoff (accountability via audit chain rather than tenant approval flow) that should be revisited if regulatory requirements change.

### Field-level encryption
PII columns (email, phone, name, message bodies) are stored as plaintext in Postgres. Stripe customer ids and platform OAuth tokens ARE encrypted at the column level — see `encryption.key` config in [src/config/configuration.ts](../../src/config/configuration.ts). Note: the config path is `encryption.key`, not `encryptionKey` — using the wrong path silently returns `undefined` and encrypts with the empty string. That was a multi-week production bug previously; all current call sites use the correct path.

### CSP / SRI / strict transport
Frontend ships without a strict CSP today. Out of scope for the backend-data-access work that Phases 0-4 covered.

---

## Conventions that should be maintained

These were established during the 0-4 work and apply to all new code:

| Rule | Why |
|---|---|
| **`NotFoundException` (404) on every cross-tenant access failure**, never 403 | Prevents existence leaks. Same convention used by `TenancyService`, `SupportGrantGuard`, and tenant-scoped controllers. |
| **`findFirst({ where: { id, userId } })` is the canonical safe pattern** for fetch-by-id | A `findUnique({ where: { id } })` without a tenant scope is a cross-tenant leak waiting to happen. |
| **All admin customer-data endpoints carry `@RequiresSupportGrant(scope)`** | `AdminGuard` alone is insufficient — admin role doesn't authorize customer-data access. |
| **Audit `accessType=support_read` is reserved for guarded admin reads of customer data** | Don't reuse the value for analytics, monitoring, or general logging. |
| **`__platform__` is the sentinel tenantId for bulk admin endpoints** | Admins issue platform-scoped grants for routes that span all tenants (`/users` list, `/trials/reset-all`, etc.). |
| **No JSON metadata blob in `data_access_logs`** | The 13-field schema is strict and indexed. Metadata blobs become un-queryable garbage over time. |
| **Service-layer business rules stay in services, not in DTOs** | DTOs are structural validation only (shape, type). Service-layer rules (whitespace-only reason, 7-day max duration, reason truncation) live where they're testable in isolation. |

---

## Test inventory

After Phase 4 + DTO fix: **39 suites, 425 tests passing**. The relevant suites for the security work:

| Suite | Coverage |
|---|---|
| [test/security/audit.sanitize.spec.ts](../../test/security/audit.sanitize.spec.ts) | PII sanitization (phone/email/token/bearer/query string) |
| [test/security/audit.service.spec.ts](../../test/security/audit.service.spec.ts) | `AuditService.logAccess` schema, never-throws contract |
| [test/security/impersonation.guard.audit.spec.ts](../../test/security/impersonation.guard.audit.spec.ts) | Impersonation flow audits both reads and writes |
| [test/security/support-grants.service.spec.ts](../../test/security/support-grants.service.spec.ts) | Service-layer business rules (defaults, clamping, validation) |
| [test/security/support-grants.dto.spec.ts](../../test/security/support-grants.dto.spec.ts) | DTO accepted/rejected through the global ValidationPipe |
| [test/security/support-grant.guard.spec.ts](../../test/security/support-grant.guard.spec.ts) | Guard 404 paths, scope match, target tenant resolution |
| [test/security/admin.controller.support-grant.spec.ts](../../test/security/admin.controller.support-grant.spec.ts) | Phase 3 read endpoints write `support_read` rows |
| [test/security/admin.controller.endpoint-split.spec.ts](../../test/security/admin.controller.endpoint-split.spec.ts) | Every customer-data endpoint carries the right scope; metadata endpoints don't |
| `test/security/*-cross-tenant.spec.ts` (14 specs) | Phase 0/1A/1B `TenancyService` integration with each controller |

---

## See also
- [support-access-runbook.md](support-access-runbook.md) — how to actually use SupportGrant day-to-day
- [migration-deploy-runbook.md](migration-deploy-runbook.md) — how migrations get applied on every deploy
